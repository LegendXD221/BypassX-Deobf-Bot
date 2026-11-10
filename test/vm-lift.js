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
  // (v2.14.0: structured blocks — one dispatch per block, blocks advance with
  // absolute `__pc = N -- → [N]` instead of per-instruction +1 bumps)
  for (const needle of [
    '"Hello from MoonSec VM"', '"ReplicatedStorage"', 'VM_OUT', 'V1 = print',
    'while true do', 'GetService', 'ran, if id: 15 (taken)', 'elseif __pc ==',
  ]) {
    assert.ok(r.code.includes(needle), `output missing: ${needle}`);
  }
  // the conditional trap must be represented (TEST-EQ around instructions 15-18)
  assert.ok(r.code.includes('TEST-EQ'), 'TEST op missing from output');
});

test('liftFromHarvest: CHECK*-lite branch comments on the devirt output (v2.13.0)', async () => {
  const { liftFromHarvest } = await import(path.join(root, 'src', 'vm-lift.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  const d = runWorker(path.join(root, 'test', 'fixtures', 'vm-table-dispatch.lua'));
  const r = liftFromHarvest(d.lift, { detectedName: 'MoonSec V3 (fixture)', version: 'escrow' });
  assert.equal(r.ok, true, r.note);
  const v = verifyCode(r.code, { lang: 'lua', filename: 'devirtualized.lua' });
  assert.equal(v.status, 'verified', v.detail);
  // CHECK*-lite markers: leaked SecureEnv CHECKIF comment style on every edge
  assert.ok(r.code.includes('branch mode: CHECK*-lite'), 'header missing');
  assert.ok(r.code.includes('CHECK*-lite branch if id:'), 'branch-id comment missing');
  assert.ok(r.code.includes('-- ran, if id:'), '"ran, if id" comment missing');
  assert.ok(r.code.includes('-- didnt run (else)'), '"didnt run (else)" comment missing');
  assert.ok(r.code.includes('· taken → ['), 'taken target missing');
  assert.ok(r.code.includes('(fall through)'), 'fall-through label missing');
  assert.ok(r.branches >= 1, `branch count: ${r.branches}`);
  assert.ok(/branch edge\(s\)/.test(r.how), 'how string missing branch stat');
});

test('liftFromHarvest: JMP opcodes emit real edges, not (unclassified) (v2.13.0 fix)', async () => {
  const { liftFromHarvest } = await import(path.join(root, 'src', 'vm-lift.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  // synthetic capture: op 1 = LOADK (CR1 + SW2), op 2 = JMP (PC reads 5 → 8 → 11 = delta 3)
  const lift = {
    snap: { mode: 'rows', rows: 4, opids: [1, 2], instrs: [[1, 1], [2, 1], [1, 2], [2, 1]], consts: ['print'] },
    probes: [
      { op: 1, ev: ['PC5', 'PC6', 'PC7', 'PC8', 'CR1', 'SW2:x', 'CR2', 'SW3:x'] },
      { op: 2, ev: ['PC5', 'PC8', 'PC11'] },
    ],
    ended: 'error',
  };
  const r = liftFromHarvest(lift, { detectedName: 'Synthetic VM' });
  assert.equal(r.ok, true, r.note);
  const v = verifyCode(r.code, { lang: 'lua', filename: 'devirtualized.lua' });
  assert.equal(v.status, 'verified', v.detail);
  assert.ok(r.code.includes('] JMP → [5]'), `JMP edge missing:\n${r.code}`);
  assert.ok(r.code.includes('__pc = 5 -- CHECK*-lite: unconditional → [5]'), 'JMP target advance missing');
  assert.ok(!r.code.includes('(unclassified)'), 'unclassified arm reached — JMP fell through');
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

test('liftFromHarvest: structured blocks — linear run advances with absolute target (v2.14.0)', async () => {
  const { liftFromHarvest } = await import(path.join(root, 'src', 'vm-lift.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  // op1 = LOADK, op2 = JMP(delta 2): pcs 0-1 linear, pc2 jumps over pc3 to pc4,
  // pc3 runs linearly then falls into pc4, pc4 jumps off-program.
  const lift = {
    snap: { mode: 'rows', rows: 5, opids: [1, 2],
      instrs: [[1, 1, 1], [1, 2, 2], [2, 1], [1, 3, 3], [2, 1]],
      consts: ['alpha', 'beta', 'gamma'] },
    probes: [
      { op: 1, ev: ['CR1', 'SW2:x', 'CR2', 'SW3:x'] },
      { op: 2, ev: ['PC1', 'PC3', 'PC5'] },
    ],
    ended: 'error',
  };
  const r = liftFromHarvest(lift, { detectedName: 'Synthetic linear' });
  assert.equal(r.ok, true, r.note);
  const v = verifyCode(r.code, { lang: 'lua', filename: 'devirtualized.lua' });
  assert.equal(v.status, 'verified', v.detail);
  assert.ok(r.code.includes('-- ══ block 1 · instructions [1..4] ══'), 'block header missing');
  assert.ok(r.code.includes('__pc = 5 -- → [5]'), `linear block advance missing:\n${r.code}`);
  assert.ok(r.code.includes('V1 = "alpha"'), 'const alpha missing');
  assert.ok(r.code.includes('V3 = "gamma"'), 'const gamma missing');
});

test('liftFromHarvest: branch-free program decompiles to pure linear Lua (v2.14.0)', async () => {
  const { liftFromHarvest } = await import(path.join(root, 'src', 'vm-lift.js'));
  const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));
  const lift = {
    snap: { mode: 'rows', rows: 4, opids: [1, 3],
      instrs: [[1, 1, 1], [3, 2], [1, 2, 2], [1, 3, 3]],
      consts: ['one', 'two', 'three'] },
    probes: [
      { op: 1, ev: ['CR1', 'SW2:x', 'CR2', 'SW3:x'] },
      { op: 3, ev: ['CALLR2:x', 'SR1'] },
    ],
    ended: 'error',
  };
  const r = liftFromHarvest(lift, { detectedName: 'Synthetic straight' });
  assert.equal(r.ok, true, r.note);
  const v = verifyCode(r.code, { lang: 'lua', filename: 'devirtualized.lua' });
  assert.equal(v.status, 'verified', v.detail);
  assert.ok(r.code.includes('-- linear program (single block, no branch edges)'), 'linear marker missing');
  assert.ok(r.code.includes('V1 = "one"') && r.code.includes('V3 = "three"'), 'constants missing');
  assert.ok(!r.code.includes('while true do'), 'dispatch loop should be absent for branch-free programs');
  assert.ok(!r.code.includes('__pc'), 'pc state should be absent for branch-free programs');
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
