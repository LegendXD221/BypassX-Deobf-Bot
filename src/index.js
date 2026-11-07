/**
 * BypassX Deobf Bot — Discord client entry point.
 *
 * Supports both prefix commands (.deobf …) and slash commands (/deobf …).
 * Slash commands self-register on ready (global; + instant per-guild when
 * GUILD_ID is set).
 */
import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { COMMANDS, commandByName, toSlashJson } from './commands-index.js';
import { makeCtx } from './ctx.js';
import { probe as probeEngine } from './engine.js';
import { errorEmbed } from './replies.js';

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
  c.user.setPresence({
    activities: [{ name: '.deobf | /deobf — best deobf bot', type: 3 }], // 3 = WATCHING
    status: 'online',
  });
  await registerSlashCommands();
  const engine = await probeEngine();
  if (!engine.available) {
    logger.warn({}, 'engine not available — runs will fail until bin/prepare-engine.js completes');
  }
});

// ---- slash interactions -----------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commandByName(interaction.commandName);
  if (!cmd) return;
  const ctx = makeCtx({ interaction, client });
  try {
    await cmd.run(ctx);
  } catch (e) {
    logger.error({ err: String(e?.stack || e).slice(0, 600), cmd: cmd.name }, 'slash command crashed');
    try {
      await ctx.reply({ embeds: [errorEmbed('Unexpected error', String(e.message || e).slice(0, 500))] });
    } catch { /* reply already sent */ }
  }
});

// ---- prefix commands --------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (!CONFIG.prefix || !message.content?.startsWith(CONFIG.prefix)) return;

    const parts = message.content.slice(CONFIG.prefix.length).trim().split(/\s+/);
    const name = (parts.shift() || '').toLowerCase();
    if (!name) return;
    const cmd = commandByName(name);
    if (!cmd) return; // silent for unknown commands

    const ctx = makeCtx({ message, client });
    // Resolve a reply-target attachment so `.deobf` works as a reply.
    if (!ctx.attachments.length && message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        if (ref?.attachments?.size) ctx.attachments.push(...ref.attachments.values());
      } catch { /* reference gone */ }
    }
    ctx.prefix = CONFIG.prefix;

    await cmd.run(ctx);
  } catch (e) {
    logger.error({ err: String(e?.stack || e).slice(0, 600) }, 'prefix command crashed');
  }
});

// ---- lifecycle --------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason?.stack || reason).slice(0, 600) }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: String(err?.stack || err).slice(0, 600) }, 'uncaught exception');
});

if (!CONFIG.discordToken) {
  console.error('DISCORD_TOKEN is not set. Get one at https://discord.com/developers/applications → Bot → Reset Token, then put it in .env');
  process.exit(1);
}

client.login(CONFIG.discordToken).catch((e) => {
  console.error(`Discord login failed: ${String(e?.message || e).slice(0, 300)}`);
  process.exit(1);
});
