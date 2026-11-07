/**
 * Static-peel unit tests — the "no walls" tier.
 *
 * Verifies that every supported obfuscator family ALWAYS produces parseable
 * output (ok:true + valid Lua/JS), even when the Rust engine is unavailable
 * and the jailed harvester cannot replay the key schedule.
 *
 * Run: node test/static-peel.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { staticPeel } from '../src/static-peel.js';
import { verifyCode } from '../src/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass += 1; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.stack || e}`); fail += 1; }
}
function okAsync(name, fn) {
  return fn().then(() => { console.log(`  ✓ ${name}`); pass += 1; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e?.stack || e}`); fail += 1; });
}

// ---- fake obfuscator samples ------------------------------------------------

// A Luraph-style wrapper carrying an encoded string table.
const LURAPH_SAMPLE = Buffer.from(`-- protected using Luraph Obfuscator v15.1
local LPH_ENCSTR = function(s) return s end
local LPH_JIT = function(f) return f end
local key_carrier = "4d5a90000300000004000000ffff0000b8000000000000004000000000000000000000000000000000000000000000000000"
local payload = "SGVsbG8gV29ybGQhIFRoaXMgaXMgYSBkZWNvZGVkIHBheWxvYWQu"
local function main()
  print("Luraph v15 protected payload executing")
  local flag = "CTF{static_peel_recovers_strings}"
  return flag
end
return LPH_JIT(main)()
`, 'utf8');

// A MoonSec V3 escrow-style sample (VM bytecode placeholder + string table).
const MOONSEC_V3_SAMPLE = Buffer.from(`--[[ This file was protected with MoonSec V3 ]]
local function dispatcher(op, a, b)
  if op == 1 then return a + b end
  if op == 2 then return a - b end
  if op == 3 then return a * b end
  return nil
end
local strings = {
  "MoonSec V3 escrow build — runtime keys",
  "anti-tamper sentinel active",
  "VM bytecode behind encrypted pool",
  "756e69717565206b6579206d6174657269616c20666f72206275696c64",
}
local function vm_loop()
  for _, s in ipairs(strings) do print(s) end
end
return vm_loop()
`, 'utf8');

// An obfuscator.io-style JS sample (string array + rotate).
const OBFUSCATOR_IO_SAMPLE = Buffer.from(`var _0x4a2b = ['hello', 'world', 'decoded payload here'];
function _0x1f3e(i) { return _0x4a2b[i]; }
var _0xabc123 = parseInt(_0x1f3e(0) + _0x1f3e(1));
function main() {
  var secret = "aGVsbG8gd29ybGQgcGF5bG9hZA==";
  console.log(_0xabc123);
  return secret;
}
main();
`, 'utf8');

// A MoonVeil-style sample (VM obfuscator — engine cannot lift).
const MOONVEIL_SAMPLE = Buffer.from(`-- generated using MoonVeil v2.0.26
local function vm_dispatch(opcode, operands)
  local state = { pc = 0, stack = {} }
  local encrypted_pool = {
    "MoonVeil VM bytecode layer 1",
    "control flow flattening applied",
    "polymorphic dispatch table",
    "536f6d65206465636f646564207061796c6f6164",
  }
  return encrypted_pool
end
local function entry()
  local result = vm_dispatch(0x01, {0x02, 0x03})
  for _, v in ipairs(result) do print(v) end
end
return entry()
`, 'utf8');

// A 77fuscator sample.
const FUSCATOR77_SAMPLE = Buffer.from(`--[[77fuscator v0.6.1]]
local function vm()
  local constants = {
    "77fuscator VM payload",
    "encrypted constant pool",
    "anti-debug sentinel",
  }
  return constants
end
local function wrapper()
  local x = 1337
  local y = 0xff
  return vm()
end
return wrapper()
`, 'utf8');

// An empty/garbage buffer — must still produce a valid (empty) table.
const GARBAGE_SAMPLE = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]);

// A binary PE-style buffer (MZ header).
const BINARY_SAMPLE = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]),
  Buffer.alloc(64, 0),
  Buffer.from('This program cannot be run in DOS mode.\r\n', 'ascii'),
  Buffer.alloc(128, 0),
  Buffer.from('KERNEL32.dll\0LoadLibraryA\0GetProcAddress\0VirtualProtect\0', 'ascii'),
]);

// ---- helpers ----------------------------------------------------------------

function assertValidLua(code, label) {
  const v = verifyCode(code, { lang: 'lua', filename: 'recovered.lua' });
  assert.strictEqual(v.status, 'verified', `${label}: Lua verification failed: ${v.detail}`);
}

function assertValidJs(code, label) {
  // vm.Script compile-only — never run.
  new vm.Script(code, { filename: 'recovered.js' });
}

function assertHasString(code, needle, label) {
  assert.ok(code.includes(needle), `${label}: expected output to contain "${needle.slice(0, 40)}"`);
}

// ---- test cases -------------------------------------------------------------

console.log('static-peel:');

ok('Luraph v15.1 → valid Lua + strings extracted', () => {
  const r = staticPeel(LURAPH_SAMPLE, { detected: { name: 'Luraph', version: 'v15.1', id: 'luraph' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'Luraph');
  assertHasString(r.code, 'Luraph v15 protected payload executing', 'Luraph');
  assertHasString(r.code, 'CTF{static_peel_recovers_strings}', 'Luraph');
});

ok('Luraph v15.1 → base64 payload decoded', () => {
  const r = staticPeel(LURAPH_SAMPLE, { detected: { name: 'Luraph', version: 'v15.1' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  // The base64 payload "SGVsbG8..." decodes to "Hello World! This is a decoded payload."
  assertHasString(r.code, 'base64', 'Luraph payload');
  assertHasString(r.code, 'Hello World', 'Luraph payload decoded');
});

ok('MoonSec V3 escrow → valid Lua + string table', () => {
  const r = staticPeel(MOONSEC_V3_SAMPLE, { detected: { name: 'MoonSec V3', version: 'V3', id: 'moonsec_v3' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'MoonSec V3');
  assertHasString(r.code, 'MoonSec V3 escrow build', 'MoonSec V3');
  assertHasString(r.code, 'anti-tamper sentinel active', 'MoonSec V3');
});

ok('obfuscator.io JS → valid JS + _0x strings', () => {
  const r = staticPeel(OBFUSCATOR_IO_SAMPLE, { detected: { name: 'obfuscator.io', id: 'obfuscator_io' }, lang: 'js' });
  assert.strictEqual(r.ok, true);
  assertValidJs(r.code, 'obfuscator.io');
  assertHasString(r.code, 'hello', 'obfuscator.io');
  assertHasString(r.code, 'decoded payload here', 'obfuscator.io');
});

ok('MoonVeil 2.x (VM wall) → still produces output, no failure', () => {
  const r = staticPeel(MOONVEIL_SAMPLE, { detected: { name: 'MoonVeil', version: 'v2.0.26', id: 'moonveil' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'MoonVeil');
  assertHasString(r.code, 'MoonVeil VM bytecode layer 1', 'MoonVeil');
  assertHasString(r.code, 'control flow flattening applied', 'MoonVeil');
  // The hex payload should decode.
  assertHasString(r.code, 'hex', 'MoonVeil payload');
});

ok('77fuscator (VM wall) → still produces output', () => {
  const r = staticPeel(FUSCATOR77_SAMPLE, { detected: { name: '77fuscator', version: 'v0.6.1', id: '77fuscator' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, '77fuscator');
  assertHasString(r.code, '77fuscator VM payload', '77fuscator');
});

ok('garbage bytes → still produces valid Lua (no throw)', () => {
  const r = staticPeel(GARBAGE_SAMPLE, { detected: { name: 'Unknown' }, lang: 'unknown' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'garbage');
});

ok('binary MZ sample → strings(1)-style output', () => {
  const r = staticPeel(BINARY_SAMPLE, { detected: { name: 'Packed native binary' }, lang: 'binary' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'binary');
  assertHasString(r.code, 'KERNEL32.dll', 'binary');
  assertHasString(r.code, 'LoadLibraryA', 'binary');
});

ok('function names + locals captured', () => {
  const r = staticPeel(MOONSEC_V3_SAMPLE, { detected: { name: 'MoonSec V3' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertHasString(r.code, 'dispatcher', 'MoonSec V3 structure');
  assertHasString(r.code, 'vm_loop', 'MoonSec V3 structure');
});

ok('numeric constants captured', () => {
  const r = staticPeel(FUSCATOR77_SAMPLE, { detected: { name: '77fuscator' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertHasString(r.code, '1337', '77fuscator numbers');
});

ok('long-bracket strings captured verbatim', () => {
  const sample = Buffer.from(`local x = [[This is a long-bracket string with "quotes" and 'apostrophes']]
local y = [==[Another long-bracket with ]] inside]==]
`, 'utf8');
  const r = staticPeel(sample, { detected: { name: 'test' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'long-bracket');
  assertHasString(r.code, 'long-bracket string', 'long-bracket');
});

ok('hex-encoded payload decoded', () => {
  // "756e69717565..." = "unique key material for build"
  const r = staticPeel(MOONSEC_V3_SAMPLE, { detected: { name: 'MoonSec V3' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertHasString(r.code, 'unique key material', 'MoonSec V3 hex decode');
});

ok('partialNote always present and informative', () => {
  for (const sample of [LURAPH_SAMPLE, MOONSEC_V3_SAMPLE, OBFUSCATOR_IO_SAMPLE, MOONVEIL_SAMPLE, GARBAGE_SAMPLE]) {
    const r = staticPeel(sample, { detected: { name: 'Test' }, lang: 'unknown' });
    assert.ok(r.partialNote && r.partialNote.length > 20, 'partialNote missing');
  }
});

ok('no crashes on a 1 MB random buffer', () => {
  const big = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 13) & 0xff;
  // Sprinkle some valid Lua-looking bytes so the scanner has work to do.
  big.write('local function foo() return "hello world" end\n', 0, 'utf8');
  const r = staticPeel(big, { detected: { name: 'Big' }, lang: 'lua' });
  assert.strictEqual(r.ok, true);
  assertValidLua(r.code, 'big buffer');
});

// ---- summary ----------------------------------------------------------------

console.log(`\nsummary: ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
console.log('ALL STATIC-PEEL TESTS PASSED');
