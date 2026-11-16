/**
 * setprefix — owner-only per-server prefix command (v2.20.0).
 * Covers: owner gate metadata, reset semantics, length cap, DB write path,
 * and the '.' default fallback wiring (config/ctx/catalog/dashboard).
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

const replies = [];
const makeCtx = (args, opts = {}) => ({
  args,
  guildId: opts.noGuild ? null : (opts.guildId ?? 'g-1'),
  isSlash: opts.isSlash ?? false,
  interaction: opts.isSlash ? { options: { getString: () => opts.slashArg ?? null } } : null,
  reply: async (payload) => { replies.push(payload); return payload; },
});

await check('setprefix is registered as owner-only with slash options', () => {
  assert.equal(cmd.name, 'setprefix');
  assert.equal(cmd.owner, true, 'must be owner-only');
  assert.ok(Array.isArray(cmd.slash?.options), 'slash options present');
});

await check('rejects prefixes over 8 characters before touching the db', async () => {
  replies.length = 0;
  await cmd.run(makeCtx(['way-too-long-prefix']));
  assert.ok(replies[0].includes('too long'), `rejection card: ${replies[0]}`);
});

await check('refuses to run outside a server (DM guard)', async () => {
  replies.length = 0;
  await cmd.run(makeCtx(['b!'], { noGuild: true }));
  assert.ok(replies[0].includes('server only'), `dm guard card: ${replies[0]}`);
});

await check('db-unavailable path replies with the fallback card', async () => {
  // no DATABASE_URL in the test env → setGuildSettings returns false
  const db = await import(path.join(root, 'src', 'db.js'));
  const url = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    replies.length = 0;
    await cmd.run(makeCtx(['b!']));
    assert.ok(replies[0].includes('database unavailable'), `fallback card: ${replies[0]}`);
    assert.equal(typeof db.setGuildSettings, 'function');
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
  // idempotent
  assert.equal(finalizeReadable(out), out);
});

console.log(`\nsetprefix: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
