/**
 * VM lifter suite — the v1.9.0 devirtualization engine end-to-end:
 *   fixture VM (table-dispatch / if-chain) → jailed lift worker
 *   → behavioral opcode classification → transpiled runner → verifyCode.
 * Also regression: the real Luraph v15.1 sample must at minimum harvest its
 * decrypted pool through the same jail (buffer-library gated).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function runWorker(fixture) {
  const res = spawnSync(process.execPath, [path.join(root, 'src', 'vm-lift-worker.js'), fixture], {
    encoding: 'utf8',
    timeout: 130_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `worker produced no result (stderr: ${(res.stderr || '').slice(0, 200)})`);
  return JSON.parse(line);
}

test('lift worker: table-dispatch fixture → VM state captured, all opcodes probed, clean exit', () => {
  const d = runWorker(path.join(root, 'test', 'fixtures', 'vm-table-dispatch.lua'));
  assert.equal(d.ok, true);
  assert.ok(d.lift && d.lift.snap, 'lift snapshot missing');
  assert.equal(d.lift.snap.mode, 'rows');
  assert.ok(d.lift.snap.rows >= 15, 'instruction stream too small');
  assert.ok(d.lift.probes.filter((p) => p.ev.length > 0).length >= 8, 'too few probed opcodes');
  assert.equal(d.lift.ended, 'clean-exit');
  // the decrypted pool must ride the snapshot
  assert.ok(d.lift.snap.consts.includes('Hello from MoonSec VM'), 'decrypted const missing from snapshot');
  // the pool must also ride the string sink (run 1)
  assert.ok(d.strings.includes('Hello from MoonSec VM'), 'pool string missing from sink');
});

test('lift worker: if-chain fixture → same quality (Luraph-style dispatch)', () => {
  const d = runWorker(path.join(root, 'test', 'fixtures', 'vm-ifchain.lua'));
  assert.equal(d.ok, true);
  assert.ok(d.lift && d.lift.snap, 'lift snapshot missing');
  assert.equal(d.lift.ended, 'clean-exit');
  assert.ok(d.lift.probes.filter((p) => p.ev.length > 0).length >= 8, 'too few probed opcodes');
  assert.ok(d.strings.includes('Hello from the if-chain VM'), 'pool string missing');
});

test('liftFromHarvest: table-dispatch → 10/10 classified, verified, constants inlined', async () => {
  const { liftFromHarvest } = await import(path.join(root, 'src', 'vm-lift.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  const d = runWorker(path.join(root, 'test', 'fixtures', 'vm-table-dispatch.lua'));
  const r = liftFromHarvest(d.lift, { detectedName: 'MoonSec V3 (fixture)', version: 'escrow' });
  assert.equal(r.ok, true, r.note);
  assert.equal(r.classified, 10, `classified ${r.classified}/10 — ${JSON.stringify(r.unknown)}`);
  const v = verifyCode(r.code, { lang: 'lua', filename: 'devirtualized.lua' });
  assert.equal(v.status, 'verified', v.detail);
  // real content: decrypted strings inline, globals resolved, runner structure
  for (const needle of [
    '"Hello from MoonSec VM"', '"ReplicatedStorage"', 'VM_OUT', 'V1 = print',
    'while true do', 'GetService', '__pc = __pc + 1',
  ]) {
    assert.ok(r.code.includes(needle), `output missing: ${needle}`);
  }
  // the conditional trap must be represented (TEST-EQ around instructions 15-18)
  assert.ok(r.code.includes('TEST-EQ'), 'TEST op missing from output');
});

test('liftFromHarvest: if-chain → verified transpile (Luraph-style shape)', async () => {
  const { liftFromHarvest } = await import(path.join(root, 'src', 'vm-lift.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  const d = runWorker(path.join(root, 'test', 'fixtures', 'vm-ifchain.lua'));
  const r = liftFromHarvest(d.lift, { detectedName: 'Luraph (fixture)', version: 'v15.1-shape' });
  assert.equal(r.ok, true, r.note);
  assert.equal(r.classified, 10);
  const v = verifyCode(r.code, { lang: 'lua', filename: 'devirtualized.lua' });
  assert.equal(v.status, 'verified', v.detail);
  assert.ok(r.code.includes('"Hello from the if-chain VM"'));
  assert.ok(r.code.includes('IFCHAIN_OUT'));
});

test('jail prelude: Luau buffer library available (Luraph v15.1 loaders bind it)', async () => {
  const fengari = (await import('fengari')).default;
  const jail = await import(path.join(root, 'src', 'jail-prelude.js'));
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const rc = lauxlib.luaL_dostring(L, to_luastring(jail.PRELUDE));
  assert.equal(rc, lua.LUA_OK);
  const rc2 = lauxlib.luaL_dostring(L, to_luastring(`
    local b = buffer.create(16)
    buffer.writestring(b, 0, "AB")
    buffer.writeu32(b, 4, 0x11223344)
    assert(buffer.readstring(b, 0, 2) == "AB")
    assert(buffer.readu8(b, 4) == 0x44)
    assert(buffer.readu16(b, 6) == 0x1122)
    assert(buffer.len(b) == 16)
    local c = buffer.fromstring("xyz")
    buffer.copy(b, 8, c, 0, 3)
    assert(buffer.readstring(b, 8, 3) == "xyz")
    buffer.fill(b, 12, 4, 7)
    assert(buffer.readu8(b, 12) == 7)
    local bits = buffer.readbits(b, 0, 16)
    assert(bits == (string.byte("A") + string.byte("B") * 256))
    _G.BUF_OK = true
  `));
  assert.equal(rc2, lua.LUA_OK, lua.lua_tojsstring(L, -1));
  lua.lua_getglobal(L, to_luastring('BUF_OK'));
  assert.equal(lua.lua_toboolean(L, -1), true);
});

test('real Luraph v15.1 sample: jailed run decrypts the pool (regression floor)', function realSample() {
  const sample = path.join(root, 'test', 'fixtures', 'luraph-v15.1-real-sample.lua');
  if (!fs.existsSync(sample)) this.skip();
  const d = runWorker(sample);
  assert.equal(d.ok, true);
  // the buffer library unblocked the loader: the pool decrypts (tens of thousands)
  assert.ok(d.strings.length > 1000, `pool too small: ${d.strings.length}`);
}, 60_000);

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
