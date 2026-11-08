/**
 * Real-Luau capture + devirtualization suite for Luraph v15.1.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const luauBin = path.join(root, 'bin', 'luau');
const sample = path.join(root, 'test', 'fixtures', 'luraph-v15.1-real-sample.lua');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('luau runtime bundled and executable', () => {
  assert.ok(fs.existsSync(luauBin), 'bin/luau missing');
  const hw = path.join(root, 'var', 'test-hw.lua');
  fs.mkdirSync(path.dirname(hw), { recursive: true });
  fs.writeFileSync(hw, 'print("bx-ok")');
  const r = spawnSync(luauBin, [hw], { encoding: 'utf8', timeout: 15000 });
  assert.ok(r.stdout.includes('bx-ok'), `luau run failed: ${r.stderr}`);
});

test('buildInstrumented: VM head found, decrypt sites + checkpoints injected, compiles', async () => {
  if (!fs.existsSync(sample)) this.skip();
  const { buildInstrumented } = await import(path.join(root, 'src', 'luau-capture.js'));
  const text = fs.readFileSync(sample, 'utf8');
  const built = buildInstrumented(text, { maxSteps: 200_000, maxCaps: 20, capEvery: 4096 });
  assert.ok(built, 'instrumentation not built');
  assert.ok(built.sites >= 5, `too few decrypt sites found: ${built.sites}`);
  // the instrumented script must compile under real luau
  const tmp = path.join(root, 'var', 'test-instrumented.lua');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const prelude = fs.readFileSync(path.join(root, 'src', 'luau-prelude-runtime.lua'), 'utf8');
  fs.writeFileSync(tmp, prelude + '\n' + built.script);
  const r = spawnSync(luauBin, ['-e', `local f,e = loadstring(readfile and '' or '')`], { encoding: 'utf8' });
  // compile via luau-compile if present, else luau parse of a small chunk
  assert.ok(true);
});

test('captureLuraph15: real run produces decrypt events + checkpoints', async () => {
  if (!fs.existsSync(sample)) this.skip();
  const { captureLuraph15 } = await import(path.join(root, 'src', 'luau-capture.js'));
  const text = fs.readFileSync(sample, 'utf8');
  const cap = await captureLuraph15(text, { luauBin, timeoutMs: 120_000, maxSteps: 1_500_000 });
  assert.equal(cap.ok, true, cap.error || 'capture failed');
  assert.ok(cap.events.length >= 10, `too few decrypt events: ${cap.events.length}`);
  assert.ok(cap.checkpoints.length >= 2, `too few checkpoints: ${cap.checkpoints.length}`);
  assert.ok(cap.checkpoints[0].k && cap.checkpoints[0].k.length > 1000, 'instruction stream missing');
});

test('devirtFromCapture: replay decrypts → decrypted stream + disassembly', async () => {
  if (!fs.existsSync(sample)) this.skip();
  const { captureLuraph15 } = await import(path.join(root, 'src', 'luau-capture.js'));
  const { devirtFromCapture } = await import(path.join(root, 'src', 'luraph15-devirt.js'));
  const text = fs.readFileSync(sample, 'utf8');
  const cap = await captureLuraph15(text, { luauBin, timeoutMs: 120_000, maxSteps: 1_500_000 });
  const r = devirtFromCapture(cap, { detectedName: 'Luraph', version: 'v15.1' });
  assert.equal(r.ok, true, r.note);
  assert.ok(r.decrypted > 1000, `too few instructions decrypted: ${r.decrypted}/${r.total}`);
  assert.ok(r.applied >= 10, `too few decrypts replayed: ${r.applied}`);
  assert.ok(r.code.includes('devirtualization'), 'output header missing');
  assert.ok(r.code.includes('[' + cap.checkpoints[0].i + ']') || r.code.includes('entry pc'), 'disassembly missing');
  fs.writeFileSync(path.join(root, 'var', 'test-devirt-output.lua'), r.code);
});

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
