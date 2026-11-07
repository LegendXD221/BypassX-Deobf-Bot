/**
 * BypassX Deobf Bot — Luau → plain Lua 5.x text-level shim.
 *
 * Roblox-targeted obfuscated files (MoonSec V2/V3 Luau builds, Luraph luau,
 * 25ms…) use Luau-only syntax that standard Lua VMs reject:
 *   • compound assignments (`o*=-1`, `h+=b`, `s..=t`, `x//=y`) — Luraph v15.1
 *     emits ~200 per build,
 *   • if-expressions (`x = if c then a else b`) — Luraph v15.1 emits 4–24 per
 *     build, incl. elseif chains; MoonSec V3 uses them in loader prologues.
 * The jailed fengari VM (Lua 5.3) needs both rewritten before loading.
 *
 * String/comment-aware scan (long strings & comments included); rewrites only
 * machine-generated-shaped LHS (identifier + .field / [expr] chains), which is
 * all obfuscator output ever emits. Unknown Luau constructs are left as-is so
 * the loader fails with its own precise error instead of us corrupting code.
 */

const COMPOUND_OPS = ['..=', '//=', '*=', '/=', '%=', '+=', '-=', '^='];

/** Does the source use Luau-only syntax (compound assign / if-expressions)? */
export function hasLuauCompoundAssign(src) {
  let out;
  try { out = stripForScan(src); } catch { return true; } // be safe, run transform
  if (COMPOUND_OPS.some((op) => scanForOp(out, op))) return true;
  return findIfExprs(out).length > 0;
}

/**
 * Transform Luau-only syntax into plain Lua:
 *   • compound assignments → `x = x + (rhs)`
 *   • if-expressions → `(function() if c then return a else return b end end)()`
 * Both are located on the same 1:1 stripped scan; edits are applied back to
 * front with an overlap guard so a mis-scan can never double-rewrite.
 */
export function transformLuauToLua(src) {
  if (!src) return src;
  const { ifEdits, compoundEdits } = collectLuauEdits(src);
  if (!ifEdits.length && !compoundEdits.length) return src;

  // PASS 1 — apply if-expression edits (positions are src-space)
  let out = src;
  if (ifEdits.length) {
    ifEdits.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const e of ifEdits) {
      if (e.end > lastStart) continue; // overlap guard
      lastStart = e.start;
      out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    }
  }

  // PASS 2 — apply compound edits (positions are pass-1-output space)
  if (compoundEdits.length) {
    compoundEdits.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const e of compoundEdits) {
      if (e.end > lastStart) continue; // overlap guard
      lastStart = e.start;
      out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    }
  }
  return out;
}

/** Collect all Luau edits as { start, end, replacement } — if-expressions
 *  first (rewritten into valid Lua so pass-2 scans see clean expressions),
 *  then compound assignments re-scanned on the if-expr-rewritten source.
 *  @internal exported for diagnostics/tests */
export function collectLuauEdits(src) {
  // PASS 1 — Luau if-expressions (expression position):
  //   `x = if c then a else b` → `x = (function() if c then return a else return b end end)()`
  const stripped1 = stripForScan(src);
  const ifEdits = [];
  // Branch bodies are expressions; prefix `=` so leading nested if-exprs are
  // seen in expression position by the recursive pass, then strip the prefix.
  const rw = (t) => (t && t.includes('if') ? transformLuauToLua(`=${t}`).slice(1) : t);
  for (const ie of findIfExprs(stripped1)) {
    if (src.slice(ie.start, ie.end).includes('...')) continue; // IIFE cannot capture `...`
    let ok = true;
    const parts = ie.branches.map((b) => ({
      kw: b.kw,
      cond: b.cond != null ? rw(src.slice(b.cond.start, b.cond.end)) : null,
      body: rw(src.slice(b.body.start, b.body.end)),
    }));
    for (const p of parts) if (!p.body || !p.body.trim() || (p.kw !== 'else' && (!p.cond || !p.cond.trim()))) ok = false;
    if (!ok) continue;
    // Flatten to independent `if c then return body end` statements + final
    // fallthrough `return elseBody`. (A single `if c then return a else return
    // b end` as the whole IIFE body trips a fengari parser quirk when the
    // function-body `end` immediately follows — verified against fengari 0.1.4.)
    const elsePart = parts.find((p) => p.kw === 'else');
    const ifParts = parts.filter((p) => p.kw !== 'else');
    const lua = ifParts.map((p) => `if ${p.cond} then return ${p.body} end`).join(' ')
      + ` return ${elsePart ? elsePart.body : 'nil'}`;
    ifEdits.push({ start: ie.start, end: ie.end, replacement: `(function() ${lua} end)()` });
  }

  // PASS 2 — compound assignments → `x = x + (rhs)` (re-scanned post pass 1)
  let pre = src;
  if (ifEdits.length) {
    ifEdits.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const e of ifEdits) {
      if (e.end > lastStart) continue;
      lastStart = e.start;
      pre = pre.slice(0, e.start) + e.replacement + pre.slice(e.end);
    }
  }
  const stripped = stripForScan(pre);
  const compoundEdits = [];
  for (const op of COMPOUND_OPS) {
    let idx = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const at = stripped.indexOf(op, idx);
      if (at === -1) break;
      idx = at + op.length;
      if (op === '..=' && stripped[at - 1] === '.') continue;
      if (op === '-=' && stripped[at - 1] === '-') continue;
      const lhs = matchLhs(stripped, at);
      if (!lhs) continue;
      const rhs = matchRhs(stripped, at + op.length);
      if (!rhs) continue;
      const lhsText = pre.slice(lhs.start, at);
      const rhsText = pre.slice(at + op.length, rhs.end);
      const luaOp = op === '..=' ? '..' : op === '//=' ? '//' : op.slice(0, 1);
      compoundEdits.push({
        start: lhs.start, end: rhs.end,
        replacement: `${lhsText}= ${lhsText.trim()} ${luaOp} (${rhsText.trim()})`,
      });
      idx = rhs.end;
    }
  }
  return { ifEdits, compoundEdits };
}

// ---- Luau if-expressions ------------------------------------------------------
// Expression-position `if c then a else b` / `if c then a elseif c2 then d
// else e`. Only matches when the preceding non-space token can START an
// expression context (`=`, `(`, `,`, `{`, binary op, return/and/or) — never a
// statement-position `if` (`;if`, `)if` after a param list, line start, …).

const IFEXPR_PRECEDING_RE = /[[=(,{+\-*/%^~<>]$/;
const IFEXPR_PRECEDING_WORD = /(?:\breturn|\band|\bor)[ \t]*$/;

function findIfExprs(stripped) {
  const out = [];
  const re = /\bif\b/g;
  let m;
  while ((m = re.exec(stripped))) {
    const at = m.index;
    // preceding non-space char (manual scan — a `[ \t]+$` regex is super-linear
    // on the huge blanked string-data regions these files contain)
    let p = at;
    while (p > 0 && (stripped[p - 1] === ' ' || stripped[p - 1] === '\t')) p -= 1;
    if (p === 0) continue; // statement if at chunk start
    const ch = stripped[p - 1];
    let pass = IFEXPR_PRECEDING_RE.test(ch);
    if (!pass) {
      // word immediately before (`return`/`and`/`or` + space can precede an expr)
      let w = p;
      while (w > 0 && p - w < 12 && /[A-Za-z]/.test(stripped[w - 1])) w -= 1;
      const word = stripped.slice(w, p);
      pass = word === 'return' || word === 'and' || word === 'or';
    }
    if (!pass) continue; // statement-position if — not our target
    const parsed = parseIfExpr(stripped, at);
    if (!parsed) continue;
    out.push(parsed);
    re.lastIndex = parsed.end;
  }
  return out;
}

/** Balanced-scan helper: from `from`, stop when the text at a depth-0
 *  position matches /^kw/ for one of `kws` (word-bounded). Strings and
 *  comments are already blanked in the stripped copy; only structural
 *  brackets are tracked. Scans at most `limit` chars (bounds false-positive
 *  matches inside string-data regions — their keywords are blanked anyway,
 *  so a limited scan can only ever produce a safe `null`).
 *  With `nestedIf` = true, `if` keywords at depth 0 open a nested if-expression
 *  whose own `else`/`elseif` are consumed instead of terminating the scan.
 *  Returns { end, kw } or null. */
function scanUntilKeyword(s, from, kws, limit = 4096, nestedIf = false) {
  let depthSq = 0, depthCu = 0, depthPa = 0;
  let depthIf = 0;
  let i = from;
  const stop = Math.min(s.length, from + limit);
  while (i < stop) {
    const c = s[i];
    if (c === '[') depthSq += 1;
    else if (c === ']') { if (depthSq === 0) return null; depthSq -= 1; }
    else if (c === '{') depthCu += 1;
    else if (c === '}') { if (depthCu === 0) return null; depthCu -= 1; }
    else if (c === '(') depthPa += 1;
    else if (c === ')') { if (depthPa === 0) return null; depthPa -= 1; }
    else if (depthSq === 0 && depthCu === 0 && depthPa === 0) {
      if (nestedIf && c === 'i' && s.startsWith('if', i) && !/[A-Za-z0-9_]/.test(s[i + 2] || '')) {
        depthIf += 1;
        i += 2;
        continue;
      }
      for (const kw of kws) {
        if (s.startsWith(kw, i) && !/[A-Za-z0-9_]/.test(s[i + kw.length] || '')) {
          // keywords belonging to a nested if-expression are consumed instead
          // of terminating the scan (`then`/`elseif` keep it open, `else`
          // closes the innermost nested if)
          if (depthIf > 0 && (kw === 'else' || kw === 'elseif' || kw === 'then')) {
            if (kw === 'else') depthIf -= 1;
            i += kw.length;
            break;
          }
          return { end: i, kw };
        }
      }
    }
    i += 1;
  }
  return null;
}

/** Parse an if-expression starting at `at` (position of the `if` keyword).
 *  Returns { start: at, end, branches: [{kw, cond?, body}] } or null.
 *  The else-branch extent reuses matchRhs (expression terminator scan). */
function parseIfExpr(s, at) {
  const branches = [];
  let pos = at + 2; // past `if`
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const kw = scanUntilKeyword(s, pos, ['then'], 4096, true);
    if (!kw) return null;
    const cond = { start: pos, end: kw.end };
    pos = kw.end + 4; // past `then`
    const brk = scanUntilKeyword(s, pos, ['elseif', 'else'], 65536, true);
    if (!brk) return null;
    branches.push({ kw: 'if', cond, body: { start: pos, end: brk.end } });
    pos = brk.end + brk.kw.length;
    if (brk.kw === 'elseif') continue; // next loop parses the elseif branch
    // `else` — the final branch extends like any RHS expression
    const fin = matchRhs(s, pos, 65536);
    if (!fin) return null;
    branches.push({ kw: 'else', body: { start: pos, end: fin.end } });
    return { start: at, end: fin.end, branches };
  }
}

/** @internal exported for diagnostics/tests */
export function debugIfExprs(src) {
  const stripped = stripForScan(src);
  return findIfExprs(stripped).map((ie) => ({
    start: ie.start,
    end: ie.end,
    text: src.slice(ie.start, ie.end),
  }));
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
  // fused-token reject: an identifier glued to alnum or `]` can't start a
  // statement. `)` IS allowed — machine-generated Luau puts the first
  // statement directly after the param list (`function(P)P%=4294967296`).
  if (!hadSpace && /[A-Za-z0-9_\]]/.test(before)) return null;
  if (!hadSpace && (before === '=' || before === '<' || before === '>')) return null;
  return { start: i };
}

/**
 * RHS: balanced scan from `from` until a top-level `,` `;` `then`/`do`/`end`
 * keyword, a statement boundary (space + identifier start at depth 0), or
 * EOF/`maxChars`. Returns { end } (exclusive).
 */
function matchRhs(s, from, maxChars = 0) {
  let depthSq = 0;
  let depthCu = 0;
  let depthPa = 0;
  let i = from;
  while (i < s.length && s[i] === ' ') i += 1; // skip leading spaces
  const stop = maxChars > 0 ? Math.min(s.length, from + maxChars) : s.length;
  while (i < stop) {
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
