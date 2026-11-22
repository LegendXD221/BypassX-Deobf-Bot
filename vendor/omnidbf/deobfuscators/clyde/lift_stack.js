'use strict';

const cfgmod = require('./cfg.js');
const { OP, decode, buildCFG, dominators, dominates, findLoops, reversePostorder } = cfgmod;
const { OPNAME } = require('./vmspec.js');
const { E, render, isIdent } = require('./luaemit.js');

function toWorking(cfg) {
  const blocks = cfg.blocks.map(b => ({
    id: b.id,
    instrs: b.instrs.slice(),
    succs: b.succs.slice(),
    preds: [],
    kind: b.kind,
    startPos: b.instrs.length ? b.instrs[0].pos : -1,
  }));
  recomputePreds(blocks);
  return blocks;
}

function recomputePreds(blocks) {
  for (const b of blocks) if (b) b.preds = [];
  for (const b of blocks) {
    if (!b) continue;
    for (const s of b.succs) if (blocks[s]) blocks[s].preds.push(b.id);
  }
}

function blockAtPos(blocks, pos) {
  for (const b of blocks) if (b && b.startPos === pos) return b.id;
  return -1;
}

const AND_OP = '@and', OR_OP = '@or', END_MARK = '@end';

function logicSig(instrs, i) {

  if (!instrs[i] || instrs[i].op !== OP.DUP) return null;
  let j = i + 1, neg = false;
  if (instrs[j] && instrs[j].op === OP.NOT) { neg = true; j++; }
  if (!instrs[j] || instrs[j].op !== OP.JMP_F) return null;
  return { neg, jIdx: j };
}

function collapseLinear(instrs) {
  const out = [];
  let i = 0;
  while (i < instrs.length) {
    const sig = logicSig(instrs, i);
    if (sig) {
      const t = instrs[sig.jIdx].args[0];
      let endIdx = -1;
      for (let k = sig.jIdx + 1; k < instrs.length; k++) {
        if (instrs[k].pos === t) { endIdx = k; break; }
      }
      const popIns = instrs[sig.jIdx + 1];
      if (endIdx > sig.jIdx + 1 && popIns && popIns.op === OP.POP && popIns.args[0] === 1) {
        const sub = collapseLinear(instrs.slice(sig.jIdx + 2, endIdx));
        out.push({ op: sig.neg ? OR_OP : AND_OP, sub, pos: instrs[i].pos, args: [], size: 0 });
        i = endIdx;
        continue;
      }
    }
    out.push(instrs[i]);
    i++;
  }
  return out;
}

function collapseLogicPass(blocks) {
  let changed = false;
  for (const b of blocks) {
    if (!b || !b.instrs.length) continue;
    const n = b.instrs.length;
    const sig = logicSig(b.instrs, n - 3) || logicSig(b.instrs, n - 2);
    if (!sig || sig.jIdx !== n - 1) continue;
    const t = b.instrs[n - 1].args[0];
    const T = blockAtPos(blocks, t);
    const F = b.succs[0];
    if (T < 0 || F === undefined || !blocks[F] || T === F) continue;

    const chain = [];
    const inChain = new Set();
    let cur = F, ok = true;
    while (cur !== T) {
      if (cur === undefined || !blocks[cur] || inChain.has(cur)) { ok = false; break; }
      chain.push(cur); inChain.add(cur);
      if (blocks[cur].succs.length !== 1) { ok = false; break; }
      cur = blocks[cur].succs[0];
    }
    if (!ok || !chain.length) continue;

    let sealed = true;
    for (const c of chain) {
      for (const p of blocks[c].preds) if (p !== b.id && !inChain.has(p)) { sealed = false; break; }
      if (!sealed) break;
    }
    if (!sealed) continue;

    let sub = [];
    for (const c of chain) sub = sub.concat(blocks[c].instrs);
    const merged = b.instrs.concat(sub, [{ op: END_MARK, pos: t, args: [], size: 0 }]);
    const col = collapseLinear(merged);
    if (col.length < 2 || col[col.length - 1].op !== END_MARK) continue;
    const last = col[col.length - 2];
    if (last.op !== AND_OP && last.op !== OR_OP) continue;

    b.instrs = col.slice(0, -1);
    b.succs = [T];
    b.kind = 'fall';
    for (const c of chain) blocks[c] = null;
    recomputePreds(blocks);
    changed = true;
  }
  return changed;
}

function coalescePass(blocks) {
  let changed = false;
  for (const b of blocks) {
    if (!b) continue;
    if (b.kind !== 'fall' && b.kind !== 'jmp') continue;
    if (b.succs.length !== 1) continue;
    const y = blocks[b.succs[0]];
    if (!y || y.id === b.id || y.preds.length !== 1 || y.preds[0] !== b.id) continue;

    let mine = b.instrs;
    if (mine.length && mine[mine.length - 1].op === OP.JMP) mine = mine.slice(0, -1);
    b.instrs = mine.concat(y.instrs);
    b.succs = y.succs.slice();
    b.kind = y.kind;
    blocks[y.id] = null;
    recomputePreds(blocks);
    changed = true;
  }
  return changed;
}

function simplify(blocks) {
  for (let guard = 0; guard < 1000; guard++) {
    const a = collapseLogicPass(blocks);
    const c = coalescePass(blocks);
    if (!a && !c) break;
  }
  return blocks;
}

module.exports = {
  AND_OP, OR_OP, toWorking, recomputePreds, blockAtPos, collapseLinear,
  collapseLogicPass, coalescePass, simplify,
};
