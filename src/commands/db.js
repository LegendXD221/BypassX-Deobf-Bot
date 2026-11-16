/**
 * .db — OWNER, DANGEROUS (L1-L5). Raw SQL against the Neon database.
 *   .db status       — connection + table overview (no confirmation needed inside)
 *   .db <sql>        — run any SQL statement (confirm-gated)
 * The DATABASE_URL credential only ever lives in the host env — output never
 * includes it.
 */
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';
import * as db from '../db.js';

function fmtRows(res) {
  const lines = [];
  if (res.fields?.length) lines.push(res.fields.join(' | '));
  const shown = res.rows.slice(0, 20);
  for (const r of shown) {
    lines.push(Object.values(r).map((v) => {
      if (v === null || v === undefined) return '∅';
      if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
      return String(v).slice(0, 120);
    }).join(' | '));
  }
  if (res.rows.length > shown.length) lines.push(`… ${res.rows.length - shown.length} more rows`);
  return lines.join('\n') || '(empty result)';
}

export default {
  name: 'db',
  description: '[owner] Raw SQL on the Neon database (dangerous — confirmation required)',
  usage: '.db <sql | status>',
  owner: true,
  danger: true,
  slash: {
    options: [
      { name: 'sql', description: 'SQL statement to run, or "status"', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const sql = ctx.isSlash
      ? ctx.interaction.options.getString('sql', true)
      : (ctx.args || []).join(' ');
    if (!sql.trim()) return ctx.reply(errorReply('Missing SQL', 'Give me a statement, or `.db status`.'));

    if (!db.describe().enabled) {
      return ctx.reply(errorReply('Database offline', 'DATABASE_URL is not set. Add your Neon connection string in the Render dashboard (or .env) and restart — the schema bootstraps itself.'));
    }

    if (sql.trim().toLowerCase() === 'status') {
      const d = db.describe();
      const counts = [
        ['deobf_history', 'SELECT COUNT(*)::int AS n FROM deobf_history'],
        ['owner_audit', 'SELECT COUNT(*)::int AS n FROM owner_audit'],
        ['blacklist', 'SELECT COUNT(*)::int AS n FROM blacklist'],
      ];
      const parts = [];
      for (const [name, q] of counts) {
        const res = await db.query(q);
        parts.push(`${name}: ${res ? `${res.rows[0]?.n ?? 0} rows` : 'unavailable'}`);
      }
      return ctx.reply(ownerOutputReply({
        title: 'database status', ok: true,
        output: [
          `connected: ${d.connected ? 'yes' : 'no'} (latency ${d.latencyMs ?? '—'} ms)`,
          `host: ${d.host || '—'}`,
          d.error ? `last error: ${d.error}` : 'last error: none',
          '',
          ...parts,
        ].join('\n'),
        meta: ['neon free tier', 'ssl on'],
      }));
    }

    await ctx.defer();
    const res = await db.rawSql(sql);
    logger.warn({ ms: res.ms, chars: sql.length }, 'owner db sql');
    if (res.error) {
      return ctx.reply(ownerOutputReply({ title: 'db error', ok: false, input: sql, output: res.error, meta: [`${res.ms}ms`] }));
    }
    return ctx.reply(ownerOutputReply({
      title: 'db result', ok: true, input: sql,
      output: `${fmtRows(res)}\n\n[${res.rowCount} row(s) in ${res.ms}ms]`,
      meta: ['raw sql', `${res.ms}ms`],
    }));
  },
};
