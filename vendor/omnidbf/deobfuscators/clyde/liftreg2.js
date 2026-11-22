'use strict';

const { E, render, isIdent } = require('./luaemit.js');
const {
  expandFused, decodeReg, normalizeLoadKX, buildRegCFG, coalesceReg, liveness,
} = require('./regspec.js');
const { execRegBlock } = require('./regexec.js');
const { structure } = require('./structure.js');
const { resugar, nameCensus, isLocalName } = require('./resugar.js');
const { collectBound, makeNamer } = require('./lift2.js');

const MAX_CLOSURES = 512;
const MAX_DEPTH = 6;

function boxedRegs(protos) {
  const s = new Set();
  for (const P of protos || []) {
    for (const u of P.upvalues || []) if (u[0] === 1) s.add(u[1]);
  }
  return s;
}

function liftBody(P, env) {
  const instrs = normalizeLoadKX(decodeReg(expandFused(P.code || [])));
  if (!instrs.length) return [];
  const blocks = liveness(coalesceReg(buildRegCFG(instrs)));

  const nParams = P.nParams || 0;
  const regs = new Map();
  for (let r = 0; r < nParams; r++) regs.set(r, 'p' + r);
  const ctx = {
    K: P.K || [],
    fresh: env.fresh,
    boxed: boxedRegs(P.protos),
    exec: execRegBlock,
    regName(r) {
      let n = regs.get(r);
      if (n === undefined) { n = env.fresh('v'); regs.set(r, n); }
      return n;
    },
    upName(i) {
      const n = env.upNames[i];
      if (n === undefined) throw new Error('liftreg2: upvalue ' + i + ' has no binding');
      return n;
    },

    globalRead(name) {
      if (isIdent(name) && !isLocalName(name)) return E.name(name);
      return E.index(E.name('_G'), E.str(name));
    },
    closure(pi) { return env.closure(pi, ctx); },
    onClose: null,
  };

  const body = resugar(structure(blocks, ctx), ctx);

  const cen = nameCensus(body);
  const bound = new Set();
  for (let r = 0; r < nParams; r++) bound.add('p' + r);
  collectBound(body, bound);
  const decl = [];
  for (const n of regs.values()) {
    if (bound.has(n) || decl.indexOf(n) >= 0) continue;
    if (cen.reads.has(n) || cen.writes.has(n)) decl.push(n);
  }
  return decl.length ? [{ k: 'local', names: decl, values: [] }].concat(body) : body;
}

function liftProgram(rec) {
  const strings = [];
  const grab = (P) => {
    for (const v of P.K || []) if (typeof v === 'string') strings.push(v);
    for (const c of P.protos || []) grab(c);
  };
  grab(rec);

  const fresh = makeNamer();
  let closures = 0;

  function liftClosure(scope, pi, depth) {
    if (++closures > MAX_CLOSURES) throw new Error('liftreg2: too many closures');
    if (depth > MAX_DEPTH) {
      throw new Error('liftreg2: proto nesting deeper than ' + MAX_DEPTH);
    }
    const P = (scope.protos || [])[pi - 1];
    if (!P) throw new Error('liftreg2: CLOSURE ' + pi + ' has no proto');

    const upNames = [];
    (P.upvalues || []).forEach((u, k) => {
      upNames[k] = u[0] === 1 ? scope.ctx.regName(u[1]) : scope.ctx.upName(u[1]);
    });

    const env = {
      fresh,
      upNames,
      closure: (childPi, childCtx) =>
        liftClosure({ protos: P.protos || [], ctx: childCtx }, childPi, depth + 1),
    };
    const body = liftBody(P, env);
    const params = [];
    for (let r = 0; r < (P.nParams || 0); r++) params.push('p' + r);
    return E.func(params, P.isVararg === true, body);
  }

  try {
    const env = {
      fresh,
      upNames: [],
      closure: (pi, ctx) => liftClosure({ protos: rec.protos || [], ctx }, pi, 1),
    };
    return { out: render(liftBody(rec, env)), bad: null, strings };
  } catch (e) {
    return { out: '', bad: String((e && e.message) || e), strings };
  }
}

module.exports = { liftProgram, liftBody, boxedRegs };
