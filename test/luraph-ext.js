/**
 * Vendored Luraph v15 full-source devirtualizer suite.
 *
 * Exercises the vendored MIT engine (vendor/luraph-v15, caomod2077/
 * Deobfuscator-Luraph-V15) through the bot's own hardened runner:
 *   • availability probe
 *   • full-source recovery on a real closure-maker-layout v15 sample
 *     (170 KB obfuscated → `print("hello")`)
 *   • clean miss on our hybrid CPS-loader v15.1 fixture (falls through fast)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const sample = path.join(root, 'test', 'fixtures', 'luraph-v15-closure-maker-sample.lua');
const hybrid = path.join(root, 'test', 'fixtures', 'luraph-v15.1-real-sample.lua');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('probeExtEngine: vendor tree + binaries + python3', async () => {
  const { probeExtEngine } = await import(path.join(root, 'src', 'luraph15-ext.js'));
  const p = probeExtEngine();
  assert.equal(p.available, true, `engine unavailable: ${p.reason}`);
  assert.ok(fs.existsSync(path.join(root, 'vendor', 'luraph-v15', 'LICENSE')), 'vendor LICENSE missing');
});

test('runExtDeobf: closure-maker v15 sample → full source', async () => {
  if (!fs.existsSync(sample)) this.skip();
  const { runExtDeobf } = await import(path.join(root, 'src', 'luraph15-ext.js'));
  const text = fs.readFileSync(sample, 'utf8');
  const r = await runExtDeobf(text, { timeoutMs: 150_000, version: 'v15' });
  assert.ok(r, 'ext engine returned null on a known-good sample');
  assert.match(r.code, /print\("hello"\)/, `output missing ground truth: ${r.code.slice(0, 200)}`);
  assert.equal(r.verification.status, 'verified');
  fs.writeFileSync(path.join(root, 'var', 'test-ext-output.lua'), r.code);
}, 200_000);

test('runExtDeobf: hybrid CPS-loader v15.1 fixture → source via trace recovery', async () => {
  if (!fs.existsSync(hybrid)) this.skip();
  const { runExtDeobf } = await import(path.join(root, 'src', 'luraph15-ext.js'));
  const text = fs.readFileSync(hybrid, 'utf8');
  const t0 = Date.now();
  const r = await runExtDeobf(text, { timeoutMs: 60_000, version: 'v15.1' });
  const secs = (Date.now() - t0) / 1000;
  // the CPS-loader layout has no liftable closure makers (devirt phase misses
  // fast), but the behaviour-trace phase records the payload's executed
  // statements and re-emits them as real source — the sample's true payload.
  assert.ok(r, 'trace phase should recover the executed payload statements');
  assert.equal(r.phase, 'trace');
  assert.equal(r.verification.status, 'verified');
  assert.match(r.code, /Instance\.new\("Folder"\)/, `output missing recovered payload: ${r.code.slice(0, 200)}`);
  assert.match(r.code, /ScreenGui/);
  assert.match(r.code, /Path2D/);
  assert.ok(r.code.length < text.length / 10, 'recovered source should be far smaller than the obfuscated input');
  assert.ok(secs < 70, `recovery took too long: ${secs}s`);
  fs.writeFileSync(path.join(root, 'var', 'test-ext-trace-output.lua'), r.code);
}, 90_000);

let failed = 0;
for (const t of tests) {
  try {
    await t.fn.call(t);
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
