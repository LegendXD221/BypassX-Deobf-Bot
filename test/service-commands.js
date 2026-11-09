/**
 * v2.8.0 test suite — per-service commands + environment logger.
 *
 *   1. Registry: every service command (.prom .ms3 .ms2 .lph .clyde .psu .ib2
 *      .hcs .lo .mv .iv .77 .goofy .luast) + .l exists as prefix AND slash,
 *      with the catalog's exact names/descriptions.
 *   2. Supported card (.families): renders the EXACT per-command list and the
 *      exact usage line.
 *   3. resolveForced: strong accepted detection wins, weak/foreign/unknown is
 *      overridden by the command's pin.
 *   4. Forced run end-to-end: .ms3 on an unknown plain-Lua input still routes
 *      MoonSec V3 (forced) and delivers through the standard flow.
 *   5. .l report builder + recording text + card serialization + live command
 *      paths (fail + injected-lift success).
 *
 * Offline: fetch is routed (attachment download + pastefy); the dumper is
 * injected for the .l success path.
 */
import assert from 'node:assert/strict';
// Load the command registry FIRST — same order as src/index.js (benign import
// cycle: deobf → keepalive → dashboard → commands-index → deobf).
import '../src/commands-index.js';
import { COMMANDS, toSlashJson } from '../src/commands-index.js';
import { SERVICE_COMMANDS, resolveForced, serviceCommandLines, serviceUsageLine } from '../src/service-catalog.js';
import { detectService } from '../src/detect.js';
import { familiesReply, loggerReply } from '../src/replies.js';
import loggerCmd, { buildLoggerReport, buildRecordingText, runLogger } from '../src/commands/logger.js';
import { commandByName } from '../src/commands-index.js';
import { makeCtx } from '../src/ctx.js';
import { checkCooldown } from '../src/rate-limit.js';

const uid = (n) => `22200000000${n}`;
const calls = [];

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

function mockInteraction(userId) {
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
    async editReply(p) { this.deferred = true; this.replied = true; calls.push(`editReply:${typeof p === 'string' ? p : JSON.stringify(p).slice(0, 90)}`); },
    async reply(p) { this.replied = true; calls.push(`interaction.reply:${JSON.stringify(p).slice(0, 90)}`); },
    async followUp(p) { this.replied = true; calls.push(`followUp:${JSON.stringify(p).slice(0, 800)}`); },
  };
}

const ok = { total: 0, failed: 0 };
async function check(name, fn) {
  ok.total += 1;
  try { await fn(); console.log(`  PASS ${name}`); } catch (e) { ok.failed += 1; console.error(`  FAIL ${name}\n    ${String(e?.stack || e).split('\n').slice(0, 4).join('\n    ')}`); }
}

// ---- 1. registry --------------------------------------------------------------
await check('registry: all 15 catalog commands exist (prefix + slash) with exact names', () => {
  for (const spec of SERVICE_COMMANDS) {
    const cmd = commandByName(spec.cmd);
    assert.ok(cmd, `command .${spec.cmd} missing from registry`);
    assert.equal(cmd.name, spec.cmd);
    assert.equal(cmd.description, spec.slash, `.${spec.cmd} description must match catalog`);
    assert.ok(cmd.heavy, `.${spec.cmd} must be heavy`);
    const names = cmd.slash.options.map((o) => o.name).sort().join(',');
    assert.ok(names === 'file,link' || names === 'file,link', `.${spec.cmd} slash options: ${names}`);
    const json = toSlashJson(cmd);
    assert.equal(json.name, spec.cmd);
    assert.ok(json.description.length <= 100, `.${spec.cmd} slash description too long`);
    assert.match(json.name, /^[-_\p{L}\p{N}]{1,32}$/u, `.${spec.cmd} is not a valid slash command name`);
    if (spec.serviceId) assert.equal(cmd.serviceCmd, true, `.${spec.cmd} must flag serviceCmd`);
  }
  assert.equal(SERVICE_COMMANDS.length, 15, 'catalog must list exactly 15 service commands');
  assert.equal(commandByName('l'), loggerCmd, '.l must be the environment logger');
});

// ---- 2. supported card ----------------------------------------------------------
await check('supported card: exact per-command lines + exact usage line', () => {
  const payload = familiesReply('.');
  const s = JSON.stringify(payload);
  for (const line of serviceCommandLines('.')) {
    assert.ok(s.includes(line), `card missing line: ${line}`);
  }
  assert.ok(s.includes(serviceUsageLine('.')), `card missing usage line: ${serviceUsageLine('.')}`);
  // order must follow the user's list (l first, luast last)
  const first = serviceCommandLines('.')[0];
  const last = serviceCommandLines('.').at(-1);
  assert.ok(s.indexOf(first) < s.indexOf(last), 'card order must match the catalog order');
  assert.ok(first.includes('`.l` — **Environment Logger**'), `first line wrong: ${first}`);
  assert.ok(last.includes('`.luast` — **LuaST**'), `last line wrong: ${last}`);
});

// ---- 3. resolveForced ------------------------------------------------------------
await check('resolveForced: accepted strong detection wins; weak/foreign/unknown is overridden', () => {
  const mk = (id, score) => ({ service: { id }, score, confidence: 90 });
  const ms3 = { id: 'moonsec_v3', accept: ['moonsec_v3', 'moonsec_v1'], tag: 'ms3' };

  assert.equal(resolveForced(null, ms3)?.id, 'moonsec_v3', 'unknown input → forced');
  assert.equal(resolveForced(mk('moonsec_v3', 60), ms3), null, 'strong accepted hit → auto');
  assert.equal(resolveForced(mk('moonsec_v1', 55), ms3), null, 'accepted sibling (v1) → auto');
  assert.equal(resolveForced(mk('moonsec_v2', 20), ms3)?.id, 'moonsec_v3', 'weak hit → forced');
  assert.equal(resolveForced(mk('luraph', 90), ms3)?.id, 'moonsec_v3', 'foreign family → forced (explicit choice wins)');
  assert.equal(resolveForced(mk('prometheus', 60), { id: 'prometheus', accept: ['prometheus', 'wearedevs'] }), null, '.prom keeps prometheus');
  assert.equal(resolveForced(mk('wearedevs', 50), { id: 'prometheus', accept: ['prometheus', 'wearedevs'] }), null, '.prom keeps wearedevs');
  assert.equal(resolveForced(mk('77fuscator', 60), { id: 'goofyscator' })?.id, 'goofyscator', 'no accept list → only the forced id');
  assert.equal(resolveForced(mk('luraph', 90), null), null, 'no forced request → pure auto');
  assert.equal(detectService(Buffer.from('protected using Luraph Obfuscator v15.1')).best?.service?.id, 'luraph', 'sanity: detector table reachable');
});

// ---- 4. forced run end-to-end (.ms3) ---------------------------------------------
await check('.ms3 forced run: targeting ack → ✅ → result card carries MoonSec V3', async () => {
  calls.length = 0;
  const cmd = commandByName('ms3');
  const interaction = mockInteraction(uid(1));
  await cmd.run(makeCtx({ interaction, client: {} }));
  const seq = calls.map((c) => c.split(':')[0]);
  assert.deepEqual(seq.filter((s) => s !== 'fetch'), ['deferReply', 'editReply', 'editReply', 'followUp'],
    `unexpected order: ${seq.join(' → ')}`);
  const firstStatus = calls.find((c) => c.startsWith('editReply:'));
  assert.ok(firstStatus.includes(`<@${uid(1)}> deobfuscating Your Code`), `status must mention user, got: ${firstStatus}`);
  assert.ok(firstStatus.includes('targeting MoonSec V3'), `status must name the forced target, got: ${firstStatus}`);
  assert.ok(calls.some((c) => c.includes('✅') && c.startsWith('editReply')), 'final status must be ✅');
  const fu = calls.find((c) => c.startsWith('followUp:'));
  assert.ok(fu, 'result must arrive via followUp');
  assert.ok(fu.includes('MoonSec V3'), `forced family must appear on the result card: ${fu.slice(0, 200)}`);
}, );

// ---- 5. logger -------------------------------------------------------------------
await check('logger: report builder verdicts + chunk classification', () => {
  const src = 'local a = 1\nprint("hi")\n';
  const r = buildLoggerReport({
    ok: true, ran: true,
    strings: ['hello world string', 'https://raw.githubusercontent.com/x/y.lua', 'x'.repeat(50)],
    chunks: [src, '\x1bLua bytecode-ish-data-here-aaaa', 'short'],
  });
  assert.equal(r.verdict, 'source', 'source chunk wins the verdict ladder');
  assert.equal(r.counts.total, 2, 'short data chunk (<12 chars) dropped');
  assert.equal(r.counts.sources, 1);
  assert.equal(r.counts.bytecode, 1);
  assert.ok(r.urls.includes('https://raw.githubusercontent.com/x/y.lua'), 'URLs extracted from pool');
  assert.equal(buildLoggerReport({ ok: false, error: 'vm-lift worker exit 1' }).verdict, 'norecord');
  assert.equal(buildLoggerReport({ ok: true, ran: true, strings: [] }).verdict, 'clean');
  assert.equal(buildLoggerReport({ ok: true, ran: false, strings: ['pool-string-one', 'pool-string-two', 'pool-string-3', 'pool-string-4'] }).verdict, 'pool');
});

await check('logger: single source chunk ships as PURE code; mixed ships annotated report', () => {
  const src = 'local a = 1\nprint("hi")\n';
  const pure = buildRecordingText(buildLoggerReport({ ok: true, ran: true, strings: [], chunks: [src] }), { filename: 's.lua' });
  assert.ok(pure.startsWith('--[['), 'pure delivery keeps a short header');
  assert.ok(pure.includes(src.trim()), 'pure delivery contains the chunk verbatim');
  const mixed = buildRecordingText(
    buildLoggerReport({ ok: true, ran: true, strings: ['one string here', 'two string here', 'three string'], chunks: [src] }),
    { filename: 's.lua' },
  );
  assert.ok(mixed.includes('--==== captured chunk 1'), 'mixed report annotates chunks');
  assert.ok(mixed.includes('local STRINGS'), 'mixed report includes the pool table');
});

await check('logger card + families-style serialization stays within V2 budget', () => {
  const report = buildLoggerReport({ ok: true, ran: true, strings: ['abc', 'def'], chunks: [] });
  report.signature = 'Luraph v14.4 — 99%';
  const payload = loggerReply(report, { url: 'https://pastefy.app/xyz', rawUrl: 'https://pastefy.app/xyz/raw' }, 's.lua', '.', Buffer.from('x'));
  const s = JSON.stringify(payload);
  assert.ok(s.includes('Environment Logger'), 'card title present');
  assert.ok(s.includes('Luraph v14.4'), 'signature fact present');
});

await check('.l fail path: ❌ status + error card, dumper never invoked', async () => {
  calls.length = 0;
  const interaction = mockInteraction(uid(2));
  interaction.options.getAttachment = () => ({ name: 'gone.lua', size: 10, url: 'https://attach.mock/fail/gone.lua' });
  let lifted = false;
  await runLogger(makeCtx({ interaction, client: {} }), { lift: async () => { lifted = true; return { ok: true, ran: true, strings: [] }; } });
  assert.ok(!lifted, 'dumper must not run without input');
  assert.ok(calls.some((c) => c.startsWith('editReply:') && c.includes('❌')), `status must turn ❌: ${calls.join(' | ')}`);
  assert.ok(calls.some((c) => c.startsWith('followUp:')), 'error card via followUp');
});

await check('.l success path (injected dumper): status flow + recording card + paste', async () => {
  calls.length = 0;
  const interaction = mockInteraction(uid(3));
  const fake = {
    ok: true, ran: true,
    strings: ['http://example.com/payload.lua', 'some long enough string here', 'another long string!!'],
    chunks: ['local flag = game.PlaceId\nprint("payload", flag)\n'],
    log: [],
  };
  await runLogger(makeCtx({ interaction, client: {} }), { lift: async () => fake });
  const seq = calls.map((c) => c.split(':'));
  assert.equal(seq[0][0], 'deferReply', 'ack first');
  assert.ok(calls.some((c) => c.startsWith('editReply:') && c.includes('running Your Code in the environment logger')), 'logger status text');
  assert.ok(calls.some((c) => c.startsWith('editReply:') && c.includes('✅')), 'status flips to ✅');
  const fu = calls.find((c) => c.startsWith('followUp:'));
  assert.ok(fu, 'recording card via followUp');
  assert.ok(fu.includes('decrypted source captured at load()'), `verdict title on card: ${fu.slice(0, 300)}`);
  assert.ok(fu.includes('Environment Logger'), 'card title present');
  assert.ok(calls.some((c) => c.startsWith('fetch:https://pastefy.app')), 'recording uploaded to pastefy');
});

await check('cooldown: service commands share the deobf-family rate limit', async () => {
  checkCooldown(uid(4));
  calls.length = 0;
  const interaction = mockInteraction(uid(4));
  await commandByName('lph').run(makeCtx({ interaction, client: {} }));
  assert.ok(!calls.some((c) => c.startsWith('deferReply')), 'cooldown short-circuits before ack');
  assert.ok(calls.some((c) => c.startsWith('interaction.reply:')), 'cooldown card via reply');
});

console.log(`\n${ok.total - ok.failed}/${ok.total} checks passed`);
if (ok.failed) process.exit(1);
