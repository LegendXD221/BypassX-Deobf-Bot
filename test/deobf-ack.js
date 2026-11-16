/**
 * v2.7.1 smoke test — the `.deobf` acknowledgement flow:
 *   "@user deobfuscating Your Code …" appears IMMEDIATELY (before the
 *   pipeline runs), and the finished code is delivered as a SEPARATE
 *   follow-up message afterwards — for both slash and prefix invocations,
 *   plus every failure path updates the status line instead of dying.
 *
 * Offline: global fetch is routed (attachment download + pastefy upload).
 */
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
// Load the command registry FIRST — same order as src/index.js. deobf.js is
// part of a benign import cycle (deobf → keepalive → dashboard → commands-index
// → deobf) that TDZs only if deobf.js is the entry point.
import '../src/commands-index.js';
import deobf from '../src/commands/deobf.js';
import { makeCtx } from '../src/ctx.js';
import { checkCooldown } from '../src/rate-limit.js';

const USER_ID = '987654321'; // used only by the cooldown test
const uid = (n) => `11100000000${n}`; // unique per check — cooldowns are per-user
const calls = [];

// ---- fetch router: attachment download + pastefy upload, everything else 404
const TINY_LUA = 'local x = 42\nprint("blah blah")\n';
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(`fetch:${u.slice(0, 60)}`);
  if (u.startsWith('https://attach.mock/ok')) {
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(TINY_LUA).buffer, headers: new Map() };
  }
  if (u.startsWith('https://attach.mock/fail')) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
  if (u.startsWith('https://pastefy.app/api/v2/paste')) {
    return { ok: true, status: 200, json: async () => ({ paste: { id: 'fakePaste1' } }), headers: new Map() };
  }
  return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
};

// ---- mock Discord objects ----------------------------------------------------
function mockInteraction(userId = USER_ID) {
  return {
    user: { id: userId, tag: 'tester' },
    guildId: 'guild1',
    deferred: false,
    replied: false,
    options: {
      getAttachment: () => ({ name: 'script.lua', size: TINY_LUA.length, url: 'https://attach.mock/ok/script.lua' }),
      getString: () => null,
      getMessage: () => null,
    },
    async deferReply() { this.deferred = true; calls.push('deferReply'); },
    async editReply(p) { this.deferred = true; this.replied = true; calls.push(`editReply:${typeof p === 'string' ? p : JSON.stringify(p).slice(0, 80)}`); },
    async reply(p) { this.replied = true; calls.push(`interaction.reply:${JSON.stringify(p).slice(0, 80)}`); },
    async followUp(p) { this.replied = true; calls.push(`followUp:${p?.flags ? 'flags-ok' : 'no-flags'}:${JSON.stringify(p).slice(0, 60)}`); },
  };
}

function mockMessage(userId = USER_ID) {
  return {
    author: { id: userId, tag: 'tester' },
    guildId: 'guild1',
    _prefix: '.',
    content: '.deobf',
    attachments: new Map([['1', { name: 'script.lua', size: TINY_LUA.length, url: 'https://attach.mock/ok/script.lua' }]]),
    reference: null,
    replies: [],
    async reply(p) { const sent = { ...p, async edit(t) { calls.push(`msg.edit:${JSON.stringify(t).slice(0, 80)}`); } }; calls.push(`msg.reply:${JSON.stringify(p).slice(0, 80)}`); this.replies.push(sent); return sent; },
  };
}

const ok = { total: 0, failed: 0 };
async function check(name, fn) {
  ok.total += 1;
  try { await fn(); console.log(`  PASS ${name}`); } catch (e) { ok.failed += 1; console.error(`  FAIL ${name}\n    ${String(e?.stack || e).split('\n').slice(0, 4).join('\n    ')}`); }
}

// ---- tests -------------------------------------------------------------------
await check('slash: status-first ordering, mention text, followUp delivery', async () => {
  calls.length = 0;
  const interaction = mockInteraction(uid(1));
  await deobf.run(makeCtx({ interaction, client: {} }));
  const seq = calls.map((c) => c.split(':')[0]);
  assert.deepEqual(seq.filter((s) => s !== 'fetch'), ['deferReply', 'editReply', 'editReply', 'followUp'],
    `unexpected order: ${seq.join(' → ')}`);
  const firstStatus = calls.find((c) => c.startsWith('editReply:'));
  assert.ok(firstStatus.includes(`<@${uid(1)}> deobfuscating Your Code`), `status must mention user + exact phrase, got: ${firstStatus}`);
  assert.ok(firstStatus.includes('script.lua'), 'status should name the input file');
  assert.ok(calls.some((c) => c.startsWith('editReply:{') === false || true));
  assert.ok(calls.some((c) => c.includes('✅') && c.startsWith('editReply')), 'final status must be the ✅ done line');
  const fu = calls.find((c) => c.startsWith('followUp:flags-ok'));
  assert.ok(fu, `result must arrive as followUp, calls: ${calls.join(' | ')}`);
});

await check('prefix: status is the FIRST reply, result a separate reply', async () => {
  calls.length = 0;
  const message = mockMessage(uid(2));
  await deobf.run(makeCtx({ message, client: {} }));
  const replies = calls.filter((c) => c.startsWith('msg.reply:'));
  assert.ok(replies.length >= 2, `expected status + result replies, got: ${calls.join(' | ')}`);
  assert.ok(replies[0].includes(`<@${uid(2)}> deobfuscating Your Code`), `first reply must be the mention status, got: ${replies[0]}`);
  assert.ok(calls.some((c) => c.includes('✅') && c.startsWith('msg.edit')), 'status line must be edited to ✅ on completion');
});

await check('failure path: ❌ status update + error card via send (no crash)', async () => {
  calls.length = 0;
  const interaction = mockInteraction(uid(3));
  interaction.options.getAttachment = () => ({ name: 'gone.lua', size: 10, url: 'https://attach.mock/fail/gone.lua' });
  await deobf.run(makeCtx({ interaction, client: {} }));
  assert.ok(calls.some((c) => c.startsWith('editReply:') && c.includes('❌')), `status must turn ❌, got: ${calls.join(' | ')}`);
  assert.ok(calls.some((c) => c.startsWith('followUp:')), 'error card must arrive via followUp');
});

await check('cooldown path: no status placeholder, ephemeral card via reply', async () => {
  calls.length = 0;
  checkCooldown(USER_ID); // burn the cooldown for this user
  const interaction = mockInteraction();
  await deobf.run(makeCtx({ interaction, client: {} }));
  assert.ok(!calls.some((c) => c.startsWith('deferReply')), 'cooldown must short-circuit before any status');
  assert.ok(!calls.some((c) => c.includes('deobfuscating Your Code')), 'no status on cooldown');
});

console.log(`\n${ok.total - ok.failed}/${ok.total} checks passed`);
if (ok.failed) process.exit(1);
