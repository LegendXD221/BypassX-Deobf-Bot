/**
 * BypassX Deobf Bot — Luau → plain Lua 5.x text-level shim.
 *
 * Roblox-targeted obfuscated files (MoonSec V2/V3 Luau builds, Luraph luau,
 * 25ms…) use Luau-only syntax that standard Lua VMs reject — most commonly
 * compound assignments (`o*=-1`, `h+=b`, `s..=t`, `x//=y`). The jailed fengari
 * VM (Lua 5.3) needs these rewritten to plain assignments before loading.
 *
 * String/comment-aware scan (long strings & comments included); rewrites only
 * machine-generated-shaped LHS (identifier + .field / [expr] chains), which is
 * all obfuscator output ever emits. Unknown Luau constructs are left as-is so
 * the loader fails with its own precise error instead of us corrupting code.
 */

const COMPOUND_OPS = ['..=', '//=', '*=', '/=', '%=', '+=', '-=', '^='];

/** Does the source use Luau compound assignment? (quick pre-check) */
export function hasLuauCompoundAssign(src) {
  let out;
  try { out = stripForScan(src); } catch { return true; } // be safe, run transform
  return COMPOUND_OPS.some((op) => scanForOp(out, op));
}

/** Transform Luau compound assignments into plain Lua assignments. */
export function transformLuauToLua(src) {
  if (!src) return src;
  // Build a stripped parallel string for locating ops, then rewrite the
  // original by index. Stripped string keeps 1:1 length with the original
  // (every char maps to itself; string/comment contents become spaces).
  const stripped = stripForScan(src);
  const edits = [];
  for (const op of COMPOUND_OPS) {
    let idx = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const at = stripped.indexOf(op, idx);
      if (at === -1) break;
      idx = at + op.length;
      // ignore `..=` overlap with `..` concat — verify char before is not '.'
      if (op === '..=' && stripped[at - 1] === '.') continue;
      if (op === '-=' && stripped[at - 1] === '-') continue; // `x -= y` vs `--x =` impossible; safe
      const lhs = matchLhs(stripped, at);
      if (!lhs) continue;
      // find end of the RHS expression: balanced scan until `,` `;` or newline at depth 0
      const rhs = matchRhs(stripped, at + op.length);
      if (!rhs) continue;
      edits.push({ start: lhs.start, end: rhs.end, lhsText: src.slice(lhs.start, at), op, rhsText: src.slice(at + op.length, rhs.end) });
      idx = rhs.end;
    }
  }
  if (!edits.length) return src;
  // apply edits back-to-front
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) {
    const luaOp = e.op === '..=' ? '..' : e.op === '//=' ? '//' : e.op.slice(0, 1);
    const repl = `${e.lhsText}= ${e.lhsText.trim()} ${luaOp} (${e.rhsText.trim()})`;
    out = out.slice(0, e.start) + repl + out.slice(e.end);
  }
  return out;
}

// ---- internals ---------------------------------------------------------------

/** 1:1-length stripped copy: strings/long strings/comments → spaces. */
function stripForScan(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        if (src[j] === '\n') break; // unterminated — bail, leave as-is
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // long string [=*[
    if (c === '[') {
      const m = /^\[(=*)\[/.exec(src.slice(i, i + 64));
      if (m) {
        const close = `]${m[1]}]`;
        const end = src.indexOf(close, i + m[0].length);
        const stop = end === -1 ? n : end + close.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }
    if (two === '--') {
      const lm = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
      if (lm) {
        const close = `]${lm[1]}]`;
        const end = src.indexOf(close, i + lm[0].length);
        const stop = end === -1 ? n : end + close.length;
        blank(i, stop);
        i = stop;
        continue;
      }
      let j = i + 2;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function scanForOp(stripped, op) {
  let idx = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const at = stripped.indexOf(op, idx);
    if (at === -1) return false;
    idx = at + op.length;
    if (op === '..=' && stripped[at - 1] === '.') continue;
    if (matchLhs(stripped, at)) return true;
  }
}

/**
 * Match a machine-shaped LHS ending right before `at` (position of op).
 * Walks backward over: identifiers, `.field` suffixes and balanced `[expr]`
 * suffixes — the only LHS shapes obfuscator output emits.
 */
function matchLhs(s, at) {
  let i = at;
  let hadSpace = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (i > 0 && s[i - 1] === ' ') { i -= 1; hadSpace = true; } // skip spaces
    if (i <= 0) return hadSpace ? { start: i } : null;
    const c = s[i - 1];
    if (/[A-Za-z0-9_]/.test(c)) {
      // consume identifier
      let k = i;
      while (k > 0 && /[A-Za-z0-9_]/.test(s[k - 1])) k -= 1;
      i = k;
      while (i > 0 && s[i - 1] === ' ') { i -= 1; hadSpace = true; }
      if (i > 0 && s[i - 1] === '.') { i -= 1; continue; }
      break;
    }
    if (c === ']') {
      // balanced walk back to the matching '['
      let depth = 0;
      while (i > 0) {
        const ch = s[i - 1];
        if (ch === ']') depth += 1;
        else if (ch === '[') { depth -= 1; if (depth === 0) { i -= 1; break; } }
        i -= 1;
      }
      if (depth !== 0 || i <= 0) return null;
      // reject expressions inside [] that are too complex (calls, arithmetic)
      const inner = s.slice(i, at);
      if (/\(|\)|\bfunction\b|\*|\+|\bor\b|\band\b/.test(inner.replace(/^\[[^\[]*/, '').replace(/\]\]*$/, ''))) return null;
      while (i > 0 && s[i - 1] === ' ') { i -= 1; hadSpace = true; }
      if (i > 0 && s[i - 1] === '.') { i -= 1; continue; }
      continue; // consume the root identifier / another suffix next
    }
    return null;
  }
  if (i <= 0) return { start: i }; // LHS at chunk start is valid
  const before = s[i - 1];
  if (!hadSpace && /[A-Za-z0-9_)\]]/.test(before)) return null; // fused tokens
  if (!hadSpace && (before === '=' || before === '<' || before === '>')) return null;
  return { start: i };
}

/**
 * RHS: balanced scan from `from` until a top-level `,` `;` `then`/`do`/`end`
 * keyword, a statement boundary (space + identifier start at depth 0), or
 * EOF. Returns { end } (exclusive).
 */
function matchRhs(s, from) {
  let depthSq = 0;
  let depthCu = 0;
  let depthPa = 0;
  let i = from;
  while (i < s.length && s[i] === ' ') i += 1; // skip leading spaces
  while (i < s.length) {
    const c = s[i];
    if (c === '[') depthSq += 1;
    else if (c === ']') { if (depthSq === 0) break; depthSq -= 1; }
    else if (c === '{') depthCu += 1;
    else if (c === '}') { if (depthCu === 0) break; depthCu -= 1; }
    else if (c === '(') depthPa += 1;
    else if (c === ')') { if (depthPa === 0) break; depthPa -= 1; }
    else if (c === "'" || c === '"') {
      // skip string literal
      i += 1;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i += 1; i += 1; }
    } else if (depthPa === 0 && depthSq === 0 && depthCu === 0) {
      if (c === ',' || c === ';' || c === '\n') break;
      if (c === ' ' && i + 1 < s.length && /[A-Za-z0-9_]/.test(s[i + 1])) {
        // space followed by identifier: statement boundary UNLESS the chunk
        // after continues the expression (binary op/closer) — scan ahead
        let j = i + 1;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
        const word = s.slice(i + 1, j);
        if (/^(then|do|end|and|or|until|elseif|else)$/.test(word)) break;
        // an identifier right after a complete operand ends the expression
        const prev = s.slice(from, i).trimEnd().slice(-1);
        if (!/[+\-*/%^#~<>=,(.[]/.test(prev)) break;
      }
      if (/^(then|do)\b/.test(s.slice(i, i + 5))) break;
      if (/^end\b/.test(s.slice(i, i + 4))) break;
      if (/^and\b/.test(s.slice(i, i + 4))) break;
      if (/^or\b/.test(s.slice(i, i + 3))) break;
    }
    i += 1;
  }
  const end = i;
  if (end === from) return null;
  return { end };
}
