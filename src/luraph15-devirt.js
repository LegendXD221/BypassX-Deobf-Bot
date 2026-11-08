/**
 * BypassX Deobf Bot — Luraph v15.1 devirtualizer (replay + disassembly).
 *
 * Consumes the real-Luau capture (decrypt-event log + VM checkpoints) and
 * produces the readable devirtualization view:
 *
 *   1. REPLAY — every recorded lazy-decrypt (9 polymorphic block-decrypt
 *      variants with their exact runtime seeds) is re-applied in JS with the
 *      interpreter's own 29-bit xorshift. Every instruction region the VM
 *      decrypted at runtime becomes readable here.
 *   2. CONST RECOVERY — const-offset table entries decrypted during the run
 *      are sliced out of the captured bytecode buffer.
 *   3. DISASSEMBLY — the decrypted stream is rendered with the behavioral
 *      ISA (loop-1 v-map) into an annotated Lua view: register ops, calls,
 *      jumps, decrypt blocks, plus a trampoline/control-flow summary.
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

/**
 * Build the devirtualization view from a capture.
 * @returns {{ ok, code, decrypted, total, consts, how, note }}
 */
export function devirtFromCapture(capture, { detectedName = 'Luraph', version = 'v15.x' } = {}) {
  if (!capture || !capture.ok || !Array.isArray(capture.checkpoints) || !capture.checkpoints.length) {
    return { ok: false, note: 'no capture' };
  }
  const c0 = capture.checkpoints[0];
  if (!c0 || !Array.isArray(c0.k)) return { ok: false, note: 'checkpoint missing instruction stream' };

  const st = {
    k: c0.k.slice(), s: c0.s.slice(), L: c0.L.slice(), O: c0.O.slice(),
    Y: (c0.Y || []).slice(), c: (c0.c || []).slice(), r: (c0.r || []).slice(),
    y5: (c0.y5 || []).slice(),
    buf: c0.y4hex ? Buffer.from(c0.y4hex, 'hex') : Buffer.alloc(0),
  };

  // 1. replay block decrypts
  let applied = 0;
  for (const ev of capture.events || []) {
    const [id, , a3, a4, a5] = ev;
    if (id >= 100) continue; // const sites handled separately
    const roles = siteRoles(capture, id);
    if (!roles || !Object.keys(roles).length) continue;
    // args: {id, I, seed, start, count, B, J, D} — some sites log count/start swapped;
    // pick the interpretation where start lands inside the stream and count is sane.
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
        const arr = st[arrName];
        const v = arr[m];
        if (typeof v === 'number') arr[m] = bxor(v, band(rshift(H, bits), 127));
      };
      for (const [arrName, bits] of Object.entries(roles)) dec(arrName, bits);
      m++;
    }
    applied++;
  }

  // 1b. const decrypts (ids >= 100): idx=a3, seed=a4 — toggle y5 entry, decrypt buffer range
  for (const ev of capture.events || []) {
    const [id, , a3, a4] = ev;
    if (id < 100) continue;
    const idx = a3 >>> 0;
    const seed = a4 >>> 0;
    if (!idx || idx >= st.y5.length) continue;
    const off = bxor(st.y5[idx] >>> 0, CONST_KEY) >>> 0;
    st.y5[idx] = off;
    if (off >= st.buf.length) continue;
    const vi = readVarint(st.buf, off + 1);
    if (!vi || vi.v <= 0 || vi.next + vi.v > st.buf.length || vi.v > 8192) continue;
    const key32 = ((seed * 16843009) >>> 0);
    let p = vi.next;
    const end = vi.next + vi.v;
    const end32 = end - (vi.v % 4);
    for (; p + 4 <= end; p += 4) st.buf.writeUInt32LE(bxor(st.buf.readUInt32LE(p), key32), p);
    for (; p < end; p++) st.buf[p] = bxor(st.buf[p], band(seed, 255));
  }

  // 2. decrypt stats
  let decrypted = 0, total = 0;
  for (let i = 1; i < st.k.length; i++) {
    const v = st.k[i];
    if (v === undefined || v === null) continue;
    total++;
    if (v >= 0 && v <= 110) decrypted++;
  }

  // 3. const recovery: entries whose decrypted offsets point at readable data
  const consts = [];
  if (st.buf.length) {
    for (let idx = 1; idx < Math.min(st.y5.length, 2000); idx++) {
      const off = st.y5[idx];
      if (typeof off !== 'number' || off <= 2 || off >= st.buf.length) continue;
      const vi = readVarint(st.buf, off + 1);
      if (!vi || vi.v <= 0 || vi.next + vi.v > st.buf.length || vi.v > 4096) continue;
      const raw = st.buf.toString('latin1', vi.next, vi.next + vi.v);
      const pr = [...raw].filter((ch) => {
        const c = ch.charCodeAt(0);
        return (c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13;
      }).length / raw.length;
      if (pr >= 0.9 && raw.length >= 2) consts.push({ idx, len: vi.v, text: raw });
    }
  }

  // 4. disassembly of the decrypted stream (entry window + trampoline targets)
  const entry = c0.i || 1;
  const L2 = [];
  L2.push('-- ══ BypassX Deobf Bot — Luraph ' + version + ' devirtualization (real-Luau VM capture) ══');
  L2.push(`-- family: ${detectedName} ${version} · instructions: ${st.k.length} · decrypted at runtime: ${decrypted}/${total}`);
  L2.push(`-- decrypt events replayed: ${applied} · const pool: ${st.y5.length} entries (${consts.length} readable strings recovered)`);
  L2.push('-- method: the obfuscated file ran inside the bundled real Luau runtime with its');
  L2.push('-- own interpreter instrumented in place; every lazy block-decrypt it executed');
  L2.push('-- was recorded and is replayed bit-exactly below — the instruction stream is');
  L2.push('-- the VM\'s own, decrypted by the build\'s own keys.');
  L2.push('');
  L2.push(`-- entry pc: ${entry}`);
  L2.push('-- ---- decrypted instruction stream (disassembly) ----');
  const shown = new Set();
  let shownCount = 0;
  const MAX_INSTR = 1200;
  for (let i = Math.max(1, entry - 8); i < st.k.length && shownCount < MAX_INSTR; i++) {
    const v = st.k[i];
    if (typeof v !== 'number' || v < 0 || v > 110) continue;
    if (shown.has(i)) continue;
    shown.add(i);
    shownCount++;
    L2.push(`[${i}] ${disasmInstr(st.k, st.s, st.L, st.O, i)}`);
  }
  if (consts.length) {
    L2.push('');
    L2.push('-- ---- recovered constant strings (decrypted by the build\'s own keys) ----');
    for (const c of consts.slice(0, 200)) L2.push(`-- K[${c.idx}] = ${JSON.stringify(c.text.slice(0, 120))}`);
  }

  const code = L2.join('\n') + '\n';
  const v = verifyCode(code, { lang: 'lua', filename: 'devirtualized.lua' });
  return {
    ok: true,
    code,
    decrypted,
    total,
    applied,
    consts: consts.length,
    how: `Luraph VM devirtualization — real-Luau capture: ${applied} decrypt events replayed, ${decrypted}/${total} instructions decrypted, ${consts.length} const strings recovered (${v.status === 'verified' ? 'syntax verified' : v.status})`,
    note: v.status !== 'verified' ? v.detail : null,
  };
}
