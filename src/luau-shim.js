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

/** Does the source use Luau-only syntax (compound assign / if-expressions /
 *  binary literals / digit separators / `continue` statements)? */
export function hasLuauCompoundAssign(src) {
  let out;
  try { out = stripForScan(src); } catch { return true; } // be safe, run transform
  if (COMPOUND_OPS.some((op) => scanForOp(out, op))) return true;
  if (findIfExprs(out).length > 0) return true;
  return hasLuauOnlyLiterals(out);
}

/**
 * Transform Luau-only syntax into plain Lua:
 *   • binary literals (`0b1010_0111`) + digit separators (`0X9D0_3`) → plain
 *     numbers, `continue` statements → `goto` + end-of-loop label, `\u{…}`
 *     string escapes → `\ddd` byte escapes (v2.5.0 — Luraph v14.x emits all
 *     of these; the jailed fengari VM is a Lua 5.3 and rejects them),
 *   • compound assignments → `x = x + (rhs)`
 *   • if-expressions → `(function() if c then return a else return b end end)()`
 * All are located on the same 1:1 stripped scan; edits are applied back to
 * front with an overlap guard so a mis-scan can never double-rewrite.
 */
export function transformLuauToLua(src) {
  if (!src) return src;
  // v2.14.0 ORDER FIX — if-expressions MUST be rewritten before the
  // continue→goto block walk: a raw `if c then a else b` has NO `end`, so
  // every unconverted if-expression shifted the continue-walk's block stack
  // by one and the loop-end labels landed on wrong closers (verified live:
  // `no visible label '__bxc68_m4n'` on a 140KB moonveil dispatcher).
  // Order is now: if-exprs → compound assigns → literals/continue.
  const { ifEdits, compoundEdits } = collectLuauEdits(src);
  let out = src;

  // PASS 1 — apply if-expression edits (positions are src-space)
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

  // PASS 3 — literal normalizer LAST (binary/separators/\u/continue→goto);
  // re-scans its own output, so the walk sees only balanced if/end pairs.
  const lit = normalizeLuauLiterals(out);
  if (lit.changed) out = lit.code;
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

// ---- Luau literal normalizer (v2.5.0) ----------------------------------------
// Luraph v14.x (and other Luau-targeted builds) emit literals/statements a
// Lua 5.3 VM cannot parse:
//   • binary literals `0b1001111`, `0B1_0__01` — 1100+ per build
//   • digit separators `0X9D0_3`, `0Xd__e1`, `1_000_000`
//   • `continue` statements inside loops — ~110 per build
//   • `\u{21}` unicode escapes in short strings
// The normalizer rewrites all four; everything else is left untouched so a
// hostile payload still fails with its own precise parse error.

const LUAU_NUM_RE = /(?<![\w.])0[xX][0-9a-fA-F_]+|(?<![\w.])0[bB][01_]+|(?<![\w.])\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?[\d_]+)?/g;
const LUAU_WORD_RE = /[A-Za-z_]+/g;

/** Quick probe: any Luau-only literal/statement present in the source? */
export function hasLuauOnlyLiterals(src) {
  const stripped = stripForScan(src);
  let m;
  LUAU_NUM_RE.lastIndex = 0;
  while ((m = LUAU_NUM_RE.exec(stripped))) {
    if (m[0].includes('_') || /^0[bB]/.test(m[0])) return true;
  }
  if (/\\u\{[0-9a-fA-F]+\}/.test(src)) return true;
  return /\bcontinue\b/.test(stripped);
}

// ---- v2.14.0: invalid string-escape repair ---------------------------------
// Obfuscators embed their encrypted payload inside short-string literals and
// their own string-encryption emits LENIENT escapes: `\x4Cur\x61\z ph \z Sc\z
// \114\i\z p\116\x3A` decodes to "Luraph Script:" — `\i` is not a real Lua
// escape but the intended byte is literally `i`. A strict Lua 5.3 lexer (the
// jailed fengari VM) refuses the whole file on it. The repair pass rewrites
// only escapes that are INVALID in Lua 5.3, inside short strings only, and
// always to the char the lenient reading intends (`\X` → `X`).

const VALID_SIMPLE_ESCAPES = new Set(['a', 'b', 'f', 'n', 'r', 't', 'v', '\\', '"', "'", 'z', '\n', '\r']);

/** Quick probe: any invalid escape sequence inside a short string? */
export function hasInvalidEscapes(src) {
  let out;
  try { out = repairInvalidEscapes(src); } catch { return false; }
  return out.changed;
}

/** Rewrite invalid `\X` escapes to the literal char X inside short strings.
 *  Long strings/comments are skipped (their content is raw). Never throws.
 *  @returns {{ changed: boolean, code: string, repaired: number }} */
export function repairInvalidEscapes(src) {
  const edits = [];
  let i = 0;
  const n = src.length;
  const LONG_EQ = /^\]*=*\[/; // not used; explicit scans below
  while (i < n) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      // comment — long comment?[[ level ]] else line comment
      const m = /^-{2}(=*\[)/.exec(src.slice(i, i + 40));
      if (m) {
        const level = m[1].length - 1; // number of '='
        const openTok = '[' + '='.repeat(level) + '[';
        const closeTok = ']' + '='.repeat(level) + ']';
        const end = src.indexOf(closeTok, i + openTok.length);
        i = end < 0 ? n : end + closeTok.length;
      } else {
        const end = src.indexOf('\n', i);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }
    if (c === '[') {
      const m = /^\[=*\[/.exec(src.slice(i, i + 40));
      if (m) {
        const level = m[0].length - 2;
        const closeTok = ']' + '='.repeat(level) + ']';
        const end = src.indexOf(closeTok, i + m[0].length);
        i = end < 0 ? n : end + closeTok.length;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          const e = src[j + 1];
          if (e === undefined) { j += 1; continue; }
          if (VALID_SIMPLE_ESCAPES.has(e)) { j += 2; continue; }
          if (e === 'x') {
            if (/^[0-9a-fA-F]{2}/.test(src.slice(j + 2, j + 4))) { j += 4; continue; }
            edits.push({ start: j, end: j + 2 }); // \x without 2 hex digits → drop backslash+x
            j += 2;
            continue;
          }
          if (e === 'u' && src[j + 2] === '{') {
            const endB = src.indexOf('}', j + 3);
            if (endB > 0 && endB - j < 12) { j = endB + 1; continue; }
            edits.push({ start: j, end: j + 2 });
            j += 2;
            continue;
          }
          if (e >= '0' && e <= '9') {
            const dm = /^\d{1,3}/.exec(src.slice(j + 1, j + 4));
            const dd = dm ? dm[0] : '';
            if (Number(dd) <= 255) { j += 1 + dd.length; continue; }
            edits.push({ start: j, end: j + 1 }); // >255 — drop backslash, keep digits
            j += 1;
            continue;
          }
          // INVALID escape — lenient decode: drop the backslash, keep the char
          edits.push({ start: j, end: j + 1 });
          j += 1;
          continue;
        }
        if (d === quote) { j += 1; break; }
        if (d === '\n') break; // unterminated on this line — bail out of this string
        j += 1;
      }
      i = Math.max(j, i + 1);
      continue;
    }
    i += 1;
  }
  if (!edits.length) return { changed: false, code: src, repaired: 0 };
  // apply back-to-front
  let code = src;
  for (const ed of edits.reverse()) {
    code = code.slice(0, ed.start) + code.slice(ed.end);
  }
  return { changed: true, code, repaired: edits.length };
}

/** Statement-position check for `continue` (machine-generated code separates
 *  statements with `;`; identifiers named `continue` never sit in this exact
 *  boundary shape). */
function isStatementContinue(stripped, at) {
  // previous non-space char must end a statement / open a branch
  // v2.14.0: widened — obfuscators emit `continue` after ANY statement end:
  //   `W'',5266 continue` (moonveil — string literal end + numeric literal end)
  //   `x = [[…]] continue` (long-bracket end), `f(1) continue` was already OK.
  let p = at;
  while (p > 0 && (stripped[p - 1] === ' ' || stripped[p - 1] === '\t')) p -= 1;
  if (p > 0) {
    const ch = stripped[p - 1];
    if (ch === ';' || ch === '}' || ch === ')'
      || ch === "'" || ch === '"' || ch === ']') {
      // ok — statement boundary (string end / long-bracket end)
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      // v2.14.0: identifiers, numeric literals and the literal keywords all
      // end statements — `a_,ge=…,oc continue` (moonveil) has a local-name
      // prev; machine code never uses `continue` as an identifier, and the
      // NEXT-side check below still guards the right boundary.
    } else {
      return false; // operator / open bracket — not a statement end
    }
  }
  // next non-space char must start a statement end / branch keyword
  let q = at + 8;
  while (q < stripped.length && (stripped[q] === ' ' || stripped[q] === '\t')) q += 1;
  if (q >= stripped.length) return true; // chunk end
  const ch2 = stripped[q];
  if (ch2 === ';' || ch2 === '\n' || ch2 === '}') return true;
  let w2 = q;
  while (w2 < stripped.length && w2 - q < 8 && /[A-Za-z_]/.test(stripped[w2])) w2 += 1;
  const word2 = stripped.slice(q, w2);
  return /^(end|elseif|else|until)$/.test(word2);
}

/** Collect numeric-literal + unicode-escape + continue edits on one scan.
 *  @returns {{ changed: boolean, code: string, numbers: number, unicode: number, continues: number }} */
export function normalizeLuauLiterals(src) {
  const stripped = stripForScan(src);
  const edits = [];
  let numbers = 0;
  let unicode = 0;
  let continues = 0;

  // 1. numeric literals (positions identical in src and stripped — numbers
  //    contain no escapes, so the token text is the real source text)
  let m;
  LUAU_NUM_RE.lastIndex = 0;
  while ((m = LUAU_NUM_RE.exec(stripped))) {
    const tok = m[0];
    if (/^0[bB]/.test(tok)) {
      const digits = tok.slice(2).replace(/_/g, '');
      let dec;
      try { dec = BigInt(digits, 2).toString(10); } catch { continue; }
      edits.push({ start: m.index, end: m.index + tok.length, replacement: dec });
      numbers += 1;
    } else if (tok.includes('_')) {
      edits.push({ start: m.index, end: m.index + tok.length, replacement: tok.replace(/_/g, '') });
      numbers += 1;
    }
  }

  // 2. string-escape normalization inside SHORT strings. Two Luau-only forms
  //    appear (long strings have no escapes):
  //      • `\u{…}` unicode escapes → `\ddd` UTF-8 byte escapes
  //      • lenient punctuation escapes — Luau accepts `\<punct>` as the bare
  //        literal char (`\)` `\[` `\-` …); Lua 5.3 rejects them, so the
  //        backslash is dropped. Valid Lua escapes pass untouched.
  {
    // walk short-string regions of the raw source
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === "'" || c === '"') {
        const q = c;
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') {
            const rest = src.slice(j, j + 12);
            const um = /^\\u\{([0-9a-fA-F]+)\}/.exec(rest);
            if (um) {
              const cp = parseInt(um[1], 16);
              if (Number.isFinite(cp) && cp <= 0x10ffff) {
                const bytes = cp <= 0x7f
                  ? [cp]
                  : cp <= 0x7ff
                    ? [0xc0 | (cp >> 6), 0x80 | (cp & 63)]
                    : cp <= 0xffff
                      ? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)]
                      : [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
                // 3-digit padding: `\73` followed by a digit would re-parse
                // as the too-large escape `\734` — `\073` + digit is safe.
                edits.push({ start: j, end: j + um[0].length, replacement: bytes.map((b) => `\\${String(b).padStart(3, '0')}`).join('') });
                unicode += 1;
              }
              j += um[0].length;
              continue;
            }
            const nx = src[j + 1];
            if (nx === '\n' || nx === '\r') { j += 2; continue; } // line continuation
            if (nx === 'z') { j += 2; continue; }                  // \z whitespace skip (5.3 native)
            if (nx === 'x' && /^[xX][0-9a-fA-F]{2}/.test(rest)) { j += 4; continue; }
            if (nx && /[0-9]/.test(nx)) { j += 2 + (/^\\[0-9]{2}/.test(rest) ? 1 : 0); continue; } // \ddd
            if (nx && 'abfnrtv\\\'"'.includes(nx)) { j += 2; continue; } // valid 5.3 escapes
            if (nx && nx !== q && !/[A-Za-z0-9]/.test(nx) && nx !== ' ') {
              // Luau lenient punctuation escape: `\<punct>` IS `<punct>`
              edits.push({ start: j, end: j + 2, replacement: nx });
              unicode += 1;
              j += 2;
              continue;
            }
            j += 2; // unknown / invalid escape — fail loud on the parser
            continue;
          }
          if (src[j] === q) { j += 1; break; }
          if (src[j] === '\n') break; // unterminated — leave as-is
          j += 1;
        }
        i = j;
        continue;
      }
      if (c === '[') {
        const lm = /^\[(=*)\[/.exec(src.slice(i, i + 64));
        if (lm) {
          const close = `]${lm[1]}]`;
          const end = src.indexOf(close, i + lm[0].length);
          i = end === -1 ? n : end + close.length;
          continue;
        }
      }
      if (c === '-' && src[i + 1] === '-') {
        const lmc = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
        if (lmc) {
          const close = `]${lmc[1]}]`;
          const end = src.indexOf(close, i + lmc[0].length);
          i = end === -1 ? n : end + close.length;
          continue;
        }
        while (i < n && src[i] !== '\n') i += 1;
        continue;
      }
      i += 1;
    }
  }

  // 3. `continue` statements → goto + end-of-loop label. One block walk:
  //    `if`/`function`/`do`/`repeat` push, `end`/`until` pop, `then`/`else`
  //    belong to the open if-block. `continue` attaches to the innermost
  //    enclosing LOOP; each such loop gets one label before its closer.
  {
    const stack = []; // { isLoop, conts: [] }
    let pendingLoop = false;
    let pendingThen = false;
    const continueEdits = [];
    let wm;
    LUAU_WORD_RE.lastIndex = 0;
    const words = [];
    while ((wm = LUAU_WORD_RE.exec(stripped))) words.push({ w: wm[0], at: wm.index });
    for (let wi = 0; wi < words.length; wi++) {
      const { w, at } = words[wi];
      if (w === 'if' || w === 'function') {
        // v2.14.0: mark function blocks — a `continue` can never bind across
        // a function boundary (its goto+label would be invisible from inside
        // the closure, verified live: `no visible label '__bxc68_m4n'`).
        stack.push({ isLoop: false, isFunction: w === 'function', conts: [] });
        pendingThen = w === 'if';
      } else if (w === 'for' || w === 'while') {
        pendingLoop = true;
      } else if (w === 'then') {
        // `then` belongs to the if/elseif already on the stack; only a stray
        // one (blanked header edge) pushes a balancing block
        if (!pendingThen) stack.push({ isLoop: false, isFunction: false, conts: [] });
        pendingThen = false;
      } else if (w === 'elseif') {
        pendingThen = true; // its `then` belongs to the SAME if-block (no push)
      } else if (w === 'do') {
        stack.push({ isLoop: pendingLoop, isFunction: false, conts: [] });
        pendingLoop = false;
      } else if (w === 'repeat') {
        stack.push({ isLoop: true, isFunction: false, conts: [] });
      } else if (w === 'end' || w === 'until') {
        const blk = stack.pop();
        if (blk && blk.conts.length) {
          const label = `__bxc${blk.conts.length}_${at.toString(36)}`;
          continueEdits.push({ start: at, end: at, replacement: `::${label}:: ` });
          for (const cAt of blk.conts) {
            continueEdits.push({ start: cAt, end: cAt + 8, replacement: `goto ${label}` });
          }
          continues += blk.conts.length;
        }
      } else if (w === 'continue' && isStatementContinue(stripped, at)) {
        // bind to the innermost enclosing loop IN THE SAME FUNCTION — never
        // cross a function boundary (Lua label visibility rule)
        for (let si = stack.length - 1; si >= 0; si--) {
          if (stack[si].isFunction) break;
          if (stack[si].isLoop) { stack[si].conts.push(at); break; }
        }
      }
    }
    edits.push(...continueEdits);
  }

  if (!edits.length) return { changed: false, code: src, numbers, unicode, continues: 0 };
  // apply back-to-front with overlap guard
  edits.sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let out = src;
  let lastStart = Infinity;
  let applied = 0;
  for (const e of edits) {
    if (e.end > lastStart) continue;
    lastStart = e.start;
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    applied += 1;
  }
  return { changed: applied > 0, code: out, numbers, unicode, continues };
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
