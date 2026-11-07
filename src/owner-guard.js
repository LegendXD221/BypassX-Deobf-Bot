/**
 * BypassX Deobf Bot — 5-layer owner protection for dangerous commands.
 *
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │ L1  IDENTITY      exact user-id match (CONFIG.ownerId). No roles,    │
 *  │                   no permissions, no server-admin shortcuts.         │
 *  │ L2  PIN           optional OWNER_PIN env — required as the first     │
 *  │                   argument (prefix) or the `pin` option (slash);     │
 *  │                   3 wrong tries → 15-minute lockout.                 │
 *  │ L3  CONFIRM       destructive commands post a single-use danger      │
 *  │                   button; 30 s expiry; only the owner can click it.  │
 *  │ L4  RATE LIMIT    one dangerous op at a time, 10 s cooldown,         │
 *  │                   max 12/hour, globally.                             │
 *  │ L5  AUDIT         every attempt (allowed AND denied, with the layer  │
 *  │                   that fired) is logged to the Neon DB and the       │
 *  │                   console; denial attempts DM the owner instantly.   │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 * Layer 0 (unlisted): dangerous commands are hidden from public help.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
  MessageFlags, ContainerBuilder, TextDisplayBuilder,
} from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';

// ---- L1: identity ------------------------------------------------------------

export function isOwner(userId) {
  return String(userId || '') === String(CONFIG.ownerId);
}

// ---- L2: PIN -------------------------------------------------------------------

const PIN_MAX_FAILS = 3;
const PIN_LOCKOUT_MS = 15 * 60_000;
const pinFails = new Map(); // userId -> { count, lockedUntil }

export function pinRequired() {
  return Boolean(process.env.OWNER_PIN);
}

/**
 * Verify the PIN. `provided` comes from the slash option or the stripped
 * first prefix argument. Fails closed when a PIN is configured.
 */
export function checkPin(userId, provided) {
  const pin = process.env.OWNER_PIN || '';
  if (!pin) return { ok: true }; // layer inactive — not configured
  const now = Date.now();
  const st = pinFails.get(userId);
  if (st?.lockedUntil && st.lockedUntil > now) {
    return { ok: false, locked: true, retryMs: st.lockedUntil - now };
  }
  if (provided && provided === pin) {
    pinFails.delete(userId);
    return { ok: true };
  }
  // Reset the counter only when a previous lockout has fully expired.
  const lockExpired = Boolean(st?.lockedUntil && st.lockedUntil <= now);
  const count = (lockExpired ? 0 : st?.count || 0) + 1;
  const locked = count >= PIN_MAX_FAILS;
  pinFails.set(userId, { count, lockedUntil: locked ? now + PIN_LOCKOUT_MS : 0 });
  return { ok: false, locked, retryMs: locked ? PIN_LOCKOUT_MS : 0, remaining: PIN_MAX_FAILS - count };
}

/** Prefix flow: strip the pin token from args when present. Returns the rest. */
export function stripPinArg(args) {
  if (!pinRequired()) return args;
  if (args?.[0] === process.env.OWNER_PIN) return args.slice(1);
  return args;
}

/** The pin token sitting in args[0] (prefix flow), if any. */
export function peekPinArg(args) {
  return args?.[0];
}

// ---- L4: danger rate limit -----------------------------------------------------

const danger = { active: 0, cooldownUntil: 0, hourCount: 0, hourStart: Date.now() };

export function acquireDanger() {
  const now = Date.now();
  if (now < danger.cooldownUntil) {
    return { ok: false, reason: `cooldown — try again in ${Math.ceil((danger.cooldownUntil - now) / 1000)}s` };
  }
  if (now - danger.hourStart >= 3_600_000) {
    danger.hourStart = now;
    danger.hourCount = 0;
  }
  if (danger.hourCount >= CONFIG.dangerMaxPerHour) {
    return { ok: false, reason: `hourly cap reached (${CONFIG.dangerMaxPerHour}/h) — resets in ${Math.ceil((3_600_000 - (now - danger.hourStart)) / 60_000)} min` };
  }
  if (danger.active >= 1) {
    return { ok: false, reason: 'another dangerous command is still running' };
  }
  danger.active += 1;
  danger.hourCount += 1;
  danger.cooldownUntil = now + CONFIG.dangerCooldownMs;
  return { ok: true };
}

export function releaseDanger() {
  danger.active = Math.max(0, danger.active - 1);
}

export function dangerStatus() {
  return { active: danger.active, usedThisHour: danger.hourCount, capPerHour: CONFIG.dangerMaxPerHour, cooldownMs: CONFIG.dangerCooldownMs };
}

// ---- L5: audit + owner alert -----------------------------------------------------

export async function audit(client, { userId, username, command, args, allowed, layer, result }) {
  const entry = {
    userId, username, command,
    args: String(args || '').slice(0, 200),
    allowed, layer, result: String(result || '').slice(0, 200),
  };
  if (allowed) logger.info({ cmd: command, user: userId }, 'owner audit: ALLOWED');
  else logger.warn({ cmd: command, user: userId, layer }, 'owner audit: DENIED');
  try { await db.audit(entry); } catch { /* db optional */ }
  if (!allowed) alertOwner(client, `🚨 **Denied attempt** — \`${command}\` by <@${userId}> (${userId})\nLayer: **${layer}**${result ? `\n${String(result).slice(0, 150)}` : ''}`);
}

/** Fire-and-forget DM to the owner. Never throws. */
export function alertOwner(client, text) {
  if (!client?.users?.fetch || !CONFIG.ownerId) return;
  client.users.fetch(CONFIG.ownerId)
    .then((u) => u.send(text))
    .catch(() => { /* DMs closed — the DB audit row still exists */ });
}

// ---- L3: confirm gate ------------------------------------------------------------

let confirmSeq = 0;

/**
 * Post a single-use confirm card and wait for the owner's click.
 * Resolves true (confirmed) / false (cancelled or 30s timeout).
 * Sends from the caller's ctx so both slash + prefix work.
 */
export async function confirmGate(ctx, { title, details }) {
  const confirmId = `oc:${++confirmSeq}:y`;
  const cancelId = `oc:${confirmSeq}:n`;
  const card = confirmCard({ title, details, confirmId, cancelId, timeoutS: CONFIG.confirmTimeoutS });

  let msg = null;
  try {
    msg = await ctx.reply(card);
    if (ctx.isSlash && (!msg || typeof msg.createMessageComponentCollector !== 'function')) {
      msg = await ctx.interaction.fetchReply();
    }
  } catch (e) {
    logger.warn({ err: String(e?.message || e).slice(0, 120) }, 'confirm gate: could not send card');
    return false;
  }
  if (!msg || typeof msg.createMessageComponentCollector !== 'function') return false;

  const verdict = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: Math.max(5, CONFIG.confirmTimeoutS) * 1000,
    });
    collector.on('collect', async (i) => {
      if (String(i.user.id) !== String(CONFIG.ownerId)) {
        await i.reply({ content: '❌ Only the bot owner can press this.', ephemeral: true }).catch(() => {});
        return; // does not consume the gate
      }
      const yes = i.customId === confirmId;
      // IMPORTANT: settle the verdict BEFORE stopping the collector —
      // collector.stop() emits the 'end' event synchronously, so stopping
      // first used to run done(false) and swallow the owner's Confirm click
      // (every press behaved like Cancel). The end handler below now also
      // respects the stop reason as a belt-and-braces guard.
      done(yes);
      collector.stop(yes ? 'confirmed' : 'cancelled');
      await i.deferUpdate().catch(() => {});
    });
    collector.on('end', (_collected, reason) => done(reason === 'confirmed'));
  });

  // Swap the dead buttons for a verdict line so the card can't be pressed
  // after resolution and the owner sees what happened at a glance. (The
  // slash flow's final reply replaces the whole card afterwards; failures
  // here are cosmetic only.)
  try { await msg.edit({ components: [verdictCard(verdict)], flags: MessageFlags.IsComponentsV2 }); } catch { /* cosmetic */ }
  return verdict;
}

// ---- card builders (imported lazily to avoid a cycle with replies.js) ------------

/** Green/red status card shown after the gate resolves (no buttons left). */
function verdictCard(confirmed) {
  const c = new ContainerBuilder().setAccentColor(confirmed ? 0x22c55e : 0xf59e0b);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(confirmed
      ? '## ✅ Confirmed\n-# Running the dangerous action…'
      : '## 🚫 Cancelled\n-# Nothing was executed'),
  );
  return c;
}

function confirmCard({ title, details, confirmId, cancelId, timeoutS }) {
  const c = new ContainerBuilder().setAccentColor(0xef4444);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🔐 ${title}\n-# Owner confirmation required — expires in ${timeoutS}s`),
  );
  if (details) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(String(details).slice(0, 1500)));
  }
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('⚠ Confirm').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}
