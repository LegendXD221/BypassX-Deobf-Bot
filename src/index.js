/**
 * Lucid Deobf Bot — Discord client entry point.
 *
 * Supports both prefix commands (.deobf …) and slash commands (/deobf …).
 * Slash commands self-register on ready (global; + instant per-guild when
 * GUILD_ID is set).
 *
 * Dispatch order for every command:
 *   1. blacklist check (Neon DB, 30 s cache; owner bypasses)
 *   2. owner commands → 5-layer protection (src/owner-guard.js):
 *      L1 exact owner-id match → L2 optional OWNER_PIN (3 fails = 15 min
 *      lock) → L3 single-use confirm button for danger commands →
 *      L4 danger rate limit → L5 audit row + DM alert on any denial.
 */
import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { COMMANDS, commandByName, toSlashJson } from './commands-index.js';
import { makeCtx } from './ctx.js';
import { looksLikeUrl } from './fetchurl.js';
import { probe as probeEngine } from './engine.js';
import {
  errorReply, ownerOnlyReply, blockedReply, pinReply, dangerLimitedReply, cancelledReply,
  guildOffReply,
} from './replies.js';
import {
  isOwner, pinRequired, checkPin, stripPinArg, peekPinArg,
  acquireDanger, releaseDanger, audit, confirmGate,
} from './owner-guard.js';
import { redactSecrets } from './redact.js';
import * as db from './db.js';
import { bootAudit as atBootAudit } from './antitamper/evidence.js';
import { setDashboardClient, announceDashboard, initDashboardToken } from './dashboard.js';
import { startKeepalive, markDiscordReady } from './keepalive.js';

// HTTP keep-alive server first — Render health checks can hit /health
// even while Discord is still connecting.
startKeepalive();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // must be enabled in the dev portal for prefix commands
  ],
});

// ---- slash registration -----------------------------------------------------
async function registerSlashCommands() {
  if (!CONFIG.clientId) {
    logger.warn({}, 'CLIENT_ID missing — skipping slash registration (prefix commands still work)');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
  const body = COMMANDS.map(toSlashJson);
  try {
    if (CONFIG.guildId) {
      await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body });
      logger.info({ guild: CONFIG.guildId }, 'slash commands registered (guild)');
    }
    await rest.put(Routes.applicationCommands(CONFIG.clientId), { body });
    logger.info({ count: body.length }, 'slash commands registered (global)');
  } catch (e) {
    logger.error({ err: String(e?.message || e).slice(0, 300) }, 'slash registration failed');
  }
}

client.once(Events.ClientReady, async (c) => {
  logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'bot ready');
  markDiscordReady(true);
  setDashboardClient(c);
  await initDashboardToken(); // DB-backed token — survives Render redeploys
  announceDashboard();
  atBootAudit(); // v2.25.0 AntiTamper V3: jail-shape audit → evidence store (fire-and-forget)
  c.user.setPresence({
    activities: [{ name: '.deobf | .lph .ms3 .ms2 +12 more | best deobf bot', type: 3 }], // 3 = WATCHING
    status: 'online',
  });
  await registerSlashCommands();
  const engine = await probeEngine();
  if (!engine.available) {
    logger.warn({}, 'engine not available — runs will fail until bin/prepare-engine.js completes');
  }
  // Neon database (optional — fully functional without it).
  if (db.describe().enabled) {
    await db.init();
  } else {
    logger.info({}, 'DATABASE_URL not set — running without database persistence');
  }
});

// ---- shared dispatch --------------------------------------------------------

/** Non-owner ran an owner command: L5 audit + instant DM alert. */
function ownerDenied(cmd, ctx) {
  logger.warn({ user: ctx.userId, cmd: cmd.name }, 'owner command denied');
  audit(client, {
    userId: ctx.userId,
    username: ctx.userTag,
    command: cmd.name,
    args: (ctx.args || []).join(' '),
    allowed: false,
    layer: 'L1 identity',
    result: 'non-owner attempted an owner command',
  });
  return ctx.reply(ownerOnlyReply(cmd.name));
}

/** Blacklist gate for public commands (owner bypasses). */
async function blacklisted(ctx) {
  if (isOwner(ctx.userId)) return false;
  try {
    if (ctx.userId && (await db.blacklistHas(ctx.userId))) return 'user';
    const gid = ctx.interaction?.guildId || ctx.message?.guildId;
    if (gid && (await db.blacklistHas(gid))) return 'server';
  } catch { /* db optional — never block on an outage */ }
  return false;
}

/**
 * Run an owner command through the 5 protection layers, then the command.
 * rawArgs: prefix args (PIN token stripped in-place) — slash reads options.
 */
async function runOwnerCommand(cmd, ctx, rawArgs) {
  // L4 — danger rate limit (before PIN/confirm so spam fails fast).
  const slot = acquireDanger();
  if (!slot.ok) {
    await audit(client, {
      userId: ctx.userId, username: ctx.userTag, command: cmd.name,
      args: (rawArgs || []).join(' '), allowed: false, layer: 'L4 rate limit', result: slot.reason,
    });
    return ctx.reply(dangerLimitedReply(slot.reason));
  }
  try {
    // L2 — optional PIN.
    if (pinRequired()) {
      let provided = '';
      if (ctx.isSlash) {
        provided = ctx.interaction.options.getString('pin') || '';
      } else {
        const candidate = peekPinArg(rawArgs);
        const stripped = stripPinArg(rawArgs);
        if (stripped !== rawArgs) {
          rawArgs.splice(0, rawArgs.length, ...stripped);
          provided = candidate;
          // Scrub the plaintext PIN message from chat history immediately.
          ctx.message?.delete?.().catch(() => {});
        } else {
          provided = candidate || '';
        }
      }
      const pin = checkPin(ctx.userId, provided);
      if (!pin.ok) {
        await audit(client, {
          userId: ctx.userId, username: ctx.userTag, command: cmd.name,
          allowed: false, layer: 'L2 pin', result: pin.locked ? 'locked out (3 wrong PINs)' : 'wrong/missing PIN',
        });
        return ctx.reply(pinReply(pin));
      }
    }

    // L3 — single-use confirm button for danger-flagged commands.
    if (cmd.danger) {
      const argPreview = ctx.isSlash
        ? (ctx.interaction.options.getAttachment?.('file')?.name
          || ctx.interaction.options.getString('command')
          || ctx.interaction.options.getString('sql')
          || ctx.interaction.options.getString('message')
          || ctx.interaction.options.getString('text')
          || ctx.interaction.options.getString('code')
          || '')
        : stripPinArg(rawArgs).join(' ');
      const okConfirm = await confirmGate(ctx, {
        title: `Confirm ${cmd.name}`,
        details: [
          `**Command** \`${cmd.name}\``,
          argPreview ? `**Input**\n\`\`\`\n${String(argPreview).slice(0, 500)}\n\`\`\`` : null,
          'This is a **dangerous** owner action. It runs only if you press Confirm.',
        ].filter(Boolean).join('\n'),
      });
      if (!okConfirm) {
        await audit(client, {
          userId: ctx.userId, username: ctx.userTag, command: cmd.name,
          args: argPreview, allowed: false, layer: 'L3 confirm', result: 'not confirmed — nothing executed',
        });
        return ctx.reply(cancelledReply());
      }
    }

    await audit(client, {
      userId: ctx.userId, username: ctx.userTag, command: cmd.name,
      args: redactSecrets((rawArgs || []).join(' ')), allowed: true, layer: 'all layers passed',
    });
    await cmd.run(ctx);
  } finally {
    releaseDanger();
  }
}

async function dispatch(cmd, ctx, rawArgs) {
  const gid = ctx.interaction?.guildId || ctx.message?.guildId;
  const [bl, gs] = await Promise.all([
    blacklisted(ctx),
    !cmd.owner && gid ? db.getGuildSettings(gid) : Promise.resolve(null),
  ]);
  if (bl) {
    logger.warn({ user: ctx.userId, cmd: cmd.name, kind: bl }, 'blacklisted entity blocked');
    audit(client, {
      userId: ctx.userId, username: ctx.userTag, command: cmd.name,
      args: (rawArgs || []).join(' '), allowed: false, layer: 'blacklist', result: `${bl} blocked`,
    });
    return ctx.reply(blockedReply(bl));
  }
  // Per-guild controls set from the owner dashboard (owner always bypasses).
  if (gs) {
    if (gs.disabled) return ctx.reply(guildOffReply('The bot is disabled in this server', 'The owner turned it off from the dashboard.'));
    if ((cmd.name === 'deobf' || cmd.serviceCmd) && !gs.deobf_enabled) return ctx.reply(guildOffReply('Deobfuscation is off here', 'The owner disabled the deobf commands in this server.'));
    if (cmd.name === 'detect' && !gs.detect_enabled) return ctx.reply(guildOffReply('Detection is off here', 'The owner disabled the detect command in this server.'));
  }
  if (cmd.owner && !isOwner(ctx.userId)) return ownerDenied(cmd, ctx);
  if (cmd.owner) return runOwnerCommand(cmd, ctx, rawArgs);
  return cmd.run(ctx);
}

// ---- slash interactions -----------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commandByName(interaction.commandName);
  if (!cmd) return;
  const ctx = makeCtx({ interaction, client });
  ctx.args = [];
  try {
    // Beat Discord's 3-second interaction ACK deadline BEFORE any DB/network work on heavy commands.
    if (cmd.heavy) await ctx.defer();
    await dispatch(cmd, ctx, ctx.args);
  } catch (e) {
    logger.error({ err: String(e?.stack || e).slice(0, 600), cmd: cmd.name }, 'slash command crashed');
    try {
      await ctx.reply(errorReply('Unexpected error', String(e.message || e).slice(0, 500)));
    } catch { /* reply already sent */ }
  }
});

// ---- prefix commands --------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot || message.webhookId || message.system || !message.content) return;
    // Fast synchronous prefix lookup — zero DB latency on regular chat messages.
    let prefix = CONFIG.prefix;
    if (message.guildId) {
      const peek = db.peekGuildPrefix(message.guildId);
      if (peek.hit) {
        prefix = peek.prefix || CONFIG.prefix;
      } else {
        // Cold cache: if the message doesn't even start with a short prefix candidate, warm in background.
        if (message.content.startsWith(CONFIG.prefix)) {
          db.getGuildSettings(message.guildId).catch(() => {});
        } else {
          prefix = (await db.guildPrefix(message.guildId)) || CONFIG.prefix;
        }
      }
    }
    if (!prefix || !message.content.startsWith(prefix)) return;

    const parts = message.content.slice(prefix.length).trim().split(/\s+/);
    const name = (parts.shift() || '').toLowerCase();
    if (!name) return;
    const cmd = commandByName(name);
    if (!cmd) return; // silent for unknown commands

    const ctx = makeCtx({ message, client });
    // Remaining arguments after the command name (owner tools use these).
    ctx.args = parts;
    // First URL in the arguments → link input (`.deobf <url>`).
    ctx.url = parts.find(looksLikeUrl) || null;
    // Resolve a reply-target attachment or link so `.deobf` works as a reply.
    if (!ctx.attachments.length && !ctx.url && message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        if (ref?.attachments?.size) ctx.attachments.push(...ref.attachments.values());
        else if (ref?.content) ctx.url = ref.content.split(/\s+/).find(looksLikeUrl) || null;
      } catch { /* reference gone */ }
    }
    ctx.prefix = prefix;

    try {
      await dispatch(cmd, ctx, ctx.args);
    } catch (e) {
      logger.error({ err: String(e?.stack || e).slice(0, 600), cmd: cmd.name }, 'prefix command crashed');
      await ctx.send(errorReply('Unexpected error', String(e?.message || e).slice(0, 500))).catch(() => {});
    }
  } catch (e) {
    logger.error({ err: String(e?.stack || e).slice(0, 600) }, 'prefix handler crashed');
  }
});

// ---- lifecycle --------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason?.stack || reason).slice(0, 600) }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: String(err?.stack || err).slice(0, 600) }, 'uncaught exception');
});

// ---- Discord login: resilient retry, never exit ----------------------------
// A bad/missing token no longer kills the process: hosts keep their /health +
// dashboard alive, and every retry re-reads .env so a token fix lands live
// without a restart. Hosts that swap instances (Render) no longer fail the
// swap because of a stale token — the new instance simply reports
// discordReady:false until a valid token is provided.
const LOGIN_RETRY_MS = 30_000;

/** DISCORD_TOKEN, re-read from .env when the file exists (pm2/VPS flow). */
function currentToken() {
  try {
    const line = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
      .split('\n').find((l) => l.startsWith('DISCORD_TOKEN='));
    const v = line ? line.slice('DISCORD_TOKEN='.length).trim() : '';
    if (v) return v;
  } catch { /* no .env file — token comes from the env provider */ }
  return CONFIG.discordToken;
}

(async function loginLoop() {
  for (;;) {
    const token = currentToken();
    if (!token) {
      console.error('DISCORD_TOKEN is not set. Get one at https://discord.com/developers/applications → Bot → Reset Token, then put it in .env — retrying in 30s');
    } else {
      try {
        await client.login(token);
        return; // gateway up — Events handlers take it from here
      } catch (e) {
        console.error(`Discord login failed: ${String(e?.message || e).slice(0, 300)} — retrying in 30s`);
        try { client.destroy(); } catch { /* not connected yet */ }
      }
    }
    await new Promise((r) => setTimeout(r, LOGIN_RETRY_MS));
  }
})();
