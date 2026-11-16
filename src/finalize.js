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
 * Prepend the BypassX heading to deobfuscated code (idempotent — never doubles).
 * @param {string} code recovered source (may already carry the heading)
 * @returns {string} heading + code
 */
export function finalizeReadable(code, lang = 'lua') {
  const text = String(code || '');
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const hadHeading = lines.some((l) => HEADING_RE.test(l));
  if (hadHeading) return text;
  return (lang === 'js' ? BYPASSX_HEADING_JS : BYPASSX_HEADING_LUA) + '\n' + text;
}

/** True when the code already starts with (or contains) the BypassX heading. */
export function hasBypassXHeading(code) {
  return String(code || '').split('\n').some((l) => HEADING_RE.test(l));
}
