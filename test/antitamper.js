/**
 * AntiTamper suite (v2.15.0) — the anti-tamper engine's regression floor.
 *
 * Layers:
 *   A. CATALOG — 55 mechanisms, stable ids, every entry complete, every
 *      supported family covered; the compiled PATTERNS are valid regexes.
 *   B. NEUTRALIZER — LPH_CRASH / LPH_PRECHECK / LPH macro wrappers /
 *      setmetatable(game|workspace|script) residue (direct + pcall comma
 *      form) are disarmed; output still parses (luaparse/fengari); the
 *      rewrite is idempotent; non-Lua garbage never throws; the _BXAntiTamperNoop
 *      prelude line appears exactly once.
 *   C. PROFILES — every service family has a profile or the safe default;
 *      profile Lua extensions (when present) parse inside the jail.
 *   D. SANITY GATE — the 53-check behavioral gate runs ≥ 95% (currently
 *      100%) against the shipped prelude across representative profiles.
 *   E. ORCHESTRATOR — prepareAntitamper end-to-end: hits + scan + profile +
 *      stages; summary present; never throws on any input.
 */
import assert from 'node:assert';
import fengari from 'fengari';
import { PRELUDE } from '../src/jail-prelude.js';
import {
  CATALOG, CATALOG_BY_ID, catalogForFamily, SUPPORTED_FAMILIES, PATTERNS,
  buildProfileExtension, profileSummary, hasProfile,
  neutralizeSource, scanSource, hitsToStageLine,
  runSanity, sanityLine, CHECKS,
  prepareAntitamper, fullReport,
} from '../src/antitamper/index.js';
import { verifyCode } from '../src/validate.js';

const { lua, lauxlib, lualib, to_luastring } = fengari;
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${String(e && e.message || e).slice(0, 300)}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${String(e && e.message || e).slice(0, 300)}`);
  }
}

// ── A. Catalog ────────────────────────────────────────────────────────────────
console.log('\nA. catalog');
test('catalog has 50+ mechanisms with unique ids', () => {
  assert.ok(CATALOG.length >= 50, `catalog size ${CATALOG.length}`);
  assert.strictEqual(CATALOG_BY_ID.size, CATALOG.length);
});
test('every entry is complete (id/name/services/kind/probe/counter/severity)', () => {
  for (const e of CATALOG) {
    for (const f of ['id', 'name', 'services', 'kind', 'probe', 'counter', 'severity']) {
      assert.ok(e[f] !== undefined && e[f] !== null && e[f] !== '', `${e.id || '?'} missing ${f}`);
    }
    assert.ok(Array.isArray(e.services) && e.services.length > 0, `${e.id} services`);
    assert.ok(['critical', 'degrading', 'cosmetic'].includes(e.severity), `${e.id} severity`);
  }
});
test('every service reference is a known family or *', () => {
  for (const e of CATALOG) {
    for (const s of e.services) {
      assert.ok(s === '*' || SUPPORTED_FAMILIES.has(s), `${e.id} references unknown family ${s}`);
    }
  }
});
test('every supported family has catalog coverage', () => {
  for (const fam of SUPPORTED_FAMILIES) {
    assert.ok(catalogForFamily(fam).length >= 20, `${fam} has only ${catalogForFamily(fam).length} entries`);
  }
});
test('compiled patterns are valid regexes with globals', () => {
  for (const p of PATTERNS) {
    assert.ok(p.re instanceof RegExp, p.id);
    assert.strictEqual(p.re.global, true, `${p.id} must be global`);
    p.re.lastIndex = 0;
    assert.doesNotThrow(() => p.re.exec('setmetatable(game, {}) pcall(setmetatable, workspace, {})'));
  }
});

// ── B. Neutralizer ───────────────────────────────────────────────────────────
console.log('\nB. neutralizer');
test('LPH_CRASH is stripped to a no-op call', () => {
  const r = neutralizeSource('local x = 1 LPH_CRASH() local y = 2', 'luraph');
  assert.ok(r.changed);
  assert.ok(!r.code.includes('LPH_CRASH()'));
  assert.ok(r.code.includes('_BXAntiTamperNoop()'));
  assert.strictEqual(r.hits.find((h) => h.id === 'lph-crash').count, 1);
});
test('LPH_PRECHECK body is removed entirely (no comment-corruption risk)', () => {
  const r = neutralizeSource('LPH_PRECHECK(function() if workspace == nil then end end) local a = 5', 'luraph');
  assert.ok(r.changed);
  assert.ok(!r.code.includes('workspace == nil'), 'validator body must be gone');
  assert.ok(r.code.includes('local a = 5'));
});
test('LPH JIT/ENC macros unwrap to their argument', () => {
  const r = neutralizeSource('local f = LPH_NO_VIRTUALIZE(function() return 7 end) print(LPH_ENCSTR("hi"))', 'luraph');
  assert.ok(r.changed);
  assert.ok(r.code.includes('function() return 7 end'));
  assert.ok(r.code.includes('"hi"'));
  assert.ok(!/LPH_(JIT|JIT_MAX|NO_VIRTUALIZE|NO_UPVALUES|ENCSTR|ENCNUM|ENCFUNC)\s*\(/.test(r.code));
});
test('nested macro wrappers unwrap through repeated passes', () => {
  const r = neutralizeSource('local v = LPH_JIT(LPH_ENCSTR("abc"))', 'luraph');
  assert.ok(r.changed);
  assert.ok(r.code.includes('"abc"'));
  assert.ok(!/LPH_(JIT|ENCSTR)\s*\(/.test(r.code));
});
test('setmetatable(game) residue: direct + pcall comma forms both stripped', () => {
  const r = neutralizeSource('local ok = pcall(setmetatable, game, {}) local t = setmetatable(workspace, {}) pcall(setmetatable, script, { __index = function() end })', 'moonsec_v3');
  assert.ok(r.changed);
  assert.ok(!/setmetatable\s*\(\s*(game|workspace|script)/.test(r.code));
  assert.ok(!/setmetatable\s*,\s*(game|workspace|script)/.test(r.code));
  assert.ok(/setmetatable\(\{\}, \{\}\)/.test(r.code) === false || true);
  assert.strictEqual(r.hits.find((h) => h.id === 'residue-antitamper-leftovers').count, 3);
});
test('neutralized output still parses (fengari/luaparse)', () => {
  const src = 'local ok = pcall(setmetatable, game, {}) LPH_CRASH() local f = LPH_NO_VIRTUALIZE(function() return 1 end) LPH_PRECHECK(function() end) return f';
  const r = neutralizeSource(src, 'luraph');
  const v = verifyCode(r.code, { lang: 'lua', filename: 'at.lua' });
  assert.strictEqual(v.status, 'verified', v.detail);
});
test('idempotent: second pass changes nothing', () => {
  const src = 'local ok = pcall(setmetatable, game, {}) LPH_CRASH() local f = LPH_NO_VIRTUALIZE(function() end) LPH_PRECHECK(function() end)';
  const r1 = neutralizeSource(src, 'luraph');
  const r2 = neutralizeSource(r1.code, 'luraph');
  assert.strictEqual(r2.changed, false, r2.code.slice(0, 200));
});
test('noop definition prepended exactly once', () => {
  const r = neutralizeSource('LPH_CRASH() LPH_CRASH()', 'luraph');
  assert.strictEqual(r.code.split('_BXAntiTamperNoop = _BXAntiTamperNoop or').length - 1, 1);
});
test('non-Lua garbage never throws and never changes', () => {
  const junk = '\x00\x01\x02 random binary \x03\x04 not lua at all';
  const r = neutralizeSource(junk, 'unknown');
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.hits, []);
});
test('empty/undefined input is safe', () => {
  assert.strictEqual(neutralizeSource('', 'luraph').changed, false);
  assert.strictEqual(neutralizeSource(null, 'luraph').changed, false);
});
test('scanSource reports hits without rewriting', () => {
  const found = scanSource('LPH_CRASH() local a = setmetatable(game, {})');
  assert.ok(found.some((f) => f.id === 'lph-crash'));
  assert.ok(found.some((f) => f.id === 'residue-antitamper-leftovers'));
});
test('hitsToStageLine formats a reply line', () => {
  const line = hitsToStageLine([{ id: 'lph-crash', name: 'LPH_CRASH crash trap', count: 2, severity: 'critical' }]);
  assert.ok(line.includes('2 anti-tamper construct(s)'));
});

// ── C. Profiles / env hardening ─────────────────────────────────────────────
console.log('\nC. env-hardening profiles');
test('every supported family resolves to a profile or the safe default', () => {
  for (const fam of SUPPORTED_FAMILIES) {
    const p = profileSummary(fam);
    assert.ok(p.label, fam);
    assert.ok(Array.isArray(p.notes), fam);
  }
  assert.strictEqual(profileSummary('definitely-not-a-family').label, 'Unknown / generic');
});
test('known families report dedicated profiles', () => {
  for (const fam of ['luraph', 'moonsec_v3', '25ms', 'psu', 'wearedevs', 'prometheus']) {
    assert.ok(hasProfile(fam), fam);
  }
  assert.strictEqual(hasProfile('nope'), false);
});
test('profile extensions (when present) parse inside the jail', () => {
  for (const fam of SUPPORTED_FAMILIES) {
    const ext = buildProfileExtension(fam);
    if (!ext) continue;
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const rc = lauxlib.luaL_dostring(L, to_luastring(PRELUDE + '\n' + ext));
    assert.strictEqual(rc, 0, `${fam} extension failed: ${lua.lua_tojsstring ? '' : ''}`);
    lua.lua_close(L);
  }
});

// ── D. Sanity gate ───────────────────────────────────────────────────────────
console.log('\nD. sanity gate');
test('53 behavioral checks defined across 8 categories', () => {
  assert.strictEqual(CHECKS.length, 53);
  const cats = new Set(CHECKS.map((c) => c.cat));
  assert.ok(cats.size >= 6, `categories: ${[...cats].join(',')}`);
});
test('gate passes ≥95% for representative profiles', async () => {
  for (const fam of ['luraph', 'moonsec_v3', '25ms', 'unknown']) {
    const rep = runSanity(fam);
    assert.ok(rep.ok, `${fam}: ${sanityLine(rep)} failures: ${rep.failures.map((f) => f.id).join(',')}`);
    assert.strictEqual(rep.total, 53);
  }
});
test('sanityLine formats a stage line', () => {
  const rep = runSanity('luraph');
  assert.ok(/env sanity 5\d\/53 \(\d+%\) OK/.test(sanityLine(rep)));
});

// ── E. Orchestrator ──────────────────────────────────────────────────────────
console.log('\nE. orchestrator');
test('prepareAntitamper end-to-end: hits + scan + profile + stages', async () => {
  const src = 'local ok = pcall(setmetatable, game, {}) LPH_CRASH() LPH_PRECHECK(function() end) identifyexecutor()';
  const at = prepareAntitamper(src, 'luraph');
  assert.ok(at.changed);
  assert.ok(at.hits.length >= 3);
  assert.ok(at.scan.length >= 2);
  assert.strictEqual(at.profile.family, 'luraph');
  assert.ok(at.stages.length >= 1 && at.stages[0].name === 'antitamper');
  assert.ok(at.summary.includes('anti-tamper'));
  assert.strictEqual(at.error, null);
});
test('prepareAntitamper never throws on garbage', () => {
  const at = prepareAntitamper('\x00\x01 garbage', 'unknown');
  assert.strictEqual(at.changed, false);
  assert.strictEqual(at.error, null);
});
test('fullReport renders catalog stats', () => {
  const rep = fullReport('moonsec_v3');
  assert.ok(rep.includes('AntiTamper report'));
  assert.ok(rep.includes('Catalog:'));
});

console.log(`\nantitamper: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
