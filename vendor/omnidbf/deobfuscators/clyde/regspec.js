'use strict';

const RK_OFFSET = 256;

const REGOP = {
  NOP: 0, LOADK: 1, LOADNIL: 2, LOADBOOL: 3, MOVE: 4, GETGLOBAL: 5, SETGLOBAL: 6,
  GETTABLE: 7, SETTABLE: 8, NEWTABLE: 9, ADD: 10, SUB: 11, MUL: 12, DIV: 13,
  MOD: 14, POW: 15, IDIV: 16, UNM: 17, NOT: 18, LEN: 19, CONCAT: 20, JMP: 21,
  EQ: 22, LT: 23, LE: 24, TEST: 25, TESTSET: 26, CALL: 27, TAILCALL: 28,
  RETURN: 29, FORPREP: 30, FORLOOP: 31, TFORLOOP: 32, SETLIST: 33, CLOSURE: 34,
  VARARG: 35, SELF: 36, GETUPVAL: 37, SETUPVAL: 38, CLOSEUPVAL: 39, PCALL: 40,
  XPCALL: 41, ITERPREP: 42, LOADKX: 43, EXTRAARG: 44,
  FUSED_TEST_JMP: 45, FUSED_EQ_JMP: 46, FUSED_LT_JMP: 47, FUSED_LE_JMP: 48,
  FUSED_TESTSET_JMP: 49, FUSED_GGET: 50, FUSED_LOADKK: 51, FUSED_MOVE_MOVE: 52,
  FUSED_SELF_CALL: 53, FUSED_GGET_CALL: 54, FUSED_LOADK_RET: 55,
  FUSED_MOVE_RET: 56,
};

const REGNAME = [];
for (const k of Object.keys(REGOP)) REGNAME[REGOP[k]] = k;

const REG_OPCODE_COUNT = 57;
const BASE_OP_COUNT = 45;

function isK(x) { return x >= RK_OFFSET; }
function rkToK(x) { return x - RK_OFFSET; }

function expandFused(code) {
  const out = [];
  const push = (op, A, B, C) => { out.push(op, A, B, C); };
  let i = 0;
  while (i + 3 < code.length) {
    const op = code[i], A = code[i + 1], B = code[i + 2], C = code[i + 3];
    switch (op) {

      case 45: push(25, A, 0, C); push(21, 0, code[i + 6], 0); i += 8; break;
      case 46: push(22, A, B, C); push(21, 0, code[i + 6], 0); i += 8; break;
      case 47: push(23, A, B, C); push(21, 0, code[i + 6], 0); i += 8; break;
      case 48: push(24, A, B, C); push(21, 0, code[i + 6], 0); i += 8; break;
      case 49: push(26, A, B, C); push(21, 0, code[i + 6], 0); i += 8; break;
      case 50: push(5, A, B, 0); push(7, code[i + 5], A, code[i + 7]); i += 8; break;
      case 51: push(1, A, B, 0); push(1, code[i + 5], code[i + 6], 0); i += 8; break;
      case 52: push(4, A, B, 0); push(4, code[i + 5], code[i + 6], 0); i += 8; break;
      case 53: push(36, A, B, C); push(27, A, code[i + 6], code[i + 7]); i += 8; break;
      case 54:
        push(5, A, B, 0);
        push(7, code[i + 5], A, code[i + 7]);
        push(27, code[i + 9], code[i + 10], code[i + 11]);
        i += 12; break;

      case 55: push(1, A, B, 0); push(29, A, 2, 0); i += 8; break;

      case 56: push(4, A, B, 0); push(29, code[i + 5], code[i + 6], 0); i += 8; break;
      default: push(op, A, B, C); i += 4; break;
    }
  }
  if (i !== code.length) {
    throw new Error('regvm: code length ' + code.length + ' is not a whole number of instructions');
  }
  return out;
}

module.exports = { RK_OFFSET, REGOP, REGNAME, REG_OPCODE_COUNT, BASE_OP_COUNT, isK, rkToK, expandFused };

function decodeReg(code) {
  if (code.length % 4 !== 0) {
    throw new Error('regvm: code length ' + code.length + ' is not a multiple of 4');
  }
  const instrs = [];
  for (let i = 0; i < code.length; i += 4) {
    const op = code[i];
    if (!Number.isFinite(op) || op < 0 || op >= BASE_OP_COUNT) {
      throw new Error('regvm: opcode ' + op + ' at instruction ' + (i / 4) + ' is not a base opcode');
    }
    instrs.push({ pc: i / 4, op, A: code[i + 1] | 0, B: code[i + 2] | 0, C: code[i + 3] | 0 });
  }
  return instrs;
}

function normalizeLoadKX(instrs) {
  for (let i = 0; i < instrs.length; i++) {
    if (instrs[i].op !== REGOP.LOADKX) continue;
    const nxt = instrs[i + 1];
    if (!nxt || nxt.op !== REGOP.EXTRAARG) {
      throw new Error('regvm: LOADKX at ' + i + ' is not followed by EXTRAARG');
    }
    instrs[i] = { pc: i, op: REGOP.LOADK, A: instrs[i].A, B: nxt.A, C: 0 };
    instrs[i + 1] = { pc: i + 1, op: REGOP.NOP, A: 0, B: 0, C: 0 };
    i++;
  }
  return instrs;
}

function callArgRange(A, B) { return B === 0 ? null : [A + 1, A + B - 1]; }
function callResRange(A, C) { return C === 0 ? null : [A, A + C - 2]; }

module.exports.decodeReg = decodeReg;
module.exports.normalizeLoadKX = normalizeLoadKX;
module.exports.callArgRange = callArgRange;
module.exports.callResRange = callResRange;

function rwOf(ins) {
  const { op, A, B, C } = ins;
  const reads = [], writes = [];
  const R = (x) => reads.push(x);
  const RK = (x) => { if (!isK(x)) reads.push(x); };
  const range = (lo, hi, into) => { for (let r = lo; r <= hi; r++) into.push(r); };
  switch (op) {
    case 0: case 21: case 39: case 44: break;
    case 1: case 3: case 5: case 9: case 34: case 37: writes.push(A); break;
    case 2: range(A, A + B, writes); break;
    case 4: R(B); writes.push(A); break;
    case 6: case 38: R(A); break;
    case 7: R(B); RK(C); writes.push(A); break;
    case 8: R(A); RK(B); RK(C); break;
    case 10: case 11: case 12: case 13: case 14: case 15: case 16:
      RK(B); RK(C); writes.push(A); break;
    case 17: case 18: case 19: R(B); writes.push(A); break;
    case 20: range(B, C, reads); writes.push(A); break;
    case 22: case 23: case 24: RK(B); RK(C); break;
    case 25: R(A); break;
    case 26: R(B); break;
    case 27: case 40: {
      R(A);
      const ar = callArgRange(A, B); if (ar) range(ar[0], ar[1], reads);
      const rr = callResRange(A, C); if (rr) range(rr[0], rr[1], writes);
      break;
    }
    case 41: {
      R(A); R(A + 1);
      if (B > 3) range(A + 2, B - 1 + A, reads);
      else if (B === 3) R(A + 2);
      const rr = callResRange(A, C); if (rr) range(rr[0], rr[1], writes);
      break;
    }
    case 28: {
      R(A);
      const ar = callArgRange(A, B); if (ar) range(ar[0], ar[1], reads);
      break;
    }
    case 29: if (B > 1) range(A, A + B - 2, reads); else if (B === 0) R(A); break;
    case 30: R(A); R(A + 2); writes.push(A); break;
    case 31: R(A); R(A + 1); R(A + 2); writes.push(A); break;
    case 32: R(A); R(A + 1); R(A + 2); range(A + 3, A + C + 2, writes); break;
    case 33: R(A); if (B > 0) range(A + 1, A + B, reads); break;
    case 35: if (B > 1) range(A, A + B - 2, writes); break;
    case 36: R(B); RK(C); writes.push(A); writes.push(A + 1); break;
    case 42: R(A); R(A + 1); R(A + 2); break;
    case 43: writes.push(A); break;
    default: throw new Error('regvm: no read/write set for opcode ' + op);
  }
  return { reads, writes };
}

module.exports.rwOf = rwOf;

function edgesOf(ins, n) {
  const { pc, op, A, B, C } = ins;
  switch (op) {
    case 21: return { kind: 'jmp', succs: [pc + 1 + B] };
    case 30: return { kind: 'jmp', succs: [pc + 1 + B] };

    case 3: return C !== 0 ? { kind: 'jmp', succs: [pc + 2] } : null;
    case 28: case 29: return { kind: 'ret', succs: [] };
    case 22: case 23: case 24: case 25: return { kind: 'cond', succs: [pc + 1, pc + 2] };
    case 26: return { kind: 'cond', succs: [pc + 1, pc + 2], condThen: [{ op: 4, A, B, C: 0 }] };
    case 31: return { kind: 'cond', succs: [pc + 1 + B, pc + 1], condThen: [{ op: 4, A: A + 3, B: A, C: 0 }] };
    case 32: return { kind: 'cond', succs: [pc + 2, pc + 1], condThen: [{ op: 4, A: A + 2, B: A + 3, C: 0 }] };
    default: return null;
  }
}

function recomputePreds(blocks) {
  for (const b of blocks) if (b) b.preds = [];
  for (const b of blocks) {
    if (!b) continue;
    for (const s of b.succs) if (blocks[s]) blocks[s].preds.push(b.id);
  }
}

function buildRegCFG(instrs) {
  const n = instrs.length;
  const leaders = new Set([0]);
  const edges = new Array(n).fill(null);
  for (const ins of instrs) {
    const e = edgesOf(ins, n);
    if (!e) continue;
    edges[ins.pc] = e;
    for (const t of e.succs) leaders.add(t);
    if (ins.pc + 1 < n) leaders.add(ins.pc + 1);
  }
  const starts = [...leaders].filter(x => x >= 0 && x < n).sort((a, b) => a - b);
  const blockAt = new Array(n).fill(-1);
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : n;
    for (let k = s; k < e; k++) blockAt[k] = i;
    blocks.push({ id: i, instrs: instrs.slice(s, e), succs: [], preds: [], kind: 'fall' });
  }
  const at = (pc) => {
    if (pc < 0 || pc >= n) throw new Error('regvm: branch to instruction ' + pc + ' outside 0..' + (n - 1));
    return blockAt[pc];
  };
  for (const b of blocks) {
    const last = b.instrs[b.instrs.length - 1];
    const e = edges[last.pc];
    if (e) {
      b.kind = e.kind;
      b.succs = e.succs.map(at);
      if (e.condThen) b.condThen = e.condThen;
    } else if (last.pc + 1 < n) {
      b.kind = 'fall';
      b.succs = [at(last.pc + 1)];
    } else {
      b.kind = 'ret';
      b.succs = [];
    }
  }
  for (let i = 0, m = blocks.length; i < m; i++) {
    const b = blocks[i];
    if (!b.condThen) continue;
    const syn = {
      id: blocks.length, kind: 'fall', synthetic: true, preds: [],
      succs: [b.succs[0]],
      instrs: b.condThen.map((x, k) => Object.assign({ pc: -1 - k }, x)),
    };
    blocks.push(syn);
    b.succs[0] = syn.id;
    delete b.condThen;
  }
  recomputePreds(blocks);
  return blocks;
}

module.exports.edgesOf = edgesOf;
module.exports.recomputePreds = recomputePreds;
module.exports.buildRegCFG = buildRegCFG;

function coalesceReg(blocks) {
  for (let guard = 0; guard < 65536; guard++) {
    let changed = false;
    for (const b of blocks) {
      if (!b || (b.kind !== 'fall' && b.kind !== 'jmp') || b.succs.length !== 1) continue;
      const y = blocks[b.succs[0]];
      if (!y || y.id === b.id || y.preds.length !== 1 || y.preds[0] !== b.id) continue;
      let mine = b.instrs;

      if (mine.length && mine[mine.length - 1].op === REGOP.JMP) mine = mine.slice(0, -1);
      b.instrs = mine.concat(y.instrs);
      b.succs = y.succs.slice();
      b.kind = y.kind;
      blocks[y.id] = null;
      recomputePreds(blocks);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return blocks;
}

function liveness(blocks) {
  const live = blocks.filter(Boolean);
  const idx = new Map();
  live.forEach((b, i) => idx.set(b.id, i));
  const use = [], def = [];
  for (const b of live) {
    const u = new Set(), d = new Set();
    for (const ins of b.instrs) {
      const rw = rwOf(ins);
      for (const r of rw.reads) if (!d.has(r)) u.add(r);
      for (const r of rw.writes) d.add(r);
    }
    use.push(u); def.push(d);
  }
  const liveIn = live.map(() => new Set());
  const outOf = (i) => {
    const o = new Set();
    for (const s of live[i].succs) {
      const j = idx.get(s);
      if (j === undefined) continue;
      for (const r of liveIn[j]) o.add(r);
    }
    return o;
  };
  for (let guard = 0; guard < 4096; guard++) {
    let changed = false;
    for (let i = live.length - 1; i >= 0; i--) {
      const nin = new Set(use[i]);
      for (const r of outOf(i)) if (!def[i].has(r)) nin.add(r);
      if (nin.size === liveIn[i].size) {
        let same = true;
        for (const r of nin) if (!liveIn[i].has(r)) { same = false; break; }
        if (same) continue;
      }
      liveIn[i] = nin;
      changed = true;
    }
    if (!changed) break;
  }
  for (let i = 0; i < live.length; i++) live[i].instrs.liveOut = outOf(i);
  return blocks;
}

module.exports.coalesceReg = coalesceReg;
module.exports.liveness = liveness;
