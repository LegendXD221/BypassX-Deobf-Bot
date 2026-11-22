/**
 * Ported OmniDBF family suite (v2.24.0).
 *
 * Covers the vendored family deobfuscators (vendor/omnidbf/) through the
 * REAL bridge: src/ported.js -> spawnHardened -> src/ported-worker.cjs.
 * Fixtures are the upstream OmniDBF Samples (test/fixtures/ported/).
 *
 * Run: node test/ported.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPorted, portedFamilyFor, PORTED_FIRST, PORTED_FAMILIES } from '../src/ported.js';
import { verifyCode } from '../src/validate.js';
import { detectService } from '../src/detect.js';
import { SERVICE_COMMANDS } from '../src/service-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (name) => path.join(here, 'fixtures', 'ported', name);

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass += 1; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.stack || e}`); fail += 1; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass += 1; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.stack || e}`); fail += 1; }
}

console.log('ported: registry');
ok('five ported families registered', () => {
  for (const id of ['clyde', 'luaobfuscator_com', 'prostone', 'ironveil', 'moonveil']) {
    assert.ok(portedFamilyFor(id), `${id} missing`);
    assert.ok(fs.existsSync(path.join(here, '..', 'vendor', 'omnidbf', 'deobfuscators', PORTED_FAMILIES[id].mod)), `${id} module missing on disk`);
  }
});
ok('PORTED_FIRST = {clyde, luaobfuscator_com, ironveil, prostone}', () => {
  assert.deepStrictEqual([...PORTED_FIRST].sort(), ['clyde', 'ironveil', 'luaobfuscator_com', 'prostone']);
});
ok('unknown family -> null', () => {
  assert.strictEqual(portedFamilyFor('luraph'), null);
  assert.strictEqual(portedFamilyFor(null), null);
});
ok('.prostone command exists in the catalog', () => {
  const p = SERVICE_COMMANDS.find((s) => s.cmd === 'prostone');
  assert.ok(p, 'prostone command missing');
  assert.strictEqual(p.serviceId, 'prostone');
});
ok('prostone carries ZERO indicators (no auto false positives)', () => {
  const plain = detectService(Buffer.from('local x = 1 print(x)'));
  assert.ok(!plain.best || plain.best.service.id !== 'prostone');
  const svc = detectService(Buffer.from('Prostone protected build')).candidates.find((c) => c.id === 'prostone');
  assert.ok(!svc, 'prostone must not auto-win on its own name');
});

console.log('ported: Clyde (vendored static VM inverter)');
await okAsync('stack-vm sample lifts to the original program', async () => {
  const r = await runPorted('clyde', fix('full_stack_max.lua'), { timeoutMs: 120_000 });
  assert.ok(r.ok, `miss: ${r.error}`);
  assert.ok(r.output.includes('full protection test'), `output missing original program: ${JSON.stringify(r.output.slice(0, 80))}`);
  const v = verifyCode(r.output, { lang: 'lua', filename: 'clyde_stack.lua' });
  assert.notStrictEqual(v.status, 'failed', `output not parseable: ${v.detail}`);
});
await okAsync('reg-vm sample lifts', async () => {
  const r = await runPorted('clyde', fix('full_reg_max.lua'), { timeoutMs: 120_000 });
  assert.ok(r.ok, `miss: ${r.error}`);
  assert.ok(r.output.length > 10 && r.output.length < 8_000_000);
});
await okAsync('simple + 1.lua samples lift', async () => {
  for (const f of ['simple_vm_normal.lua', '1.lua']) {
    const r = await runPorted('clyde', fix(f), { timeoutMs: 120_000 });
    assert.ok(r.ok, `${f}: ${r.error}`);
  }
});

console.log('ported: IronVeil V1');
await okAsync('obf.lua recovers the real program (ground truth markers)', async () => {
  const r = await runPorted('ironveil', fix('obf.lua'), { timeoutMs: 120_000 });
  assert.ok(r.ok, `miss: ${r.error}`);
  assert.ok(r.output.includes('game:GetService("Players")'), 'Players service missing');
  assert.ok(r.output.includes('ORBIT_RADIUS'), 'recovered config missing');
  assert.ok(r.output.length < 123_139, 'output must be a real peel, not an echo');
  const v = verifyCode(r.output, { lang: 'lua', filename: 'iv.lua' });
  assert.notStrictEqual(v.status, 'failed', `not parseable: ${v.detail}`);
});

console.log('ported: LuaObfuscator.com');
await okAsync('ChaoticEvil sample reconstructs', async () => {
  const r = await runPorted('luaobfuscator_com', fix('luaobf_chaoticevil.lua'), { timeoutMs: 120_000 });
  assert.ok(r.ok, `miss: ${r.error}`);
  assert.ok(r.output.length > 500, 'output too small');
  const v = verifyCode(r.output, { lang: 'lua', filename: 'lo.lua' });
  assert.notStrictEqual(v.status, 'failed', `not parseable: ${v.detail}`);
});

console.log('ported: Prostone (Prometheus-derived AST+VM pipeline)');
await okAsync('non-Prostone input never invents output (clean fail or optimizer round-trip)', async () => {
  const plain = path.join(here, 'fixtures', 'ported-not-prostone.lua');
  fs.writeFileSync(plain, 'local x = 1 print("hello")\n');
  const r = await runPorted('prostone', plain, { timeoutMs: 60_000 });
  if (r.ok) {
    // detect:false retry runs the AST pipeline on plain Lua — its optimizer
    // drops dead locals, so an EXACT round-trip is not guaranteed. The honest
    // contract: the program statements survive, nothing is invented, nothing
    // expands. (Forced-command semantics: the user asked for Prostone; the
    // pipeline's passthrough guard covers auto-path abuse.)
    assert.ok(r.output.includes('print("hello")'), `program lost: ${JSON.stringify(r.output.slice(0, 80))}`);
    assert.ok(r.output.length <= 40, `output expanded: ${r.output.length}B`);
  } else {
    assert.ok(r.error && r.error.length > 0);
  }
});
await okAsync('nonexistent module path reports a bridge error', async () => {
  const r = await runPorted('clyde', '/nonexistent/input.lua', { timeoutMs: 30_000 });
  assert.ok(!r.ok);
});

console.log('ported: MoonVeil (static-only port, dump runtime stubbed)');
await okAsync('VM build degrades to an honest miss (engine/harvest still own it)', async () => {
  const r = await runPorted('moonveil', fix('moonveil_2023.lua'), { timeoutMs: 120_000 });
  assert.ok(!r.ok, 'static-only port must not claim VM recovery');
  assert.ok(r.meta && (r.meta.version === '2.0.23' || r.meta.score >= 8), `detection meta weak: ${JSON.stringify(r.meta)}`);
});

console.log(`\nported: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
