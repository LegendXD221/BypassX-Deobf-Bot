/**
 * BypassX Deobf Bot — readable-only finalizer.
 *
 * Every deobf deliverable leaves the pipeline in EXACTLY this shape:
 *   line 1: -- This File Was Deobfuscated By BypassX Deobf. discord - https://dc.gg/bypassx
 *   lines 2+: the deobfuscated code. Nothing else.
 *
 * Multiple banner/comment headers from earlier stages are collapsed so the
 * heading is the only meta line, and the heading is never duplicated.
 */
export const BYPASSX_HEADING_LUA = '-- This File Was Deobfuscated By BypassX Deobf. discord - https://dc.gg/bypassx';
export const BYPASSX_HEADING_JS = '// This File Was Deobfuscated By BypassX Deobf. discord - https://dc.gg/bypassx';
const HEADING_RE = /^\s*(?:--|\/\/)\s*This File Was Deobfuscated By BypassX Deobf\.?\s*discord\s*-\s*https?:\/\/dc\.gg\/bypassx\s*$/i;

/**
 * Prepend/normalize the BypassX heading on deobfuscated code.
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
  const canonical = lang === 'js' ? BYPASSX_HEADING_JS : BYPASSX_HEADING_LUA;
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

/** True when the code already starts with (or contains) the BypassX heading. */
export function hasBypassXHeading(code) {
  return String(code || '').split('\n').some((l) => HEADING_RE.test(l));
}
