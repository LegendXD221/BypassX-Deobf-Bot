/**
 * Harvest load()-chunk capture tests (v1.8.0) — the Luraph/MoonSec escrow tier.
 *
 * Decrypt-then-load obfuscators hand their FULL decrypted source (or bytecode)
 * to load()/loadstring() during the jailed VM run. These tests verify:
 *   1. the worker captures chunks into the JSON result,
 *   2. the pipeline delivers a captured source chunk as the recovered code
 *      (complete source recovery — ok:true, verified),
 *   3. captured bytecode is delivered as a binary .luac artifact,
 *   4. the production-shaped Roblox env (Is* booleans, HttpGet nil, PlaceId,
 *      string.dump nil) lets env-gated decryption run.
 *
 * Run: node test/harvest-chunks.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Engine absent in tests → route falls through to harvest fast.
// MUST be set before importing config/pipeline.
process.env.ENGINE_PATH = '/nonexistent/bypassx-deobf';

const { harvestConstants } = await import('../src/harvest.js');
const { deobfuscate } = await import('../src/pipeline.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass += 1; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e?.stack || e}`); fail += 1; });
}

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxchunks-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---- samples ----------------------------------------------------------------

// Decrypt-then-load (the shape Luraph LPH_ENCSTR / PSU / MoonSec V2
// load-stage variants / IronBrew lines all use): keystream-decrypt a source
// chunk, hand it to loadstring().
function makeDecryptThenLoad(marker) {
  return `-- Protected_by_MoonSecV2
local function keystream(n)
  local s = 0x5A
  local out = {}
  for i = 1, n do s = (s * 1103515245 + 12345) % 2147483648; out[i] = s % 256 end
  return out
end
local ks = keystream(256)
local src = 'local POOL = {"secret_string_one","secret_string_two","secret_string_three","${marker}"} print("chunk ran") return POOL'
local encrypted = {}
for i = 1, #src do encrypted[i] = string.byte(src, i) ~ ks[(i - 1) % #ks + 1] end
local dec = {}
for i = 1, #encrypted do dec[i] = string.char(encrypted[i] ~ ks[(i - 1) % #ks + 1]) end
local payload = table.concat(dec)
local f = loadstring(payload)
if not f then error('chunk failed') end
f()
`;
}

// Bytecode-capture shape: the chunk handed to load() starts with the Lua
// bytecode escape header (invalid as 5.3 bytecode — but the capture happens
// BEFORE the load attempt, so classification sees it).
const BYTECODE_SAMPLE = `-- obfuscated by ironbrew
local bc = "\\27\\76\\117\\97\\81\\0\\1\\4\\4\\4\\8\\0" .. string.rep("Z", 64)
local ok, err = pcall(loadstring, bc)
if not ok then end
local a, b = 1, 2
local function vm() return a + b end
return vm()
`;

// Env-gated decryption: strings only decrypt (via string.char + table.concat,
// the exact shape VM dispatchers use) when the Roblox env reads
// production-shaped (IsStudio false, IsClient true, HttpGet nil, PlaceId > 0,
// string.dump nil). Proves the v1.8.0 anti-dump shaping.
const ENV_SAMPLE = `-- Protected_by_MoonSecV2
local function dec(bytes)
  local t = {}
  for i = 1, #bytes do t[i] = string.char(bytes[i]) end
  return table.concat(t)
end
local function s(str)
  local b = {}
  for i = 1, #str do b[i] = string.byte(str, i) end
  return b
end
local sink = {}
if game:GetService('RunService'):IsStudio() == false then sink[#sink + 1] = dec(s('ENV_STUDIO_FALSE_OK')) end
if game:GetService('RunService'):IsClient() == true then sink[#sink + 1] = dec(s('ENV_ISCLIENT_TRUE_OK')) end
if game.HttpGet == nil then sink[#sink + 1] = dec(s('ENV_HTTPGET_NIL_OK')) end
if game.PlaceId > 0 then sink[#sink + 1] = dec(s('ENV_PLACEID_OK')) end
if string.dump == nil then sink[#sink + 1] = dec(s('ENV_STRDUMP_NIL_OK')) end
if game:GetService('RunService'):IsEdit() == false then sink[#sink + 1] = dec(s('ENV_ISEDIT_FALSE_OK')) end
local function pad(x) local t = 0 for i = 1, x do t = t + i end return t end
return pad(#sink)
`;

// ---- tests ------------------------------------------------------------------

console.log('harvest-chunks:');

await ok('worker captures the decrypted chunk', async () => {
  const p = tmpFile('escrow.lua', makeDecryptThenLoad('BX_WORKER_MARKER_01'));
  const h = await harvestConstants(p, { timeoutMs: 60_000 });
  assert.strictEqual(h.ok, true, `harvest failed: ${h.error || ''}`);
  assert.ok(Array.isArray(h.chunks), 'chunks array missing');
  assert.ok(h.chunks.some((c) => c.includes('BX_WORKER_MARKER_01')), `chunk not captured: ${JSON.stringify(h.chunks).slice(0, 200)}`);
});

await ok('pipeline delivers captured source as the recovered code', async () => {
  const p = tmpFile('escrow.lua', makeDecryptThenLoad('BX_PIPELINE_MARKER_77'));
  const result = await deobfuscate({ buffer: fs.readFileSync(p), filename: 'escrow.lua' });
  assert.strictEqual(result.ok, true, `pipeline not ok — stages: ${JSON.stringify(result.stages)}, note: ${result.note || ''}`);
  assert.ok(result.code.includes('BX_PIPELINE_MARKER_77'), `recovered code missing marker: ${result.code.slice(0, 300)}`);
  assert.ok(result.code.includes('secret_string_one'), 'pool strings missing from recovered source');
  assert.ok(String(result.how).includes('load()'), `how should mention load(): ${result.how}`);
  assert.strictEqual(result.verification.status, 'verified', `verification: ${JSON.stringify(result.verification)}`);
});

await ok('captured bytecode is delivered as a binary .luac artifact', async () => {
  const p = tmpFile('bytecode.lua', BYTECODE_SAMPLE);
  const result = await deobfuscate({ buffer: fs.readFileSync(p), filename: 'bytecode.lua' });
  assert.strictEqual(result.ok, true, `pipeline not ok — stages: ${JSON.stringify(result.stages)}`);
  assert.strictEqual(result.binaryOutput, true, 'bytecode artifact should ride as binaryOutput');
  assert.ok(Buffer.isBuffer(result.outputBuffer), 'outputBuffer missing');
  assert.strictEqual(result.outputBuffer[0], 0x1b, 'outputBuffer should start with the Lua bytecode escape byte');
  assert.ok(result.outputBuffer.toString('latin1').startsWith('\x1bLua'), 'outputBuffer should start with \\27Lua signature');
  assert.ok(String(result.how).includes('bytecode'), `how: ${result.how}`);
});

await ok('production-shaped Roblox env passes anti-dump gates', async () => {
  const p = tmpFile('env.lua', ENV_SAMPLE);
  const h = await harvestConstants(p, { timeoutMs: 60_000 });
  assert.strictEqual(h.ok, true, `harvest failed: ${h.error || ''}`);
  const found = (h.strings || []).join('\n');
  for (const marker of ['ENV_STUDIO_FALSE_OK', 'ENV_ISCLIENT_TRUE_OK', 'ENV_HTTPGET_NIL_OK', 'ENV_PLACEID_OK', 'ENV_STRDUMP_NIL_OK', 'ENV_ISEDIT_FALSE_OK']) {
    assert.ok(found.includes(marker), `anti-dump gate failed: ${marker} missing (strings: ${JSON.stringify(h.strings)})`);
  }
});

await ok('pool-only harvest still works (no chunks, ≥3 strings)', async () => {
  const pool = Buffer.from(`-- Protected_by_MoonSecV2
local function build()
  local pool = {}
  pool[1] = 'MOON_POOL_STR_A'
  pool[2] = 'MOON_POOL_STR_B'
  pool[3] = 'MOON_POOL_STR_C'
  return table.concat(pool, ',')
end
local function shuffle(t)
  local out = {}
  for i = 1, #t do out[#out + 1] = string.upper(t[i]) end
  return out
end
return shuffle({ build(), 'extra' })
`, 'utf8');
  const p = tmpFile('pool.lua', pool);
  const h = await harvestConstants(p, { timeoutMs: 60_000 });
  assert.strictEqual(h.ok, true, `harvest failed: ${h.error || ''}`);
  const all = (h.strings || []).join('\n');
  assert.ok(all.includes('MOON_POOL_STR_A') && all.includes('MOON_POOL_STR_C'), `pool strings missing: ${all.slice(0, 200)}`);
});

// ---- summary ----------------------------------------------------------------

console.log(`\nsummary: ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
console.log('ALL HARVEST-CHUNK TESTS PASSED');
process.exit(0);
