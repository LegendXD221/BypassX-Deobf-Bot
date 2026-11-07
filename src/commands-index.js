/**
 * Command registry — single source of truth for prefix + slash commands.
 */
import deobf from './commands/deobf.js';
import detect from './commands/detect.js';
import families from './commands/families.js';
import help from './commands/help.js';
import ping from './commands/ping.js';
import invite from './commands/invite.js';

export const COMMANDS = [deobf, detect, families, help, ping, invite];

export function commandByName(name) {
  return COMMANDS.find((c) => c.name === name) || null;
}

/** Convert a command definition to Discord REST JSON for slash registration. */
export function toSlashJson(cmd) {
  const TYPE_IDS = {
    SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5,
    USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11,
  };
  return {
    name: cmd.name,
    description: cmd.description,
    type: 1,
    options: (cmd.slash?.options || []).map((o) => ({
      name: o.name,
      description: o.description,
      type: typeof o.type === 'string' ? (TYPE_IDS[o.type] ?? 3) : o.type,
      required: Boolean(o.required),
    })),
  };
}
