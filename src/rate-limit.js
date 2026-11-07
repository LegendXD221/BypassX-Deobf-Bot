/**
 * BypassX Deobf Bot — simple per-user cooldown.
 */
import { CONFIG } from './config.js';

const lastUse = new Map();

export function checkCooldown(userId) {
  const now = Date.now();
  const prev = lastUse.get(userId) || 0;
  const remaining = CONFIG.userCooldownMs - (now - prev);
  if (remaining > 0) return { ok: false, remainingMs: remaining };
  lastUse.set(userId, now);
  // prune occasionally
  if (lastUse.size > 5000) {
    for (const [uid, ts] of lastUse) {
      if (now - ts > CONFIG.userCooldownMs * 2) lastUse.delete(uid);
    }
  }
  return { ok: true, remainingMs: 0 };
}
