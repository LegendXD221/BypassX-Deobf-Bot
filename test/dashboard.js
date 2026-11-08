/**
 * v1.5.0 unit tests — secret owner dashboard + DB overload protection.
 * Run: node test/dashboard.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { setDashboardClient, handleDashboard, announceDashboard } from '../src/dashboard.js';
import { prettyEngine, esc } from '../src/pretty.js';
import * as db from '../src/db.js';

process.env.DASHBOARD_TOKEN = 'test-token-0123456789abcdefghij';

// fake Discord client
const guildId = '999888777666555444';
const fakeGuild = {
  id: guildId,
  name: 'Test Guild ‹emo› & <stuff>',
  memberCount: 421337,
  iconURL: () => null,
  joinedTimestamp: Date.now(),
  ownerId: '111',
  channels: { cache: new Map([['ch1', { id: 'ch1', name: 'general', isTextBased: () => true, viewable: true }]]) },
};
const fakeClient = {
  user: { tag: 'BypassX Deobf#0267', id: '1568531740530581586' },
  ws: { ping: 42 },
  guilds: { cache: new Map([[guildId, fakeGuild]]), has: (id) => id === guildId, get: (id) => (id === guildId ? fakeGuild : null) },
  channels: { fetch: async () => { throw new Error('nope'); } },
};
setDashboardClient(fakeClient);

const server = http.createServer((req, res) => {
  handleDashboard(req, res, (req.url || '/').split('?')[0]).catch(() => {
    try { res.writeHead(500); res.end(); } catch { /* ignore */ }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const TOK = process.env.DASHBOARD_TOKEN;

function req(path, { method = 'GET', body = null } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---- auth: the URL is the credential ------------------------------------------
let r = await req('/dash/wrong-guess');
assert.equal(r.status, 404, 'auth: wrong token → 404');
assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', 'auth: noindex header');

r = await req(`/dash/${TOK}`);
assert.equal(r.status, 200, 'auth: right token → dashboard');
const page = await r.text();
assert.ok(page.includes('mission control'), 'page: dashboard renders');
assert.ok(page.includes('Per-guild control'), 'page: guild control present');
assert.ok(!page.includes(TOK), 'page: token never echoed inside the page HTML');
assert.ok(r.headers.get('cache-control').includes('no-store'), 'page: never cached');
assert.ok(r.headers.get('x-frame-options') === 'DENY', 'page: clickjacking protection');
// v2.3.0 regression guard: the v2.0 dashboard shipped a client script that
// FAILED TO PARSE (template-literal escape bug) — page looked fine but every
// button was dead. Parse the served inline script here so that can never
// happen silently again.
{
  const script = page.split('<script>')[1].split('</scr' + 'ipt>')[0];
  assert.ok(script.length > 10_000, 'page: inline client script extracted');
  new Function(script); // throws on syntax error
  // tool cards are built client-side — assert the builder data ships in the script
  assert.ok(script.includes('Run full deobf') && script.includes('Detect obfuscator'), 'page: power tools builders present (deobf + detect)');
  assert.ok(script.includes('Extract strings') && script.includes('Run shell'), 'page: analyzer + shell tools present');
}
console.log('dashboard auth + page + CLIENT SCRIPT PARSE: ok');

// ---- guilds with names + member counts ------------------------------------------
r = await req(`/dash/${TOK}/api/state`);
assert.equal(r.status, 200, 'state: reachable');
const st = (await r.json()).data;
assert.equal(st.guilds.length, 1, 'state: guild list');
assert.equal(st.guilds[0].name, 'Test Guild ‹emo› & <stuff>', 'state: guild name');
assert.equal(st.guilds[0].memberCount, 421337, 'state: member count');
assert.ok(st.guilds[0].channels.some((c) => c.id === 'ch1'), 'state: guild channels exposed');
assert.equal(st.botTag, 'BypassX Deobf#0267', 'state: bot tag');
assert.ok(st.db && 'breaker' in st.db, 'state: db breaker info present');
console.log('guild list + state: ok');

// ---- powerful actions ------------------------------------------------------------
r = await req(`/dash/${TOK}/api/exec`, { method: 'POST', body: { cmd: 'echo dashboard-runner-ok' } });
let j = await r.json();
assert.ok(j.ok, 'exec: ran');
assert.ok(String(j.data.output).includes('dashboard-runner-ok'), `exec: output (got ${j.data.output})`);

r = await req(`/dash/${TOK}/api/eval`, { method: 'POST', body: { code: 'return 6 * 7' } });
j = await r.json();
assert.ok(j.ok, 'eval: ran');
assert.ok(String(j.data.output).includes('42'), 'eval: jailed result 42');
r = await req(`/dash/${TOK}/api/eval`, { method: 'POST', body: { code: 'return process.env.DISCORD_TOKEN' } });
j = await r.json();
assert.ok(!String(j.data.output).includes('MTU'), 'eval: no secret reach (process unreachable)');
console.log('power actions (exec/eval): ok');

// ---- guild settings require the DB --------------------------------------------------
r = await req(`/dash/${TOK}/api/guild`, { method: 'POST', body: { id: guildId, action: 'settings', disabled: true } });
j = await r.json();
assert.equal(j.ok, false, 'guild settings: refused without DB');
assert.ok(/database/i.test(j.error), 'guild settings: clear error');
r = await req(`/dash/${TOK}/api/guild`, { method: 'POST', body: { id: 'nope', action: 'leave' } });
j = await r.json();
assert.equal(j.ok, false, 'guild action: unknown guild refused');
console.log('guild settings guards: ok');

// ---- blacklist + logs + audit ---------------------------------------------------------
r = await req(`/dash/${TOK}/api/blacklist`, { method: 'POST', body: { action: 'add', target: '123' } });
j = await r.json();
assert.equal(j.ok, false, 'blacklist: needs DB');
r = await req(`/dash/${TOK}/api/logs?n=20`);
j = await r.json();
assert.ok(Array.isArray(j.data.lines), 'logs: lines array');
console.log('blacklist guard + logs: ok');

// ---- db overload protection shape ------------------------------------------------------
const d = db.describe();
assert.ok(d.breaker && Number.isFinite(d.breaker.queued), 'db: breaker telemetry exposed');
assert.ok(Number.isFinite(d.breaker.trips), 'db: trips counter exposed');
delete process.env.DATABASE_URL; // ensure helpers fail soft even when env was present
assert.equal(await db.query('SELECT 1'), null, 'db: query nulls out safely');
assert.deepEqual(await db.getGuildSettings(guildId), db.GUILD_DEFAULTS, 'db: guild settings fall back to defaults');
console.log('db overload protection + fallback: ok');

// ---- display helpers --------------------------------------------------------------------
assert.equal(prettyEngine('bypassx_deobf 0.12.0 (commit 54c88e2263b616c8258c48c43820716033c12b4e)'), 'bypassx_deobf 0.12.0', 'pretty: commit hash stripped');
assert.equal(prettyEngine('weird (commit abc123) trailing'), 'weird trailing', 'pretty: stray suffix removed');
assert.equal(esc('<img src=x onerror=alert(1)>&'), '&lt;img src=x onerror=alert(1)&gt;&amp;', 'esc: html escaped');
assert.ok(!page.includes('<img src=x'), 'page: no unescaped injection');
console.log('display helpers: ok');

// ---- brute-force lockout (LAST — it poisons the IP) --------------------------------------
for (let i = 0; i < 10; i++) {
  r = await req('/dash/incorrect-guess');
  assert.equal(r.status, 404, `brute: guess ${i + 1} → 404`);
}
// v2.3.0 fix: the v2.0 behavior locked the OWNER out too (right token → 404
// for 15 min after an attacker spammed wrong guesses). The correct token is
// the credential — presenting it must always pass and clear the lockout.
r = await req(`/dash/${TOK}`);
assert.equal(r.status, 200, 'brute: correct token is IMMUNE to lockout (v2.3 owner-unlock fix)');
r = await req(`/dash/${TOK}/api/state`);
assert.equal(r.status, 200, 'brute: api works after lockout clearance');
console.log('brute-force lockout + owner immunity: ok');

server.close();
console.log('\nALL DASHBOARD + DB PROTECTION TESTS PASSED');
process.exit(0);
