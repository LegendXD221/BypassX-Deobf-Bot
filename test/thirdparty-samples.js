/**
 * Third-party sample corpus + 25ms technique tests (v2.10.0).
 *
 * The fixtures in test/fixtures/thirdparty/ are real-world obfuscated builds
 * (mined from the leaked env-logger collection — per-obfuscator samples:
 * Luraph ×5, IronBrew 1/2, MoonVeil, WeAreDevs ×2, Junkie ×2, 25ms, LuaArmor,
 * Prometheus-derived customs). They are the regression floor for the jail's
 * dynamic tiers:
 *
 *   1. tier 3 — 25ms-style concat-capture injection: strings the VM builds
 *      with raw `..` concatenation of pool-table reads are captured via the
 *      _BXCAP passthrough (technique credit: leaked 25ms luraphdump.lua).
 *   2. nested peel — chunks handed to load() that are themselves VM builds
 *      (`return(function(…`) re-run in a fresh jail so the INNER obfuscator
 *      decrypts its pool into our sinks too (multi-layer peel, dynamic tier).
 *   3. corpus contract — every sample completes with parseable JSON and a
 *      stable capture baseline (no crashes, no hangs, monotonic floor).
 *
 * Run: node test/thirdparty-samples.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

process.env.ENGINE_PATH = '/nonexistent/bypassx-deobf';

const { harvestConstants } = await import('../src/harvest.js');
const { detectService } = await import('../src/detect.js');

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIXDIR = path.join(here, 'fixtures', 'thirdparty');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass += 1; } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.stack || e}`); fail += 1;
  }
}

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx3p-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---- 1. tier 3: 25ms concat-capture injection --------------------------------

// Strings built ONLY by raw `..` concat of pool-table reads — no string.*
// sink ever fires, so strict + forgiving tiers starve (usable < 3) and the
// instrumented tier must recover them. 1–2 letter idents: the exact wrapper
// shape the 25ms regex targets (real Luraph: `S[m[V]]..S[w[V]]`).
const CONCAT_SAMPLE = `-- bx concat-capture probe
local g={}
g[1]="BX" g[2]="-concat-capture" g[3]="-works" g[4]="!"
local j={}
j[1]=1 j[2]=2 j[3]=3 j[4]=4
local s1=g[j[1]]..g[j[2]]
local s2=g[j[3]]..g[j[4]]
error(s1..s2)
`;

// ---- 2. nested peel: VM chunk re-run in a fresh jail --------------------------

// Outer hands a `return(function(…)` chunk to loadstring WITHOUT running it —
// only the nested-peel tier executes it, so its captured strings prove the
// fresh-state pass ran. Padded past the 512-byte eligibility floor.
function makeNestedSample() {
  const pad = '-- peel-pad ' + 'x'.repeat(80) + '\n';
  const inner = 'return(function(b,c)\n'
    + pad.repeat(6)
    + 'local p,q="peel","-nested-ok"\n'
    + 'local s=table.concat({p,q})\n'
    + 'error(s)\n'
    + 'end)(b,c)';
  return `-- bx nested-peel probe\nlocal f=loadstring(${JSON.stringify(inner)})\nif f then f(1,2) end\n`;
}

// ---- 3. corpus ----------------------------------------------------------------

const FIXTURES = fs.readdirSync(FIXDIR).filter((f) => f.endsWith('.lua')).sort();

console.log(`third-party corpus: ${FIXTURES.length} samples`);

await ok('tier3 concat-injection recovers raw-concat strings', async () => {
  const p = tmpFile('concat.lua', CONCAT_SAMPLE);
  const r = await harvestConstants(p, { timeoutMs: 30_000 });
  assert.strictEqual(r.ok, true, `worker not ok: ${r.error}`);
  const hits = r.strings.filter((s) => s.includes('BX-concat-capture') || s.includes('-works!'));
  assert.ok(hits.length >= 2, `concat products not captured — have: ${JSON.stringify(r.strings.slice(0, 12))}`);
  assert.ok(r.log.some((l) => l.includes('tier3')), `tier3 not logged: ${JSON.stringify(r.log)}`);
});

await ok('nested VM chunks are peeled in a fresh jail', async () => {
  const p = tmpFile('nested.lua', makeNestedSample());
  const r = await harvestConstants(p, { timeoutMs: 30_000 });
  assert.strictEqual(r.ok, true, `worker not ok: ${r.error}`);
  assert.ok(r.log.some((l) => l.includes('peel: nested chunk 1')), `peel not logged: ${JSON.stringify(r.log)}`);
  assert.ok(
    r.strings.some((s) => s.includes('peel-nested-ok')),
    `inner strings missing — have: ${JSON.stringify(r.strings.slice(0, 12))}`,
  );
});

// Per-sample contract + baseline. The floor is the calibrated minimum from the
// v2.10.0 mining run; a drop means a jail regression (env shaping, sinks,
// budget) — not sample drift, the files are immutable. v2.18.0 floors raised
// from 0 where the Biggest Scan unblocked the sample (backtick/type-annotation
// shim, compound-assign scanner fixes, pre-parse filter, escalation + static
// floor tiers) — a drop below THESE now also fails, pinning the wins.
const BASELINE = {
  '25ms-obf.lua': 500,
  'custom-obf.lua': 1000,
  'customprometheus-obf.lua': 2500,
  'ironbrew1-obf.lua': 100,
  'ironbrew2-obf.lua': 5000,
  'junkie-obf.lua': 0,
  'junkie-obf2.lua': 30,
  'luarmor-obf.lua': 5,
  'luraph1-obf.lua': 0,
  'luraph2-obf.lua': 500,
  'luraph4-obf.lua': 1,
  'luraph5-obf.lua': 0,
  'luraph6-obf.lua': 1,
  'moonveil-obf.lua': 100,
  'somecoolobfuscator-obf.lua': 1000,
  'wearedevs-obf.lua': 50,
  'wearedevs-obf2.lua': 800,
};

let captured = 0;
const lines = [];
for (const f of FIXTURES) {
  await ok(`corpus: ${f}`, async () => {
    const p = path.join(FIXDIR, f);
    const t0 = Date.now();
    const r = await harvestConstants(p, { timeoutMs: 45_000 });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    // contract: parseable result, never a throw — ok:false must carry a reason
    if (!r.ok) {
      assert.ok(typeof r.error === 'string' && r.error.length > 0, 'ok:false without error string');
      lines.push(`${f.padEnd(30)} ERROR ${r.error.slice(0, 60)}`);
      return;
    }
    const total = r.strings.length + r.chunks.length;
    if (total > 0) captured += 1;
    const floor = BASELINE[f] ?? 0;
    assert.ok(
      total >= floor,
      `baseline drop: ${total} captured < floor ${floor} (strings ${r.strings.length}, chunks ${r.chunks.length})`,
    );
    let fam = '—';
    try { fam = detectService(fs.readFileSync(p)).best?.service?.name || '—'; } catch { /* advisory */ }
    lines.push(`${f.padEnd(30)} ${String(total).padStart(5)} captured (${dt}s) [${fam}]`);
  });
}

await ok('corpus: majority of samples yield captured data', () => {
  // observed at v2.10.0: 9/17 (WeAreDevs ×2, 77fuscator-lineage custom,
  // IronBrew 1/2, Luraph ×3, customs) — floor 7 leaves regression margin
  assert.ok(captured >= 7, `only ${captured}/${FIXTURES.length} samples captured anything`);
});

console.log('\n  corpus baseline (strings+chunks per sample):');
for (const l of lines) console.log(`    ${l}`);

console.log(`\nthirdparty-samples: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
