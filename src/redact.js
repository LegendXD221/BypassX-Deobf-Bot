/**
 * Lucid Deobf Bot — secret redaction & host-path sanitization.
 *
 * Defense-in-depth: ensures Discord tokens, DB credentials, Pastefy/GitHub
 * tokens, dashboard URLs, and host filesystem paths never leak into logs,
 * Pastefy pastes, or Discord replies (inspired by novalogger/davix/kvms
 * path scrubbing + strict env redaction).
 */

const SECRET_ENV_KEYS = [
  'DISCORD_TOKEN', 'DISCORD_BOT_TOKEN', 'PASTEFY_TOKEN', 'PASTEFY_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_PAT', 'DATABASE_URL', 'DASHBOARD_TOKEN',
  'OWNER_PIN', 'RENDER_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'BOT_TOKEN',
];

const TOKEN_PATTERNS = [
  // Discord bot/user token shape
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{27,}\b/g,
  // Postgres / Neon / Redis connection strings with credentials
  /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^\s"'`<>]+/gi,
  // GitHub PATs
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // Dashboard secret path
  /\/dash\/[A-Za-z0-9_-]{16,}/g,
  // Authorization Bearer header values
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Scrub secrets from any string (logs, shell output, SQL results, errors). */
export function redactSecrets(input) {
  let s = String(input ?? '');
  if (!s) return s;

  for (const key of SECRET_ENV_KEYS) {
    const val = process.env[key];
    if (typeof val === 'string' && val.length >= 6) {
      if (s.includes(val)) s = s.split(val).join('[REDACTED]');
    }
  }

  s = s.replace(TOKEN_PATTERNS[0], '[REDACTED_TOKEN]');
  s = s.replace(TOKEN_PATTERNS[1], '[REDACTED_DB_URL]');
  s = s.replace(TOKEN_PATTERNS[2], '[REDACTED_GH_TOKEN]');
  s = s.replace(TOKEN_PATTERNS[3], '/dash/[REDACTED]');
  s = s.replace(TOKEN_PATTERNS[4], '$1[REDACTED]');
  return s;
}

/** Scrub host filesystem paths from deobf/dumper outputs and error messages. */
export function sanitizePaths(input) {
  let s = String(input ?? '');
  if (!s) return s;
  s = s.replace(/\/opt\/lucid-deobf(?:\/[^\s"'`:)\]]*)?/g, '<app>');
  s = s.replace(/\/(?:root|home\/[^/\s"'`]+|Users\/[^/\s"'`]+|data\/(?:user\/\d+\/[^/\s"'`]+|data\/[^/\s"'`]+))/g, '<host>');
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '<host>');
  return s;
}
