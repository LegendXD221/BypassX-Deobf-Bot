/**
 * BypassX Deobf Bot — Xfuscator v1: the in-house Lua obfuscator.
 *
 * Layer stack (every layer is semantics-preserving and verified):
 *   1. input validation — refuse non-text, over-limit, and non-Lua input
 *   2. string-table extraction — short plain string literals move into an
 *      encrypted string table (per-build XOR key chain); literals become
 *      YF[n] lookups fed by a runtime decoder. Skipped for files that use
 *      long-bracket strings, backticks, or too many literals.
 *   3. number encoding — safe numeric literals become opaque arithmetic
 *      expressions built from per-build constants (string spans protected)
 *   4. full-body encryption — the whole program is XOR-encrypted with a
 *      per-build rolling key and emitted as a self-contained loader:
 *      integrity gate (position-weighted checksum) → decrypt → loadstring →
 *      call with varargs forwarded. Anti-tamper junk state machines pad it.
 *
 * Output always starts with the Xfuscator signature header:
 *   -- This File Was Obfuscated By Xfuscator (v1). discord- https://dc.gg/bypassx
 *
 * Portability rules (the loader must run on Lua 5.1 executors AND Luau):
 *   - bitwise work goes through bit32.bxor / bit32.band (both worlds have it)
 *   - no table.create / no integer division / no goto / no bitwise operators
 *   - checksum multiplies stay under 2^53 (position factor ≤ 251 × byte ≤ 255)
 *   - the blob round-trips byte-exact in JS before anything is emitted
 */
import { BYPASSX_HEADING_XF } from './xf-header.js';

export const XFUL_VERSION = 'v1';

// ---------- per-build PRNG (xorshift32) --------------------------------------
function makeRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

// ---------- shared checksum (identical math in JS and Lua) --------------------
// sum = Σ( byte_i × ((i-1) mod 251 + 1) ) mod 2^32
export function xfChecksum(bytes) {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) {
    h = (h + bytes[i] * ((i % 251) + 1)) >>> 0;
  }
  return h >>> 0;
}

function xorBytes(bytes, keys) {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ^ keys[i % keys.length]) & 0xff;
  return out;
}

function blobLiteral(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b >= 32 && b < 127 && b !== 0x22 && b !== 0x5c) out += String.fromCharCode(b);
    else out += '\\' + String(b).padStart(3, '0');
  }
  return out;
}

function luaQuote(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 32 || c > 126) out += '\\' + c;
    else out += ch;
  }
  return out + '"';
}

function junkStateMachine(name, rng) {
  // opaque predicate: loop body runs exactly once, affects nothing
  const a = (rng() & 0xffff) + 1;
  const b = (rng() & 0xffff) + 1;
  return `local ${name}=0;while ${name}<(${a}*1+${b}-1-${b})do ${name}=${name}+1 end;`;
}

// ---------- string scanning (spans for every literal) -------------------------
function stringSpans(src) {
  const spans = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      // comment — skip long-bracket comments fully, line comments to EOL
      if (src[i + 2] === '[') {
        const m = /^-\-\[(=*)\[/.exec(src.slice(i));
        if (m) {
          const close = ']' + m[1] + ']';
          const end = src.indexOf(close, i + m[0].length);
          i = end === -1 ? n : end + close.length;
          continue;
        }
      }
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') { break; }
        j++;
      }
      spans.push({ open: i, close: Math.min(j, n - 1) });
      i = j + 1;
      continue;
    }
    if (c === '[' && src[i + 1] === '[' || (c === '[' && /^\[(=*)\[/.test(src.slice(i)))) {
      const m = /^\[(=*)\[/.exec(src.slice(i));
      if (m) {
        const close = ']' + m[1] + ']';
        const end = src.indexOf(close, i + m[0].length);
        spans.push({ open: i, close: end === -1 ? n - 1 : end + close.length - 1 });
        i = (end === -1 ? n : end + close.length);
        continue;
      }
    }
    i++;
  }
  return spans;
}

const inSpans = (pos, spans) => spans.some((s) => pos >= s.open && pos <= s.close);

// collect SHORT plain strings safe for extraction (no escapes, no newlines)
function collectStrings(src, spans) {
  const out = [];
  const re = /"([^"\\\n]{1,80})"|'([^'\\\n]{1,80})'/g;
  let m;
  while ((m = re.exec(src))) {
    if (inSpans(m.index, spans) && !isExactSpan(spans, m.index)) continue;
    const val = m[1] !== undefined ? m[1] : m[2];
    out.push({ val, at: m.index, len: m[0].length });
  }
  return out;
}
function isExactSpan(spans, at) {
  return spans.some((s) => s.open === at);
}

// ---------- main entry --------------------------------------------------------
/**
 * Obfuscate Lua source with Xfuscator v1.
 * @param {string} source original Lua/Luau source
 * @param {{ seed?: number, version?: string }} opts
 * @returns {{ ok: boolean, code?: string, error?: string, meta?: object }}
 */
export function xfuscate(source, opts = {}) {
  const src = String(source || '');
  const meta = { version: XFUL_VERSION, inBytes: src.length };
  if (!src.trim()) return { ok: false, error: 'empty input' };
  if (/[\u0000-\u0008\u000e-\u001f]/.test(src.slice(0, 2048))) {
    return { ok: false, error: 'binary input — Xfuscator works on text Lua only' };
  }
  if (src.length > 4 * 1024 * 1024) return { ok: false, error: 'input over 4MB' };
  if (/^\s*(?:--|local function|function)?/i.test(src) && !/[=({]/.test(src.slice(0, 400))) {
    return { ok: false, error: 'input does not look like Lua code' };
  }

  const seed = (opts.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
  meta.seed = opts.seed ?? null;
  const rng = makeRng(seed);
  const version = opts.version || XFUL_VERSION;

  const spans = stringSpans(src);

  // ---- layer 2: string table (conservative full case) ----
  let body = src;
  const strings = collectStrings(src, spans);
  const canExtract = strings.length > 0 && strings.length <= 4000
    && !src.includes('`')
    && !/\[(=*)\[/.test(src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, ''));
  if (canExtract) {
    const keyCount = strings.length * 2 + 8;
    const keys = [];
    for (let i = 0; i < keyCount; i++) keys.push(rng() & 0xff);
    // per-build table names — never collide with identifiers in the user's code
    const tag = (rng() & 0xfffff).toString(36) + (rng() & 0xfffff).toString(36);
    const TBL = 'YF' + tag;
    const DEC = 'YFD' + tag;
    const uniq = new Map();
    const tableRows = [];
    const uses = [];
    for (const s of strings) {
      let idx = uniq.get(s.val);
      if (idx === undefined) {
        idx = uniq.size;
        uniq.set(s.val, idx);
        const k = keys[(idx * 2 + 3) % keys.length];
        const enc = Buffer.from(s.val, 'latin1');
        const shifted = Buffer.alloc(enc.length);
        for (let i = 0; i < enc.length; i++) shifted[i] = (enc[i] ^ k) & 0xff;
        tableRows.push(`${TBL}[${idx + 1}]=${DEC}("${blobLiteral(shifted)}",${k});`);
      }
      uses.push({ at: s.at, len: s.len, idx });
    }
    const decoder = `local ${TBL}={} local ${DEC}=function(s,k)local o={}for i=1,#s do o[i]=string.char(bit32.bxor(string.byte(s,i),k)) end return table.concat(o) end;`;
    // splice right-to-left so offsets stay valid
    uses.sort((x, y) => y.at - x.at);
    for (const u of uses) body = body.slice(0, u.at) + `${TBL}[${u.idx + 1}]` + body.slice(u.at + u.len);
    meta.strings = { extracted: uses.length, unique: uniq.size };
    globalThis.__XF_DECODER = decoder + tableRows.join('');
  } else {
    meta.strings = { extracted: 0, unique: 0 };
    globalThis.__XF_DECODER = null;
  }

  // ---- layer 3: number encoding (span-protected, user source only —
  // MUST run before the decoder/table block is prepended, or the \ddd
  // escapes in the table rows get corrupted) ----
  let numCount = 0;
  const numRe = /(\b\d+\b|\b0[xX][0-9a-fA-F]+\b)/g;
  const numHits = [];
  let m;
  while ((m = numRe.exec(body))) {
    if (inSpans(m.index, spans)) continue;
    numHits.push({ at: m.index, len: m[0].length, tok: m[0] });
  }
  numHits.sort((a, b) => b.at - a.at);
  for (const h of numHits) {
    if (h.tok.length > 9) continue;
    const dec = h.tok.toLowerCase().startsWith('0x') ? parseInt(h.tok, 16) : Number(h.tok);
    if (!Number.isFinite(dec) || dec > 0xffffffff) continue;
    const a = (rng() & 0xffff) + 1;
    const b = (rng() & 0xff) + 2;
    const c = Math.floor(dec / b) - a;
    const r = dec - (a + b * c);
    const enc = r === 0 ? `(${a}+${b}*(${c}))` : `(${a}+${b}*(${c})+${r})`;
    body = body.slice(0, h.at) + enc + body.slice(h.at + h.len);
    numCount++;
  }
  meta.numbersEncoded = numCount;
  if (globalThis.__XF_DECODER) body = globalThis.__XF_DECODER + '\n' + body;
  globalThis.__XF_DECODER = null;

  // ---- layer 4: full-body encrypted loader ----
  const raw = Buffer.from(body, 'latin1');
  const keyCount = 16 + (rng() & 15);
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push((rng() & 0xff) || 1);
  const enc = xorBytes(raw, keys);
  const sum = xfChecksum(raw);
  meta.blob = { rawBytes: raw.length, encBytes: enc.length, keys: keyCount, checksum: sum.toString(16) };

  // JS-side round-trip proof before emitting anything
  const rt = Buffer.from(xorBytes(enc, keys));
  if (!rt.equals(raw)) return { ok: false, error: 'internal: blob round-trip failed' };
  if (xfChecksum(rt) !== sum) return { ok: false, error: 'internal: checksum round-trip failed' };

  const loader = [
    'local XFK={' + keys.join(',') + '};',
    junkStateMachine('xf_a', rng),
    'local XFB="' + blobLiteral(enc) + '";',
    junkStateMachine('xf_e', rng),
    'local XFD=function(b)local o={}for i=1,#b do o[i]=string.char(bit32.bxor(string.byte(b,i),XFK[(i-1)%#XFK+1])) end return table.concat(o) end;',
    'local XFC=function(b)local h=0 for i=1,#b do h=bit32.band(h+bit32.band(string.byte(b,i)*(((i-1)%251)+1),4294967295),4294967295) end return h end;',
    junkStateMachine('xf_g', rng),
    'local XD=XFD(XFB);',
    `if XFC(XD)~=${sum} then error("xf: integrity check failed") end`,
    junkStateMachine('xf_h', rng),
    'local XF=loadstring(XD);',
    'if not XF then error("xf: payload load failed") end',
    'return XF(...)',
  ].join('\n');

  const code = BYPASSX_HEADING_XF.replace('%V', version) + '\n' + loader + '\n';
  meta.outBytes = code.length;
  return { ok: true, code, meta };
}
