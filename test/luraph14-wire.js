/**
 * v2.19.0 — Luraph v14.7 wire recovery (bloxfruits sample, live user request):
 *   1. static wire unwrap — base85 blobs → LZMA1 (byte-exact JS port of the
 *      loader's own pure-Lua decoder; the in-fengari decode balloons >950MB)
 *      → VM interpreter source + program bytecode
 *   2. static constant-pool extraction (tag 0xDB + len + bytes)
 *   3. the VM chunk classifies as Luau source (transform + repair) — the
 *      pipeline delivers it instead of re-peeling the VM runtime
 * Floor: bloxfruits-luraph14-obf.lua (254KB) — was a 1,432-byte static-peel
 * wall before v2.19.0; now delivers 117 pool strings + the full VM source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unwrapV14Wire, findWireBlobs, extractV14Pool, b85decode, lzmaDecode } from '../src/luraph14-wire.js';
import { transformLuauToLua, repairInvalidEscapes } from '../src/luau-shim.js';
import { verifyCode } from '../src/validate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'fixtures', 'thirdparty', 'bloxfruits-luraph14-obf.lua');
const src = fs.readFileSync(SAMPLE, 'utf8');

const ok = { total: 0, failed: 0 };
function check(name, fn) {
  ok.total += 1;
  try { fn(); console.log(`  PASS ${name}`); }
  catch (e) { ok.failed += 1; console.error(`  FAIL ${name}\n    ${String(e?.stack || e).split('\n').slice(0, 4).join('\n    ')}`); }
}

check('wire detected: exactly two [=[LPH…]=] blobs', () => {
  const blobs = findWireBlobs(src);
  assert.equal(blobs.length, 2, `expected 2 blobs, got ${blobs.length}`);
  assert.ok(blobs[0].text.startsWith('LPH:'), 'blob1 must carry the LPH: magic');
  assert.ok(blobs[1].text.startsWith('LPH?'), 'blob2 must carry the LPH? magic');
});

check('base85 decode: 17292 bytes from blob1 (matches the loader N() output byte-for-byte)', () => {
  const dec = b85decode(findWireBlobs(src)[0].text);
  assert.equal(dec.length, 17292, `got ${dec.length}`);
});

check('LZMA decode: VM chunk is the Luraph v14.7 interpreter source', () => {
  const wire = unwrapV14Wire(src);
  assert.ok(!wire.error, `unwrap failed: ${wire.error}`);
  assert.equal(wire.vmChunk.length, 59485, `vmChunk ${wire.vmChunk.length} (reference LZMA ground truth)`);
  assert.equal(wire.data.length, 364976, `data ${wire.data.length} (reference LZMA ground truth)`);
  const head = Buffer.from(wire.vmChunk.slice(0, 20)).toString('latin1');
  assert.ok(head.startsWith('local t='), `vm chunk must be Lua source, got: ${JSON.stringify(head)}`);
});

check('constant pool: ≥100 strings incl. the Roblox API surface', () => {
  const wire = unwrapV14Wire(src);
  const pool = extractV14Pool(wire.data);
  assert.ok(pool.strings.length >= 100, `pool ${pool.strings.length}`);
  for (const required of ['GetService', 'Instance', 'HttpService', 'RunService', 'setmetatable', 'Connect']) {
    assert.ok(pool.strings.includes(required), `pool missing "${required}"`);
  }
});

check('VM chunk classifies as verified Luau source (transform + repair)', () => {
  const wire = unwrapV14Wire(src);
  const vmSource = Buffer.from(wire.vmChunk).toString('latin1');
  const rep = repairInvalidEscapes(transformLuauToLua(vmSource));
  const v = verifyCode(rep.code, { lang: 'lua', filename: 'vm.lua' });
  assert.equal(v.status, 'verified', `verify: ${v.status} ${JSON.stringify(v.issues || []).slice(0, 120)}`);
});

check('decoder determinism: unwrap twice → identical bytes', () => {
  const a = unwrapV14Wire(src);
  const b = unwrapV14Wire(src);
  assert.deepEqual(Buffer.from(a.vmChunk).equals(Buffer.from(b.vmChunk)), true);
  assert.deepEqual(Buffer.from(a.data).equals(Buffer.from(b.data)), true);
});

check('b85+LZMA unit: known group decodes to the exact <I4 LE bytes', () => {
  // "V]7Sp" → F = (86-33)*85⁴ + (93-33)*85³ + (55-33)*85² + (83-33)*85 + (112-33)
  //        = 3322313695 → LE: 3f 01 db c6? — recomputed here from first principles
  const dec = b85decode('LPH:V]7Sp');
  // value = 53*52200625 + 60*614125 + 22*7225 + 50*85 + 79
  const expect = 53 * 52200625 + 60 * 614125 + 22 * 7225 + 50 * 85 + 79;
  const le = [expect & 255, (expect >>> 8) & 255, (expect >>> 16) & 255, (expect >>> 24) & 255];
  assert.deepEqual(Array.from(dec), le, `got ${Buffer.from(dec).toString('hex')}`);
});

console.log(`\nluraph14-wire: ${ok.total - ok.failed} passed, ${ok.failed} failed`);
if (ok.failed) process.exit(1);
