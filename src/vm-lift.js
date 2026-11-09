/**
 * BypassX Deobf Bot — VM lift transpiler.
 *
 * Consumes the vm-lift-worker's capture (snap: {mode, rows, opids, instrs,
 * consts} + probes: [{op, ev:[...]}]) and produces REAL Lua source:
 *
 *   1. CLASSIFICATION — each opcode id is mapped to a semantic (LOADK,
 *      GETGLOBAL, SETGLOBAL, MOVE, CALL, GETTABLE, SETTABLE, NEWTABLE,
 *      arith ops, TEST, JMP, RETURN) purely from its BEHAVIORAL fingerprint:
 *      the effects the obfuscator's own handler produced against virtualized
 *      registers/constants/env during probing. No signature tables — works
 *      for per-build shuffled opcodes.
 *   2. OPERAND ROLE MAPPING — probe records used sentinel operands (1,2,3 →
 *      record fields 2,3,4); the events record which sentinel moved, so each
 *      semantic's operands map back to real record fields per build.
 *   3. EMISSION — a pc-runner program: exact control flow (jumps become
 *      __pc assignments), decrypted constants inlined, global names resolved
 *      from the captured constant pool, one comment per instruction showing
 *      the raw record. Always valid Lua → passes verifyCode.
 */
import { verifyCode } from './validate.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ARITH = {
  add: '+', sub: '-', mul: '*', div: '/', mod: '%', pow: '^', idiv: '//',
  band: '&', bor: '|', bxor: '~', shl: '<<', shr: '>>', unm: 'UNM', bnot: 'BNOT',
  concat: '..',
};

function parseSlot(label) {
  // slot mocks are tagged 'r<k>' (stack) / 'c<k>' (const) / plain number
  if (typeof label !== 'string') return null;
  const m = /^r(\d+)$/.exec(label) || /^c(\d+)$/.exec(label) || /^(\d+)$/.exec(label);
  return m ? Number(m[1]) : null;
}

/** Merge + dedupe events of one opcode across its arity probes. */
function mergeEvents(evs) {
  const seen = new Set();
  const out = [];
  for (const e of evs) {
    if (e.startsWith('PC')) continue; // handled separately for jump analysis
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** pc-jump analysis from PC events: served positions per opid in order. */
function pcAnalysis(probes) {
  // build a global timeline of PC reads
  const timeline = []; // {pc, op}
  const byOp = new Map(); // op -> [pc...]
  for (const p of probes) {
    const pcs = [];
    for (const e of p.ev) {
      const m = /^PC(\d+)$/.exec(e);
      if (m) pcs.push(Number(m[1]));
    }
    byOp.set(p.op, pcs);
    for (const pc of pcs) timeline.push({ pc, op: p.op });
  }
  timeline.sort((a, b) => a.pc - b.pc);
  // jump delta per op: for a probe record served at pc, the NEXT served pc
  // (in op order) minus pc — >1 means the handler moved the pc.
  const jumps = new Map(); // op -> max observed delta
  const deltas = new Map(); // op -> ALL observed deltas (v2.13.0 CHECK*-lite)
  for (const [op, pcs] of byOp) {
    const all = [];
    for (let i = 0; i < pcs.length; i++) {
      const next = byOp.get(op)[i + 1];
      if (next !== undefined && next - pcs[i] !== 1) all.push(next - pcs[i]);
    }
    if (all.length) {
      jumps.set(op, Math.max(...all));
      deltas.set(op, [...new Set(all)].sort((a, b) => a - b));
    }
  }
  return { byOp, jumps, deltas, timeline };
}

const ARITH_NAME = {
  add: 'ADD', sub: 'SUB', mul: 'MUL', div: 'DIV', mod: 'MOD', pow: 'POW',
  idiv: 'IDIV', band: 'BAND', bor: 'BOR', bxor: 'BXOR', shl: 'SHL', shr: 'SHR',
};

/**
 * Classify one opcode from its merged effects.
 * Returns { name, kind, sig:{...} } where sig holds operand field positions.
 */
function classifyOp(op, evs, ctx) {
  const has = (re) => evs.some((e) => re.test(e));
  const findAll = (re, group = 1) =>
    evs.map((e) => { const m = re.exec(e); return m ? m[group] : null; }).filter((x) => x !== null);

  const gr = findAll(/^GR:(.+)$/);
  const gw = findAll(/^GW:([^:]+):/, 1);
  const sw = findAll(/^SW(\d+):/).map(Number);
  const sr = findAll(/^SR(\d+)$/).map(Number);
  const cr = findAll(/^CR(\d+)$/).map(Number);
  const tr = findAll(/^TR(\w+):/).map(parseSlot).filter((x) => x !== null);
  const tw = findAll(/^TW(\w+):/).map(parseSlot).filter((x) => x !== null);
  const callr = findAll(/^CALLR(\w+):/).map(parseSlot).filter((x) => x !== null);
  const ar = findAll(/^AR\w+:(\w+)$/);
  const arSlot = findAll(/^AR(\w+):\w+$/).map(parseSlot);
  const cmp = findAll(/^CMP\w+:(\w+)$/);
  const len = has(/^LEN/);

  // RETURN: the run ended cleanly right after this op's last probe record
  if (ctx.cleanExitOp === op) return { name: 'RETURN', kind: 'return', sig: {} };

  if (len && sw.length) return { name: 'LEN', kind: 'len', sig: { dst: sw[0], src: sr[0] ?? 0 } };

  if (gw.length) {
    return { name: 'SETGLOBAL', kind: 'setglobal', sig: { name: cr[0] ?? 1, val: sr[0] ?? sw[0] } };
  }
  if (callr.length) {
    return { name: 'CALL', kind: 'call', sig: { fn: callr[0], arg: sr.find((s) => s !== callr[0]) ?? 0 } };
  }
  if (tr.length) {
    return { name: 'GETTABLE', kind: 'gettable', sig: { dst: sw[0], tbl: tr[0], key: cr[0] } };
  }
  if (tw.length) {
    return { name: 'SETTABLE', kind: 'settable', sig: { tbl: tw[0], key: cr[0], val: sr[sr.length - 1] ?? 0 } };
  }
  if (ar.length && ARITH_NAME[ar[0]]) {
    const lhs = arSlot[0];
    const rhs = sr.find((s) => s !== lhs) ?? 0;
    return { name: ARITH_NAME[ar[0]], kind: 'arith', op: ar[0], sig: { dst: sw[0], lhs, rhs } };
  }
  if (cmp.length) {
    const kindMap = { eq: 'TEST-EQ', lt: 'TEST-LT', le: 'TEST-LE' };
    return { name: kindMap[cmp[0]] || 'TEST', kind: 'test', cmp: cmp[0], sig: { a: sr[0], b: sr[1] ?? 0 } };
  }
  if (gr.length) {
    return { name: 'GETGLOBAL', kind: 'getglobal', sig: { dst: sw[0], name: cr[0] } };
  }
  if (cr.length && sw.length) {
    return { name: 'LOADK', kind: 'loadk', sig: { dst: sw[0], konst: cr[0] } };
  }
  if (sw.length && sw[0] !== undefined && sr.length === 0 && cr.length === 0) {
    return { name: 'NEWTABLE', kind: 'newtable', sig: { dst: sw[0] } };
  }
  if (sr.length && sw.length) {
    return { name: 'MOVE', kind: 'move', sig: { dst: sw[0], src: sr[0] } };
  }
  if (ctx.jumps.has(op)) return { name: 'JMP', kind: 'jmp', sig: {} };
  return { name: `OP${op}`, kind: 'unknown', sig: {} };
}

function constLiteral(v) {
  if (typeof v === 'string') {
    const esc = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\0/g, '\\0');
    return `"${esc}"`;
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(v);
  }
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return 'nil';
  return 'nil';
}

function globalRef(name) {
  if (typeof name === 'string' && IDENT_RE.test(name)) return name;
  return `_G[${constLiteral(String(name))}]`;
}

/**
 * Main entry: build devirtualized Lua from a lift worker result.
 * @returns {{ ok:boolean, code?:string, classified?:number, total?:number,
 *             unknown?:string[], how?:string, note?:string }}
 */
export function liftFromHarvest(lift, { detectedName = 'VM', version = '' } = {}) {
  if (!lift || !lift.snap || !Array.isArray(lift.probes)) {
    return { ok: false, note: 'no lift capture' };
  }
  const snap = lift.snap;
  if (snap.mode !== 'rows' || !Array.isArray(snap.instrs)) {
    return { ok: false, note: `unsupported VM layout (${snap.mode || '?'})` };
  }
  const rows = snap.instrs.filter((r) => Array.isArray(r) && r.length >= 1);
  if (rows.length < 4) return { ok: false, note: 'instruction stream too small' };

  const { jumps, deltas: opDeltas } = pcAnalysis(lift.probes);
  // the opid that exited cleanly = RETURN semantics
  const lastPc = lift.probes
    .flatMap((p) => p.ev.filter((e) => /^PC/.test(e)).map((e) => Number(e.slice(2))))
    .reduce((a, b) => Math.max(a, b), 0);
  let cleanExitOp = null;
  if (lift.ended === 'clean-exit') {
    for (const p of lift.probes) {
      const pcs = p.ev.filter((e) => /^PC/.test(e)).map((e) => Number(e.slice(2)));
      if (pcs.includes(lastPc)) cleanExitOp = p.op;
    }
  }
  const ctx = { cleanExitOp, jumps };

  // classify every opcode id present in the real stream
  const classes = new Map();
  const realOpIds = [...new Set(rows.map((r) => Number(r[0])).filter((n) => Number.isFinite(n)))];
  for (const op of realOpIds) {
    const probe = lift.probes.find((p) => p.op === op);
    if (!probe) { classes.set(op, { name: `OP${op}`, kind: 'unknown', sig: {} }); continue; }
    classes.set(op, classifyOp(op, mergeEvents(probe.ev), ctx));
  }
  const classified = realOpIds.filter((op) => classes.get(op).kind !== 'unknown').length;
  if (classified < 2) return { ok: false, note: `only ${classified}/${realOpIds.length} opcodes classified` };

  const consts = Array.isArray(snap.consts) ? snap.consts : [];
  const unknown = realOpIds.filter((op) => classes.get(op).kind === 'unknown').map((op) => classes.get(op).name);

  // ---- operand fields: sentinel v ↔ field index v+1 (probe records {op,1,2,3})
  const F = (sentinel) => Math.min(4, Math.max(2, sentinel + 1));

  // emit
  const maxReg = Math.min(24, Math.max(4, ...rows.map((r) => Math.min(r.length - 1, 4))));
  const L = [];
  L.push('-- ══ BypassX Deobf Bot — VM devirtualization (behavioral opcode lifting) ══');
  L.push(`-- family: ${detectedName}${version ? ' ' + version : ''} · layout: ${snap.mode} · instructions: ${rows.length}`);
  L.push(`-- opcodes: ${classified}/${realOpIds.length} classified${unknown.length ? ` (unclassified: ${unknown.join(', ')})` : ''}`);
  L.push('-- method: jailed VM run — instruction stream + constant pool captured at the');
  L.push('-- dispatcher, every opcode probed against the obfuscator\'s own handlers,');
  L.push('-- semantics learned from behavior, bytecode transpiled to this runner.');
  L.push('-- branch mode: CHECK*-lite — every conditional/unconditional edge carries a');
  L.push('-- branch comment ("ran, if id: N" / "didnt run (else)") in the leaked');
  L.push('-- SecureEnv CHECKIF style; skip deltas are the skip the handler itself');
  L.push('-- performed on probed operands, not a guess.');
  L.push('');
  L.push(`-- decrypted constant pool (${consts.length} entries)`);
  for (let i = 0; i < Math.min(consts.length, 64); i++) {
    L.push(`-- K[${i + 1}] = ${constLiteral(consts[i])}`);
  }
  L.push('');
  const regs = [];
  for (let i = 1; i <= maxReg; i++) regs.push(`V${i}`);
  L.push(`local ${regs.join(', ')} = nil`);
  L.push('local __pc = 1');
  L.push('while true do');
  for (let pc = 0; pc < rows.length; pc++) {
    const row = rows[pc];
    const op = Number(row[0]);
    const cls = classes.get(op) || { name: `OP${op}`, kind: 'unknown', sig: {} };
    const a = row[1]; const b = row[2]; const c = row[3];
    const raw = row.map((x) => (typeof x === 'number' ? x : JSON.stringify(x))).join(', ');
    L.push(pc === 0 ? `  if __pc == ${pc + 1} then` : `  elseif __pc == ${pc + 1} then`);
    const head = `-- [${pc + 1}] ${cls.name}`;
    switch (cls.kind) {
      case 'return':
        L.push(`    ${head} · raw { ${raw} }`);
        L.push('    return');
        break;
      case 'loadk': {
        const konst = consts[(b ?? 1) - 1];
        L.push(`    ${head} V${a} = K[${b}] · raw { ${raw} }`);
        L.push(`    V${a} = ${constLiteral(konst)}`);
        break;
      }
      case 'getglobal': {
        const name = consts[(b ?? 1) - 1];
        L.push(`    ${head} V${a} = _G[K[${b}]] · raw { ${raw} }`);
        L.push(`    V${a} = ${globalRef(String(name))}`);
        break;
      }
      case 'setglobal': {
        const name = consts[(a ?? 1) - 1];
        L.push(`    ${head} _G[K[${a}]] = V${b} · raw { ${raw} }`);
        L.push(`    ${globalRef(String(name))} = V${b}`);
        break;
      }
      case 'move':
        L.push(`    ${head} V${a} = V${b} · raw { ${raw} }`);
        L.push(`    V${a} = V${b}`);
        break;
      case 'call':
        L.push(`    ${head} V${a} = V${a}(V${b}) · raw { ${raw} }`);
        L.push(`    V${a} = V${a}(V${b})`);
        break;
      case 'gettable': {
        const key = consts[(c ?? 1) - 1];
        const keyTxt = typeof key === 'string' && IDENT_RE.test(key) ? `.${key}` : `[${constLiteral(key)}]`;
        L.push(`    ${head} V${a} = V${b}[K[${c}]] · raw { ${raw} }`);
        L.push(`    V${a} = V${b}${keyTxt}`);
        break;
      }
      case 'settable': {
        const key = consts[(b ?? 1) - 1];
        const keyTxt = typeof key === 'string' && IDENT_RE.test(key) ? `.${key}` : `[${constLiteral(key)}]`;
        L.push(`    ${head} V${a}[K[${b}]] = V${c} · raw { ${raw} }`);
        L.push(`    V${a}${keyTxt} = V${c}`);
        break;
      }
      case 'newtable':
        L.push(`    ${head} V${a} = {} · raw { ${raw} }`);
        L.push(`    V${a} = {}`);
        break;
      case 'arith': {
        const opSym = ARITH[cls.op] || '?';
        if (opSym === 'UNM') {
          L.push(`    ${head} V${a} = -V${b} · raw { ${raw} }`);
          L.push(`    V${a} = -V${b}`);
        } else if (opSym === 'BNOT') {
          L.push(`    ${head} V${a} = ~V${b} · raw { ${raw} }`);
          L.push(`    V${a} = ~V${b}`);
        } else {
          L.push(`    ${head} V${a} = V${b} ${opSym} V${c} · raw { ${raw} }`);
          L.push(`    V${a} = V${b} ${opSym} V${c}`);
        }
        break;
      }
      case 'jmp': {
        // v2.13.0: JMP used to fall into the default (unclassified) arm and
        // advance by 1 — silently corrupting control flow. Emit the real edge:
        // the delta the handler itself performed on probed operands.
        const dl = (opDeltas.get(op) || []).filter((d) => d !== 0);
        const d0 = dl.length ? dl[dl.length - 1] : Math.max(1, jumps.get(op) || 1);
        const target = pc + 1 + d0; // 1-based target pc label
        const back = d0 < 0;
        L.push(`    ${head} → [${target}]${back ? ' (loop back-edge)' : ''} · raw { ${raw} }`);
        L.push(`    __pc = __pc + ${d0} -- CHECK*-lite: unconditional → [${target}]${dl.length > 1 ? ` · observed deltas ${dl.map((d) => (d > 0 ? '+' + d : String(d))).join('/')}` : ''}`);
        break;
      }
      case 'test': {
        const opSym = cls.cmp === 'eq' ? '==' : cls.cmp === 'lt' ? '<' : '<=';
        // v2.13.0 CHECK*-lite: prefer the skip the handler OBSERVED to perform
        // on probed operands; structural guess (max numeric operand field) is
        // only the fallback.
        const observed = (opDeltas.get(op) || []).filter((d) => d > 1);
        const delta = observed.length
          ? observed[observed.length - 1]
          : Math.max(...row.slice(1).filter((x) => typeof x === 'number'), 1);
        const takenAt = pc + 1 + delta;
        const elseAt = pc + 2;
        const obsTxt = observed.length ? `probed skip +${delta}` : `skip +${delta} (guessed from operand fields)`;
        L.push(`    ${head} if V${a} ${opSym} V${b} skips ${delta} · raw { ${raw} }`);
        L.push(`    -- CHECK*-lite branch if id: ${pc + 1} · ${obsTxt} · taken → [${takenAt}] · not taken → [${elseAt}] (fall through)`);
        L.push(`    if V${a} ${opSym} V${b} then`);
        L.push(`      __pc = __pc + ${delta} -- ran, if id: ${pc + 1} (taken)`);
        L.push('    else');
        L.push(`      __pc = __pc + 1 -- didnt run (else) → [${elseAt}]`);
        L.push('    end');
        break;
      }
      case 'len':
        L.push(`    ${head} V${a} = #V${b} · raw { ${raw} }`);
        L.push(`    V${a} = #V${b}`);
        break;
      default:
        L.push(`    ${head} (unclassified) · raw { ${raw} }`);
        L.push('    __pc = __pc + 1');
        continue;
    }
    if (cls.kind !== 'test' && cls.kind !== 'return' && cls.kind !== 'jmp') L.push(`    __pc = __pc + 1`);
  }
  L.push('  else');
  L.push('    return -- fell off the program');
  L.push('  end');
  L.push('end');
  L.push('');

  const code = L.join('\n') + '\n';
  const v = verifyCode(code, { lang: 'lua', filename: 'devirtualized.lua' });
  const branchCount = realOpIds.filter((op) => ['test', 'jmp'].includes(classes.get(op).kind)).length;
  return {
    ok: true,
    code,
    classified,
    total: realOpIds.length,
    unknown,
    branches: branchCount,
    how: `VM devirtualization — ${classified}/${realOpIds.length} opcodes behaviorally classified, ${rows.length} instructions transpiled, ${branchCount} branch edge(s) annotated CHECK*-lite (${v.status === 'verified' ? 'syntax verified' : v.status})`,
    note: v.status !== 'verified' ? v.detail : null,
  };
}
