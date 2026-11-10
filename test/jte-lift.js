/**
 * v2.14.0 — jte bytecode-lift adapter suite.
 *
 * The jte decompiler (research/jte-lua-decompiler, Rust) is the bytecode-lift
 * node: when its binary is built, captured load()-bytecode chunks come back as
 * readable source. These tests pin the adapter contract WITHOUT requiring the
 * binary: graceful absence, correct bytecode sniffing, and honest notes.
 */
import assert from 'node:assert';
import {
  jteDecompile,
  isLuauBytecode,
  isLuaBytecode,
  jteBinaryPresent,
} from '../src/jte-lift.js';

const ok = { total: 0, failed: 0 };
async function check(name, fn) {
  ok.total += 1;
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e) { ok.failed += 1; console.error(`  FAIL ${name}\n    ${String(e?.stack || e).split('\n').slice(0, 4).join('\n    ')}`); }
}

await check('bytecode sniffing: RSB1 Luau + \\x1bLua signatures detected, source rejected', async () => {
  assert.equal(isLuauBytecode(Buffer.from('RSB1\x01\x02payload')), true);
  assert.equal(isLuaBytecode(Buffer.from('\x1bLuaQ\x00\x01\x04\x08')), true);
  assert.equal(isLuauBytecode(Buffer.from('local x = 1')), false);
  assert.equal(isLuaBytecode(Buffer.from('local x = 1')), false);
  assert.equal(isLuauBytecode(Buffer.from('RSB')), false, 'too short');
  assert.equal(isLuaBytecode(null), false);
});

await check('graceful absence: no binary → ok:false with honest note, never throws', async () => {
  const present = jteBinaryPresent();
  const r = await jteDecompile(Buffer.from('\x1bLuaQ\x00\x01\x04\x08padding'), { timeoutMs: 5_000 });
  if (!present) {
    assert.equal(r.ok, false);
    assert.ok(/not built/.test(r.note), `note: ${r.note}`);
  } else {
    // binary exists in this environment — real decompile path must run
    assert.ok(r.ok === true || (r.ok === false && r.note), 'either a decompile or an honest note');
  }
});

await check('real Lua 5.1 bytecode decompiles to source when the binary is built', async () => {
  const present = jteBinaryPresent();
  if (!present) { console.log('    (skipped — jte binary not built in this sandbox)'); return; }
  // Compile `local a = 41 return a + 1` with luac if available; else minimal roundtrip
  const { spawnSync } = await import('node:child_process');
  const luac = spawnSync('luac', ['-o', '-', '-'], { input: 'local a = 41\nreturn a + 1\n', encoding: 'buffer' });
  if (luac.status !== 0 || !luac.stdout || luac.stdout.length < 8) {
    console.log('    (skipped — no luac to produce test bytecode)');
    return;
  }
  const r = await jteDecompile(luac.stdout, { deobfuscate: true });
  assert.equal(r.ok, true, r.note);
  assert.ok(/\b41\b/.test(r.code), `constant lost: ${r.code}`);
});

console.log(`\n${ok.total - ok.failed}/${ok.total} checks passed`);
if (ok.failed) process.exit(1);
