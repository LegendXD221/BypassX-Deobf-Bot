/**
 * BypassX Deobf Bot — AntiTamper Neutralizer (v2.15.0).
 *
 * Static, regex-level rewriter that disarms known anti-tamper constructs in
 * the OBFUSCATED source BEFORE any engine (jail lift, Luraph devirt chain,
 * Prometheus deep pass, static peel) sees it. Regex-level on purpose:
 * megabyte minified sources with Luau syntax are exactly where a full parser
 * chokes, and every rewrite is verify-gated by the caller (pipeline.js) — a
 * rewrite that changes what the code parses as never ships.
 *
 * Rewrites (all semantics-preserving or trap-removing, never guessing):
 *   1. LPH_CRASH(...)            → _BXAntiTamperNoop() (trap never fires)
 *   2. LPH_PRECHECK(function() … end) → _BXAntiTamperNoop() — the validator
 *      body is REMOVED from the text (validation that never runs can never
 *      fail; keeping the body would risk Lua long-comment `]]` corruption)
 *   3. LPH_JIT/LPH_JIT_MAX/LPH_NO_VIRTUALIZE/LPH_NO_UPVALUES(f)  → (f) (unwrap)
 *   4. LPH_ENCSTR/LPH_ENCNUM/LPH_ENCFUNC(x)      → (x) (unwrap)
 *   5. setmetatable(game|workspace|script, …)    → _BXAntiTamperNoop()
 *      (tamper residue that would poison our inert DataModel and leak into
 *      output — the removed text is preserved inside a comment with `]]`
 *      escaped)
 *
 * Lua-grammar discipline: replacements are CALLS (_BXAntiTamperNoop()), so
 * they stay valid in BOTH statement and expression positions. Comments are
 * always level-1 `--[[ ... ]]` (valid in every Lua flavor luaparse accepts —
 * never `--[=[`), and never contain `]]`.
 *
 * The unwraps use a BALANCED-paren scanner (no regex across nested calls).
 * Idempotent by construction: running it twice changes nothing.
 */

import { PATTERNS } from './catalog.js';

const NOOP_DEF = 'local _BXAntiTamperNoop = _BXAntiTamperNoop or function() return nil end\n';
const NOOP_CALL = '_BXAntiTamperNoop()';

/** Escape a text fragment for safe embedding inside a `--[[ ... ]]`. */
function escComment(text) {
  return String(text).replace(/\]\]/g, '][');
}

const LPH_MACROS = new Set([
  'LPH_JIT', 'LPH_JIT_MAX', 'LPH_NO_VIRTUALIZE', 'LPH_NO_UPVALUES',
  'LPH_ENCSTR', 'LPH_ENCNUM', 'LPH_ENCFUNC', 'LPH_CRACH', 'LPH_CRASH', 'LPH_PRECHECK',
]);

/** Find the index just past the balanced ")" closing the "(" at `openIdx`. */
function matchParen(text, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '[' && text[i + 1] === '[') { inStr = ']]'; i++; continue; }
    if (inStr === ']]' && c === ']' && text[i + 1] === ']') { inStr = null; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Find the end of the Lua expression starting at `start` inside `text`
 * (used for macro arguments): scans forward tracking depth of ( { [
 * and stops at the top-level "," or ")" that closes the call.
 * Returns { end, stop } where end is exclusive.
 */
function scanLuaExpr(text, start) {
  let depth = 0;
  let inStr = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (inStr === ']]') {
        if (c === ']' && text[i + 1] === ']') { inStr = null; i++; }
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '[' && text[i + 1] === '[') { inStr = ']]'; i++; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return { end: i, stop: c };
      depth--;
      continue;
    }
    if (depth === 0 && c === ',') return { end: i, stop: ',' };
  }
  return { end: text.length, stop: null };
}

/**
 * Neutralize the source for a detected family.
 * → { code, changed, hits: [{ id, name, count, severity }] }
 */
export function neutralizeSource(luaText, familyId = 'unknown') {
  if (typeof luaText !== 'string' || !luaText) {
    return { code: luaText || '', changed: false, hits: [] };
  }
  const hits = new Map(); // id → { id, name, count, severity }
  const bump = (id, name, severity, count = 1) => {
    const cur = hits.get(id) || { id, name, count: 0, severity };
    cur.count += count;
    hits.set(id, cur);
  };

  let code = luaText;

  // ── 1. LPH macro family ──────────────────────────────────────────────────
  // Repeated passes: a macro can sit inside another macro's argument.
  let lphTouch = true;
  let guard = 0;
  while (lphTouch && guard++ < 24) {
    lphTouch = false;
    for (const macro of LPH_MACROS) {
      let idx = code.indexOf(macro);
      while (idx !== -1 && guard < 4096) {
        const before = code[idx - 1];
        const after = code[idx + macro.length];
        const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
        if (isWordChar(before) || isWordChar(after)) {
          idx = code.indexOf(macro, idx + macro.length);
          continue;
        }
        // find the opening paren (allow whitespace)
        let p = idx + macro.length;
        while (p < code.length && /\s/.test(code[p])) p++;
        if (code[p] !== '(') {
          idx = code.indexOf(macro, p);
          continue;
        }
        const close = matchParen(code, p);
        if (close === -1) {
          idx = code.indexOf(macro, p);
          continue;
        }
        const inner = code.slice(p + 1, close);
        lphTouch = true;

        if (macro === 'LPH_CRASH' || macro === 'LPH_CRACH') {
          // Crash trap: replace the whole call with a no-op CALL (valid in
          // statement and expression positions).
          code = code.slice(0, idx) + NOOP_CALL + ' --[[LPH_CRASH stripped]]' + code.slice(close + 1);
          bump('lph-crash', 'LPH_CRASH crash trap', 'critical');
        } else if (macro === 'LPH_PRECHECK') {
          // Environment validation: drop the call AND its body (no comment
          // corruption risk, no residue in output).
          code = code.slice(0, idx) + NOOP_CALL + ' --[[LPH_PRECHECK disarmed]]' + code.slice(close + 1);
          bump('lph-precheck', 'LPH_PRECHECK environment validation', 'critical');
        } else {
          // JIT/ENC macros: unwrap — the argument expression stands alone.
          const comment = `--[[${macro} unwrapped]]`;
          code = code.slice(0, idx) + '(' + comment + inner + ')' + code.slice(close + 1);
          bump('lph-macros', 'LPH macro wrapper unwrapped', 'degrading');
        }
        idx = code.indexOf(macro, idx);
      }
    }
  }

  // ── 2. Tamper residue: setmetatable on our inert DataModel roots ─────────
  // Two source shapes:
  //   direct:  setmetatable(game, {...})
  //   comma:   pcall(setmetatable, game, {...})   (also xpcall etc.)
  // For both, the stripped region is the ENCLOSING CALL: replace it with
  // _BXAntiTamperNoop() (a call — valid in statement and expression spots).
  {
    const reRes = new RegExp('setmetatable\\s*\\(\\s*(game|workspace|script)\\s*,|setmetatable\\s*,\\s*(game|workspace|script)\\b', 'g');
    reRes.lastIndex = 0;
    let m;
    let residueGuard = 0;
    while ((m = reRes.exec(code)) !== null && residueGuard++ < 64) {
      // m[1] set by the direct alternation, m[2] by the comma alternation.
      const commaForm = m[2] !== undefined;
      let stmtStart = -1;
      let stmtEnd = -1;
      if (commaForm) {
        // Enclosing call: nearest '(' BEFORE the match; include the callee
        // name in front of it (pcall / xpcall / table.pcall …).
        let open = -1;
        for (let i = m.index - 1; i >= 0; i--) {
          const c = code[i];
          if (c === ')') break;          // hit a previous close first — no wrapper
          if (c === '(') { open = i; break; }
        }
        if (open === -1) { reRes.lastIndex = m.index + m[0].length; continue; }
        const close = matchParen(code, open);
        if (close === -1) { reRes.lastIndex = m.index + m[0].length; continue; }
        let start = open;
        while (start > 0 && /[A-Za-z0-9_.]/.test(code[start - 1])) start--;
        stmtStart = start;
        stmtEnd = close + 1;
      } else {
        const openParen = code.indexOf('(', m.index);
        if (openParen === -1) { reRes.lastIndex = m.index + m[0].length; continue; }
        const close = matchParen(code, openParen);
        if (close === -1) { reRes.lastIndex = m.index + m[0].length; continue; }
        stmtStart = m.index;
        stmtEnd = close + 1;
      }
      const removed = code.slice(stmtStart, stmtEnd);
      const root = m[1] || m[2] || 'game';
      // Short comment only — embedding the removed text would re-match the
      // pattern inside our own comment (idempotency + loop hazards).
      const comment = ` --[[BypassX AntiTamper: tamper mutation on ${root} stripped]]`;
      const inserted = NOOP_CALL + comment;
      code = code.slice(0, stmtStart) + inserted + code.slice(stmtEnd);
      bump('residue-antitamper-leftovers', `setmetatable(${root}) mutation stripped`, 'degrading');
      reRes.lastIndex = stmtStart + inserted.length;
    }
  }

  if (code !== luaText) code = NOOP_DEF + code;
  return { code, changed: code !== luaText, hits: [...hits.values()] };
}

/** Quick scan WITHOUT rewriting (for reports on already-safe sources). */
export function scanSource(luaText) {
  const found = [];
  if (typeof luaText !== 'string' || !luaText) return found;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(luaText);
    if (m) found.push({ id: p.id, name: p.name, severity: p.severity });
  }
  for (const macro of LPH_MACROS) {
    const re = new RegExp(`${macro}\\s*\\(`);
    if (re.test(luaText) && !found.some((f) => f.id === (macro === 'LPH_CRASH' || macro === 'LPH_CRACH' ? 'lph-crash' : macro === 'LPH_PRECHECK' ? 'lph-precheck' : 'lph-macros'))) {
      found.push({
        id: macro === 'LPH_CRASH' || macro === 'LPH_CRACH' ? 'lph-crash' : macro === 'LPH_PRECHECK' ? 'lph-precheck' : 'lph-macros',
        name: macro === 'LPH_CRASH' || macro === 'LPH_CRACH' ? 'LPH_CRASH crash trap' : macro === 'LPH_PRECHECK' ? 'LPH_PRECHECK environment validation' : 'LPH macro wrapper unwrapped',
        severity: macro === 'LPH_PRECHECK' || macro === 'LPH_CRASH' || macro === 'LPH_CRACH' ? 'critical' : 'degrading',
      });
    }
  }
  return found;
}

/** Human one-liner for bot stages from a hits array. */
export function hitsToStageLine(hits) {
  if (!hits || !hits.length) return null;
  const total = hits.reduce((a, h) => a + h.count, 0);
  const names = hits.map((h) => `${h.name}×${h.count}`).join(', ');
  return `${total} anti-tamper construct(s) disarmed: ${names}`;
}
