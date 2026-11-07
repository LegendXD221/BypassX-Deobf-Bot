/**
 * BypassX Deobf Bot — configuration from environment.
 */
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function num(name, def) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

export const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  guildId: process.env.GUILD_ID || '',
  prefix: (process.env.PREFIX || '.').trim() || '.',

  pastefyToken: process.env.PASTEFY_TOKEN || '',
  pastefyExpireDays: num('PASTEFY_EXPIRE_DAYS', 30),

  engineUrl: process.env.ENGINE_URL || 'https://github.com/LegendXD221/BypassX-Deobf-Bot/releases/latest/download/bypassx-deobf.gz',
  enginePath: process.env.ENGINE_PATH || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  varDir: path.join(repoRoot, 'var'),

  maxUploadBytes: Math.max(1, num('MAX_UPLOAD_MB', 10)) * 1024 * 1024,
  engineTimeoutMs: Math.max(30, num('ENGINE_TIMEOUT_S', 180)) * 1000,

  // Concurrency: at most 2 engine runs at once, queue up to 8.
  maxConcurrent: 2,
  maxQueue: 8,
  userCooldownMs: 10_000,

  // Bot owner — powerful owner-only commands (eval/exec/servers/…).
  ownerId: (process.env.OWNER_ID || '1134757298733064203').trim(),

  // 5-layer protection for dangerous owner commands (src/owner-guard.js):
  // L2 pin = OWNER_PIN env; L3 confirm button; L4 limits below; L5 = DB audit.
  dangerCooldownMs: Math.max(0, num('DANGER_COOLDOWN_S', 10)) * 1000,
  dangerMaxPerHour: Math.max(1, num('DANGER_MAX_PER_HOUR', 12)),
  confirmTimeoutS: Math.max(5, num('CONFIRM_TIMEOUT_S', 30)),

  version: '1.5.1',
};

export function ensureVarDir(sub = '') {
  const dir = sub ? path.join(CONFIG.varDir, sub) : CONFIG.varDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
