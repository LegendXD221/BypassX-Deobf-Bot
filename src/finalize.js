/**
 * Lucid Deobf Bot — readable-only finalizer.
 *
 * Every deobf deliverable leaves the pipeline in EXACTLY this shape:
 *   line 1: -- This File Was Deobfuscated By Lucid Deobf. discord - https://dsc.gg/luciddeobf
 *   lines 2+: the deobfuscated code. Nothing else.
 *
 * Multiple banner/comment headers from earlier stages are collapsed so the
 * heading is the only meta line, and the heading is never duplicated.
 *
 * v2.22.0 rebrand: BypassX Deobf → Lucid Deobf. New outputs carry the Lucid
 * heading; the regex still recognizes legacy "BypassX Deobf" heading lines so
 * old deliveries normalize onto exactly one canonical Lucid line.
 */
export const LUCID_HEADING_LUA = '-- This File Was Deobfuscated By Lucid Deobf. discord - https://dsc.gg/luciddeobf';
export const LUCID_HEADING_JS = '// This File Was Deobfuscated By Lucid Deobf. discord - https://dsc.gg/luciddeobf';
// Back-compat aliases (pre-rebrand symbol names).
export const BYPASSX_HEADING_LUA = LUCID_HEADING_LUA;
export const BYPASSX_HEADING_JS = LUCID_HEADING_JS;
const HEADING_RE = /^\s*(?:--|\/\/)\s*This File Was Deobfuscated By (?:Lucid|BypassX)\s+Deobf\.?\s*discord\s*-\s*https?:\/\/(?:dsc\.gg\/luciddeobf|dc\.gg\/bypassx)\s*$/i;

/**
 * Prepend/normalize the Lucid heading on deobfuscated code.
 *   - no heading        → the canonical heading is prepended;
 *   - a heading variant  → that line is rewritten to the canonical form
 *                          (e.g. the no-space "--This…" variant collapses to
 *                          "-- This…"), so exactly one canonical line remains;
 *   - duplicate headings → extras are dropped.
 * @param {string} code recovered source (may already carry the heading)
 * @param {'lua'|'js'} lang comment style for the canonical heading
 * @returns {string} heading + code
 */
export function finalizeReadable(code, lang = 'lua') {
  const text = String(code || '');
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const canonical = lang === 'js' ? LUCID_HEADING_JS : LUCID_HEADING_LUA;
  let seen = false;
  const out = [];
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      if (!seen) { seen = true; out.push(canonical); }
      continue; // duplicate headings are dropped
    }
    out.push(line);
  }
  if (!seen) out.unshift(canonical);
  return out.join('\n');
}

/** True when the code already starts with (or contains) the Lucid heading. */
export function hasLucidHeading(code) {
  return String(code || '').split('\n').some((l) => HEADING_RE.test(l));
}
/** Back-compat alias for the pre-rebrand name. */
export const hasBypassXHeading = hasLucidHeading;
