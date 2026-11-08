/**
 * Regression suite for the Luraph v14.x runtime-state devirtualizer (v2.6.0).
 *
 * Covers the real-world failure case: the TokraScript sample
 * (Luraph v14.4.2 payload VM) that previously deobfuscated to a bare,
 * unreadable VM-entry stub. The new stage must:
 *   1. probe available,
 *   2. refuse non-v14 input (graceful null),
 *   3. recover: decoded payload binary + deserialized state + loadstring stub,
 *   4. emit verified, readable Lua with the constant pool + structure,
 *   5. run through the full pipeline producing a readable (non-stub) result.
 *
 * Run: node test/luraph14.js   (also registered in test/all.js)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const { runLuraph14Devirt, probeLuraph14 } = await import(path.join(root, 'src', 'luraph14.js'));
const { deobfuscate } = await import(path.join(root, 'src', 'pipeline.js'));

const SAMPLE = path.join(root, 'test', 'fixtures', 'tokrascript-6961824067-sample.luau');
let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`  PASS ${name}`); })
    .catch((e) => { fail += 1; console.error(`  FAIL ${name}: ${e.message}`); });
}

const probe = probeLuraph14();

await check('probe: vendored harness + luau available', () => {
  assert.equal(probe.available, true, `unavailable: ${probe.reason}`);
});

if (probe.available) {
  const src = fs.readFileSync(SAMPLE, 'latin1');

  await check('refuses non-LPH# input gracefully (null, no throw)', async () => {
    const r = await runLuraph14Devirt('local x = 1\nprint("hello")\n', { timeoutMs: 30_000, version: 'v14.4.2' });
    assert.equal(r, null);
  });

  await check('recovers runtime state from the TokraScript v14.4.2 sample', async () => {
    const r = await runLuraph14Devirt(src, { timeoutMs: 120_000, version: 'v14.4.2' });
    assert.ok(r, 'devirt returned null');
    assert.ok(r.code && r.code.length > 1000, 'output too small');
    assert.ok(r.meta.payloadBytes >= 500_000, `payload binary capture too small: ${r.meta.payloadBytes}`);
    assert.ok(r.meta.stubBytes > 1000, `stub not captured: ${r.meta.stubBytes}`);
    assert.ok(r.meta.constants && r.meta.constants.strings >= 50, 'constant pool not parsed');
    assert.ok(r.meta.struct.tables >= 100, 'deserialized state too small');
  });

  await check('output is verified Lua containing stub + pool + structure', async () => {
    const r = await runLuraph14Devirt(src, { timeoutMs: 120_000, version: 'v14.4.2' });
    assert.ok(r, 'devirt returned null');
    assert.equal(r.verification.status, 'verified');
    assert.ok(r.code.includes('recovered source'), 'stub section missing');
    assert.ok(r.code.includes('CONSTANTS'), 'constant pool section missing');
    assert.ok(r.code.includes('loadstring'), 'stub code not embedded');
    assert.ok(r.code.includes('program structure'), 'structure section missing');
  });

  await check('full pipeline delivers readable output (not the bare VM stub)', async () => {
    const buf = fs.readFileSync(SAMPLE);
    const result = await deobfuscate({ buffer: buf, filename: 'tokrascript-6961824067.luau' });
    assert.ok(result.ok, 'pipeline failed');
    assert.ok(result.code.length > 3000, `output too small: ${result.code.length}`);
    // the OLD failure mode: output was exactly the stub + banner and nothing else
    assert.ok(!result.code.trim().startsWith('return setfenv'), 'bare stub leaked through');
    assert.ok(result.code.includes('Luraph v14 devirtualization'), 'state-devirt stage did not run');
    assert.ok(result.stages.some((s) => String(s.name).includes('state-devirt:hit')), 'state-devirt:hit stage missing');
  }, 200_000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
