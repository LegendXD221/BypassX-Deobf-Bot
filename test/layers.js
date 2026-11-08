/**
 * Multi-layer + readability suite — the v2.4.0 "Total Deobf" engine:
 *   1. residualObfuscation — layer-agnostic "is this still obfuscated?" verdict
 *      (real Luraph samples OBF, ground truth clean, _0x floods OBF).
 *   2. detectLayers — stacked-family detection from co-existing banners.
 *   3. readable engine — escape decode / literal folds / machine-name rename,
 *      all parse-verified; readability grading.
 *   4. END-TO-END PEEL LOOP — a genuine 2-layer sample (runtime loader wrapped
 *      around a runtime loader wrapped around plain source) must come back as
 *      the plain source with a 2-entry layer stack via pipeline.deobfuscate().
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const tests = [];
const test = (name, optsOrFn, maybeFn) => {
  const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
  tests.push({ name, fn });
};

const { residualObfuscation, detectLayers, stackSummary, peelSummary } = await import(path.join(root, 'src', 'layers.js'));
const { makeReadableLua, makeReadableJs, readabilityScore } = await import(path.join(root, 'src', 'readable.js'));
const { verifyCode } = await import(path.join(root, 'src', 'validate.js'));

// ---- 1. residual obfuscation ---------------------------------------------------

test('residual: ground-truth plain Lua reads clean (0 signals)', () => {
  const gt = fs.readFileSync(path.join(root, 'test', 'fixtures', 'luraph-v15.1-real-groundtruth.lua'), 'utf8');
  const r = residualObfuscation(gt, 'lua');
  assert.equal(r.obfuscated, false);
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.signals, []);
});

test('residual: real Luraph v15.1 sample reads heavily obfuscated', () => {
  const text = fs.readFileSync(path.join(root, 'test', 'fixtures', 'luraph-v15.1-real-sample.lua'), 'utf8');
  const r = residualObfuscation(text, 'lua');
  assert.equal(r.obfuscated, true);
  assert.ok(r.confidence >= 80, `confidence too low: ${r.confidence}`);
  assert.ok(r.residualFamily && r.residualFamily.id === 'luraph', 'family not identified');
});

test('residual: _0x identifier flood JS reads obfuscated', () => {
  const js = `var _0x4f2a = function(_0x1b3c, _0x2d4e) { var _0x5f6a = _0x1b3c ^ _0x2d4e; return _0x5f6a; };\n`.repeat(60);
  const r = residualObfuscation(js, 'js');
  assert.equal(r.obfuscated, true);
  assert.ok(r.confidence >= 45);
});

test('residual: escaped-string loader wrapper reads obfuscated (load marker)', () => {
  const codes = Array.from({ length: 900 }, (_, i) => 40 + (i % 80)).join(' ');
  const loader = `local c = "${codes}" local t = {} for x in c:gmatch("%d+") do t[#t + 1] = string.char(tonumber(x)) end load(table.concat(t))()`;
  const r = residualObfuscation(loader, 'lua');
  assert.equal(r.obfuscated, true, `expected OBF, got ${r.confidence}: ${r.signals.map((s) => s.label).join('; ')}`);
});

test('residual: honest code using load() with a variable stays clean', () => {
  const code = `-- plugin hot-reload\nlocal src = io.open("plugin.lua"):read("*a")\nlocal chunk, err = load(src, "plugin")\nif chunk then chunk() end\n`;
  const r = residualObfuscation(code, 'lua');
  assert.equal(r.obfuscated, false, `false positive at ${r.confidence}: ${r.signals.map((s) => s.label).join('; ')}`);
});

// ---- 2. static layer stack -----------------------------------------------------

test('detectLayers: two family banners in one file → multi-layer stack', () => {
  const text = '--[[ MoonSec V3 ]]\nlocal a = 1\n-- LPH_NOJIT\n-- protected using Luraph Obfuscator v15.1\nlocal b = 2\n';
  const s = detectLayers(Buffer.from(text));
  assert.equal(s.multi, true);
  const ids = s.layers.map((l) => l.id);
  assert.ok(ids.includes('moonsec_v3'), 'moonsec v3 layer missing');
  assert.ok(ids.includes('luraph'), 'luraph layer missing');
  assert.ok(s.summary.includes('MoonSec V3') && s.summary.includes('Luraph'), 'summary incomplete');
});

test('detectLayers: single-banner file is not multi-layer', () => {
  const text = '-- protected with MoonSec V3\nlocal x = 1\nprint(x)\n';
  const s = detectLayers(Buffer.from(text));
  assert.equal(s.multi, false);
});

test('stackSummary / peelSummary formatting', () => {
  assert.equal(stackSummary([{ name: 'Luraph', version: 'v15.1' }, { name: 'MoonSec V3' }]), 'Luraph v15.1 → MoonSec V3');
  const p = peelSummary([
    { family: 'runtime loader layer', residual: 53 },
    { family: 'Luraph', version: 'v15.1', residual: 0 },
  ]);
  assert.ok(p.includes('L1: runtime loader layer (residual 53%)'));
  assert.ok(p.includes('L2: Luraph v15.1 (residual 0%)'));
});

// ---- 3. readability engine -----------------------------------------------------

test('readable: string-escape decode turns \\104 escapes into text', () => {
  const src = 'local s = "\\104\\101\\108\\108\\111\\32\\119\\111\\114\\108\\100"\nprint(s)\n';
  const r = makeReadableLua(src);
  assert.ok(r.passes.includes('string-escape decode'), `passes: ${r.passes}`);
  assert.ok(r.code.includes('"hello world"'), r.code);
  assert.equal(verifyCode(r.code, { lang: 'lua' }).status, 'verified');
});

test('readable: escapes carrying non-printables are preserved', () => {
  const src = 'local s = "a\\0b"\nprint(s)\n';
  const r = makeReadableLua(src);
  assert.ok(r.code.includes('\\0'), 'NUL escape must survive');
});

test('readable: literal concat folds across the statement', () => {
  const src = 'local greet = "Hel" .. "lo, " .. "wor" .. "ld!"\nprint(greet)\n';
  const r = makeReadableLua(src);
  assert.ok(r.passes.includes('literal concat fold'), `passes: ${r.passes}`);
  assert.ok(r.code.includes('"Hello, world!"'), r.code);
  assert.equal(verifyCode(r.code, { lang: 'lua' }).status, 'verified');
});

test('readable: small arithmetic folds with signed-result safety', () => {
  const src = 'local a = (3 + 4)\nlocal b = (6 - 9)\nlocal c = (5 * 5)\nprint(a, b, c)\n';
  const r = makeReadableLua(src);
  assert.ok(r.passes.includes('constant arithmetic fold'), `passes: ${r.passes}`);
  assert.ok(r.code.includes('local a = 7'), r.code);
  assert.ok(r.code.includes('local b = (-3)'), r.code);
  assert.ok(r.code.includes('local c = 25'), r.code);
  assert.equal(verifyCode(r.code, { lang: 'lua' }).status, 'verified');
});

test('readable: machine-name rename is consistent and parse-safe', () => {
  const lines = [];
  for (let i = 0; i < 24; i++) lines.push(`local v${i} = ${i}`);
  lines.push('print(v0, v23, v12 + v7)');
  const src = lines.join('\n') + '\n';
  const r = makeReadableLua(src);
  assert.ok(r.passes.includes('machine-name rename'), `passes: ${r.passes}`);
  assert.ok(!/\bv\d+\b/.test(r.code), 'machine names remain after rename');
  assert.ok(/\bprint\b/.test(r.code), 'globals must never be renamed');
  assert.equal(verifyCode(r.code, { lang: 'lua' }).status, 'verified');
});

test('readable: rename refuses Luau/unparseable files (gate holds)', () => {
  const src = 'local v0 = 1\nlocal v1 = 2\nif v0 then v0 += v1 end\n'; // Luau compound assign — luaparse refuses
  const r = makeReadableLua(src);
  assert.ok(!r.passes.includes('machine-name rename'), 'rename must not engage on unparseable input');
});

test('readable: JS \\xNN escapes decode', () => {
  const r = makeReadableJs('var s = "\\x48\\x65\\x6c\\x6c\\x6f";\nconsole.log(s);\n');
  assert.ok(r.passes.includes('string-escape decode'));
  assert.ok(r.code.includes('"Hello"'), r.code);
});

test('readability: clean code 100, obfuscated VM dump graded machine/rough', () => {
  const clean = 'local x = 1\nif x then\n  print("hi")\nend\n';
  assert.equal(readabilityScore(clean, 'lua').score, 100);
  const text = fs.readFileSync(path.join(root, 'test', 'fixtures', 'luraph-v15.1-real-sample.lua'), 'utf8');
  const s = readabilityScore(text, 'lua');
  assert.ok(s.score < 80, `expected low score, got ${s.score}`);
  assert.ok(s.issues.length >= 1);
});

// ---- 4. END-TO-END 2-LAYER PEEL LOOP --------------------------------------------

function numericLoader(src) {
  const codes = [...Buffer.from(src, 'utf8')].join(' ');
  return [
    `local __codes = "${codes}"`,
    'local __parts = {}',
    'for __c in __codes:gmatch("%d+") do __parts[#__parts + 1] = string.char(tonumber(__c)) end',
    'load(table.concat(__parts))()',
    '',
  ].join('\n');
}

test('peel loop e2e: 2-layer runtime-loader stack → plain source + layer stack', { timeoutMs: 300_000 }, async () => {
  const inner = [
    '-- layer-two ground truth',
    'print("LAYER-TWO-SOURCE-RECOVERED")',
    'local table_name = "bypassx"',
    'for i = 1, 3 do print(i, table_name) end',
    '',
  ].join('\n');
  const layer2 = numericLoader(inner);
  const layer1 = numericLoader(layer2);
  assert.equal(verifyCode(layer1, { lang: 'lua' }).status, 'verified', 'fixture must be valid Lua');

  const { deobfuscate } = await import(path.join(root, 'src', 'pipeline.js'));
  const result = await deobfuscate({ buffer: Buffer.from(layer1, 'utf8'), filename: 'two-layer.lua' });

  assert.equal(result.ok, true, 'pipeline must never fail');
  assert.ok(result.code, 'text output expected');
  assert.ok(result.layers.length >= 2, `expected ≥2 layer records, got ${JSON.stringify(result.layers)}`);
  assert.ok(result.code.includes('LAYER-TWO-SOURCE-RECOVERED'), 'final code must be the innermost plain source');
  assert.ok(!result.code.includes('__codes'), 'final code must not contain the loader plumbing');
  assert.ok(result.verification.status === 'verified', `verification: ${result.verification?.detail}`);
  const last = result.layers[result.layers.length - 1];
  assert.ok(last.residual == null || last.residual < 45, `innermost layer still reads obfuscated: ${last.residual}`);
  assert.ok(result.layerSummary, 'layer summary missing');
});

test('peel loop e2e: plain script finishes in ONE pass with clean residual', { timeoutMs: 120_000 }, async () => {
  const src = 'local greet = "hi"\nprint(greet .. " there")\n';
  const { deobfuscate } = await import(path.join(root, 'src', 'pipeline.js'));
  const result = await deobfuscate({ buffer: Buffer.from(src, 'utf8'), filename: 'plain.lua' });
  assert.equal(result.ok, true);
  assert.equal(result.layers.length, 1, 'single pass for plain code');
  assert.ok(result.code.includes('hi'));
});

// ---- runner --------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  PASS ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${t.name}\n    ${e.message}`);
  }
}
console.log(failed ? `\n${failed} FAILED` : `\n${tests.length} passed, 0 failed`);
process.exit(failed ? 1 : 0);
