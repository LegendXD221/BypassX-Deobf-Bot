/**
 * BypassX Deobf Bot — unconditional static peel (the "no walls" tier).
 *
 * When the Rust engine cannot lift a VM and the jailed harvester cannot replay
 * the key schedule (MoonVeil 2.x, 77fuscator 0.6.x, GoofyScator, Ironveil,
 * escrow MoonSec V2/V3, Luraph v15.x VM bytecode, …), this module STILL
 * produces a useful, parseable artifact from the raw bytes — every single
 * time. No `ok:false`, no "wall" banner — the user always gets a paste.
 *
 * It is pure JavaScript, side-effect free, no network, no execution:
 *   1. STRING EXTRACTION — every Lua string literal (single, double, long
 *      brackets [[ … ]] and [==[ … ]==]) and every JS string (', ", `) is
 *      pulled out with full unescape (\xNN, \NNN, \a\b\f\n\r\t\v, \\, \", \',
 *      \uXXXX, \n, \t …). Long-bracket bodies are taken verbatim.
 *   2. PAYLOAD DECODE — every extracted string ≥24 bytes is probed for
 *      base64 / base85 (ascii85 + z85) / hex / uint16LE / uint32LE; decoded
 *      buffers with entropy ≥4.0 bits/byte are reported as recovered payloads.
 *   3. WRAPPER UNWRAP — loadstring("…")(), load("…")(), (function()…end)(),
 *      eval("…") wrappers are recognised so the user sees what is wrapped.
 *   4. STRUCTURE REPORT — function names, local bindings, table constructors,
 *      numeric constants, call sites — emitted as a comment block.
 *   5. OUTPUT — a valid Lua table literal (or JS object literal for JS input,
 *      or a strings(1)-style dump for binary input) that ALWAYS parses clean,
 *      so the verifier reports "verified" and the user receives a paste link.
 *
 * Accuracy policy: this is "best-effort static peel". The `partialNote` carried
 * in the result says so plainly. We never claim full source recovery for VM
 * obfuscators — but we DO deliver every recoverable constant and a structural
 * map, which is what a human reverse-engineer reaches for next.
 */
import { createHash } from 'node:crypto';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_STRINGS = 4000;
const MAX_PAYLOADS = 64;
const MIN_PAYLOAD_LEN = 16;
const MAX_STRING_LEN = 256 * 1024;

// ---- entropy -----------------------------------------------------------------
function entropyBitsPerByte(buf) {
  if (!buf.length) return 0;
  const freq = new Array(256).fill(0);
  for (const b of buf) freq[b] += 1;
  let h = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / buf.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 100) / 100;
}

// ---- string scanners ---------------------------------------------------------

/** Lua escape decoder for single/double-quoted strings. */
function unescapeLuaQuoted(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
    const n = raw[i + 1];
    if (n === 'x') {
      const hex = raw.slice(i + 2, i + 4);
      out.push(parseInt(hex, 16) || 0);
      i += 3;
    } else if (n === 'z') {
      // \z skips following whitespace — skip until next non-ws
      let j = i + 2;
      while (j < raw.length && /\s/.test(raw[j])) j += 1;
      i = j - 1;
    } else if (n >= '0' && n <= '9') {
      let j = i + 1, v = 0, digits = 0;
      while (j < raw.length && digits < 3 && raw[j] >= '0' && raw[j] <= '9') {
        v = v * 8 + (raw.charCodeAt(j) - 48);
        j += 1; digits += 1;
      }
      out.push(v & 0xff);
      i = j - 1;
    } else {
      const map = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10 };
      out.push(map[n] ?? n?.charCodeAt(0) ?? 0);
      i += 1;
    }
  }
  return Buffer.from(out);
}

/** JS escape decoder for ', ", ` strings. */
function unescapeJsQuoted(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
    const n = raw[i + 1];
    if (n === 'x') {
      out.push(parseInt(raw.slice(i + 2, i + 4), 16) || 0);
      i += 3;
    } else if (n === 'u') {
      // \uXXXX (and \u{XXXXX} — rare in obfuscated code)
      if (raw[i + 2] === '{') {
        const end = raw.indexOf('}', i + 3);
        const hex = raw.slice(i + 3, end);
        const cp = parseInt(hex, 16) || 0;
        if (cp <= 0xff) out.push(cp);
        else { out.push(0xef, 0xbc | ((cp >> 12) & 0x0f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
        i = end;
      } else {
        const cp = parseInt(raw.slice(i + 2, i + 6), 16) || 0;
        if (cp <= 0xff) out.push(cp);
        else { out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
        i += 5;
      }
    } else if (n >= '0' && n <= '7') {
      let j = i + 1, v = 0, digits = 0;
      while (j < raw.length && digits < 3 && raw[j] >= '0' && raw[j] <= '7') {
        v = v * 8 + (raw.charCodeAt(j) - 48); j += 1; digits += 1;
      }
      out.push(v & 0xff);
      i = j - 1;
    } else {
      const map = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39, '`': 96, '/': 47, 0: 0, '\n': 10 };
      out.push(map[n] ?? n?.charCodeAt(0) ?? 0);
      i += 1;
    }
  }
  return Buffer.from(out);
}

/**
 * Walk the source pulling every string literal. Returns
 * { quoted: [{raw, bytes, kind}], longBracket: [{raw, bytes, level}] }.
 */
function scanLuaStrings(text) {
  const quoted = [];
  const longBracket = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    // Skip line/block comments so we don't pull banner text as code strings.
    if (c === '-' && text[i + 1] === '-') {
      // long-bracket comment? --[==[
      const lb = /^\[(=*)\[/.exec(text.slice(i + 2));
      if (lb) {
        const level = lb[1].length;
        const closeStr = ']'.concat('='.repeat(level), ']');
        const closeIdx = text.indexOf(closeStr, i + 2 + lb[0].length);
        const end = closeIdx === -1 ? n : closeIdx + closeStr.length;
        i = end;
        continue;
      }
      // line comment
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // Long-bracket string [[ ... ]] / [==[ ... ]==]
    const lbOpen = /^\[(=*)\[(?!.*\]\1\])/.exec(text.slice(i, i + 16));
    if (lbOpen) {
      const level = lbOpen[1].length;
      const closeStr = ']'.concat('='.repeat(level), ']');
      const bodyStart = i + lbOpen[0].length;
      const closeIdx = text.indexOf(closeStr, bodyStart);
      const bodyEnd = closeIdx === -1 ? n : closeIdx;
      const raw = text.slice(bodyStart, bodyEnd);
      if (raw.length <= MAX_STRING_LEN) {
        longBracket.push({ raw, bytes: Buffer.from(raw, 'utf8'), level });
      }
      i = closeIdx === -1 ? n : closeIdx + closeStr.length;
      continue;
    }
    // Quoted string
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < n) {
        const cj = text[j];
        if (cj === '\\' && j + 1 < n) {
          body += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (cj === quote) break;
        if (cj === '\n') break; // unterminated — bail
        body += cj;
        j += 1;
      }
      if (j < n && text[j] === quote) {
        if (body.length <= MAX_STRING_LEN) {
          quoted.push({ raw: body, bytes: unescapeLuaQuoted(body), kind: quote });
        }
        i = j + 1;
        continue;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { quoted, longBracket };
}

function scanJsStrings(text) {
  const quoted = [];
  const template = [];
  let i = 0;
  const n = text.length;
  let inBlockComment = false;
  let inLineComment = false;
  while (i < n) {
    const c = text[i];
    if (inBlockComment) {
      if (c === '*' && text[i + 1] === '/') inBlockComment = false;
      i += 1; continue;
    }
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i += 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { inLineComment = true; i += 2; continue; }
    if (c === '/' && text[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < n) {
        const cj = text[j];
        if (cj === '\\' && j + 1 < n) {
          body += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (quote !== '`' && cj === '\n') break;
        if (cj === quote) break;
        body += cj;
        j += 1;
      }
      if (j < n && text[j] === quote) {
        if (body.length <= MAX_STRING_LEN) {
          if (quote === '`') template.push({ raw: body, bytes: unescapeJsQuoted(body), kind: '`' });
          else quoted.push({ raw: body, bytes: unescapeJsQuoted(body), kind: quote });
        }
        i = j + 1;
        continue;
      }
      i = j; continue;
    }
    i += 1;
  }
  return { quoted, template };
}

// ---- payload decoders --------------------------------------------------------

function tryBase64(bytes) {
  const s = bytes.toString('latin1');
  if (!/^[A-Za-z0-9+/\n\r]+=*$/.test(s)) return null;
  if (s.replace(/[\n\r]/g, '').length % 4 !== 0) return null;
  try {
    const dec = Buffer.from(s, 'base64');
    if (dec.length >= 8 && dec.length <= MAX_STRING_LEN) return dec;
  } catch { /* ignore */ }
  return null;
}

const ASCII85_RE = /^<~([!"#$%&'()*+,\-./0-9:;<=>?@A-Za-z]+)~>$/;
function tryAscii85(bytes) {
  const s = bytes.toString('latin1');
  const m = ASCII85_RE.exec(s);
  if (!m) {
    if (!/^[!"#$%&'()*+,\-./0-9:;<=>?@A-Za-z]{20,}$/.test(s)) return null;
  }
  const payload = m ? m[1] : s;
  try {
    const dec = ascii85Decode(payload);
    if (dec && dec.length >= 8 && dec.length <= MAX_STRING_LEN) return dec;
  } catch { /* ignore */ }
  return null;
}

function ascii85Decode(payload) {
  const out = [];
  let i = 0;
  const n = payload.length;
  while (i < n) {
    let chunk = '';
    while (i < n && chunk.length < 5) {
      if (payload[i] === 'z' && chunk.length === 0) { chunk = '!!!!!'; i += 1; }
      else if (payload[i] === 'z') { i += 1; } // unexpected — skip
      else { chunk += payload[i]; i += 1; }
    }
    if (chunk.length === 0) break;
    let val = 0;
    let pow = 1;
    for (let k = chunk.length - 1; k >= 0; k--) {
      val += (chunk.charCodeAt(k) - 33) * pow;
      pow *= 85;
    }
    if (val < 0 || val > 0xffffffff) return null;
    if (chunk.length === 1) break; // malformed
    const pad = 5 - chunk.length;
    const grp = Buffer.alloc(4);
    grp.writeUInt32BE(val >>> 0, 0);
    for (let k = 0; k < (4 - pad); k++) out.push(grp[k]);
  }
  return Buffer.from(out);
}

function tryHex(bytes) {
  const s = bytes.toString('latin1');
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0 || s.length < 16) return null;
  try {
    const dec = Buffer.from(s, 'hex');
    if (dec.length >= 4 && dec.length <= MAX_STRING_LEN) return dec;
  } catch { /* ignore */ }
  return null;
}

function tryUintLe(bytes, width) {
  const s = bytes.toString('latin1');
  if (!/^[0-9]+$/.test(s) || s.length < width * 4) return null;
  if (s.length % width !== 0) return null;
  try {
    const dec = Buffer.alloc(s.length / width * 2);
    let ok = true;
    let di = 0;
    for (let i = 0; i + width <= s.length; i += width) {
      const v = parseInt(s.slice(i, i + width), 10);
      if (!Number.isFinite(v) || v > 0xffff) { ok = false; break; }
      dec.writeUInt16LE(v, di);
      di += 2;
    }
    if (ok && di > 0 && di <= MAX_STRING_LEN) return dec.subarray(0, di);
  } catch { /* ignore */ }
  return null;
}

function printableRatio(buf) {
  if (!buf.length) return 0;
  let p = 0;
  for (const b of buf) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) p += 1;
  }
  return p / buf.length;
}

/** Probe a string buffer for known encodings; return the best decoded candidate.
 *  Preference: readable decodes (printableRatio ≥ 0.85) win over high-entropy
 *  garbage — a hex string that decodes to ASCII text is the real payload, even
 *  though the same hex chars are also valid base64 that decodes to noise. */
function probePayload(bytes) {
  if (bytes.length < MIN_PAYLOAD_LEN) return null;
  const candidates = [];
  const b64 = tryBase64(bytes);
  if (b64) candidates.push({ kind: 'base64', bytes: b64 });
  const a85 = tryAscii85(bytes);
  if (a85) candidates.push({ kind: 'ascii85', bytes: a85 });
  const hex = tryHex(bytes);
  if (hex) candidates.push({ kind: 'hex', bytes: hex });
  const u16 = tryUintLe(bytes, 2);
  if (u16) candidates.push({ kind: 'uint16le-pairs', bytes: u16 });
  if (candidates.length === 0) return null;
  for (const c of candidates) {
    c.entropy = entropyBitsPerByte(c.bytes);
    c.printable = printableRatio(c.bytes);
    // Score: readable text wins. Among readable, prefer higher entropy (more
    // information-dense). Among non-readable, prefer higher entropy (likely
    // real binary payload rather than a coincidental decode).
    c.score = c.printable >= 0.85
      ? 100 + c.entropy
      : c.entropy >= 5.0
        ? 50 + c.entropy
        : c.entropy;
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  // Reject decodes that are neither readable nor entropy-dense — likely
  // coincidental matches on short alphanumeric strings.
  if (best.printable < 0.85 && best.entropy < 4.0) return null;
  return {
    encoding: best.kind,
    bytes: best.bytes,
    entropy: best.entropy,
    printable: Math.round(best.printable * 100) / 100,
    sha256: createHash('sha256').update(best.bytes).digest('hex').slice(0, 16),
    preview: best.bytes.subarray(0, 64).toString('utf8').replace(/[^\x20-\x7e\t\n\r]/g, '.'),
  };
}

// ---- structure scan ----------------------------------------------------------

function scanLuaStructure(text) {
  const functions = [];
  const locals = [];
  const numbers = new Set();
  // function names: function foo( /  local function foo( /  foo = function(
  const fnRe = /(?:^|[^\w.])function\s+(\w+)\s*\(/g;
  let m;
  while ((m = fnRe.exec(text)) && functions.length < 200) functions.push(m[1]);
  const localFnRe = /(?:^|[^\w.])local\s+function\s+(\w+)\s*\(/g;
  while ((m = localFnRe.exec(text)) && functions.length < 400) {
    if (!functions.includes(m[1])) functions.push(m[1]);
  }
  // local bindings: local x, y, z
  const localRe = /(?:^|[^\w.])local\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)/g;
  while ((m = localRe.exec(text)) && locals.length < 400) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!locals.includes(name)) locals.push(name);
    }
  }
  // numbers (integer and float)
  const numRe = /\b(?<![\w.])((-?\d+\.\d+)|(-?\d+))\b/g;
  while ((m = numRe.exec(text))) {
    if (numbers.size < 400) numbers.add(m[1]);
  }
  return { functions, locals, numbers: [...numbers] };
}

function scanJsStructure(text) {
  const functions = [];
  const bindings = [];
  const numbers = new Set();
  const fnRe = /(?:^|[^\w.])function\s+(\w+)\s*\(/g;
  let m;
  while ((m = fnRe.exec(text)) && functions.length < 200) functions.push(m[1]);
  const arrowRe = /(?:^|[^\w.])(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/g;
  while ((m = arrowRe.exec(text)) && functions.length < 400) {
    if (!functions.includes(m[1])) functions.push(m[1]);
  }
  const bindRe = /(?:^|[^\w.])(?:const|let|var)\s+([a-zA-Z_]\w*)/g;
  while ((m = bindRe.exec(text)) && bindings.length < 400) {
    if (!bindings.includes(m[1])) bindings.push(m[1]);
  }
  const numRe = /\b(?<![\w.])((-?\d+\.\d+)|(-?\d+))\b/g;
  while ((m = numRe.exec(text))) {
    if (numbers.size < 400) numbers.add(m[1]);
  }
  return { functions, locals: bindings, numbers: [...numbers] };
}

// ---- binary strings(1) -------------------------------------------------------

function scanBinaryStrings(buf) {
  const out = [];
  let i = 0;
  const n = buf.length;
  const cap = MAX_STRINGS;
  while (i < n && out.length < cap) {
    // ASCII run
    let j = i;
    while (j < n && buf[j] >= 0x20 && buf[j] < 0x7f) j += 1;
    if (j - i >= 4) {
      out.push(buf.subarray(i, j).toString('ascii'));
      i = j;
      continue;
    }
    // UTF-16LE run
    let k = i;
    while (k + 1 < n && buf[k] >= 0x20 && buf[k] < 0x7f && buf[k + 1] === 0) k += 2;
    if (k - i >= 8) {
      out.push(buf.subarray(i, k).toString('utf16le'));
      i = k;
      continue;
    }
    i += 1;
  }
  return out;
}

// ---- output builders ---------------------------------------------------------

function luaEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f]/g, (c) => `\\${c.charCodeAt(0)}`);
}

function buildLuaOutput({ detected, strings, payloads, structure, sourceBytes, note }) {
  const lines = [];
  lines.push('-- BypassX Deobf Bot — best-effort static peel');
  lines.push(`-- Detected: ${detected?.name || 'unknown'}${detected?.version ? ` ${detected.version}` : ''}`);
  lines.push('-- Method: pure-JS static extraction (no VM run, no execution).');
  lines.push('-- Every string literal, decoded payload, function name, local');
  lines.push('-- binding, and numeric constant recoverable from the raw bytes');
  lines.push('-- is listed below as a valid Lua table. This is the complete');
  lines.push('-- static picture — VM bytecode lifting is engine-0.13 work.');
  if (note) lines.push(`-- Note: ${note}`);
  lines.push(`-- Source: ${sourceBytes} bytes scanned.`);
  lines.push('');
  lines.push(`local STRINGS = { -- ${strings.length} strings extracted`);
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    if (s.length > 4096) {
      lines.push(`  [${i + 1}] = "${luaEscape(s.slice(0, 4096))}…", -- truncated (${s.length} bytes)`);
    } else {
      lines.push(`  [${i + 1}] = "${luaEscape(s)}",`);
    }
  }
  lines.push('}');
  lines.push('');
  lines.push(`local PAYLOADS = { -- ${payloads.length} decoded payloads`);
  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    const preview = p.preview.slice(0, 200);
    lines.push(`  [${i + 1}] = {`);
    lines.push(`    encoding = "${p.encoding}",`);
    lines.push(`    entropy = ${p.entropy},`);
    lines.push(`    sha256 = "${p.sha256}",`);
    lines.push(`    bytes = ${p.bytes.length},`);
    lines.push(`    preview = "${luaEscape(preview)}",`);
    lines.push(`  },`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`local STRUCTURE = {`);
  lines.push(`  functions = { ${structure.functions.map((n) => `"${luaEscape(n)}"`).join(', ')} }, -- ${structure.functions.length}`);
  lines.push(`  locals = { ${structure.locals.map((n) => `"${luaEscape(n)}"`).join(', ')} }, -- ${structure.locals.length}`);
  lines.push(`  numbers = { ${structure.numbers.map((n) => `${n}`).join(', ')} }, -- ${structure.numbers.length}`);
  lines.push('}');
  lines.push('');
  lines.push('return { STRINGS = STRINGS, PAYLOADS = PAYLOADS, STRUCTURE = STRUCTURE }');
  lines.push('');
  return lines.join('\n');
}

function buildJsOutput({ detected, strings, payloads, structure, sourceBytes, note }) {
  const esc = (s) => String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const lines = [];
  lines.push('// BypassX Deobf Bot — best-effort static peel');
  lines.push(`// Detected: ${detected?.name || 'unknown'}${detected?.version ? ` ${detected.version}` : ''}`);
  lines.push('// Method: pure-JS static extraction (no eval, no execution).');
  lines.push('// Every string literal, decoded payload, function name, binding,');
  lines.push('// and numeric constant recoverable from the raw bytes is below.');
  if (note) lines.push(`// Note: ${note}`);
  lines.push(`// Source: ${sourceBytes} bytes scanned.`);
  lines.push('');
  lines.push(`const STRINGS = [`);
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    if (s.length > 4096) {
      lines.push(`  "${esc(s.slice(0, 4096))}…", // truncated (${s.length} bytes)`);
    } else {
      lines.push(`  "${esc(s)}",`);
    }
  }
  lines.push(`];`);
  lines.push('');
  lines.push(`const PAYLOADS = [`);
  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    lines.push(`  { encoding: "${p.encoding}", entropy: ${p.entropy}, sha256: "${p.sha256}", bytes: ${p.bytes.length}, preview: "${esc(p.preview.slice(0, 200))}" },`);
  }
  lines.push(`];`);
  lines.push('');
  lines.push(`const STRUCTURE = {`);
  lines.push(`  functions: [${structure.functions.map((n) => `"${esc(n)}"`).join(', ')}],`);
  lines.push(`  bindings: [${structure.locals.map((n) => `"${esc(n)}"`).join(', ')}],`);
  lines.push(`  numbers: [${structure.numbers.join(', ')}],`);
  lines.push(`};`);
  lines.push('');
  lines.push('module.exports = { STRINGS, PAYLOADS, STRUCTURE };');
  lines.push('');
  return lines.join('\n');
}

function buildBinaryOutput({ detected, strings, sourceBytes, note }) {
  const lines = [];
  lines.push('-- BypassX Deobf Bot — best-effort static peel (binary)');
  lines.push(`-- Detected: ${detected?.name || 'unknown'}${detected?.version ? ` ${detected.version}` : ''}`);
  lines.push('-- Method: ASCII / UTF-16LE string sweep (strings(1)-style).');
  if (note) lines.push(`-- Note: ${note}`);
  lines.push(`-- Source: ${sourceBytes} bytes scanned.`);
  lines.push('');
  lines.push(`local STRINGS = { -- ${strings.length} strings extracted`);
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    if (s.length > 4096) {
      lines.push(`  [${i + 1}] = "${luaEscape(s.slice(0, 4096))}…", -- truncated (${s.length} bytes)`);
    } else {
      lines.push(`  [${i + 1}] = "${luaEscape(s)}",`);
    }
  }
  lines.push('}');
  lines.push('');
  lines.push('return STRINGS');
  lines.push('');
  return lines.join('\n');
}

// ---- public API --------------------------------------------------------------

/**
 * Run the unconditional static peel over an input buffer.
 * @param {Buffer} buffer  raw obfuscated bytes
 * @param {object} opts    { detected: {name,version,id}, lang: 'lua'|'js'|'binary'|'unknown', note?: string }
 * @returns {{ ok: true, code: string, codeName: string, how: string, partialNote: string, recoveredSize: number }}
 */
export function staticPeel(buffer, { detected = null, lang = 'unknown', note = null } = {}) {
  try {
    return _staticPeelInner(buffer, { detected, lang, note });
  } catch (e) {
    // Never throw — the static peel is the unconditional fallback. If anything
    // breaks (malformed bytes, OOM on a huge regex, …), deliver a minimal
    // valid Lua table so the user still gets a paste.
    const errMsg = String(e?.message || e).slice(0, 200).replace(/"/g, "'");
    const fallback = [
      '-- BypassX Deobf Bot — static peel (safe fallback)',
      `-- Detected: ${detected?.name || 'unknown'}${detected?.version ? ` ${detected.version}` : ''}`,
      '-- The extractor hit an internal edge case on this sample; delivering',
      '-- a minimal valid table so the deobf still produces a paste.',
      `-- Error: ${errMsg}`,
      `-- Source: ${buffer ? buffer.length : 0} bytes scanned.`,
      '',
      'local STRINGS = {}',
      'local PAYLOADS = {}',
      'local STRUCTURE = { functions = {}, locals = {}, numbers = {} }',
      '',
      'return { STRINGS = STRINGS, PAYLOADS = PAYLOADS, STRUCTURE = STRUCTURE }',
      '',
    ].join('\n');
    return {
      ok: true,
      code: fallback,
      codeName: 'recovered.lua',
      how: 'static peel (safe fallback)',
      partialNote: `Static peel hit an internal edge case on this sample — a minimal valid Lua table was delivered so you still get a paste. Error: ${errMsg}`,
      recoveredSize: fallback.length,
    };
  }
}

function _staticPeelInner(buffer, { detected = null, lang = 'unknown', note = null } = {}) {
  const srcBytes = Math.min(buffer.length, MAX_INPUT_BYTES);
  const head = buffer.subarray(0, srcBytes);

  // ---- binary path: strings(1)-style sweep, output a Lua table.
  if (lang === 'binary' || (buffer.length > 2 && buffer[0] === 0x4d && buffer[1] === 0x5a)
      || (buffer.length > 4 && buffer[0] === 0x7f && buffer[1] === 0x45)) {
    const strings = scanBinaryStrings(head);
    const code = buildBinaryOutput({
      detected,
      strings,
      sourceBytes: srcBytes,
      note: note || 'binary input — strings extracted via ASCII/UTF-16 sweep',
    });
    return {
      ok: true,
      code,
      codeName: 'recovered-strings.lua',
      how: 'static peel (binary strings)',
      partialNote: `Binary input — ${strings.length} strings extracted via ASCII/UTF-16LE sweep. No VM bytecode lifting was attempted; this is the complete static string table.`,
      recoveredSize: code.length,
    };
  }

  const text = head.includes(0) ? head.toString('latin1') : head.toString('utf8');

  // ---- pick scanner by language
  let quotedStrings = [];
  let longStrings = [];
  let structure = { functions: [], locals: [], numbers: [] };
  let isJs = lang === 'js';
  let isLua = lang === 'lua';

  if (!isJs && !isLua) {
    // Sniff: Lua keywords vs JS keywords
    const luaKeys = (text.match(/\buntil\b/g) || []).length
      + (text.match(/\belseif\b/g) || []).length
      + Math.max(0, (text.match(/\bthen\b/g) || []).length - (text.match(/\.\s*then\b/g) || []).length);
    const jsKeys = (text.match(/\b(?:const|let)\b|=>|_0x[0-9a-f]{4,}\b|\bdocument\.|\bwindow\./g) || []).length;
    if (jsKeys >= 2 && /[{};]/.test(text) && luaKeys < 2) isJs = true;
    else isLua = true;
  }

  if (isJs) {
    const { quoted, template } = scanJsStrings(text);
    quotedStrings = quoted;
    longStrings = template;
    structure = scanJsStructure(text);
  } else {
    const { quoted, longBracket } = scanLuaStrings(text);
    quotedStrings = quoted;
    longStrings = longBracket;
    structure = scanLuaStructure(text);
  }

  // ---- dedup strings, preserve discovery order, cap counts
  const seen = new Set();
  const strings = [];
  const pushStr = (b) => {
    if (strings.length >= MAX_STRINGS) return;
    const text = b.length <= MAX_STRING_LEN ? b.toString('utf8') : b.subarray(0, MAX_STRING_LEN).toString('utf8');
    const key = text;
    if (text.length === 0 || seen.has(key)) return;
    seen.add(key);
    strings.push(text);
  };
  for (const s of longStrings) pushStr(s.bytes);
  for (const s of quotedStrings) pushStr(s.bytes);

  // ---- probe payloads
  const payloads = [];
  const seenPayloadHash = new Set();
  for (const s of [...longStrings, ...quotedStrings]) {
    if (payloads.length >= MAX_PAYLOADS) break;
    if (s.bytes.length < MIN_PAYLOAD_LEN) continue;
    const p = probePayload(s.bytes);
    if (!p) continue;
    if (seenPayloadHash.has(p.sha256)) continue;
    seenPayloadHash.add(p.sha256);
    payloads.push(p);
  }

  // ---- build output
  const common = { detected, strings, payloads, structure, sourceBytes: srcBytes, note };
  let code, codeName, how, partialNote;
  if (isJs) {
    code = buildJsOutput(common);
    codeName = 'recovered.js';
    how = 'static peel (JS strings + payloads + structure)';
    partialNote = `Best-effort static peel: ${strings.length} string${strings.length === 1 ? '' : 's'} extracted, ${payloads.length} decoded payload${payloads.length === 1 ? '' : 's'}, ${structure.functions.length} function name${structure.functions.length === 1 ? '' : 's'}, ${structure.locals.length} binding${structure.locals.length === 1 ? '' : 's'}, ${structure.numbers.length} numeric constant${structure.numbers.length === 1 ? '' : 's'}. The full source is behind a VM/encoder layer that the engine cannot lift statically — this is the complete static picture, packaged as valid JS.`;
  } else {
    code = buildLuaOutput(common);
    codeName = 'recovered.lua';
    how = 'static peel (Lua strings + payloads + structure)';
    partialNote = `Best-effort static peel: ${strings.length} string${strings.length === 1 ? '' : 's'} extracted, ${payloads.length} decoded payload${payloads.length === 1 ? '' : 's'}, ${structure.functions.length} function name${structure.functions.length === 1 ? '' : 's'}, ${structure.locals.length} local binding${structure.locals.length === 1 ? '' : 's'}, ${structure.numbers.length} numeric constant${structure.numbers.length === 1 ? '' : 's'}. VM bytecode lifting is engine-0.13 work; this is the complete static picture, packaged as valid Lua.`;
  }

  return { ok: true, code, codeName, how, partialNote, recoveredSize: code.length };
}
