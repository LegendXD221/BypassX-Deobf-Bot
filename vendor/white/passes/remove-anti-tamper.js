function isSingleUpper(name) {
  return /^[A-Z]$/.test(name);
}

function collectIds(node, result) {
  if (!node || typeof node !== "object") return result;
  if (node.type === "Identifier") { result.add(node.name); return result; }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) { v.forEach(c => collectIds(c, result)); }
    else if (v && typeof v === "object") { collectIds(v, result); }
  }
  return result;
}

function hasAntiTamperIdents(cond) {
  const ids = collectIds(cond, new Set());
  let upper = 0;
  for (const n of ids) { if (isSingleUpper(n)) upper++; }
  return upper >= 2 && upper >= ids.size * 0.5;
}

function isOrBranch(node) {
  return node && node.type === "BinaryExpression" && node.operator === "or";
}

function isAndBranch(node) {
  return node && node.type === "BinaryExpression" && node.operator === "and";
}

function unwrapParens(node) {
  if (!node) return node;
  while (node && node.type === "ParenthesisExpression") {
    node = node.expression || node;
  }
  return node;
}

function isAntiTamperCondition(cond) {
  cond = unwrapParens(cond);
  if (!cond) return false;
  if (!isOrBranch(cond)) return false;
  const left = unwrapParens(cond.left);
  const right = unwrapParens(cond.right);
  if (!left || !right) return false;
  if (!isAndBranch(left) || !isAndBranch(right)) return false;
  const leftCond = unwrapParens(left.left);
  const rightCond = unwrapParens(right.left);
  const leftCmp = unwrapParens(left.right);
  const rightCmp = unwrapParens(right.right);
  if (!leftCond || !rightCond || !leftCmp || !rightCmp) return false;
  if (leftCond.type !== "Identifier" || !isSingleUpper(leftCond.name)) return false;
  if (rightCond.type !== "UnaryExpression" || rightCond.operator !== "not") return false;
  const notArg = unwrapParens(rightCond.argument);
  if (!notArg || notArg.type !== "Identifier" || notArg.name !== leftCond.name) return false;
  if (leftCmp.type !== "BinaryExpression" || !leftCmp.operator) return false;
  if (rightCmp.type !== "BinaryExpression" || !rightCmp.operator) return false;
  return true;
}

function processNode(node, parent, key) {
  if (!node || node.type !== "IfStatement") return false;
  let changed = false;
  for (let i = 0; i < node.clauses.length; i++) {
    const clause = node.clauses[i];
    if (clause.condition && isAntiTamperCondition(clause.condition)) {
      if (parent && key !== undefined && key !== null && parent[key] === node) {
        parent[key] = { type: "DoStatement", body: [] };
        changed = true;
        return true;
      }
    }
  }
  for (const clause of node.clauses) {
    if (clause.body) {
      for (let j = 0; j < clause.body.length; j++) {
        if (processNode(clause.body[j], clause.body, j)) changed = true;
      }
    }
  }
  return changed;
}

function walkAndProcess(node, parent, key) {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  if (node.type === "IfStatement") {
    if (processNode(node, parent, key)) changed = true;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "scope") continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (walkAndProcess(item, v, i)) changed = true;
      });
    } else if (v && typeof v === "object") {
      if (walkAndProcess(v, node, k)) changed = true;
    }
  }
  return changed;
}

function removeAntiTamperPass(ast) {
  let changed = false;
  for (let i = 0; i < 4; i++) {
    if (walkAndProcess(ast, null, null)) {
      changed = true;
    } else {
      break;
    }
  }
  return { ast, changed };
}
module.exports = { removeAntiTamperPass };