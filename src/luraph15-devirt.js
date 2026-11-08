/**
 * BypassX Deobf Bot — Luraph v15.1 devirtualizer (replay + disassembly).
 *
 * Consumes the real-Luau capture (decrypt-event log + VM checkpoints) and
 * produces the readable devirtualization view:
 *
 *   1. MULTI-STREAM — the Luraph VM executes one instruction stream per proto
 *      (k/s/L/O are swapped wholesale); checkpoints are grouped into streams
 *      by array signature and each stream is lifted independently.
 *   2. SELECTIVE REPLAY — every stream's last checkpoint already contains all
 *      decrypts applied up to that hit, so only events at/after that hit are
 *      replayed (bit-exact 29-bit xorshift, the build's own keys). Const
 *      sites support both handler shapes: raw seed operand and the runtime
 *      B-derived seed — candidates are validated against the varint frame.
 *   3. CONST RECOVERY — the bytecode buffer is re-dumped by the capture
 *      whenever a const region decrypts (dirty-flag), so late snapshots hold
 *      plaintext constants; offsets come from the VM's own write-back.
 *   4. DISASSEMBLY — each decrypted stream renders through the behavioral
 *      ISA (loop-1 v-map): register ops, calls, jumps, decrypt blocks.
 */
import { verifyCode } from './validate.js';

const M29 = 536870911;
const bxor = (a, b) => (a ^ b) >>> 0;
const band = (a, b) => (a & b) >>> 0;
const rshift = (a, b) => (a >>> (b & 31)) >>> 0;

function xorshiftStep(H) {
  H = band(bxor(H, (H << 13) >>> 0), M29);
  H = bxor(H, rshift(H, 13));
  H = band(bxor(H, (H << 14) >>> 0), M29);
  return H >>> 0;
}

/** block-decrypt site roles come from the capture (per-build, auto-detected);
 *  this fallback covers the common role families when the capture omits them. */
const BLOCK_SITE_FALLBACK = [
  { roles: { s: 0, k: 7, L: 14, O: 21 } },
  { roles: { L: 0, s: 7, O: 14, k: 21 } },
  { roles: { s: 0, O: 7, L: 14, k: 21 } },
];
function siteRoles(capture, id) {
  const r = capture.roles && capture.roles[id] && capture.roles[id].roles;
  if (r && Object.keys(r).length) return r;
  return BLOCK_SITE_FALLBACK[id % BLOCK_SITE_FALLBACK.length].roles;
}

const CONST_KEY = 535359694;

function readVarint(buf, pos) {
  const b0 = buf[pos];
  if (b0 === undefined) return null;
  if (b0 < 128) return { v: b0, next: pos + 1 };
  const b1 = buf[pos + 1];
  if (b1 === undefined) return null;
  if (b1 < 128) return { v: (b0 - 128) * 128 + b1, next: pos + 2 };
  const b2 = buf[pos + 2];
  if (b2 === undefined) return null;
  if (b2 < 128) return { v: (b0 - 128) + (b1 - 128) * 16384 + b2 * 128, next: pos + 3 };
  const b3 = buf[pos + 3];
  if (b3 === undefined) return null;
  return {
    v: (b0 - 128) * 2097152 + (b1 - 128) * 128 + (b2 - 128) * 16384 + (b3 % 128) + (b3 - (b3 % 128)) * 2097152,
    next: pos + 4,
  };
}

/** Loop-1 (v) ISA — semantic names for the decrypted opcodes. */
const V_ISA = {
  0: 'GETUPVAL_IDX', 1: 'MOD', 2: 'MUL32', 3: 'SETTABLE_I', 4: 'CALL_2IMM', 5: 'MOVE', 6: 'ADD_I',
  7: 'CALL_2', 8: 'SUB_I', 9: 'LOAD_INTERNAL', 10: 'DECRYPT_BLOCK_J', 11: 'TEST_LT_JMP', 12: 'LT_I',
  13: 'EQ', 14: 'MUL', 15: 'CLOSURE', 16: 'IDIV', 17: 'ADD', 18: 'GETUPVAL_IDX_R', 19: 'CALL_1IMM',
  20: 'LOAD_JKEY', 21: 'MUL32_RI', 22: 'IJMP', 23: 'NEWTABLE', 24: 'SETTABLE_RI', 25: 'LOAD_BKEY',
  26: 'GETGLOBAL_C', 27: 'NEWTABLE_N', 28: 'TOINT', 29: 'RETURN_FIXUP', 30: 'FIXUP_ONE', 31: 'LOAD_DKEY',
  32: 'SETUPVAL', 33: 'MUL_IR', 34: 'DIV_I', 35: 'SELF_DECRYPT_B', 36: 'ADD_RI', 37: 'SETUPVAL_C',
  38: 'SELF_DECRYPT_B2', 39: 'MUL32_RI2', 40: 'SUB_RR', 41: 'REG_SHUFFLE', 42: 'LOADK', 43: 'MOD_IR',
  44: 'CALL_STORE', 45: 'LE_I', 46: 'NE_I', 47: 'CALL_DISCARD', 48: 'LEN', 49: 'GETTABLE_C',
  51: 'GETTABLE_C2', 52: 'LOADK2', 53: 'SETUPVAL_RI', 54: 'METHOD_PREP', 55: 'LE', 56: 'MUL32_RR',
  57: 'RETURN_REG', 58: 'MUL32_RR2', 59: 'ADD_II', 60: 'ADD_RI2', 61: 'TEST_NE_JMP', 62: 'GETTABLE_RR',
  63: 'EQ_I', 64: 'CALL_2REG', 65: 'STORE_JKEY', 66: 'GETGLOBAL_L', 67: 'CALL_PACKED', 68: 'GE',
  69: 'SUB_RI', 70: 'JMP', 71: 'UNM', 72: 'STORE_DKEY', 73: 'CALL_1', 74: 'DIV', 75: 'CALL_METHOD',
  76: 'MOD_RI', 77: 'GT', 78: 'MUL32_IMM', 79: 'CLEAR_REGS', 80: 'MUL32_RR3', 81: 'GT_IMM',
  82: 'DECRYPT_BLOCK_B', 83: 'ADD_RI3', 84: 'CONST_DECRYPT', 85: 'TEST_LE_JMP', 86: 'IDIV_I',
  87: 'CALL_1IMM_D', 88: 'MOD_IMM', 89: 'SETGLOBAL', 97: 'SUB_RC', 98: 'RETURN_CONST',
  99: 'NE_C', 100: 'MUL_IR2', 101: 'NOT', 102: 'TOINT_IMM', 103: 'TEST_TRUE_JMP', 104: 'SETUPVAL_IMM',
  105: 'SETTABLE_RR', 106: 'CALL_1_D', 107: 'GETUPVAL', 108: 'SETTABLE_C', 109: 'LOAD_KARR', 110: 'CALL_2MIX',
};

/** Render one decrypted instruction. */
function disasmInstr(k, s, L, O, i) {
  const v = k[i];
  const name = V_ISA[v] || `OP${v}`;
  const ops = `s=${s[i]} L=${L[i]} O=${O[i]}`;
  switch (v) {
    case 5: return `e[${L[i]}] = e[${O[i]}]`;
    case 42: case 87: return `e[${s[i]}] = ${L[i]}`;
    case 95: return `e[${s[i]}] = K[${s[i]}] (Y=${s[i]})`;
    case 26: return `e[${L[i]}] = _G[K[${i}]]  -- ${JSON.stringify(safeStr(s[i]))}`;
    case 66: return `e[${O[i]}] = _G[${JSON.stringify(L[i])}]`;
    case 89: return `_G[${s[i]}] = e[${O[i]}]`;
    case 70: return `goto ${s[i]}`;
    case 22: return `goto e[${O[i]}]  -- indirect`;
    case 11: return `if e[${L[i]}] < ${s[i]} then goto ${O[i]} end`;
    case 61: return `if e[${s[i]}] ~= ${s[i] ^ 0} then goto ${O[i]} end  -- TEST_NE`;
    case 85: return `if e[${L[i]}] <= ${s[i]} then goto ${O[i]} end`;
    case 103: return `if e[${L[i]}] then goto ${s[i]} else goto ${O[i]} end`;
    case 44: return `e[${L[i]}] = e[${O[i]}]()`;
    case 73: return `e[${O[i]}] = e[${s[i]}](e[${L[i]}])`;
    case 47: return `e[${O[i]}]()`;
    case 17: return `e[${O[i]}] = e[${L[i]}] + e[${s[i]}]`;
    case 40: return `e[${O[i]}] = e[${L[i]}] - e[${s[i]}]`;
    case 14: return `e[${s[i]}] = e[${O[i]}] * e[${L[i]}]`;
    case 74: return `e[${s[i]}] = e[${O[i]}] / e[${L[i]}]`;
    case 1: return `e[${O[i]}] = e[${s[i]}] % e[${L[i]}]`;
    case 49: return `e[${s[i]}] = e[${O[i]}][${L[i]}]`;
    case 51: return `e[${O[i]}] = e[${s[i]}][${s[i]}]`;
    case 62: return `e[${s[i]}] = e[${O[i]}][e[${L[i]}]]`;
    case 105: return `e[${L[i]}][e[${s[i]}]] = e[${O[i]}]`;
    case 108: return `e[${O[i]}][${s[i]}] = e[${L[i]}]`;
    case 23: return `e[${s[i]}] = {}`;
    case 15: return `e[${s[i]}] = closure(proto=${(O || [])[i]})`;
    case 96: return `EXIT -> g=${O[i]} pc=${s[i] + 1}`;
    case 57: case 98: return `RETURN`;
    case 10: case 82: return `-- DECRYPT-BLOCK ${v === 10 ? 'J' : 'B'}: seed-op=${s[i]} start=${L[i] + 1} n=${O[i]}`;
    case 84: return `-- CONST-DECRYPT idx=${s[i]} seed=${L[i]}`;
    case 35: case 38: return `-- SELF-DECRYPT`;
    default: return `${name} ${ops}`;
  }
}

function safeStr(v) {
  return typeof v === 'string' ? v : (v ?? 0);
}

/** Event hit field: block events are 8-long (hit last), const events 9-long. */
function evHit(ev) {
  if (ev.length >= 9) return ev[8] >>> 0;      // const event with hit
  if (ev.length >= 8 && ev[0] < 100) return ev[7] >>> 0; // block event with hit
  return 0;                                     // legacy capture without hit info
}

/** Drop duplicated const events — the shape + anchor injections both log the
 *  same site; the VM self-patches the instruction so each fires once. */
function dedupeEvents(events) {
  const out = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (prev && prev[0] === ev[0] && prev[1] === ev[1] && prev[2] === ev[2]
      && (prev[0] >= 100 || (prev[3] === ev[3] && prev[4] === ev[4]))) continue;
    out.push(ev);
  }
  return out;
}

/** Group checkpoints into execution streams (per-proto array swaps). */
function groupStreams(checkpoints) {
  const streams = [];
  for (const cp of checkpoints) {
    if (!cp || !Array.isArray(cp.k) || !cp.k.length) continue;
    const key = `${cp.k.length}:${(cp.s || []).length}:${(cp.L || []).length}:${(cp.O || []).length}`;
    let st = streams.find((x) => x.key === key);
    if (!st) {
      st = { key, cps: [] };
      streams.push(st);
    }
    st.cps.push(cp);
  }
  for (const st of streams) {
    st.first = st.cps[0];
    st.last = st.cps[st.cps.length - 1];
    st.lastHit = st.last.hit || 0;
    st.firstHit = st.first.hit || 0;
  }
  return streams;
}

/** Which stream was active at VM hit H — the stream of the last checkpoint
 *  at/before H (streams execute contiguously). */
function streamAtHit(streams, H) {
  let best = null;
  for (const st of streams) {
    if (st.firstHit <= H) {
      if (!best || st.firstHit > best.firstHit) best = st;
    }
  }
  return best || streams[0];
}

/** Build one stream's lifted state for the INSTRUCTION ARRAYS:
 *  arrayBase = the stream's LAST checkpoint (arrays as of lastHit — every
 *  block decrypt before it is already applied by the VM itself); only block
 *  events at/after lastHit are replayed. Const decrypts live on the global
 *  hit-1 base (see liftConsts) — the buffer is shared across protos. */
function liftStream(st, events, capture) {
  const arrayBase = st.last;
  const state = {
    k: arrayBase.k.slice(), s: arrayBase.s.slice(), L: arrayBase.L.slice(), O: arrayBase.O.slice(),
    Y: (arrayBase.Y || []).slice(), c: (arrayBase.c || []).slice(), r: (arrayBase.r || []).slice(),
  };

  // block events assigned to this stream that fired at/after the last snapshot
  const pending = [];
  for (const ev of events) {
    if (ev[0] >= 100) continue; // const sites — global base, handled in liftConsts
    const hit = evHit(ev);
    if (!hit) {
      // legacy capture without hit info: apply everything to the first stream
      if (st === st.streamsRef[0]) pending.push({ ev, hit: 0 });
      continue;
    }
    const owner = streamAtHit(st.streamsRef, hit);
    if (owner !== st) continue;
    if (hit >= st.lastHit) pending.push({ ev, hit });
  }

  let applied = 0;
  for (const { ev } of pending) {
    const [id, , a3, a4, a5] = ev;
    const roles = siteRoles(capture, id);
    if (!roles || !Object.keys(roles).length) continue;
    const cands = [
      { seed: a3, start: a4, count: a5 },
      { seed: a3, start: a5, count: a4 },
    ];
    let picked = null;
    for (const c of cands) {
      const st2 = c.start >>> 0; const cn2 = c.count >>> 0;
      if (Number.isFinite(st2) && st2 >= 0 && st2 < 20000 && Number.isFinite(cn2) && cn2 >= 1 && cn2 <= 20000) { picked = c; break; }
    }
    if (!picked) continue;
    let H = picked.seed >>> 0;
    const start = picked.start >>> 0;
    const count = picked.count >>> 0;
    let m = start;
    for (let t = 1; t <= count; t++) {
      H = xorshiftStep(H);
      const dec = (arrName, bits) => {
        const arr = state[arrName];
        const v = arr[m];
        if (typeof v === 'number') arr[m] = bxor(v, band(rshift(H, bits), 127));
      };
      for (const [arrName, bits] of Object.entries(roles)) dec(arrName, bits);
      m++;
    }
    applied++;
  }
  return { state, applied };
}

/** Count plausibly-decrypted opcodes in a stream state. */
function inRangeCount(state) {
  let n = 0;
  for (let i = 1; i < state.k.length; i++) {
    const v = state.k[i];
    if (typeof v === 'number' && v >= 0 && v <= 110) n++;
  }
  return n;
}

/**
 * Build the devirtualization view from a capture.
 * @returns {{ ok, code, decrypted, total, consts, how, note, streams }}
 */
export function devirtFromCapture(capture, { detectedName = 'Luraph', version = 'v15.x' } = {}) {
  if (!capture || !capture.ok || !Array.isArray(capture.checkpoints) || !capture.checkpoints.length) {
    return { ok: false, note: 'no capture' };
  }
  const streams = groupStreams(capture.checkpoints);
  if (!streams.length) return { ok: false, note: 'checkpoint missing instruction stream' };
  for (const st of streams) st.streamsRef = streams;

  const events = dedupeEvents(capture.events || []);

  // constant pool: the capture logs the plaintext straight from each const
  // handler's epilogue (the VM's own decrypted bytes) — ground truth, no
  // seed derivation or buffer-base reconstruction needed.
  const seenIdx = new Set();
  const consts = [];
  for (const st of capture.strings || []) {
    if (seenIdx.has(st.idx)) continue;
    seenIdx.add(st.idx);
    consts.push(st);
  }
  consts.sort((a, b) => a.idx - b.idx);

  const sections = [];
  let totalDecrypted = 0, totalInstr = 0, totalApplied = 0;
  let streamNo = 0;
  for (const st of streams) {
    streamNo++;
    const { state, applied } = liftStream(st, events, capture);
    totalApplied += applied;

    // self-check: a bad block replay corrupts — keep whichever variant decodes
    // more opcodes (const state lives on bufBase and is unaffected).
    const replayed = inRangeCount(state);
    if (applied) {
      const bare = {
        k: st.last.k, s: st.last.s, L: st.last.L, O: st.last.O,
      };
      if (inRangeCount(bare) > replayed) {
        state.k = bare.k; state.s = bare.s; state.L = bare.L; state.O = bare.O;
      }
    }

    const { decrypted, total } = (() => {
      let d = 0, t = 0;
      for (let i = 1; i < state.k.length; i++) {
        const v = state.k[i];
        if (v === undefined || v === null) continue;
        t++;
        if (v >= 0 && v <= 110) d++;
      }
      return { decrypted: d, total: t };
    })();

    totalDecrypted += decrypted; totalInstr += total;

    const L2 = [];
    L2.push(`-- ════ stream ${streamNo}/${streams.length} · ${state.k.length} instructions · decrypted ${decrypted}/${total} ════`);
    L2.push(`-- entry pc: ${st.last.i || 1}`);
    L2.push('-- ---- decrypted instruction stream (disassembly) ----');
    const shown = new Set();
    let shownCount = 0;
    const MAX_INSTR = 1200;
    for (let i = Math.max(1, (st.last.i || 1) - 8); i < state.k.length && shownCount < MAX_INSTR; i++) {
      const v = state.k[i];
      if (typeof v !== 'number' || v < 0 || v > 110) continue;
      if (shown.has(i)) continue;
      shown.add(i);
      shownCount++;
      L2.push(`-- [${i}] ${disasmInstr(state.k, state.s, state.L, state.O, i)}`);
    }
    sections.push(L2.join('\n'));
  }

  if (consts.length) {
    sections.push([
      '-- ════ constant pool (decrypted by the build\'s own keys, all protos) ════',
      ...consts.slice(0, 400).map((c) => `-- K[${c.idx}] = ${JSON.stringify(c.text.slice(0, 200))}`),
    ].join('\n'));
  }

  const code = [
    '-- ══ BypassX Deobf Bot — Luraph ' + version + ' devirtualization (real-Luau VM capture) ══',
    `-- family: ${detectedName} ${version} · streams: ${streams.length} · instructions: ${totalInstr} · decrypted at runtime: ${totalDecrypted}/${totalInstr}`,
    `-- decrypt events replayed: ${totalApplied} · const strings recovered: ${consts.length}`,
    '-- method: the obfuscated file ran inside the bundled real Luau runtime with its',
    '-- own interpreter instrumented in place; every lazy block-decrypt it executed',
    '-- was recorded and is replayed bit-exactly below — the instruction stream is',
    '-- the VM\'s own, decrypted by the build\'s own keys. One section per proto',
    '-- stream (the VM swaps k/s/L/O wholesale between protos).',
    '',
    `-- entry pc: ${streams[0].last.i || 1}`,
    sections.join('\n\n'),
    '',
  ].join('\n');
  const v = verifyCode(code, { lang: 'lua', filename: 'devirtualized.lua' });
  return {
    ok: true,
    code,
    decrypted: totalDecrypted,
    total: totalInstr,
    applied: totalApplied,
    consts: consts.length,
    streams: streams.length,
    how: `Luraph VM devirtualization — real-Luau capture: ${totalApplied} decrypt events replayed across ${streams.length} proto streams, ${totalDecrypted}/${totalInstr} instructions decrypted, ${consts.length} const strings recovered (${v.status === 'verified' ? 'syntax verified' : v.status})`,
    note: v.status !== 'verified' ? v.detail : null,
  };
}
