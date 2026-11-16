/**
 * Xfuscator regression suite — semantics preservation + signature + resilience.
 *
 *  1. header: every output starts with the Xfuscator signature line
 *  2. round-trip: original vs obfuscated run in the vendored luau jail →
 *     identical observable behavior (print output)
 *  3. syntax: the obfuscated output parses with the vendored luau-ast
 *  4. determinism: fixed seed → fixed output
 *  5. layer features: string table + number encoding + blob encryption active
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const { xfuscate, xfChecksum, XFUL_VERSION } = await import(path.join(root, 'src', 'xfuscator.js'));
const { BYPASSX_HEADING_XF } = await import(path.join(root, 'src', 'xf-header.js'));

const LUAAU_BIN = path.join(root, 'vendor', 'luraph-v15', 'bin', 'luau');
const LUAAU_AST = path.join(root, 'vendor', 'luraph-v15', 'bin', 'luau-ast');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.error(`  FAIL ${name}: ${e.message}`); }
}

function runLuau(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-'));
  const f = path.join(dir, 's.luau');
  fs.writeFileSync(f, src, 'latin1');
  try {
    const out = execFileSync(LUAAU_BIN, [f], { timeout: 20_000, encoding: 'latin1' });
    return out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const SAMPLES = [
  {
    name: 'prints + arithmetic + strings',
    code: `local name = "bypassx"\nlocal n = 42\nprint("hello " .. name)\nprint(n * 2 + 1)\nif n > 10 then print("big") else print("small") end\nfor i = 1, 3 do print("iter " .. i) end\n`,
  },
  {
    name: 'functions + tables + loops',
    code: `local function add(a, b) return a + b end\nlocal t = { x = 10, y = 25 }\nt.z = add(t.x, t.y)\nprint(t.z)\nlocal s = 0\nfor k, v in pairs(t) do s = s + v end\nprint(s)\ntypeof = nil\n`,
  },
  {
    name: 'varargs + returns',
    code: `local function sum(...) local r = 0 for _, v in ipairs({...}) do r = r + v end return r end\nprint(sum(1, 2, 3, 4))\nlocal function two() return 7, 8 end\nlocal a, b = two()\nprint(a + b)\n`,
  },
];

await check('header signature on every output', async () => {
  for (const s of SAMPLES) {
    const r = xfuscate(s.code);
    assert.ok(r.ok, `xfuscate failed: ${r.error}`);
    assert.ok(r.code.startsWith(BYPASSX_HEADING_XF.replace('%V', XFUL_VERSION)), 'missing signature header');
    assert.equal(r.code.split('\n')[0], BYPASSX_HEADING_XF.replace('%V', XFUL_VERSION));
  }
});

await check('obfuscated output parses (luau-ast)', async () => {
  for (const s of SAMPLES) {
    const r = xfuscate(s.code);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfa-'));
    const f = path.join(dir, 'o.luau');
    fs.writeFileSync(f, r.code, 'latin1');
    try {
      execFileSync(LUAAU_AST, [f], { timeout: 20_000, stdio: 'pipe' });
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});

await check('behavior round-trip: original vs obfuscated identical', async () => {
  for (const s of SAMPLES) {
    const orig = runLuau(s.code);
    const obf = runLuau(xfuscate(s.code).code);
    assert.equal(obf, orig, `behavior mismatch:\n--- orig ---\n${orig}\n--- obf ---\n${obf}`);
  }
});

await check('string-table + number + blob layers active', async () => {
  const r = xfuscate(SAMPLES[0].code, { seed: 777 });
  assert.equal(r.meta.strings.extracted > 0, true, 'no strings extracted');
  assert.equal(r.meta.numbersEncoded > 0, true, 'no numbers encoded');
  assert.equal(r.meta.blob.encBytes > 0, true, 'no blob');
  const bodyOnly = r.code.split('\n').slice(1).join('\n');
  assert.ok(!bodyOnly.includes('bypassx'), 'plaintext string leaked into output');
  assert.ok(!bodyOnly.includes('hello '), 'plaintext string (hello) leaked');
});

await check('determinism: fixed seed → fixed output', async () => {
  const a = xfuscate(SAMPLES[1].code, { seed: 42 }).code;
  const b = xfuscate(SAMPLES[1].code, { seed: 42 }).code;
  assert.equal(a, b);
});

await check('checksum helper matches Lua formula', () => {
  const bytes = Buffer.from('The quick brown fox', 'latin1');
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h + bytes[i] * ((i % 251) + 1)) >>> 0;
  assert.equal(xfChecksum(bytes), h >>> 0);
});

await check('refuses binary + empty input', () => {
  const r1 = xfuscate('');
  assert.equal(r1.ok, false);
  const r2 = xfuscate(Buffer.from([0x13, 0x02, 0x00]).toString('latin1') + 'print(1)');
  assert.equal(r2.ok, false, 'binary accepted');
});

console.log(`\nxfuscator: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
