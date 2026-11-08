/**
 * BypassX Deobf Bot — readability engine (v2.4.0).
 *
 * "Readable" is enforced, not hoped for. After the peel loop recovers source,
 * these verify-gated passes run before delivery:
 *
 *   P1  string-escape decode   "\104\101\108\108\111" → "hello" (printable-only)
 *   P2  literal concat fold    "a" .. "b" → "ab"
 *   P3  small-arith fold       (3 + 4) → 7, (6 - 9) → (-3)
 *   P4  machine-name rename    v0, l_2_5, IlIlI, _0x1f → a, b, c … (scope-safe
 *                              token rename, luaparse-gated, collision-checked)
 *
 * Every pass is individually gated: the result must re-verify at the SAME OR
 * BETTER parse level (fengari real-grammar check), otherwise it is reverted.
 * All functions are pure and never throw.
 *
 * readabilityScore() grades the final text 0–100 so the reply can *prove*
 * readability instead of promising it.
 */

import luaparse from 'luaparse';
import { verifyCode } from './validate.js';

const RANK = { failed: 0, unverifiable: 1, verified: 2 };

/** A pass survives only if the output parses at the same-or-better level. */
function sameOrBetter(before, after) {
  try {
    const a = verifyCode(before, { lang: 'lua', filename: 'r.lua' });
    const b = verifyCode(after, { lang: 'lua', filename: 'r.lua' });
    return (RANK[b.status] ?? 0) >= (RANK[a.status] ?? 0);
  } catch {
    return false;
  }
}

// ---- segment scanner (string/comment aware) ------------------------------------
// Splits Lua source into segments: code, short strings, long strings, comments.
// Transforms apply ONLY to the segment kinds they are safe on.

function scanLuaSegments(src) {
  const segs = [];
  const n = src.length;
  let i = 0;
  let buf = '';
  const flush = (type) => { if (buf) { segs.push({ type, text: buf }); buf = ''; } };

  while (i < n) {
    const ch = src[i];
    // comment?
    if (ch === '-' && src[i + 1] === '-') {
      const lm = /^--\[(=*)\[/.exec(src.slice(i, i + 32));
      if (lm) {
        const close = `]${lm[1]}]`;
        const end = src.indexOf(close, i + 4);
        const stop = end === -1 ? n : end + close.length;
        flush('code'); segs.push({ type: 'comment', text: src.slice(i, stop) }); i = stop;
      } else {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        flush('code'); segs.push({ type: 'comment', text: src.slice(i, stop) }); i = stop;
      }
      continue;
    }
    // long string?
    const ls = /^\[(=*)\[/.exec(src.slice(i, i + 32));
    if (ls) {
      const close = `]${ls[1]}]`;
      const end = src.indexOf(close, i + ls[0].length);
      const stop = end === -1 ? n : end + close.length;
      flush('code'); segs.push({ type: 'longstring', text: src.slice(i, stop) }); i = stop;
      continue;
    }
    // short string?
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === ch || src[j] === '\n') { j += 1; break; }
        else j += 1;
      }
      flush('code'); segs.push({ type: 'string', text: src.slice(i, j) }); i = j;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush('code');
  return segs;
}

function reassemble(segs) {
  return segs.map((s) => s.text).join('');
}

/** Map each segment of the given kinds through fn; reassemble. */
function mapSegments(src, kinds, fn) {
  const segs = scanLuaSegments(src);
  for (const s of segs) {
    if (kinds.includes(s.type)) {
      try { s.text = fn(s.text, s.type); } catch { /* keep original segment */ }
    }
  }
  return reassemble(segs);
}

/**
 * P2 works ACROSS segments: `"foo" .. "bar"` is string/code/string. Scans the
 * segment list for that exact shape (plain, escape-free, same-quote literals)
 * and merges. Repeat to fixpoint so chains of 3+ collapse.
 */
function foldConcatSegments(segs) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 2 < segs.length; i++) {
      const a = segs[i];
      const op = segs[i + 1];
      const b = segs[i + 2];
      if (a.type !== 'string' || b.type !== 'string') continue;
      if (!/^\s*\.\.\s*$/.test(op.text)) continue;
      const q = a.text[0];
      if (q !== b.text[0] || (q !== '"' && q !== "'")) continue;
      const bodyA = a.text.slice(1, -1);
      const bodyB = b.text.slice(1, -1);
      if (bodyA.includes('\\') || bodyB.includes('\\')) continue;
      segs.splice(i, 3, { type: 'string', text: `${q}${bodyA}${bodyB}${q}` });
      changed = true;
    }
  }
  return segs;
}

// ---- P1: string-escape decode ---------------------------------------------------

function unescapeLuaBody(body) {
  // Full unescape of a short-string body. Returns null when any escape is
  // unknown/unsupported → caller leaves the string untouched.
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; i += 1; continue; }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (next === 'a') { out += '\x07'; i += 2; }
    else if (next === 'b') { out += '\b'; i += 2; }
    else if (next === 'f') { out += '\f'; i += 2; }
    else if (next === 'n') { out += '\n'; i += 2; }
    else if (next === 'r') { out += '\r'; i += 2; }
    else if (next === 't') { out += '\t'; i += 2; }
    else if (next === 'v') { out += '\v'; i += 2; }
    else if (next === '\\') { out += '\\'; i += 2; }
    else if (next === '"') { out += '"'; i += 2; }
    else if (next === "'") { out += "'"; i += 2; }
    else if (next === '\n') { out += '\n'; i += 2; }
    else if (next === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 2));
      if (!m) return null;
      out += String.fromCharCode(parseInt(m[0], 16));
      i += 2 + m[0].length;
    } else if (next === 'u' || next === 'z') {
      return null; // Luau unicode skip / \z — leave untouched
    } else if (/[0-9]/.test(next)) {
      const m = /^[0-9]{1,3}/.exec(body.slice(i + 1));
      const code = parseInt(m[0], 10);
      if (code > 255) return null;
      out += String.fromCharCode(code);
      i += 1 + m[0].length;
    } else {
      return null;
    }
  }
  return out;
}

function escapeLuaBody(body, quote) {
  let out = '';
  for (const ch of body) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\${c}`;
    else out += ch;
  }
  return out;
}

/** Decode one short-string token when every decoded char is printable ASCII. */
function decodeStringToken(token) {
  if (token.length < 2) return token;
  const quote = token[0];
  if (quote !== '"' && quote !== "'") return token;
  if (!token.endsWith(quote)) return token;
  const body = token.slice(1, -1);
  if (!/\\/.test(body)) return token; // nothing to decode
  const decoded = unescapeLuaBody(body);
  if (decoded == null || decoded.length === 0) return token;
  for (const ch of decoded) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c > 0x7e) return token; // non-printable → keep escapes (they carry meaning)
  }
  const next = quote + escapeLuaBody(decoded, quote) + quote;
  // Only accept when strictly more readable (shorter or fewer escapes).
  return next.length < token.length || !next.includes('\\') ? next : token;
}

// ---- P3: small arithmetic fold --------------------------------------------------

function foldArithSegment(code) {
  // (int op int) for + - * — semantics-preserving for integers; keep a signed
  // result parenthesized so precedence can never shift.
  return code.replace(/\((\d{1,9})\s*([+\-*])\s*(\d{1,9})\)/g, (_m, a, op, b) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return _m;
    let r = op === '+' ? x + y : op === '-' ? x - y : x * y;
    if (!Number.isSafeInteger(r)) return _m;
    return r < 0 ? `(${r})` : String(r);
  });
}

// ---- P4: machine-name rename ----------------------------------------------------

const MACHINE_NAME_RE = /\b_0x[0-9a-fA-F]{3,}\b|\b[vVwWlLoOuU]_?\d{1,4}(?:_\d{1,4})?\b|\b[lI1]{4,}[oO0]?\b|\b[uU]\d{2,}\b/g;

const RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if',
  'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
  'continue', 'self', 'type', 'export',
]);

function prettyNameGen(used) {
  const names = [];
  const az = 'abcdefghijklmnopqrstuvwxyz';
  const pushRange = (gen) => { for (const a of az) names.push(gen(a)); };
  pushRange((a) => a);
  pushRange((a) => `${a}r`); // ar, br, … second generation before doubles
  pushRange((a) => `${a}${a}`);
  for (const n of names) {
    if (!RESERVED.has(n) && !used.has(n)) return n;
  }
  // fallback: numbered
  for (let i = 1; i < 100000; i++) {
    const n = `n${i}`;
    if (!used.has(n)) return n;
  }
  return null;
}

/**
 * Rename machine-generated identifiers to short readable names, consistently,
 * gated on luaparse accepting the file. Renaming only engages when the file is
 * clearly machine-named (≥ 15 machine ids) so hand-written `l1` never moves.
 */
function renameMachineNames(src) {
  let ast = null;
  try {
    ast = luaparse.parse(src, { luaVersion: '5.1', ranges: false });
  } catch {
    return src; // Luau or unsupported syntax — rename pass refuses, by design
  }
  if (!ast) return src;

  const ids = new Set();
  let m;
  const re = new RegExp(MACHINE_NAME_RE.source, 'g');
  while ((m = re.exec(src)) !== null) ids.add(m[0]);
  if (ids.size < 15) return src; // not machine-named enough to justify a rename

  // Names already in use by non-machine identifiers (single letters etc.)
  const used = new Set();
  const allIds = src.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  for (const id of allIds) {
    if (!ids.has(id)) used.add(id);
  }

  const mapping = new Map();
  for (const id of ids) {
    const pretty = prettyNameGen(used);
    if (!pretty) break;
    mapping.set(id, pretty);
    used.add(pretty);
  }

  // Single combined pass — no cascading renames.
  const parts = [...mapping.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const combined = new RegExp(`\\b(?:${parts.join('|')})\\b`, 'g');
  return src.replace(combined, (name) => mapping.get(name) || name);
}

// ---- public API -----------------------------------------------------------------

/**
 * Make recovered Lua source readable. Never throws; every pass is gated.
 * @returns {{ code:string, passes:string[] }}
 */
export function makeReadableLua(src) {
  const passes = [];
  let out = String(src ?? '');
  if (!out) return { code: out, passes };

  // P1 — string-escape decode
  try {
    const next = mapSegments(out, ['string'], decodeStringToken);
    if (next !== out && sameOrBetter(out, next)) { out = next; passes.push('string-escape decode'); }
  } catch { /* gated out */ }

  // P2 — literal concat fold (across string/code/string segments)
  try {
    const segs = foldConcatSegments(scanLuaSegments(out));
    const next = reassemble(segs);
    if (next !== out && sameOrBetter(out, next)) { out = next; passes.push('literal concat fold'); }
  } catch { /* gated out */ }

  // P3 — small arithmetic fold (code segments only)
  try {
    const next = mapSegments(out, ['code'], foldArithSegment);
    if (next !== out && sameOrBetter(out, next)) { out = next; passes.push('constant arithmetic fold'); }
  } catch { /* gated out */ }

  // P4 — machine-name rename (luaparse-gated whole-file pass)
  try {
    const next = renameMachineNames(out);
    if (next !== out && next && sameOrBetter(out, next)) { out = next; passes.push('machine-name rename'); }
  } catch { /* gated out */ }

  return { code: out, passes };
}

/**
 * Light readability pass for JS (webcrack already renames upstream):
 * decode \xNN escapes in double/single-quoted strings when printable-only.
 */
export function makeReadableJs(src) {
  const passes = [];
  let out = String(src ?? '');
  if (!out) return { code: out, passes };
  try {
    const next = out.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (tok) => {
      if (!/\\x[0-9a-fA-F]{2}|\\[0-9]{2,3}/.test(tok)) return tok;
      const next = unescapeJsToken(tok);
      return next;
    });
    if (next !== out) { out = next; passes.push('string-escape decode'); }
  } catch { /* keep original */ }
  return { code: out, passes };
}

/** Decode \xHH / \NNN escapes in a JS string token; printable-only, never throws. */
function unescapeJsToken(tok) {
  const quote = tok[0];
  if (quote !== '"' && quote !== "'") return tok;
  const body = tok.slice(1, -1);
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; i += 1; continue; }
    const n = body[i + 1];
    if (n === 'x') {
      const m = /^[0-9a-fA-F]{2}/.exec(body.slice(i + 2));
      if (!m) return tok;
      out += String.fromCharCode(parseInt(m[0], 16));
      i += 4;
    } else if (n === 'n') { out += '\n'; i += 2; }
    else if (n === 't') { out += '\t'; i += 2; }
    else if (n === 'r') { out += '\r'; i += 2; }
    else if (n === 'b') { out += '\b'; i += 2; }
    else if (n === 'f') { out += '\f'; i += 2; }
    else if (n === 'v') { out += '\v'; i += 2; }
    else if (n === '0' && !/[0-9]/.test(body[i + 2] || '')) { out += '\0'; i += 2; return tok; /* NUL → keep */ }
    else if (n === '\\') { out += '\\'; i += 2; }
    else if (n === quote) { out += quote; i += 2; }
    else if (/[0-9]/.test(n)) {
      const m = /^[0-9]{1,3}/.exec(body.slice(i + 1));
      const code = parseInt(m[0], 8); // JS legacy octal-ish escapes in obfuscator output
      out += String.fromCharCode(code);
      i += 1 + m[0].length;
    } else {
      return tok; // unknown escape — leave the token untouched
    }
  }
  for (const ch of out) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c > 0x7e) return tok;
  }
  const reEscaped = out.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`);
  const next = quote + reEscaped + quote;
  return next.length < tok.length || !next.includes('\\') ? next : tok;
}

// ---- readability score ----------------------------------------------------------

/**
 * Grade how readable a piece of code is, 0–100.
 * @returns {{ score:number, grade:string, issues:string[] }}
 */
export function readabilityScore(text, lang = 'lua') {
  const issues = [];
  if (!text || !text.trim()) return { score: 0, grade: 'empty', issues: ['no output'] };
  const bytes = text.length;
  const lines = text.split('\n');
  const codeLines = lines.filter((l) => l.trim().length > 0);
  const nonEmpty = Math.max(1, codeLines.length);
  let score = 100;

  const avgLen = codeLines.reduce((s, l) => s + l.length, 0) / nonEmpty;
  if (avgLen > 250) { score -= 35; issues.push('very long lines'); }
  else if (avgLen > 120) { score -= 20; issues.push('long lines'); }

  const indented = codeLines.filter((l) => /^\s+\S/.test(l)).length / nonEmpty;
  if (indented < 0.08 && nonEmpty > 6) { score -= 15; issues.push('no indentation'); }

  const machine = (text.match(/\b_0x[0-9a-fA-F]{3,}\b|\b[vVwWlLoOuU]_?\d{1,4}(?:_\d{1,4})?\b|\b[lI1]{4,}[oO0]?\b/g) || []).length;
  const perKbIds = (machine * 1024) / bytes;
  if (perKbIds > 30 && machine > 40) { score -= 40; issues.push(`${machine} machine names`); }
  else if (perKbIds > 10 && machine > 15) { score -= 25; issues.push(`${machine} mangled names`); }

  const escapes = (text.match(/\\[0-9]{1,3}|\\x[0-9a-fA-F]{2}/g) || []).length;
  if ((escapes * 1024) / bytes > 8 && escapes > 30) { score -= 20; issues.push(`${escapes} string escapes`); }

  const nums = (text.match(/\b\d{2,}\b/g) || []).length;
  if ((nums * 1024) / bytes > 60 && nums > 60) { score -= 20; issues.push('numeric flood'); }

  const kwRe = lang === 'js' ? /\b(?:function|var|let|const|return|if|else|for|while)\b/g : /\b(?:local|function|end|if|then|else|elseif|for|while|do|return)\b/g;
  const kws = (text.match(kwRe) || []).length;
  if (bytes > 3072 && (kws * 1024) / bytes < 4) { score -= 15; issues.push('keyword starvation'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? 'clean' : score >= 60 ? 'readable' : score >= 40 ? 'rough' : 'machine-grade';
  return { score, grade, issues };
}
