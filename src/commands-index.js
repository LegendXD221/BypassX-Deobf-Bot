/**
 * Command registry — single source of truth for prefix + slash commands.
 * Commands flagged `owner: true` are enforced at dispatch (index.js) and
 * restricted to CONFIG.ownerId. Commands flagged `danger: true` additionally
 * pass through the 5-layer protection gate (src/owner-guard.js).
 */
import deobf from './commands/deobf.js';
import serviceCommands from './commands/services.js';
import loggerCmd from './commands/logger.js';
import detect from './commands/detect.js';
import families from './commands/families.js';
import stats from './commands/stats.js';
import paste from './commands/paste.js';
import beautify from './commands/beautify.js';
import strings from './commands/strings.js';
import history from './commands/history.js';
import help from './commands/help.js';
import ping from './commands/ping.js';
import invite from './commands/invite.js';
import evalCmd from './commands/eval.js';
import exec from './commands/exec.js';
import restart from './commands/restart.js';
import dbCmd from './commands/db.js';
import broadcast from './commands/broadcast.js';
import dm from './commands/dm.js';
import blacklist from './commands/blacklist.js';
import activity from './commands/activity.js';
import env from './commands/env.js';
import owner from './commands/owner.js';
import servers from './commands/servers.js';
import leave from './commands/leave.js';
import setstatus from './commands/setstatus.js';
import logs from './commands/logs.js';
import shutdown from './commands/shutdown.js';

export const COMMANDS = [
  // public — deobf family first (.deobf auto + every per-service command)
  deobf, ...serviceCommands, loggerCmd, detect, families, stats, paste, beautify, strings, history, help, ping, invite,
  // owner-only (eval/exec/restart/db/broadcast/dm/leave/shutdown are danger-gated)
  evalCmd, exec, restart, dbCmd, broadcast, dm, blacklist, activity, env, owner,
  servers, leave, setstatus, logs, shutdown,
];

export function commandByName(name) {
  return COMMANDS.find((c) => c.name === name) || null;
}

/** Convert a command definition to Discord REST JSON for slash registration. */
export function toSlashJson(cmd) {
  const TYPE_IDS = {
    SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5,
    USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11,
  };
  const options = (cmd.slash?.options || []).map((o) => ({
    name: o.name,
    description: o.description,
    type: typeof o.type === 'string' ? (TYPE_IDS[o.type] ?? 3) : o.type,
    required: Boolean(o.required),
  }));
  // Danger commands always get an optional PIN field (protection layer 2).
  if (cmd.danger && cmd.owner && !options.some((o) => o.name === 'pin')) {
    options.push({
      name: 'pin',
      description: 'Owner PIN — required when OWNER_PIN is set',
      type: TYPE_IDS.STRING,
      required: false,
    });
  }
  return {
    name: cmd.name,
    description: cmd.description,
    type: 1,
    options,
  };
}
