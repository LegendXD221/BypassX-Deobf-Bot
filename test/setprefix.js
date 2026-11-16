/**
 * setprefix — owner-only per-server prefix command (v2.20.0, ported to the
 * v2.21.0 hardening in src/commands/setprefix.js).
 *
 * Covers: owner gate metadata, slash shape, guards (missing arg / DM /
 * offline DB), and the '.' default fallback wiring + the readable finalize.
 *
 * NOTE on the port: the earlier v2.20.0 implementation read `ctx.guildId` —
 * makeCtx() never defines that field, so the DM guard would have tripped in
 * production. The kept implementation resolves the guild from
 * ctx.interaction?.guildId || ctx.message?.guildId (these tests mock exactly
 * that shape).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`  PASS ${name}`); })
    .catch((e) => { fail += 1; console.error(`  FAIL ${name}: ${e.message}`); });
}

const cmd = (await import(path.join(root, 'src', 'commands', 'setprefix.js'))).default;
const { CONFIG } = await import(path.join(root, 'src', 'config.js'));
const { finalizeReadable } = await import(path.join(root, 'src', 'finalize.js'));
const { toSlashJson } = await import(path.join(root, 'src', 'commands-index.js'));

const replies = [];
const makeCtx = (arg, opts = {}) => {
  const interaction = opts.isSlash
    ? { guildId: opts.noGuild ? null : (opts.guildId ?? 'g-1'), options: { getString: () => arg ?? null }, user: { id: 'u' } }
    : null;
  const message = opts.isSlash ? null : {
    guildId: opts.noGuild ? null : (opts.guildId ?? 'g-1'),
    author: { id: 'u', tag: 't' },
    _prefix: '.',
    attachments: new Map(),
  };
  const ctx = {
    args: opts.isSlash ? [] : [arg],
    isSlash: Boolean(opts.isSlash),
    interaction,
    message,
    userId: 'u',
    prefix: '.',
    reply: async (payload) => { replies.push(JSON.stringify(payload)); return payload; },
  };
  return ctx;
};

await check('setprefix is registered as owner-only with a required slash option', () => {
  assert.equal(cmd.name, 'setprefix');
  assert.equal(cmd.owner, true, 'must be owner-only');
  assert.ok(!cmd.danger, 'not danger-gated');
  const json = toSlashJson(cmd);
  assert.equal(json.name, 'setprefix');
  assert.ok(json.options.some((o) => o.name === 'prefix' && o.required), 'slash needs required prefix option');
});

await check('rejects a missing prefix before touching anything else', async () => {
  replies.length = 0;
  await cmd.run(makeCtx(''));
  assert.ok(replies[0].includes('Missing prefix'), `rejection card: ${replies[0]}`);
});

await check('refuses to run outside a server (DM guard)', async () => {
  replies.length = 0;
  await cmd.run(makeCtx('.', { noGuild: true }));
  assert.ok(replies[0].includes('Server only'), `dm guard card: ${replies[0]}`);
});

await check('db-unavailable path replies with the fallback card (prefix arg + reset)', async () => {
  const db = await import(path.join(root, 'src', 'db.js'));
  assert.equal(typeof db.setGuildSettings, 'function');
  const url = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    replies.length = 0;
    await cmd.run(makeCtx('!'));
    assert.ok(replies[0].includes('Database offline'), `offline card: ${replies[0]}`);
    replies.length = 0;
    await cmd.run(makeCtx('reset'));
    assert.ok(replies[0].includes('Database offline'), `offline card on reset: ${replies[0]}`);
  } finally {
    if (url) process.env.DATABASE_URL = url;
  }
});

await check('global default prefix is "." everywhere', () => {
  assert.equal(CONFIG.prefix, '.', 'config default');
});

await check('readable finalize produces heading + code only', () => {
  const out = finalizeReadable('print(1)');
  const lines = out.split('\n');
  assert.equal(lines.length, 2, `exactly heading + code: ${JSON.stringify(lines)}`);
  assert.ok(lines[0].startsWith('-- This File Was Deobfuscated By BypassX Deobf. discord - https://dc.gg/bypassx'), 'heading text');
  assert.equal(lines[1], 'print(1)');
  // idempotent — and the no-space variant collapses onto the canonical one
  assert.equal(finalizeReadable(out), out);
  assert.equal(finalizeReadable('--This File Was Deobfuscated By BypassX Deobf. discord - https://dc.gg/bypassx\nprint(1)'), out);
});

console.log(`\nsetprefix: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
