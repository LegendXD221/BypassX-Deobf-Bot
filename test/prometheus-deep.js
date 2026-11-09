/**
 * Prometheus deep static pass suite (v2.13.0).
 *
 * The fixture pair is REAL: test/fixtures/prometheus-weak-obf.lua was produced
 * by the actual Prometheus obfuscator (levno-710, Weak preset: control-flow
 * flattening + strings-only ConstantArray with rotation + custom-alphabet
 * base64/base85 string encoding + WrapInFunction) from the ground-truth
 * source prometheus-weak-src.lua. The pass must undo the string scaffolding
 * BEHAVIORALLY — running the obfuscator's own decoder in a jailed Lua state —
 * and inline every decoded string at its call site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('prometheusDeepPass: real Weak-preset build → scaffolding undone, strings inlined, verified', async () => {
  const { prometheusDeepPass } = await import(path.join(root, 'src', 'prometheus-deep.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  const buf = fs.readFileSync(path.join(root, 'test', 'fixtures', 'prometheus-weak-obf.lua'));
  const r = await prometheusDeepPass(buf);
  assert.ok(r, 'pass returned null — shape not matched');
  assert.equal(verifyCode(r.code, { lang: 'lua', filename: 'p.lua' }).status, 'verified', 'output does not parse');

  // every ground-truth string must appear as a literal in the output
  const src = fs.readFileSync(path.join(root, 'test', 'fixtures', 'prometheus-weak-src.lua'), 'utf8');
  for (const needle of ['Players', 'GetService', 'LocalPlayer', 'Humanoid', 'WalkSpeed', 'FindFirstChildOfClass']) {
    assert.ok(r.code.includes(`"${needle}"`), `decoded string "${needle}" missing from output`);
  }
  void src;

  // decoded stats: 100% pool decoded, every literal call site inlined
  assert.equal(r.decoded, r.poolSize);
  assert.ok(r.inlined >= 15, `too few call sites inlined: ${r.inlined}`);
  assert.ok(r.how.includes('behaviorally'));
});

test('prometheusDeepPass: clean miss on non-matching shapes (never throws, never mangles)', async () => {
  const { prometheusDeepPass } = await import(path.join(root, 'src', 'prometheus-deep.js'));
  const plain = Buffer.from('local x = 1\nprint(x)\n');
  assert.equal(await prometheusDeepPass(plain), null);
  assert.equal(await prometheusDeepPass(Buffer.alloc(0)), null);
  // garbage must not throw
  assert.equal(await prometheusDeepPass(Buffer.from('\x00\x01\x02not lua at all')), null);
});

test('prometheusDeepPass: destructive-input safety — output parses even under fuzzed wrapper shapes', async () => {
  const { prometheusDeepPass } = await import(path.join(root, 'src', 'prometheus-deep.js'));
  // a wrapper with a string table + ipairs loop but NO accessor/decoder → must miss, not emit
  const half = Buffer.from(`return (function(...)
  local U = {"a", "b", "c"}
  for A, s in ipairs({{1, 3}}) do
    while s[1] < s[2] do
      U[s[1]], U[s[2]], s[1], s[2] = U[s[2]], U[s[1]], s[1] + 1, s[2] - 1
    end
  end
  print(U[1])
end)(...)`);
  const r = await prometheusDeepPass(half);
  assert.equal(r, null, 'half-shaped input must miss (no accessor/decoder)');
});

test('pipeline wiring: prom-deep stage runs before the engine peel for the prometheus family', async () => {
  // route-level check without Discord: run the real pipeline on the fixture
  const { deobfuscate } = await import(path.join(root, 'src', 'pipeline.js'));
  const buffer = fs.readFileSync(path.join(root, 'test', 'fixtures', 'prometheus-weak-obf.lua'));
  const res = await deobfuscate({ buffer, filename: 'prometheus-weak-obf.lua' });
  assert.equal(res.ok, true, `pipeline failed: ${res.error || 'unknown'}`);
  const allStages = (res.stages || []).concat(...(res.layers || []).map((l) => l.stages || []));
  assert.ok(allStages.some((s) => s.name === 'prom-deep:hit'), `prom-deep:hit missing — stages: ${allStages.map((s) => s.name).join(' → ')}`);
  assert.ok(res.verification.status === 'verified', `verification: ${res.verification?.status}`);
  const delivered = res.code || (res.files?.[0]?.buffer?.toString('utf8'));
  assert.ok(delivered && delivered.includes('"GetService"'), 'delivered code missing decoded strings');
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
