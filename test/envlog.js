/**
 * v2.25.0 suite — env logger V2 (global-env access recorder) + evidence store.
 *
 * 1. Worker-level E2E: the envlog-probe fixture runs through the jailed
 *    vm-lift-worker; the result must carry envlog with the missing-global
 *    read (webhook_url) and both global writes (MARKER_ONE/MARKER_TWO),
 *    while jail instrumentation names stay filtered out.
 * 2. Report-level integration: buildLoggerReport exposes env + notable;
 *    buildRecordingText embeds the env-access + notable sections.
 * 3. Evidence store: record() → summary() round-trip on an isolated varDir.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function runWorker(fixture, env = {}) {
  const res = spawnSync(process.execPath, [path.join(root, 'src', 'vm-lift-worker.js'), fixture], {
    encoding: 'utf8',
    timeout: 130_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `worker produced no result (stderr: ${(res.stderr || '').slice(0, 200)})`);
  return JSON.parse(line);
}

test('envlog: worker carries the global-env access record', () => {
  const d = runWorker(path.join(root, 'test', 'fixtures', 'envlog-probe.lua'));
  assert.equal(d.ok, true);
  assert.ok(d.envlog && Array.isArray(d.envlog.reads) && Array.isArray(d.envlog.writes), 'envlog missing');
  const reads = d.envlog.reads.map((r) => r.n);
  const writes = d.envlog.writes.map((w) => w.n);
  assert.ok(reads.includes('webhook_url'), 'missing-global read not recorded');
  assert.ok(writes.includes('MARKER_ONE'), 'global write (plain) not recorded');
  assert.ok(writes.includes('MARKER_TWO'), 'global write (_G[...]) not recorded');
  // jail internals must never leak into the record
  const all = [...reads, ...writes];
  assert.ok(!all.some((n) => /^(?:_BX_|__bx|_bx_)/.test(n)), 'jail instrumentation names leaked into envlog');
  // counts are positive ints, sorted desc
  for (const r of d.envlog.reads) assert.ok(Number.isInteger(r.c) && r.c > 0);
  for (let i = 1; i < d.envlog.writes.length; i++) {
    assert.ok(d.envlog.writes[i - 1].c >= d.envlog.writes[i].c, 'writes not sorted by count');
  }
});

test('envlog: harvester worker carries the same record', () => {
  const res = spawnSync(process.execPath, [path.join(root, 'src', 'harvester-worker.js'), path.join(root, 'test', 'fixtures', 'envlog-probe.lua')], {
    encoding: 'utf8',
    timeout: 130_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
  assert.ok(line, 'harvester produced no result');
  const d = JSON.parse(line);
  assert.equal(d.ok, true);
  assert.ok(d.envlog, 'harvester envlog missing');
  assert.ok(d.envlog.reads.some((r) => r.n === 'webhook_url'), 'harvester envlog read missing');
  assert.ok(d.envlog.writes.some((w) => w.n === 'MARKER_ONE'), 'harvester envlog write missing');
});

test('envlog: logger report + recording text integrate env and notable', async () => {
  // import order matters: load the command registry FIRST (same as src/index.js)
  // so logger.js's own imports resolve without a partial-module cycle.
  await import('../src/commands-index.js');
  const { buildLoggerReport, buildRecordingText } = await import('../src/commands/logger.js');
  const r = buildLoggerReport({
    ran: true,
    strings: [
      'https://discord.com/api/webhooks/999/fake-hook-token',
      'please_enter_your_password_again',
      'Hello from MoonSec VM',
    ],
    chunks: [],
    envlog: {
      reads: [{ n: 'webhook_url', c: 3 }, { n: 'getgenv', c: 1 }],
      writes: [{ n: 'MARKER_ONE', c: 1 }],
    },
  });
  assert.equal(r.env.reads.length, 2);
  assert.equal(r.env.writeTotal, 1);
  assert.ok(r.notable.some((x) => x.kind === 'webhook'), 'webhook not classified as notable');
  const text = buildRecordingText(r, { filename: 'probe.lua' });
  assert.match(text, /notable strings/);
  assert.match(text, /global-env access/);
  assert.match(text, /webhook_url/);
  assert.match(text, /exfil webhook/);
});

test('evidence: record → summary round-trip on an isolated varDir', async () => {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-evidence-'));
  const { CONFIG } = await import('../src/config.js');
  const oldVar = CONFIG.varDir;
  CONFIG.varDir = tmp;
  try {
    const { record, summary } = await import('../src/antitamper/evidence.js');
    assert.equal(record({ type: 'defuse', vectors: [{ id: 'lph-crash', count: 2 }], bytesSaved: 120, file: 'a.lua' }), true);
    assert.equal(record({ type: 'logger', verdict: 'source', chunks: 1, strings: 5, notable: [{ kind: 'webhook', preview: 'https://discord.com/api/webhooks/1/x' }] }), true);
    const s = summary();
    assert.ok(s, 'summary returned null');
    assert.equal(s.defusals, 1);
    assert.equal(s.vectors['lph-crash'], 2);
    assert.equal(s.loggerRecordings, 1);
    assert.equal(record(null), false, 'null entry must be rejected');
    assert.equal(record({ big: 'x'.repeat(64 * 1024) }), false, 'oversized entry must be rejected');
  } finally {
    CONFIG.varDir = oldVar;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- runner -------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  PASS ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(`    ${String(e && e.message || e).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
if (failed) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\n${tests.length} passed, 0 failed`);
