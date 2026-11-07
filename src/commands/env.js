/**
 * .env — OWNER. Show which environment variables are configured — NAMES and
 * set/unset state only. Secret-class values are ALWAYS masked; nothing that
 * could leak a credential is ever echoed.
 */
import { ownerOutputReply } from '../replies.js';
import * as db from '../db.js';

const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|PIN|DATABASE_URL|URL$/i;
const INTERESTING = [
  'DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'PREFIX', 'OWNER_ID', 'OWNER_PIN',
  'DATABASE_URL', 'PASTEFY_TOKEN', 'GITHUB_TOKEN', 'PUBLIC_URL', 'RENDER_EXTERNAL_URL',
  'MAX_UPLOAD_MB', 'ENGINE_TIMEOUT_S', 'PASTEFY_EXPIRE_DAYS', 'DANGER_COOLDOWN_S',
  'DANGER_MAX_PER_HOUR', 'CONFIRM_TIMEOUT_S', 'LOG_LEVEL', 'NODE_VERSION', 'PORT',
];

function mask(k, v) {
  if (v === undefined || v === '') return '— (unset)';
  if (SECRET.test(k)) return `${'•'.repeat(Math.min(16, Math.max(8, String(v).length / 2)))} (set, hidden)`;
  return String(v).slice(0, 60);
}

export default {
  name: 'env',
  description: '[owner] Which environment variables are set (values masked)',
  usage: '.env',
  owner: true,
  slash: { options: [] },

  async run(ctx) {
    const rows = INTERESTING.map((k) => `-# ${k} = ${mask(k, process.env[k])}`);
    const d = db.describe();
    rows.push(`-# DATABASE_URL: ${d.enabled ? `configured (${d.host})` : 'not set — database offline'}`);
    return ctx.reply(ownerOutputReply({
      title: 'environment', ok: true,
      output: rows.join('\n'),
      meta: ['values masked', `${INTERESTING.length} keys checked`],
    }));
  },
};
