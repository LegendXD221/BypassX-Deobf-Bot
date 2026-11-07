/**
 * Registers slash commands once (global + optional GUILD_ID for instant dev).
 * Run: npm run deploy
 */
import { REST, Routes } from 'discord.js';
import { CONFIG } from './src/config.js';
import { COMMANDS, toSlashJson } from './src/commands-index.js';
import { logger } from './src/logger.js';

async function main() {
  if (!CONFIG.discordToken || !CONFIG.clientId) {
    console.error('DISCORD_TOKEN and CLIENT_ID are required.');
    process.exit(1);
  }
  const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
  const body = COMMANDS.map(toSlashJson);
  if (CONFIG.guildId) {
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body });
    logger.info({ guild: CONFIG.guildId }, 'guild slash commands registered');
  }
  const res = await rest.put(Routes.applicationCommands(CONFIG.clientId), { body });
  logger.info({ count: res.length }, 'global slash commands registered');
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
