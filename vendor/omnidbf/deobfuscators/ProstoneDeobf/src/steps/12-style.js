'use strict';

const { Kind, unparen } = require('../lua/ast');
const { walk } = require('../lua/walk');
const { isLocalBinding } = require('../lua/scope');

function isSingleValueSlot(parentInfo) {
  if (!parentInfo) return false;
  const { parent, key, index } = parentInfo;
  if (!parent) return false;

  if (parent.kind === Kind.LocalDeclaration || parent.kind === Kind.Assignment) {
    const targets = parent.kind === Kind.LocalDeclaration ? parent.names : parent.targets;
    const exprs = parent.expressions || [];
    return targets.length === 1 && exprs.length === 1 && key === 'expressions';
  }

  if (parent.kind === Kind.CallStatement) return key === 'expression';
  if (parent.kind === Kind.Call || parent.kind === Kind.MethodCall) {
    if (key === 'base') return true;

    if (key === 'args' && index !== null && index < parent.args.length - 1) return true;
    return false;
  }

  if (parent.kind === Kind.Index) return true;
  return false;
}

function dropParens(chunk) {
  let changed = 0;
  walk(chunk, {
    enter(node, parentInfo) {
      if (!node || node.kind !== Kind.Paren) return undefined;
      const inner = node.expression;
      if (!inner) return undefined;
      if (inner.kind !== Kind.Call && inner.kind !== Kind.MethodCall && inner.kind !== Kind.Vararg) {
        replaceNode(parentInfo, inner);
        changed += 1;
        return undefined;
      }
      if (isSingleValueSlot(parentInfo)) {
        replaceNode(parentInfo, inner);
        changed += 1;
      }
      return undefined;
    },
  });
  return changed;
}

function replaceNode(parentInfo, replacement) {
  if (!parentInfo || !parentInfo.parent) return false;
  const { parent, key, index } = parentInfo;
  if (index === null || index === undefined) parent[key] = replacement;
  else parent[key][index] = replacement;
  return true;
}

function findParent(root, target) {
  let found = null;
  walk(root, {
    enter(node, parentInfo) {
      if (node === target) {
        found = parentInfo;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function clone(node) {

  return JSON.parse(JSON.stringify(node, (key, value) => (
    key === 'binding' || key === 'scope' ? undefined : value
  )));
}

function isPureValue(node) {
  const inner = unparen(node);
  if (!inner) return false;

  if (inner.kind === Kind.Name) return true;
  if (inner.kind === Kind.Number || inner.kind === Kind.String
    || inner.kind === Kind.True || inner.kind === Kind.False
    || inner.kind === Kind.Nil) return true;
  if (inner.kind === Kind.Index) return isPureValue(inner.base) && isPureValue(inner.index);
  return false;
}

function freeNamesOf(node) {
  const out = new Set();
  walk(node, {
    enter(n) {
      if (n && n.kind === Kind.Name) out.add(n.name);
      return undefined;
    },
  });
  return out;
}

const SCOPED = new Set([Kind.Function, Kind.LocalFunction, Kind.GenericFor, Kind.NumericFor]);

function scopeSafe(block, target) {
  const par = new Map();
  walk(block, {
    enter(n, pi) {
      if (pi) par.set(n, pi);
      return undefined;
    },
  });
  let cur = par.get(target);
  while (cur && cur.parent && cur.parent !== block) {
    if (SCOPED.has(cur.parent.kind)) return false;
    cur = par.get(cur.parent);
  }
  return !!cur;
}

function topStatement(block, target) {
  const par = new Map();
  walk(block, {
    enter(n, pi) {
      if (pi) par.set(n, pi);
      return undefined;
    },
  });
  let cur = par.get(target);
  if (!cur) return null;
  while (cur.parent && cur.parent !== block) {
    const up = par.get(cur.parent);
    if (!up) return null;
    cur = up;
  }
  return cur.parent === block ? cur.node : null;
}

function declaresLocals(statement) {
  if (!statement) return false;
  return statement.kind === Kind.LocalDeclaration
    || statement.kind === Kind.LocalFunction
    || statement.kind === Kind.GenericFor
    || statement.kind === Kind.NumericFor;
}

function bindingOfName(node) {
  return node && node.kind === Kind.Name ? node.binding || null : null;
}

function joinSplitDecl(block) {
  let changed = 0;
  const statements = block.statements;
  for (let at = 0; at < statements.length; at += 1) {
    const decl = statements[at];
    if (!decl || decl.kind !== Kind.LocalDeclaration) continue;
    if (decl.names.length !== 1 || (decl.expressions || []).length !== 0) continue;
    const binding = (decl.bindings || [])[0];
    if (!binding || !isLocalBinding(binding)) continue;
    for (let jt = at + 1; jt < statements.length; jt += 1) {
      const cand = statements[jt];
      if (cand.kind === Kind.Assignment
        && cand.targets.length === 1 && (cand.expressions || []).length === 1
        && cand.targets[0].kind === Kind.Name
        && bindingOfName(cand.targets[0]) === binding) {
        decl.expressions = [cand.expressions[0]];
        statements.splice(jt, 1);
        changed += 1;
        break;
      }

      if (declaresLocals(cand)) break;
      let touched = false;
      walk(cand, {
        enter(node) {
          if (node && node.kind === Kind.Name && bindingOfName(node) === binding) {
            touched = true;
            return false;
          }
          return undefined;
        },
      });
      if (touched) break;
    }
  }
  return changed;
}

function foldAliases(block) {
  let changed = 0;
  const statements = block.statements;
  for (let at = 0; at < statements.length; at += 1) {
    const decl = statements[at];
    if (!decl || decl.kind !== Kind.LocalDeclaration) continue;
    if (decl.names.length !== 1 || (decl.expressions || []).length !== 1) continue;
    const binding = (decl.bindings || [])[0];
    if (!binding || !isLocalBinding(binding)) continue;
    if (!isPureValue(decl.expressions[0])) continue;

    if (binding.captured || (binding.writes || []).length !== 0) continue;
    const reads = binding.reads || [];
    if (reads.length === 0) {
      statements.splice(at, 1);
      at -= 1;
      changed += 1;
      continue;
    }
    if (reads.length === 1) {
      if (decl.names[0] && decl.names[0].length === 1) continue;
      const parentInfo = findParent(block, reads[0]);

      if (!parentInfo || !scopeSafe(block, reads[0])) continue;
      const rhsNames = freeNamesOf(decl.expressions[0]);
      const top = topStatement(block, reads[0]);
      let shadowed = !top;
      if (top) {
        const from = statements.indexOf(top);
        for (let k = at + 1; k < from && !shadowed; k += 1) {
          const gap = statements[k];
          if (gap.kind === Kind.LocalDeclaration) {
            for (const n of gap.names || []) if (rhsNames.has(n)) shadowed = true;
          } else if (gap.kind === Kind.LocalFunction) {
            if (rhsNames.has(gap.name)) shadowed = true;
          } else if (gap.kind === Kind.GenericFor) {
            for (const n of gap.variables || []) if (rhsNames.has(n)) shadowed = true;
          } else if (gap.kind === Kind.NumericFor) {
            if (rhsNames.has(gap.variable)) shadowed = true;
          }
        }
      }
      if (shadowed) continue;
      replaceNode(parentInfo, clone(decl.expressions[0]));
      statements.splice(at, 1);
      at -= 1;
      changed += 1;
    }
  }
  return changed;
}

function isAlwaysTrue(node) {
  const inner = unparen(node);
  if (!inner) return false;
  return inner.kind === Kind.True
    || (inner.kind === Kind.Number && inner.value !== 0)
    || inner.kind === Kind.String;
}

function nilTestParts(condition) {

  const c = unparen(condition);
  if (!c || c.kind !== Kind.Binary) return null;
  if (c.operator !== '==' && c.operator !== '~=') return null;
  const left = unparen(c.lhs);
  const right = unparen(c.rhs);
  const isNil = (n) => n && n.kind === Kind.Nil;
  let nameNode = null;
  if (left.kind === Kind.Name && isNil(right)) nameNode = left;
  else if (right.kind === Kind.Name && isNil(left)) nameNode = right;
  else return null;
  return { name: nameNode.name, binding: bindingOfName(nameNode), negated: c.operator === '~=' };
}

function singleBreak(statements) {
  return Array.isArray(statements) && statements.length === 1 && statements[0].kind === Kind.Break;
}

function whileToGenericFor(block) {
  let changed = 0;
  const statements = block.statements;
  for (let at = 0; at < statements.length; at += 1) {
    const loop = statements[at];
    if (!loop || loop.kind !== Kind.While || !isAlwaysTrue(loop.condition)) continue;
    const decl = statements[at - 1];
    if (!decl || decl.kind !== Kind.LocalDeclaration) continue;
    if (decl.names.length !== 3 || (decl.expressions || []).length !== 1) continue;
    const callExpr = unparen(decl.expressions[0]);
    if (!callExpr || (callExpr.kind !== Kind.Call && callExpr.kind !== Kind.MethodCall)) continue;
    const declBindings = decl.bindings || [];
    if (declBindings.length !== 3) continue;
    const [bF, bS, bV] = declBindings;

    for (const b of [bF, bS]) {
      if (!b || !isLocalBinding(b)) continue;
      if ((b.reads || []).length !== 1 || (b.writes || []).length !== 0) continue;
    }
    if (!bF || !bS || !bV || !isLocalBinding(bF) || !isLocalBinding(bS) || !isLocalBinding(bV)) continue;
    if ((bF.reads || []).length !== 1 || (bS.reads || []).length !== 1) continue;
    if ((bF.writes || []).length !== 0 || (bS.writes || []).length !== 0) continue;

    const body = (loop.body && loop.body.statements) || [];

    let cursor = 0;
    const temps = [];
    while (cursor < body.length
      && body[cursor].kind === Kind.LocalDeclaration
      && (body[cursor].expressions || []).length === 0) {
      temps.push(body[cursor]);
      cursor += 1;
    }
    const dispatch = body[cursor];
    if (!dispatch || dispatch.kind !== Kind.Assignment) continue;
    if (dispatch.targets.length !== 2 || (dispatch.expressions || []).length !== 1) continue;
    const [tV, tT] = dispatch.targets;
    if (!tV || tV.kind !== Kind.Name || bindingOfName(tV) !== bV) continue;
    if (!tT || tT.kind !== Kind.Name) continue;
    const tempBinding = bindingOfName(tT);
    if (!tempBinding || !temps.some((t) => (t.bindings || [])[0] === tempBinding)) continue;
    const dCall = unparen(dispatch.expressions[0]);
    if (!dCall || dCall.kind !== Kind.Call || (dCall.args || []).length !== 2) continue;
    const dFunc = unparen(dCall.base);
    const dArgs = dCall.args.map(unparen);
    if (!dFunc || dFunc.kind !== Kind.Name || bindingOfName(dFunc) !== bF) continue;
    if (!dArgs[0] || dArgs[0].kind !== Kind.Name || bindingOfName(dArgs[0]) !== bS) continue;
    if (!dArgs[1] || dArgs[1].kind !== Kind.Name || bindingOfName(dArgs[1]) !== bV) continue;

    const inLoop = new Set();
    walk(loop, { enter(node) { inLoop.add(node); return undefined; } });
    const vReadsOk = (bV.reads || []).every((n) => inLoop.has(n));
    const vWritesOk = (bV.writes || []).length === 1 && inLoop.has((bV.writes || [])[0]);
    if (!vReadsOk || !vWritesOk) continue;

    const tReadsOk = (tempBinding.reads || []).every((n) => inLoop.has(n));
    const tWritesOk = (tempBinding.writes || []).length === 1;
    if (!tReadsOk || !tWritesOk) continue;

    let tempsClean = true;
    for (const t of temps) {
      const b = (t.bindings || [])[0];
      if (!b) { tempsClean = false; break; }
      if (b === tempBinding) continue;
      if ((b.reads || []).length !== 0 || (b.writes || []).length !== 0) { tempsClean = false; break; }
    }
    if (!tempsClean) continue;

    cursor += 1;
    const test = body[cursor];
    if (!test || test.kind !== Kind.If || (test.elseIfs || []).length !== 0) continue;
    const parts = nilTestParts(test.condition);
    if (!parts || parts.binding !== bV) continue;
    let loopBody = null;
    if (!parts.negated && singleBreak(test.body.statements) && test.elseBody) {
      loopBody = test.elseBody.statements;
    } else if (!parts.negated && singleBreak(test.body.statements) && !test.elseBody) {
      loopBody = body.slice(cursor + 1);
      if (!loopBody.length) continue;

    } else if (parts.negated && test.elseBody && singleBreak(test.elseBody.statements)) {
      loopBody = test.body.statements;
    } else continue;

    const forNode = {
      kind: Kind.GenericFor,
      variables: [decl.names[2], tT.name],
      expressions: [decl.expressions[0]],
      bindings: [],
      body: { kind: Kind.Block, statements: loopBody },
    };

    statements.splice(at - 1, 1);
    statements[at - 1] = forNode;
    changed += 1;
  }
  return changed;
}

function styleBlock(block, counts) {
  let changed = 0;
  const j = joinSplitDecl(block);
  const a = foldAliases(block);
  const it = whileToGenericFor(block);
  changed = j + a + it;
  if (counts) { counts.join += j; counts.alias += a; counts.iter += it; }
  return changed;
}

function run(context) {
  const counts = { parens: 0, join: 0, alias: 0, iter: 0 };
  for (let iter = 0; iter < 10; iter += 1) {
    context.resolve();
    let moved = 0;
    const p = dropParens(context.chunk);
    moved += p; counts.parens += p;
    walk(context.chunk, {
      enter(node) {
        if (node && (node.kind === Kind.Block)) {
          moved += styleBlock(node, counts);
        }
        return undefined;
      },
    });
    if (!moved) break;
  }
  context.resolve();
  const total = counts.parens + counts.join + counts.alias + counts.iter;
  if (total) {
    context.note(
      `styled output: ${total} readability rewrite(s) ` +
      `(parens ${counts.parens}, join ${counts.join}, alias ${counts.alias}, iter ${counts.iter})`,
      total,
    );
    context.bump('style.rewrites', total);
  }
}

module.exports = {
  name: '12-style',
  run,
};
