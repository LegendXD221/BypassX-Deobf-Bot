/**
 * BypassX Deobf Bot — tiny display helpers (no imports, no cycles).
 */

/** Strip the engine's "(commit …)" suffix from version strings shown to users. */
export function prettyEngine(v) {
  return String(v ?? '').replace(/\s*\(commit\s+[0-9a-f]{6,64}\)\s*/i, ' ').trim();
}

/** Format bytes for the dashboard. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Escape untrusted text for safe HTML interpolation. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
