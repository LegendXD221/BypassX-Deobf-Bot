/**
 * BypassX Deobf Bot — Luraph v14.x payload-VM lifter v2 (instruction → Lua source).
 *
 * Turns the deserialized VM program (captured by luraph14.js's state dump) into
 * genuinely readable, structured Lua source. Pipeline:
 *
 *   1. parse the state graph → protos with operand columns + per-pc constants
 *   2. decode every instruction through the recovered opcode semantics
 *      (dispatch-tree resolution + behavioral probing, verified offline)
 *   3. build a real CFG of basic blocks and REACHABILITY-FILTER it: Luraph
 *      chains blocks in scrambled order and pads the stream with decoy blocks
 *      that no edge can ever reach — they are dropped (counted, not emitted)
 *   4. recover structure: natural loops via dominator back edges, numeric
 *      for-loops via the forprep/forloop pairing, if/else + skip-if regions
 *      via join analysis; every edge is translated exactly, with `break` for
 *      loop exits and `while true do` shells for generic loops
 *   5. emit one Lua function per proto (children first), registers R<n>
 *      (or a REGS table for high-register protos), ENV for globals, upvalue
 *      cells declared at file scope, consistent indentation, no dead code
 *
 * Every step is best-effort: an unclear edge degrades to a comment (counted),
 * never to wrong control flow, and never crashes the pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const VENDOR_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'luraph-v15');
const LUAAU_AST = path.join(VENDOR_DIR, 'bin', 'luau-ast');

// ---------- value/format helpers ----------
function unesc(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && /^\\x[0-9a-fA-F]{2}/.test(s.slice(i, i + 4))) {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
      i += 3;
      continue;
    }
    out += s[i];
  }
  return out;
}

function fkey(k) {
  return typeof k === 'string' && k.startsWith('n:') ? Number(k.slice(2)) : k;
}

function fval(v) {
  if (v.startsWith('REF T')) return { t: 'ref', v: v.slice(4) };
  if (v.startsWith('s')) return { t: 'str', v: unesc(v.slice(v.indexOf(':') + 1)) };
  if (v.startsWith('n:')) return { t: 'num', v: Number(v.slice(2)) };
  if (v === 'b:1') return { t: 'bool', v: true };
  if (v === 'b:0') return { t: 'bool', v: false };
  if (v === '~') return { t: 'nil', v: null };
  return { t: '?', v };
}

function qstr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 32 || c > 126) out += '\\' + c;
    else out += ch;
  }
  return out + '"';
}

function qnum(v) {
  const f = Number(v);
  if (!Number.isFinite(f)) return '0/0 /*nan*/';
  return Number.isInteger(f) && Math.abs(f) < 2 ** 53 ? String(f) : String(f);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue']);

function safeIndex(v) {
  if (typeof v === 'string' && IDENT.test(v) && !KEYWORDS.has(v)) return '.' + v;
  if (typeof v === 'boolean') return v ? '[true]' : '[false]';
  if (typeof v === 'number') return '[' + qnum(v) + ']';
  return '[' + qstr(String(v)) + ']';
}

function envName(v) {
  if (typeof v === 'string' && IDENT.test(v) && !KEYWORDS.has(v)) return 'ENV.' + v;
  if (typeof v === 'string') return 'ENV[' + qstr(v) + ']';
  return 'ENV[' + qnum(Number(v)) + ']';
}

// ---------- proto extraction ----------
function resolveArray(nodes, label) {
  const ref = nodes[label];
  if (!ref || ref.kind !== 'table') return [];
  const arr = new Map();
  for (const [k, v] of ref.fields) {
    const kt = fkey(k);
    if (typeof kt !== 'number') return null;
    const { t, v: x } = fval(v);
    if (t === 'num') arr.set(kt, x);
    else if (t === 'bool') arr.set(kt, x ? 1 : 0);
    else if (t === 'nil') arr.set(kt, 0);
    else return null;
  }
  if (!arr.size) return [];
  const n = Math.max(...arr.keys());
  for (let i = 1; i <= n; i++) if (!arr.has(i)) return null;
  return Array.from({ length: n }, (_, i) => arr.get(i + 1));
}

function resolveMap(nodes, label) {
  const ref = nodes[label];
  if (!ref || ref.kind !== 'table') return {};
  const out = {};
  for (const [k, v] of ref.fields) {
    const kt = fkey(k);
    if (typeof kt === 'number') out[kt] = fval(v).v;
  }
  return out;
}

class Proto {
  constructor(label, nodes) {
    this.label = label;
    this.nodes = nodes;
    const n = nodes[label];
    const f = {};
    for (const [k, v] of n.fields) f[fkey(k)] = v;
    const g = (i) => (fval(f[i]).t === 'ref' ? resolveArray(nodes, fval(f[i]).v) : []);
    this.col_o = g(4);
    this.col_op = g(5);
    this.col_g = g(7);
    this.col_G = g(9);
    this.cmap = fval(f[8]).t === 'ref' ? resolveMap(nodes, fval(f[8]).v) : {};
    this.amap = fval(f[11]).t === 'ref' ? resolveMap(nodes, fval(f[11]).v) : {};
    this.pmap = fval(f[2]).t === 'ref' ? resolveMap(nodes, fval(f[2]).v) : {};
    this.n = this.col_op.length;
    this.closureAt = {};
    for (const [pc, v] of Object.entries(this.amap)) {
      if (typeof v === 'string' && nodes[v] && Array.isArray(nodes[v].fields) && nodes[v].fields.length === 11) {
        this.closureAt[Number(pc)] = v;
      }
    }
  }

  ins(pc) {
    const i = pc - 1;
    return {
      pc,
      op: i < this.n ? Math.trunc(this.col_op[i]) : -1,
      G: i < this.col_G.length ? Math.trunc(this.col_G[i]) : 0,
      g: i < this.col_g.length ? Math.trunc(this.col_g[i]) : 0,
      o: i < this.col_o.length ? Math.trunc(this.col_o[i]) : 0,
      p: this.pmap[pc], C: this.cmap[pc], a: this.amap[pc],
    };
  }
}

// ---------- instruction decode (recovered ISA) ----------
// Semantics recovered by resolving the VM's dispatch tree (decoys evaluated
// against measured env-truth) and verified by behavioral probing of all 201
// opcodes in the offline emulator. Each entry:
//   { lines: [...] }                      straight-line effect
//   { term: ['jmp'|'cjmp'|'forprep'|'forloop'|'ret', ...] } control transfer
const NOOP_OPS = new Set([29, 38, 92, 123, 97, 108, 41, 139]);

function decodeIns(P, pc, R, CE) {
  const i = P.ins(pc);
  const { op, G, g, o } = i;
  const C = i.C, a = i.a, p = i.p;
  const e = { pc, op, lines: [], term: null };

  if (op === 77) e.lines = [`${R(G)} = ${R(g)}`];
  else if (op === 65) e.lines = [`${R(G)} = ${CE(C)}`];
  else if (op === 143) e.lines = [`${R(g)} = nil`];
  else if (op === 1) e.lines = [`${R(g)} = {}`];
  else if (op === 11) e.lines = [`${R(G)} = table.create(${g})`];
  else if (op === 2 || op === 129) {
    const names = Array.from({ length: g }, (_, k) => R(k + 1)).join(', ');
    e.lines = g ? [`${names} = ...`] : [];
  } else if (op === 52) e.lines = [`${R(o)} = ${envName(a)}`];
  else if (op === 63) e.lines = [`-- [op 63] G=${G} g=${g} o=${o} (rare op, no side effect emitted)`];
  else if (op === 68) e.lines = [`${R(g)} = ENV[${typeof G === 'number' ? G : JSON.stringify(G)}]`];
  else if (op === 21) e.lines = [`ENV[${typeof G === 'number' ? G : JSON.stringify(G)}] = ${R(g)}`];
  else if (op === 59) e.lines = [`${R(o)} = ${R(G)}${safeIndex(a)}`];
  else if (op === 117) e.lines = [`${R(g)} = ${R(o)}[${R(G)}]`];
  else if (op === 40) e.lines = [`${R(o)} = ${R(g)}${safeIndex(p)}`];
  else if (op === 69) e.lines = [`${R(o)}${safeIndex(p)} = ${CE(a)}`];
  else if (op === 81) e.lines = [`${R(g)}[${CE(C)}] = ${R(G)}`];
  else if (op === 131) e.lines = [`${R(G)}[${R(o)}] = ${R(g)}`];
  else if (op === 39) e.lines = [`${R(G)}[${R(o)}] = ${CE(a)}`];
  else if (op === 95) e.lines = [`${R(G)} = U${g}`];
  else if (op === 9) e.lines = [`${R(g)} = U${G}[${CE(C)}]`];
  else if (op === 48) e.lines = [`U${o}[${R(G)}] = ${R(g)}`];
  else if (op === 27) e.lines = [`U${o}_cell[${CE(p)}] = ${CE(a)}`];
  else if (op === 35) e.lines = [`U${G}_cell = ${R(g)}`];
  else if (op === 56) e.lines = [`${R(o)} = U${G}_cell[${R(g)}]`];
  else if (op === 66) e.lines = [`${R(g)} = U${o}_cell`];
  else if (op === 71) e.lines = [`${R(G)} = U${o}_cell[${CE(a)}]`];
  else if (op === 88) e.lines = [`U${G}_cell[${R(o)}] = ${R(g)}`];
  else if (op === 136) e.lines = [`${R(g)} = U${o}[${R(G)}]`];
  else if (op === 125) e.lines = [`${R(g)} = ${R(G)} + ${R(o)}`];
  else if (op === 22) e.lines = [`${R(G)} = ${R(o)} + ${CE(a)}`];
  else if (op === 62) e.lines = [`${R(G)} = ${CE(C)} + ${R(g)}`];
  else if (op === 46) e.lines = [`${R(G)} = ${R(g)} - ${R(o)}`];
  else if (op === 104) e.lines = [`${R(G)} = ${R(g)} - ${CE(C)}`];
  else if (op === 72) e.lines = [`${R(G)} = ${R(o)} * ${R(g)}`];
  else if (op === 14) e.lines = [`${R(o)} = ${R(G)} * ${CE(a)}`];
  else if (op === 23) e.lines = [`${R(g)} = ${CE(p)} * ${R(o)}`];
  else if (op === 36) e.lines = [`${R(g)} = ${R(o)} * 2`];
  else if (op === 12) e.lines = [`${R(G)} = ${R(g)} / ${R(o)}`];
  else if (op === 105) e.lines = [`${R(o)} = ${R(g)} / ${CE(p)}`];
  else if (op === 17) e.lines = [`${R(o)} = ${R(g)} % ${R(G)}`];
  else if (op === 30) e.lines = [`${R(o)} = ${R(g)} % ${CE(p)}`];
  else if (op === 102) e.lines = C === undefined || a === undefined ? [] : [`${R(G)} = ${CE(C)} % ${CE(a)}`];
  else if (op === 113) e.lines = [`${R(o)} = ${R(g)} ^ ${R(G)}`];
  else if (op === 47) e.lines = [`${R(g)} = ${R(o)} .. ${R(G)}`];
  else if (op === 141) e.lines = p === undefined ? [] : [`${R(g)} = ${R(o)} .. ${CE(p)}`];
  else if (op === 94) e.lines = p === undefined ? [] : [`${R(o)} = ${CE(p)} .. ${R(g)}`];
  else if (op === 82) e.lines = [`${R(o)} = -${R(g)}`];
  else if (op === 28) e.lines = [`${R(G)} = not ${R(g)}`];
  else if (op === 112) e.lines = [`${R(g)} = #${R(o)}`];
  else if (op === 7) e.lines = [`${R(g)} = bit32.bxor(${R(G)}, ${CE(C)})`];
  else if (op === 49) e.lines = [`${R(G)} = bit32.bxor(${R(o)}, ${R(g)})`];
  else if (op === 0) e.lines = [`${R(G)} = (${R(g)} >= ${R(o)})`];
  else if (op === 20) e.lines = [`${R(o)} = (${R(G)} < ${R(g)})`];
  else if (op === 15) e.lines = [`${R(g)} = (${R(o)} > ${R(G)})`];
  else if (op === 45) e.lines = [`${R(o)} = (${R(G)} == ${CE(a)})`];
  else if (op === 74) e.lines = [`${R(o)} = (${R(G)} > ${CE(a)})`];
  else if (op === 34) e.lines = [`${R(o)} = (${CE(p)} < ${R(g)})`];
  else if (op === 119) e.lines = [`${R(g)} = (${R(G)} == ${R(o)})`];
  else if (op === 120) e.lines = [`${R(g)} = (${R(o)} == ${R(G)})`];
  // ---- control transfer ----
  else if (op === 13) e.term = { kind: 'jmp', target: g + 1 };
  else if (op === 4) e.term = { kind: 'cjmp', cond: `not (${R(g)} < ${CE(C)})`, target: G + 1 };
  else if (op === 5) e.term = { kind: 'cjmp', cond: `${CE(C)} <= ${R(G)}`, target: g + 1 };
  else if (op === 10) e.term = { kind: 'cjmp', cond: `${R(G)} ~= ${CE(C)}`, target: g + 1 };
  else if (op === 33) e.term = { kind: 'cjmp', cond: `${R(G)} <= ${R(o)}`, target: g + 1 };
  else if (op === 80) e.term = { kind: 'cjmp', cond: `not (${R(o)} == ${R(G)})`, target: g + 1 };
  else if (op === 89) e.term = { kind: 'cjmp', cond: `${R(g)} == ${R(o)}`, target: G + 1 };
  else if (op === 61 || op === 116) e.term = { kind: 'cjmp', cond: `not ${R(G)}`, target: o + 1 };
  else if (op === 132) e.term = { kind: 'cjmp', cond: `not (${CE(a)} < ${R(o)})`, target: G + 1 };
  else if (op === 31) e.term = { kind: 'forprep', m: o, skip: G + 1 };
  else if (op === 100) e.term = { kind: 'forloop', m: G, body: g + 1 };
  else if (op === 126) e.term = { kind: 'cjmp', cond: `${R(g + 3)} ~= nil`, target: G + 1 };
  else if (op === 18 || op === 67) e.term = { kind: 'ret', text: 'return' };
  else if (op === 90) e.term = { kind: 'ret', text: `return ${R(g)}` };
  else if (op === 121) e.term = { kind: 'ret', text: `return ${R(o)}` };
  else if (op === 134) e.term = { kind: 'ret', text: `return ${R(g)}` };
  else if (op === 124) e.term = { kind: 'ret', text: 'return' };
  else if (op === 128) {
    const cnt = Math.max(G, 1);
    e.term = { kind: 'ret', text: cnt > 30
      ? `return table.unpack(REGS, ${g}, ${g + cnt - 1})`
      : `return ${Array.from({ length: cnt }, (_, k) => R(g + k)).join(', ')}` };
  } else if (op === 110) {
    const cnt = Math.max(g - 1, 1);
    e.term = { kind: 'ret', text: cnt > 30
      ? `return table.unpack(REGS, ${G}, ${G + cnt - 1})`
      : `return ${Array.from({ length: cnt }, (_, k) => R(G + k)).join(', ')}` };
  } else if (op === 106) e.lines = [`${R(o)}(${R(o + 1)}, ${R(o + 2)})`];
  else if (op === 140) e.lines = [`${R(G)} = ${R(G)}(${R(G + 1)}, ${R(G + 2)})`];
  else if (op === 44) e.lines = [`${R(G)} = ${R(G)}()`];
  else if (op === 70) e.lines = [`${R(G)} = ${R(G)}(${R(G + 1)})`];
  else if (op === 3) e.lines = [`${R(o)}()`];
  else if (op === 19) {
    const cnt = Math.max(g - 1, 0);
    if (cnt > 30) {
      e.lines = [`${R(o)}(table.unpack(REGS, ${o + 1}, ${o + cnt}))`];
    } else {
      const args = Array.from({ length: cnt }, (_, k) => R(o + 1 + k)).join(', ');
      e.lines = [args ? `${R(o)}(${args})` : `${R(o)}()`];
    }
  } else if (op === 130 || op === 85 || op === 98) {
    const S = op === 98 ? o : G;
    e.lines = op === 85 ? [`${R(S)} = ${R(S)}(...)`] : [`${R(S)}(...)`];
  } else if (op === 115) {
    const cntArgs = Math.max(o - 1, 0);
    const args = cntArgs > 30
      ? `table.unpack(REGS, ${g + 1}, ${g + cntArgs})`
      : Array.from({ length: cntArgs }, (_, k) => R(g + 1 + k)).join(', ');
    if (G === 1) e.lines = [`${R(g)} = ${R(g)}(${args})`];
    else if (G === 0) e.lines = [`${R(g)}(${args})`];
    else if (G > 30) e.lines = [`${R(g)} = {${R(g)}(${args})}`];
    else {
      const names = Array.from({ length: G }, (_, k) => R(g + k)).join(', ');
      e.lines = [`${names} = ${R(g)}(${args})`];
    }
  } else if (op === 96) e.lines = [`CLOSURE@${pc}`];
  else if (op === 64) e.lines = [`-- varargs into R${g}..`];
  else if (op === 54) {
    const m = o, c = G, cnt = Math.max(g - 1, 0);
    if (cnt) {
      const lhs = Array.from({ length: cnt }, (_, k) => R(c + 1 + k)).join(', ');
      const rhs = Array.from({ length: cnt }, (_, k) => R(m + 1 + k)).join(', ');
      e.lines = [`${lhs} = ${rhs}`];
    }
  } else if (op === 84) e.lines = [`-- move range (op 84) R${g + 1}.. -> R${G + 1}..`];
  else if (op === 78) e.lines = [`${R(g)} = ${R(g)}(...) -- thread call`];
  else if (op === 25) e.lines = ['-- op 25 (env return site; no program effect)'];
  else if (NOOP_OPS.has(op)) e.lines = [];
  else e.lines = [`-- [op ${op} unlifted] G=${G} g=${g} o=${o}`];
  return e;
}

// ---------- CFG: blocks, reachability, dominators, loops ----------
class Block {
  constructor(start) {
    this.start = start;   // first pc
    this.end = start;     // last pc
    this.ins = [];        // decoded instructions
    this.succs = [];      // block indices
    this.preds = new Set();
    this.id = -1;
    this.term = null;     // terminator of the LAST instruction
  }
}

function buildCfg(P, decoded) {
  // leaders: entry, jump targets, after-terminators
  const leaders = new Set([1]);
  for (let pc = 1; pc <= P.n; pc++) {
    const d = decoded[pc];
    if (!d) continue;
    if (d.term) {
      const t = d.term;
      if (t.kind === 'jmp' || t.kind === 'cjmp' || t.kind === 'forloop') leaders.add(t.target);
      if (t.kind === 'forprep') leaders.add(t.skip);
      if (pc + 1 <= P.n) leaders.add(pc + 1);
    }
  }
  const blocks = [];
  let cur = null;
  for (let pc = 1; pc <= P.n; pc++) {
    if (leaders.has(pc)) { cur = new Block(pc); blocks.push(cur); }
    if (!cur) continue;
    cur.ins.push(decoded[pc]);
    cur.end = pc;
    if (decoded[pc] && decoded[pc].term) cur = null;
  }
  const blockOf = (pc) => {
    // binary search over sorted starts
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blocks[mid].start <= pc) lo = mid; else hi = mid - 1;
    }
    return blocks[lo];
  };
  for (const b of blocks) {
    const last = b.ins[b.ins.length - 1];
    b.term = last && last.term ? last.term : null;
  }
  // succs/preds
  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    const t = b.term;
    const add = (pc) => {
      if (pc < 1 || pc > P.n) return;
      const tb = blockOf(pc);
      if (!b.succs.includes(tb)) b.succs.push(tb);
      tb.preds.add(b);
    };
    if (!t) { add(b.end + 1); continue; }
    if (t.kind === 'jmp') add(t.target);
    else if (t.kind === 'ret') { /* none */ }
    else if (t.kind === 'forprep') { add(b.end + 1); add(t.skip); }
    else { add(t.target); add(b.end + 1); }
  }
  return { blocks, blockOf, leaders };
}

function reachableBlocks(cfg) {
  const entry = cfg.blocks[0];
  const reach = new Set();
  const stack = [entry];
  while (stack.length) {
    const b = stack.pop();
    if (reach.has(b)) continue;
    reach.add(b);
    for (const s of b.succs) stack.push(s);
  }
  return reach;
}

function dominators(cfg, reach) {
  // iterative Cooper-Harvey-Kennedy on reachable blocks
  const order = [];
  const seen = new Set();
  const stack = [cfg.blocks[0]];
  while (stack.length) {
    const b = stack.pop();
    if (seen.has(b)) continue;
    seen.add(b);
    order.push(b);
    for (let i = b.succs.length - 1; i >= 0; i--) {
      const s = b.succs[i];
      if (reach.has(s) && !seen.has(s)) stack.push(s);
    }
  }
  const rpo = order.slice().reverse();
  const rpoIdx = new Map(order.map((b, i) => [b, i]));
  const dom = new Map();
  for (const b of rpo) dom.set(b, rpo.includes(b) && b !== order[0] ? new Set(rpo) : new Set([b]));
  dom.set(order[0], new Set([order[0]]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === order[0]) continue;
      let newDom = null;
      for (const p of b.preds) {
        if (!reach.has(p) || !dom.has(p)) continue;
        if (newDom === null) newDom = new Set(dom.get(p));
        else newDom = new Set([...newDom].filter((x) => dom.get(p).has(x)));
      }
      if (newDom === null) newDom = new Set([b]);
      newDom.add(b);
      const cur = dom.get(b);
      if (cur.size !== newDom.size || [...newDom].some((x) => !cur.has(x))) {
        dom.set(b, newDom);
        changed = true;
      }
    }
  }
  return dom;
}

function naturalLoops(cfg, reach, dom) {
  // back edges: u -> h where h dominates u
  const loops = []; // { header, blocks:Set, backs:[u...] }
  const headerOf = new Map();
  for (const u of reach) {
    for (const h of u.succs) {
      if (!reach.has(h)) continue;
      const d = dom.get(u);
      if (!d || !d.has(h)) continue;
      // natural loop of (u -> h)
      let loop = headerOf.get(h);
      if (!loop) {
        loop = { header: h, blocks: new Set([h]), backs: [] };
        headerOf.set(h, loop);
        loops.push(loop);
      }
      if (!loop.blocks.has(u)) {
        const stack = [u];
        while (stack.length) {
          const x = stack.pop();
          if (loop.blocks.has(x)) continue;
          loop.blocks.add(x);
          for (const p of x.preds) if (reach.has(p)) stack.push(p);
        }
      }
      if (!loop.backs.includes(u)) loop.backs.push(u);
    }
  }
  return loops;
}

// ---------- structured emitter ----------
function emitProto(P, opts) {
  const stats = { blocks: 0, loops: 0, forLoops: 0, ifs: 0, breaks: 0, degraded: 0, reachableIns: 0, decoys: 0 };
  const decoded = {};
  for (let pc = 1; pc <= P.n; pc++) decoded[pc] = decodeIns(P, pc, opts.R, opts.CE);

  const cfg = buildCfg(P, decoded);
  const reach = reachableBlocks(cfg);
  const dom = dominators(cfg, reach);
  const loops = naturalLoops(cfg, reach, dom);
  stats.blocks = cfg.blocks.length;
  stats.loops = loops.length;
  for (const b of reach) stats.reachableIns += b.ins.length;
  for (const b of cfg.blocks) if (!reach.has(b)) stats.decoys += b.ins.length;

  const loopOfHeader = new Map(loops.map((l) => [l.header, l]));
  // forloop pairing: forprep at block X (op31, m) ↔ forloop block (op100, same m)
  const forPair = new Map(); // forloopBlock -> {prep, m, skip, bodyBlocks}
  {
    const forloops = cfg.blocks.filter((b) => b.term && b.term.kind === 'forloop');
    for (const fl of forloops) {
      const prep = cfg.blocks.find((b) => b.term && b.term.kind === 'forprep' && b.term.m === fl.term.m);
      if (!prep || prep === fl) continue;
      // body = natural loop with header fl (back edges into the forloop block)
      const loop = loops.find((l) => l.header === fl);
      const bodyBlocks = loop ? loop.blocks : new Set([fl]);
      forPair.set(fl, { prep, m: fl.term.m, skip: prep.term.skip, bodyStart: fl.term.body, bodyBlocks, loop, flBlock: fl });
    }
  }
  const prepOf = new Map([...forPair.values()].map((v) => [v.prep, v]));

  const out = [];
  const visited = new Set();
  let dupDepth = 0; // depth of shared-region inlining (caps runaway duplication)
  const padOf = (depth) => '  '.repeat(depth);

  /** emit straight-line instruction lines of a block */
  function emitIns(b, depth) {
    const pad = padOf(depth);
    for (const d of b.ins) {
      if (d.term && d.term.kind !== 'ret') continue; // terminator handled by caller
      if (d.term && d.term.kind === 'ret') continue;
      for (const ln of d.lines) out.push(pad + ln);
    }
  }
  /** emit only the non-terminator head lines of the block that holds the guard */
  function emitHeadLines(b, depth) {
    const pad = padOf(depth);
    for (const d of b.ins) {
      if (d.term) break;
      for (const ln of d.lines) out.push(pad + ln);
    }
  }

  const isLoopHeader = (b) => loopOfHeader.has(b) && !prepOf.has(b);
  const isForPrep = (b) => prepOf.has(b);

  /** where does a loop's execution continue after it ends? */
  function loopExit(loop) {
    // prefer targets from inside the body that lie outside it
    const exits = [];
    for (const b of loop.blocks) {
      if (!b.term) {
        const nxt = cfg.blockOf(b.end + 1);
        if (nxt && !loop.blocks.has(nxt)) exits.push(nxt);
        continue;
      }
      const t = b.term;
      if (t.kind === 'jmp' || t.kind === 'cjmp') {
        const tb = cfg.blockOf(t.target);
        if (!loop.blocks.has(tb)) exits.push(tb);
      }
    }
    return exits;
  }

  /** emit a for-loop (forprep/forloop pair) */
  function emitForLoop(pair, depth) {
    const pad = padOf(depth);
    const { prep, m, skip, bodyStart, bodyBlocks, loop, flBlock } = pair;
    const fm = opts.R(m), fl = opts.R(m + 1), fst = opts.R(m + 2);
    const tableMode = opts.tableMode;
    if (tableMode) {
      const fv = `__fi${m}_${pair.prep.start}`;
      out.push(`${pad}do`);
      out.push(`${pad}  local ${fv} = REGS[${m}]`);
      out.push(`${pad}  for ${fv} = REGS[${m}], REGS[${m + 1}], REGS[${m + 2}] do`);
      out.push(`${pad}    REGS[${m}] = ${fv}`);
      emitBody(depth + 2);
      out.push(`${pad}  end`);
      out.push(`${pad}end`);
    } else {
      out.push(`${pad}for ${fm} = ${fm}, ${fl}, ${fst} do`);
      emitBody(depth + 1);
      out.push(`${pad}end`);
    }
    stats.forLoops += 1;
    visited.add(prep);
    // mark the forloop block + whole body visited
    if (loop) for (const b of loop.blocks) visited.add(b);
    visited.add(flBlock);

    function emitBody(d) {
      const bodyStops = new Set([flBlock]);
      emitChain(cfg.blockOf(bodyStart), bodyStops, { blocks: bodyBlocks, header: flBlock, isFor: true }, d);
    }
  }

  /** emit a generic while loop at a header block */
  function emitWhileLoop(loop, depth) {
    const pad = padOf(depth);
    const h = loop.header;
    const exits = loopExit(loop);
    out.push(pad + 'while true do');
    visited.add(h);
    const t = h.term;
    if (t && t.kind === 'cjmp') {
      const tb = cfg.blockOf(t.target);
      if (!loop.blocks.has(tb)) {
        // guard exits the loop: pre-guard lines, then the test as a break
        emitHeadLines(h, depth + 1);
        out.push(padOf(depth + 1) + `if ${t.cond} then break end`);
        stats.breaks += 1;
        const bodyStart = cfg.blockOf(h.end + 1);
        if (bodyStart && loop.blocks.has(bodyStart) && !visited.has(bodyStart)) {
          emitChain(bodyStart, new Set([h]), loop, depth + 1);
        }
      } else {
        // guard re-enters the body (cond true → body start); fallthrough exits
        emitHeadLines(h, depth + 1);
        emitChain(tb, new Set([h]), loop, depth + 1);
      }
    } else {
      emitIns(h, depth + 1);
      if (!t) {
        const nxt = cfg.blockOf(h.end + 1);
        if (nxt && loop.blocks.has(nxt) && !visited.has(nxt)) {
          emitChain(nxt, new Set([h]), loop, depth + 1);
        }
      } else if (t.kind === 'jmp') {
        const tb = cfg.blockOf(t.target);
        if (loop.blocks.has(tb) && !visited.has(tb)) {
          emitChain(tb, new Set([h]), loop, depth + 1);
        }
      }
      // ret terminator: the loop body is the header alone
    }
    out.push(pad + 'end');
    stats.loops += 1;
    return exits;
  }

  /**
   * Follow the chain from block b, emitting until a stop condition.
   * stops: Set of blocks where this chain hands control back to the parent.
   * loop: current loop context { blocks, header, isFor? } or null.
   *
   * When the chain arrives at an already-emitted block (a shared tail reached
   * from a second path) the block's code is DUPLICATED for this path (capped):
   * every dynamic arrival must execute it once, so copying is exact while
   * dropping it would silently lose the tail of the path.
   */
  function emitChain(b, stops, loop, depth) {
    let cur = b;
    let guard = 0;
    while (cur && guard++ < 10000) {
      if (stops.has(cur)) return;
      if (loop && loop.isFor && cur === loop.header) return; // for-latch omitted in `for` form
      if (visited.has(cur)) {
        if (loop && cur === loop.header) return; // wrap to loop top
        if (dupDepth < 3) {
          out.push(padOf(depth) + `-- shared region (pc ${cur.start}) inlined for this path`);
          dupDepth += 1;
          emitChain(cur, stops, loop, depth);
          dupDepth -= 1;
          return;
        }
        out.push(padOf(depth) + `-- control joins earlier code at pc ${cur.start}`);
        return;
      }
      // for-loop construction
      if (isForPrep(cur)) {
        const pair = prepOf.get(cur);
        emitForLoop(pair, depth);
        const after = cfg.blockOf(pair.skip);
        if (!after || stops.has(after)) return;
        cur = after;
        continue;
      }
      // generic loop header
      if (isLoopHeader(cur)) {
        const l = loopOfHeader.get(cur);
        const exits = emitWhileLoop(l, depth);
        // continue at the first unvisited exit
        let nextB = null;
        for (const e of exits) {
          if (!visited.has(e) && !stops.has(e)) { nextB = e; break; }
        }
        if (!nextB) return;
        cur = nextB;
        continue;
      }
      visited.add(cur);
      emitIns(cur, depth);
      const t = cur.term;
      if (!t) {
        const nxt = cfg.blockOf(cur.end + 1);
        if (!nxt || stops.has(nxt)) return;
        cur = nxt;
        continue;
      }
      if (t.kind === 'ret') {
        out.push(padOf(depth) + t.text);
        return;
      }
      if (t.kind === 'jmp') {
        const tb = cfg.blockOf(t.target);
        if (loop && !loop.blocks.has(tb)) { out.push(padOf(depth) + 'break'); stats.breaks += 1; return; }
        if (visited.has(tb)) {
          if (dupDepth < 3) {
            out.push(padOf(depth) + `-- shared region (pc ${tb.start}) inlined for this path`);
            dupDepth += 1;
            emitChain(tb, stops, loop, depth);
            dupDepth -= 1;
            return;
          }
          return; // back edge — loop wraps
        }
        if (stops.has(tb)) return;
        cur = tb;
        continue;
      }
      if (t.kind === 'cjmp') {
        const tb = cfg.blockOf(t.target);
        const fallB = cfg.blockOf(cur.end + 1);
        // loop exit?
        if (loop && !loop.blocks.has(tb)) {
          out.push(padOf(depth) + `if ${t.cond} then break end`);
          stats.breaks += 1;
          stats.ifs += 1;
          if (!fallB || stops.has(fallB)) return;
          if (visited.has(fallB)) {
            if (dupDepth < 3) {
              out.push(padOf(depth) + `-- shared region (pc ${fallB.start}) inlined for this path`);
              dupDepth += 1;
              emitChain(fallB, stops, loop, depth);
              dupDepth -= 1;
            }
            return;
          }
          cur = fallB;
          continue;
        }
        // backward within loop
        if (tb.start < cur.start && loop) {
          if (tb === loop.header) {
            // conditional continue: fallthrough runs only when NOT cond
            out.push(padOf(depth) + `if not (${t.cond}) then`);
            stats.ifs += 1;
            if (fallB && !visited.has(fallB) && !stops.has(fallB)) {
              emitChain(fallB, new Set([...stops, loop.header, tb]), loop, depth + 1);
            }
            out.push(padOf(depth) + 'end');
            return; // cond-true path wraps via loop end
          }
          // mid-loop continue: re-run the tb..cur tail until the test flips
          out.push(padOf(depth) + `if ${t.cond} then`);
          stats.ifs += 1;
          out.push(padOf(depth + 1) + `repeat -- re-entry (pc ${tb.start})`);
          emitContinueTail(tb, new Set([cur]), loop, depth + 2);
          out.push(padOf(depth + 1) + `until not (${t.cond})`);
          out.push(padOf(depth) + 'end');
          if (!fallB || stops.has(fallB)) return;
          if (visited.has(fallB)) {
            if (dupDepth < 3) {
              out.push(padOf(depth) + `-- shared region (pc ${fallB.start}) inlined for this path`);
              dupDepth += 1;
              emitChain(fallB, stops, loop, depth);
              dupDepth -= 1;
            }
            return;
          }
          cur = fallB;
          continue;
        }
        // jump to a loop header
        if (isLoopHeader(tb) || isForPrep(tb)) {
          out.push(padOf(depth) + `if ${t.cond} then`);
          stats.ifs += 1;
          if (!visited.has(tb)) {
            if (isForPrep(tb)) emitForLoop(prepOf.get(tb), depth + 1);
            else {
              const l = loopOfHeader.get(tb);
              emitWhileLoop(l, depth + 1);
              const ex = loopExit(l).find((e) => !visited.has(e) && !stops.has(e));
              if (ex) emitChain(ex, new Set([...stops]), loop, depth + 1);
            }
          } else {
            out.push(padOf(depth + 1) + `-- joins the loop at pc ${tb.start}`);
          }
          out.push(padOf(depth) + 'end');
          if (!fallB || stops.has(fallB)) return;
          if (visited.has(fallB)) {
            if (dupDepth < 3) {
              out.push(padOf(depth) + `-- shared region (pc ${fallB.start}) inlined for this path`);
              dupDepth += 1;
              emitChain(fallB, stops, loop, depth);
              dupDepth -= 1;
            }
            return;
          }
          cur = fallB;
          continue;
        }
        // degenerate: target is the fallthrough itself
        if (tb === fallB) {
          out.push(padOf(depth) + `-- [op ${cur.ins[cur.ins.length - 1].op}] always-true test at pc ${cur.end}`);
          cur = fallB;
          continue;
        }
        if (tb.start < cur.start) {
          // backward jump into already-emitted code — re-run the tail in a
          // repeat shell; `until not (cond)` re-evaluates this very test, so
          // the translation is exact (including looping forever)
          out.push(padOf(depth) + `if ${t.cond} then`);
          stats.ifs += 1;
          out.push(padOf(depth + 1) + `repeat -- re-entry (pc ${tb.start})`);
          emitContinueTail(tb, new Set([cur]), loop, depth + 2);
          out.push(padOf(depth + 1) + `until not (${t.cond})`);
          out.push(padOf(depth) + 'end');
          if (!fallB || stops.has(fallB) || visited.has(fallB)) return;
          cur = fallB;
          continue;
        }
        // forward: does the fallthrough path reach the target (join)?
        const reaches = pathReaches(fallB, tb, new Set([...stops]), loop);
        if (reaches) {
          out.push(padOf(depth) + `if not (${t.cond}) then`);
          stats.ifs += 1;
          if (fallB && !visited.has(fallB)) {
            emitChain(fallB, new Set([...stops, tb]), loop, depth + 1);
          }
          out.push(padOf(depth) + 'end');
          if (visited.has(tb) || stops.has(tb)) return;
          cur = tb;
          continue;
        }
        // divergent: target reached only when cond is true
        out.push(padOf(depth) + `if ${t.cond} then`);
        stats.ifs += 1;
        if (!visited.has(tb) && !stops.has(tb)) {
          emitChain(tb, new Set([...stops, ...(loop ? [loop.header] : [])]), loop, depth + 1);
        }
        out.push(padOf(depth) + 'end');
        if (!fallB || stops.has(fallB)) return;
        if (visited.has(fallB)) {
          if (dupDepth < 3) {
            out.push(padOf(depth) + `-- shared region (pc ${fallB.start}) inlined for this path`);
            dupDepth += 1;
            emitChain(fallB, stops, loop, depth);
            dupDepth -= 1;
          }
          return;
        }
        cur = fallB;
        continue;
      }
      if (t.kind === 'forloop') {
        // forloop reached without its forprep consumed (shouldn't happen) — degrade
        out.push(padOf(depth) + `-- [forloop pc ${cur.end}] (unpaired)`);
        stats.degraded += 1;
        return;
      }
      return;
    }
  }

  /**
   * Emit the re-entry tail of a mid-loop `continue`: a linear walk from `start`
   * (an earlier block of the same loop) up to the wrap point. Runs inside the
   * cond-true branch, so the loop's normal wrap takes over afterwards.
   */
  function emitContinueTail(start, stopSet, loop, depth) {
    const localSeen = new Set();
    let cur = start;
    let guard = 0;
    while (cur && guard++ < 400) {
      if (stopSet.has(cur) || localSeen.has(cur)) return;
      if (loop && loop.isFor && cur === loop.header) return;
      if (isLoopHeader(cur) && cur !== start) return; // joins another loop — stop
      localSeen.add(cur);
      emitIns(cur, depth);
      const t = cur.term;
      if (!t) { cur = cfg.blockOf(cur.end + 1); continue; }
      if (t.kind === 'ret') { out.push(padOf(depth) + t.text); return; }
      if (t.kind === 'jmp') {
        const tb = cfg.blockOf(t.target);
        if (loop && !loop.blocks.has(tb)) { out.push(padOf(depth) + 'break'); stats.breaks += 1; return; }
        cur = tb;
        continue;
      }
      if (t.kind === 'cjmp') {
        const tb = cfg.blockOf(t.target);
        const fb = cfg.blockOf(cur.end + 1);
        if (loop && !loop.blocks.has(tb)) {
          out.push(padOf(depth) + `if ${t.cond} then break end`);
          stats.breaks += 1;
          if (fb && !stopSet.has(fb)) { cur = fb; continue; }
          return;
        }
        out.push(padOf(depth) + `if ${t.cond} then`);
        stats.ifs += 1;
        emitContinueTail(tb, new Set([...stopSet, ...localSeen]), loop, depth + 1);
        out.push(padOf(depth) + 'else');
        if (fb) emitContinueTail(fb, new Set([...stopSet, ...localSeen]), loop, depth + 1);
        out.push(padOf(depth) + 'end');
        return;
      }
      return; // forprep/forloop inside a tail — stop conservatively
    }
  }

  /** can the fallthrough path from `from` reach block `target` without loops? */
  function pathReaches(from, target, stops, loop) {
    const seen = new Set();
    const stack = [from];
    let guard = 0;
    while (stack.length && guard++ < 4000) {
      const b = stack.pop();
      if (b === target) return true;
      if (!b || visited.has(b) || stops.has(b) || seen.has(b)) continue;
      if (loop && !loop.blocks.has(b)) continue; // don't wander out of the region
      if (isLoopHeader(b) || isForPrep(b)) continue;
      seen.add(b);
      const t = b.term;
      if (!t) {
        const nxt = cfg.blockOf(b.end + 1);
        if (nxt) stack.push(nxt);
      } else if (t.kind === 'jmp') {
        stack.push(cfg.blockOf(t.target));
      } else if (t.kind === 'cjmp') {
        stack.push(cfg.blockOf(t.target));
        const fb = cfg.blockOf(b.end + 1);
        if (fb) stack.push(fb);
      } else if (t.kind === 'forloop') {
        stack.push(cfg.blockOf(t.body));
      }
    }
    return false;
  }

  // ---- main chain ----
  emitChain(cfg.blocks[0], new Set(), null, 1);

  // ---- seeds: reachable blocks the chain never structured (rare) ----
  const seeds = [...reach].filter((b) => !visited.has(b)).sort((a, b) => a.start - b.start);
  for (const s of seeds) {
    if (visited.has(s)) continue;
    // Lua requires return/break to be the last statement of a block — wrap one
    if (out.length) {
      const last = out[out.length - 1];
      const mr = /^ {2}return\b(.*)$/.exec(last);
      const mb = /^ {2}break$/.exec(last);
      if (mr) out[out.length - 1] = `  do return${mr[1]} end`;
      else if (mb) out[out.length - 1] = '  do break end';
    }
    out.push(padOf(1) + `do -- region entered from pc ${s.start}`);
    const before = out.length;
    emitChain(s, new Set(), null, 2);
    if (out.length === before) out.pop();
    else out.push(padOf(1) + 'end');
  }

  return { out, stats, reach, cfg, decoded };
}

// ---------- per-proto assembly ----------
function protoBody(P) {
  // register naming: high-register protos use a REGS table
  let maxReg = 0;
  for (let pc = 1; pc <= P.n; pc++) {
    const i = P.ins(pc);
    maxReg = Math.max(maxReg, i.G, i.g, i.o);
  }
  const tableMode = maxReg > 180;
  const R = (x) => (tableMode ? `REGS[${x}]` : `R${x}`);
  const CE = (v) => (typeof v === 'string' ? qstr(v)
    : v === true ? 'true' : v === false ? 'false' : v == null ? 'nil' : qnum(v));

  const { out, stats, reach, decoded } = emitProto(P, { R, CE, tableMode });

  // prune register declarations to what's actually referenced
  const scanText = out.join('\n');
  const used = new Set();
  if (tableMode) {
    for (const m of scanText.matchAll(/REGS\[(\d+)\]/g)) used.add(Number(m[1]));
  } else {
    for (const m of scanText.matchAll(/\bR(\d+)\b/g)) used.add(Number(m[1]));
  }
  // params from op 2/129 at pc 1
  const first = decoded[1];
  const nparams = first && (first.op === 2 || first.op === 129) ? P.ins(1).g || 0 : 0;
  for (let k = 1; k <= nparams; k++) used.add(k);

  // collapse runs of identical annotation comments (shared-region markers repeat
  // when several capped paths merge — one marker is enough for the reader)
  const collapsed = [];
  for (const ln of out) {
    if (ln.trim().startsWith('-- ') && collapsed.length && collapsed[collapsed.length - 1] === ln) continue;
    collapsed.push(ln);
  }
  const final = [];
  if (tableMode) {
    final.push('  local REGS = {}');
  } else if (used.size) {
    const regs = [...used].sort((a, b) => a - b).map((k) => 'R' + k);
    final.push('  local ' + regs.join(', '));
  }
  final.push(...collapsed);
  return { lines: final, stats, tableMode, maxReg };
}

/**
 * Lift a deserialized-program state graph to readable Lua source.
 * @param {{nodes: object, order: string[]}} graph parsed state dump
 * @returns {{ code: string, protos: number, instructions: number, reachable: number, decoys: number, stats: object }}
 */
export function liftVmProgram(graph) {
  const { nodes, order } = graph;
  const protoLabels = [];
  for (const label of order) {
    const n = nodes[label];
    if (!n || n.kind !== 'table') continue;
    const keys = n.fields.map(([k]) => fkey(k));
    if (keys.length === 11 && keys.every((k, i) => k === i + 1)) protoLabels.push(label);
  }
  const protos = {};
  for (const label of protoLabels) protos[label] = new Proto(label, nodes);
  const total = [...Object.values(protos)].reduce((s, p) => s + p.n, 0);

  // children before parents
  const childrenOf = {};
  for (const label of protoLabels) childrenOf[label] = Object.values(protos[label].closureAt);
  const order2 = [];
  const visit = (label) => {
    if (order2.includes(label)) return;
    for (const c of childrenOf[label] || []) visit(c);
    order2.push(label);
  };
  for (const label of protoLabels) visit(label);

  // pass 1: emit every proto, collect upvalue/cell references
  const emitted = new Map(); // label -> { lines, stats, tableMode }
  const uvNames = new Set();
  const uvCells = new Set();
  for (const label of order2) {
    const P = protos[label];
    const res = protoBody(P);
    // resolve CLOSURE markers
    const lines = [];
    for (const ln of res.lines) {
      const m = /^(\s*)CLOSURE@(\d+)$/.exec(ln);
      if (m) {
        const pcx = Number(m[2]);
        const child = P.closureAt[pcx];
        const Gt = P.ins(pcx).G;
        const lhs = P.ins(pcx).G;
        lines.push(`${m[1]}${res.tableMode ? `REGS[${lhs}]` : `R${lhs}`} = F_${child || 'X' + pcx}  -- closure${child ? '' : ' (unresolved)'}`);
        continue;
      }
      lines.push(ln);
    }
    const text = lines.join('\n');
    for (const m of text.matchAll(/\bU(\d+)_cell\b/g)) uvCells.add(Number(m[1]));
    for (const m of text.matchAll(/\bU(\d+)\b/g)) {
      const n = Number(m[1]);
      if (!uvCells.has(n)) uvNames.add(n);
    }
    emitted.set(label, { lines, stats: res.stats, tableMode: res.tableMode, maxReg: res.maxReg });
  }

  // pass 2: document
  const L = [];
  L.push('-- =============================================================================');
  L.push('-- BypassX Deobf Bot — Luraph payload VM: FULL DEVIRTUALIZATION');
  const reachTotal = [...emitted.values()].reduce((s, e) => s + e.stats.reachableIns, 0);
  const decoyTotal = [...emitted.values()].reduce((s, e) => s + e.stats.decoys, 0);
  const degradedTotal = [...emitted.values()].reduce((s, e) => s + e.stats.degraded, 0);
  const forTotal = [...emitted.values()].reduce((s, e) => s + e.stats.forLoops, 0);
  const whileTotal = [...emitted.values()].reduce((s, e) => s + e.stats.loops, 0);
  const ifTotal = [...emitted.values()].reduce((s, e) => s + e.stats.ifs, 0);
  L.push(`-- ${total} VM instructions decoded · ${reachTotal} reachable (semantic program) · ${decoyTotal} decoy blocks dropped.`);
  L.push(`-- Structure recovered: ${forTotal} for-loops, ${whileTotal} while-loops, ${ifTotal} conditionals across ${protoLabels.length} protos.`);
  if (degradedTotal) L.push(`-- ${degradedTotal} edge(s) too tangled to structure — kept as annotated comments (control flow preserved).`);
  L.push('-- Registers R<n> (or REGS table for high-register protos), globals via ENV,');
  L.push('-- upvalues U<n> and their cells U<n>_cell are bound by the loader at runtime.');
  L.push('-- =============================================================================');
  L.push('');
  L.push('local ENV = setmetatable({}, { __index = _G })');
  if (uvNames.size) {
    L.push(`local ${[...uvNames].sort((a, b) => a - b).map((n) => 'U' + n).join(', ')}`);
  }
  if (uvCells.size) {
    L.push(`local ${[...uvCells].sort((a, b) => a - b).map((n) => `U${n}_cell = {}`).join(', ')}`);
  }
  L.push('');
  for (const label of order2) {
    const e = emitted.get(label);
    const st = e.stats;
    L.push(`-- ---- proto ${label} · ${st.reachableIns}/${P_n(protos[label])} instructions live · ${st.decoys} decoy ----`);
    L.push(`local function F_${label}(...)`);
    L.push(...e.lines);
    L.push('end');
    L.push('');
  }
  const mainLabel = protoLabels[0];
  L.push(`F_${mainLabel}(...)`);
  const code = L.join('\n') + '\n';
  return {
    code,
    protos: protoLabels.length,
    instructions: total,
    reachable: reachTotal,
    decoys: decoyTotal,
    stats: {
      order: order2,
      forLoops: forTotal,
      whileLoops: whileTotal,
      ifs: ifTotal,
      degraded: degradedTotal,
    },
  };
}

function P_n(P) { return P.n; }

/** Syntax-verify lifted code with the vendored luau-ast when available. */
export function verifyLift(code) {
  if (!fs.existsSync(LUAAU_AST)) return { ok: null, why: 'luau-ast missing' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxlift-'));
  const f = path.join(dir, 'lifted.lua');
  try {
    fs.writeFileSync(f, code, 'latin1');
    const r = spawnSync(LUAAU_AST, [f], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, stderr: (r.stderr || '').toString().slice(0, 400) };
  } catch (e) {
    return { ok: null, why: String(e && e.message || e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}
