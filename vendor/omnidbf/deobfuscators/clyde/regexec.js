'use strict';

const { E, isIdent } = require('./luaemit.js');
const { isSafe, info, writesOf, overlaps, kexpr, kname } = require('./symexec.js');
const { REGNAME, isK, rkToK, rwOf } = require('./regspec.js');

const BIN = { 10: '+', 11: '-', 12: '*', 13: '/', 14: '%', 15: '^' };
const UN = { 17: '-', 18: 'not', 19: '#' };

function neg(e) {
  if (e.k === 'un' && e.op === 'not') return e.a;
  if (e.k === 'bin' && e.op === '==') return E.bin('~=', e.a, e.b);
  if (e.k === 'bin' && e.op === '~=') return E.bin('==', e.a, e.b);
  return E.un('not', e);
}

const trunc = (e) => (e.k === 'call' || e.k === 'method' || e.k === 'vararg' ? E.paren(e) : e);

const clash = (a, b) => a.call || b.call || (a.index && b.index) || overlaps(a.names, b.names);

function pendingPlan(instrs, rw, liveOutHas, boxed) {
  const keep = instrs.map(() => new Set());
  for (let i = 0; i < instrs.length; i++) {
    for (const r of rw[i].writes) {
      if (boxed && boxed.has(r)) continue;
      let reads = 0, redefined = false;
      for (let j = i + 1; j < instrs.length; j++) {
        for (const x of rw[j].reads) if (x === r) reads++;
        if (rw[j].writes.indexOf(r) >= 0) { redefined = true; break; }
        if (reads > 1) break;
      }
      if (reads !== 1) continue;
      if (!redefined && liveOutHas(r)) continue;
      keep[i].add(r);
    }
  }
  return keep;
}

function execRegBlock(instrs, ctx, pure) {
  const K = ctx.K;
  const stmts = [];
  const pend = new Map();
  let seq = 0;
  let multi = null;
  let multiAt = -1;
  let cond = null;
  const liveOut = instrs.liveOut || null;
  const rw = instrs.map(rwOf);
  const boxed = ctx.boxed || null;
  const liveOutHas = (r) => (liveOut ? liveOut.has(r) : true);
  const keep = pendingPlan(instrs, rw, liveOutHas, boxed);
  const nameOf = (r) => E.name(ctx.regName(r));
  const fail = (msg) => { throw new Error('regvm: ' + msg); };
  const bySeq = () => Array.from(pend.entries()).sort((a, b) => a[1].seq - b[1].seq);

  function spill(r) {
    const p = pend.get(r);
    if (!p) return;
    pend.delete(r);
    const nm = ctx.regName(r);
    for (const [q, x] of bySeq()) if (info(x.e).names.has(nm)) spill(q);
    stmts.push({ k: 'assign', targets: [nameOf(r)], values: [p.e] });
  }

  function flushFor(p) {
    const b = info(p.e);
    const list = bySeq();
    let cut = -1;
    for (const [, x] of list) {
      if (x.seq >= p.seq || isSafe(x.e)) continue;
      if (clash(info(x.e), b)) cut = x.seq;
    }
    if (cut < 0) return;
    for (const [q, x] of list) if (x.seq <= cut && !isSafe(x.e)) spill(q);
  }

  function emit(s) {
    if (pure) fail('side effect inside an and/or operand');
    const w = writesOf(s);
    const list = bySeq();
    let cut = -1;
    for (const [, x] of list) {
      if (isSafe(x.e)) continue;
      if (clash(info(x.e), w)) cut = x.seq;
    }
    if (cut >= 0) for (const [q, x] of list) if (x.seq <= cut && !isSafe(x.e)) spill(q);
    stmts.push(s);
  }

  function get(r) {
    const p = pend.get(r);
    if (!p) return nameOf(r);
    flushFor(p);
    pend.delete(r);
    return p.e;
  }

  function nameGet(r) {
    const p = pend.get(r);
    if (p) { flushFor(p); spill(r); }
    return nameOf(r);
  }

  function materialize(regs) {
    for (const [q] of bySeq()) if (regs.indexOf(q) >= 0) nameGet(q);
  }

  function put(i, r, e) {
    const old = pend.get(r);
    if (old) { flushFor(old); spill(r); }
    if (keep[i].has(r)) { pend.set(r, { seq: seq++, e }); return; }
    emit({ k: 'assign', targets: [nameOf(r)], values: [e] });
  }

  function putMany(regs, e) {
    materialize(regs);
    emit({ k: 'assign', targets: regs.map(nameOf), values: [e] });
  }

  const RK = (x) => (isK(x) ? kexpr(K, rkToK(x)) : get(x));
  const RKname = (x) => (isK(x) ? kexpr(K, rkToK(x)) : nameGet(x));

  function readsLater(from, r) {
    for (let j = from; j < instrs.length; j++) {
      if (rw[j].reads.indexOf(r) >= 0) return true;
      if (rw[j].writes.indexOf(r) >= 0) return false;
    }
    return liveOutHas(r);
  }

  function openFrom(base) {
    if (multi === null) fail('an open register range has no producer');
    if (multi.base < base) {
      fail('open range starts at register ' + multi.base + ', below ' + base);
    }
    const out = [];
    for (let r = base; r < multi.base; r++) out.push(get(r));
    out.push(multi.expr);
    multi = null;
    return out;
  }

  function args(base, b) {
    if (b === 0) return openFrom(base);
    const out = [];
    for (let r = base; r <= base + b - 2; r++) out.push(get(r));
    if (out.length) out[out.length - 1] = trunc(out[out.length - 1]);
    return out;
  }

  function results(i, A, C, call) {
    if (C === 0) { multi = { base: A, expr: call }; multiAt = i; return; }
    if (C === 1) { emit({ k: 'callstat', call }); return; }
    const regs = [];
    for (let r = A; r <= A + C - 2; r++) regs.push(r);
    if (regs.length === 1) put(i, regs[0], call);
    else putMany(regs, call);
  }

  function testCond(ins) {
    const { op, A, B, C } = ins;
    if (op === 22 || op === 23 || op === 24) {
      const l = RK(B), r = RK(C);
      const t = E.bin(op === 22 ? '==' : op === 23 ? '<' : '<=', l, r);
      return A !== 0 ? t : neg(t);
    }
    if (op === 25) { const v = get(A); return C !== 0 ? v : neg(v); }
    if (op === 26) { const v = get(B); return C !== 0 ? v : neg(v); }
    return fail('block ends on ' + (REGNAME[op] || op) + ', which is not a test');
  }

  for (let i = 0; i < instrs.length; i++) {
    const ins = instrs[i];
    if (multi !== null && multiAt < i - 1) {
      fail('open argument range from instruction ' + multiAt + ' was never used');
    }
    const A = ins.A, B = ins.B, C = ins.C;
    const last = i === instrs.length - 1;
    switch (ins.op) {
      case 0: case 21: case 44: break;
      case 1: put(i, A, kexpr(K, B)); break;
      case 2: for (let r = A; r <= A + B; r++) put(i, r, E.nil()); break;
      case 3: put(i, A, E.bool(B !== 0)); break;
      case 4: put(i, A, get(B)); break;
      case 5: put(i, A, ctx.globalRead(kname(K, B))); break;
      case 6:
        emit({ k: 'assign', targets: [ctx.globalRead(kname(K, B))], values: [get(A)] });
        break;
      case 7: put(i, A, E.index(get(B), RK(C))); break;
      case 8: {
        const t = get(A), k = RK(B), v = RK(C);
        emit({ k: 'assign', targets: [E.index(t, k)], values: [v] });
        break;
      }
      case 9: put(i, A, E.table([])); break;
      case 10: case 11: case 12: case 13: case 14: case 15: {
        const l = RK(B), r = RK(C);
        put(i, A, E.bin(BIN[ins.op], l, r));
        break;
      }
      case 16: {
        const l = RK(B), r = RK(C);
        put(i, A, E.call(E.index(E.name('math'), E.str('floor')), [E.bin('/', l, r)], false));
        break;
      }
      case 17: case 18: case 19: put(i, A, E.un(UN[ins.op], get(B))); break;

      case 20: {
        if (C < B) fail('CONCAT over an empty range ' + B + '..' + C);
        if (C === B) { const v = nameGet(B); put(i, A, E.bin('..', v, v)); break; }
        let e = null;
        for (let r = B; r <= C; r++) { const v = get(r); e = e === null ? v : E.bin('..', e, v); }
        put(i, A, e);
        break;
      }
      case 22: case 23: case 24: case 25: case 26:
        if (!last) fail((REGNAME[ins.op] || ins.op) + ' is not the last instruction of its block');
        cond = testCond(ins);
        break;
      case 27: {
        const f = get(A);
        results(i, A, C, E.call(f, args(A + 1, B), C === 0));
        break;
      }
      case 28: {
        const f = get(A);
        emit({ k: 'return', values: [E.call(f, args(A + 1, B), true)] });
        break;
      }
      case 29: {
        if (B === 0) { emit({ k: 'return', values: openFrom(A) }); break; }
        if (B === 1) { emit({ k: 'return', values: [] }); break; }
        const vs = [];
        for (let r = A; r <= A + B - 2; r++) vs.push(get(r));
        vs[vs.length - 1] = trunc(vs[vs.length - 1]);
        emit({ k: 'return', values: vs });
        break;
      }
      case 30:
        materialize([A, A + 2]);
        emit({ k: 'assign', targets: [nameOf(A)], values: [E.bin('-', nameOf(A), nameOf(A + 2))] });
        break;
      case 31: {
        if (!last) fail('FORLOOP is not the last instruction of its block');
        materialize([A, A + 1, A + 2]);
        emit({ k: 'assign', targets: [nameOf(A)], values: [E.bin('+', nameOf(A), nameOf(A + 2))] });
        cond = E.bin('or',
          E.bin('and', E.bin('>', nameOf(A + 2), E.num(0)), E.bin('<=', nameOf(A), nameOf(A + 1))),
          E.bin('and', E.bin('<=', nameOf(A + 2), E.num(0)), E.bin('>=', nameOf(A), nameOf(A + 1))));
        break;
      }

      case 32: {
        if (!last) fail('TFORLOOP is not the last instruction of its block');
        if (C < 1) fail('TFORLOOP asks for ' + C + ' loop variables');
        materialize([A, A + 1, A + 2]);
        const regs = [];
        for (let r = A + 3; r <= A + C + 2; r++) regs.push(r);
        materialize(regs);
        emit({ k: 'assign', targets: regs.map(nameOf),
               values: [E.call(nameOf(A), [nameOf(A + 1), nameOf(A + 2)], true)] });
        cond = E.bin('~=', nameOf(A + 3), E.nil());
        break;
      }
      case 33: {
        const t = nameGet(A);
        const base = C - 1;
        if (B === 0) {
          const vs = openFrom(A + 1);
          const open = vs.pop();
          for (let j = 0; j < vs.length; j++) {
            emit({ k: 'assign', targets: [E.index(t, E.num(base + 1 + j))], values: [vs[j]] });
          }
          const pk = ctx.fresh('t');
          emit({ k: 'local', names: [pk],
                 values: [E.call(E.index(E.name('table'), E.str('pack')), [open], false)] });
          emit({ k: 'callstat', call: E.call(E.index(E.name('table'), E.str('move')),
            [E.name(pk), E.num(1), E.index(E.name(pk), E.str('n')),
             E.num(base + 1 + vs.length), t], false) });
          break;
        }
        for (let j = 1; j <= B; j++) {
          emit({ k: 'assign', targets: [E.index(t, E.num(base + j))], values: [get(A + j)] });
        }
        break;
      }
      case 34: put(i, A, ctx.closure(B + 1)); break;
      case 35: {
        if (B === 0) { multi = { base: A, expr: E.vararg() }; multiAt = i; break; }
        if (B === 1) break;
        if (B === 2) { put(i, A, E.paren(E.vararg())); break; }
        const regs = [];
        for (let r = A; r <= A + B - 2; r++) regs.push(r);
        putMany(regs, E.vararg());
        break;
      }

      case 36: {
        const kn = isK(C) ? kexpr(K, rkToK(C)) : null;
        const nx = instrs[i + 1];

        const fuse = nx && nx.op === 27 && nx.A === A && nx.B >= 2
          && kn !== null && kn.k === 'str' && isIdent(kn.v)
          && !(boxed && (boxed.has(A) || boxed.has(A + 1)))
          && !readsLater(i + 2, A) && !readsLater(i + 2, A + 1);
        if (fuse) {
          const o = get(B);
          const as = args(A + 2, nx.B - 1);
          results(i + 1, A, nx.C, E.method(o, kn.v, as, nx.C === 0));
          i += 1;
          break;
        }
        const o = nameGet(B);
        const k = kn !== null ? kn : RKname(C);
        materialize([A, A + 1]);
        emit({ k: 'assign', targets: [nameOf(A + 1)], values: [o] });
        put(i, A, E.index(o, k));
        break;
      }
      case 37: put(i, A, E.name(ctx.upName(B))); break;
      case 38: emit({ k: 'assign', targets: [E.name(ctx.upName(B))], values: [get(A)] }); break;
      case 39: {
        if (pure) fail('CLOSEUPVAL inside an and/or operand');
        const list = [];
        if (boxed) for (const r of boxed) if (r >= A) list.push(r);
        list.sort((x, y) => x - y);
        if (!list.length) break;
        for (const r of list) if (ctx.onClose) ctx.onClose(r);

        stmts.push({ k: 'close', slots: list, names: list.map(r => ctx.regName(r)) });
        break;
      }
      case 40: {
        const f = get(A);
        const as = args(A + 1, B === 0 ? 1 : B);
        results(i, A, C, E.call(ctx.globalRead('pcall'), [f].concat(as), C === 0));
        break;
      }
      case 41: {
        const f = get(A), h = get(A + 1);
        const as = B >= 3 ? args(A + 2, B - 1) : [];
        results(i, A, C, E.call(ctx.globalRead('xpcall'), [f, h].concat(as), C === 0));
        break;
      }

      case 42:
        materialize([A, A + 1, A + 2]);
        emit({ k: 'iterprep', slots: [A, A + 1, A + 2],
               names: [ctx.regName(A), ctx.regName(A + 1), ctx.regName(A + 2)] });
        break;
      case 43: fail('LOADKX survived normalisation'); break;
      default: fail('unhandled opcode ' + ins.op + ' (' + (REGNAME[ins.op] || '?') + ')');
    }
  }

  if (multi !== null) {
    fail('open argument range from instruction ' + multiAt + ' was never used');
  }

  for (const [q] of bySeq()) nameGet(q);
  return { stmts, stack: [], cond };
}

module.exports = { execRegBlock, pendingPlan, neg, trunc, BIN, UN };
