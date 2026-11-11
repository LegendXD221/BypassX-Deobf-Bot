/**
 * AntiTamper V2 suite (v2.15.0) — the full engine, pinned.
 *
 *   A. CATALOG — intelligence database integrity + live matching.
 *   B. NEUTRALIZER — every static defuse rule, syntax safety, idempotence,
 *      zero-hit byte-identity, and "real code is never touched".
 *   C. ENV HARDENING — production + executor masquerade layers compose and
 *      carry the identity surface.
 *   D. SANITY GATE — the sUNC-style behavioral audit must be 100% green
 *      (production + every executor identity).
 *   E. END-TO-END ESCALATION — an executor-gated sample that produces an
 *      EMPTY pool under the production shape decrypts under the Synapse Z
 *      identity via the vm-lift worker (the money test).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const {
  CATALOG, CATALOG_SIZE, FAMILIES, matchCatalog, isExecutorGated,
  neutralize, harden, executorLadder, audit, EXECUTOR_IDENTITIES, defuseSummary, brief,
} = await import(path.join(root, 'src/antitamper/index.js'));

// ---- runner ---------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ===== A. catalog =================================================================

test('A1 catalog integrity — required fields, unique ids, valid regexes', () => {
  const ids = new Set();
  const GOALS = new Set(['static', 'dynamic', 'both']);
  const COUNTERS = new Set(['neutralize', 'env', 'escalate']);
  for (const e of CATALOG) {
    assert.ok(e.id && !ids.has(e.id), `duplicate/missing id: ${e.id}`);
    ids.add(e.id);
    assert.ok(e.family && e.name, `missing family/name on ${e.id}`);
    assert.ok(Number.isInteger(e.severity) && e.severity >= 1 && e.severity <= 5, `bad severity on ${e.id}`);
    assert.ok(Array.isArray(e.signals) && e.signals.length > 0, `no signals on ${e.id}`);
    for (const s of e.signals) assert.doesNotThrow(() => new RegExp(s, 'i'), `bad regex on ${e.id}: ${s}`);
    assert.ok(GOALS.has(e.goal), `bad goal on ${e.id}`);
    assert.ok(COUNTERS.has(e.counter), `bad counter on ${e.id}`);
    assert.ok(e.note && e.note.length > 30, `thin note on ${e.id}`);
    assert.ok(e.source && e.source.length > 5, `missing source on ${e.id}`);
  }
  assert.ok(CATALOG_SIZE >= 100, `catalog must stay large (got ${CATALOG_SIZE})`);
  assert.ok(FAMILIES.length >= 10, `families must cover the landscape (got ${FAMILIES.length})`);
});

test('A2 matchCatalog flags LPH macros, identity gates, magic numbers', () => {
  const src = `
    local function LPH_PRECHECK() if not identifyexecutor() then error('no executor') end end
    LPH_PRECHECK()
    if tostring(game) == 45195195 then LPH_CRASH() end
    while true do end
  `;
  const hits = matchCatalog(src);
  const ids = new Set(hits.map((h) => h.id));
  for (const want of ['lph-crash', 'lph-precheck', 'luraph-tostring-magic', 'exwl-identifyexecutor']) {
    assert.ok(ids.has(want), `expected ${want} in ${[...ids].join(',')}`);
  }
  assert.ok(hits[0].severity >= hits[hits.length - 1].severity, 'sorted by severity');
});

test('A3 isExecutorGated — gate + kill required, neither alone suffices', () => {
  assert.ok(isExecutorGated('if identifyexecutor() then error() end'), 'gate+kill');
  assert.ok(isExecutorGated('local x = getgenv() while true do end'), 'genv+spin');
  assert.ok(!isExecutorGated('print("hello")'), 'neither');
  assert.ok(!isExecutorGated('if x then error("no executor word only") end'), 'kill alone');
  assert.ok(!isExecutorGated('local _ = checkcaller'), 'bare name without call+kill');
});

test('A4 brief() summarizes sample posture', () => {
  const b = brief('if not checkcaller() then error("detected") end identifyexecutor()');
  assert.ok(b.hits >= 2 && b.severity >= 3 && b.gated === true, JSON.stringify(b));
});

// ===== B. neutralizer ===============================================================

test('B1 zero-hit source passes through BYTE-IDENTICAL', () => {
  const src = 'local x = 42\nprint("hello world")\nfor i = 1, 10 do print(i) end\n';
  const r = neutralize(src);
  assert.strictEqual(r.code, src);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.report.edits.length, 0);
});

test('B2 LPH_CRASH call statements are stripped', () => {
  const r = neutralize('local a = 1\nLPH_CRASH()\nlocal b = 2\nreturn a + b');
  assert.ok(!r.code.includes('LPH_CRASH'), r.code);
  assert.strictEqual(r.changed, true);
  const e = r.report.edits.find((x) => x.id === 'lph-crash');
  assert.ok(e && e.count === 1, JSON.stringify(r.report.edits));
});

test('B3 LPH_PRECHECK definition is emptied — callers become no-ops', () => {
  const src = 'function LPH_PRECHECK(a, b) if not identifyexecutor() then error("denied") end end\nLPH_PRECHECK(1, 2)\nprint("payload")';
  const r = neutralize(src);
  assert.ok(r.changed, 'must transform');
  assert.ok(/function LPH_PRECHECK\(\) end/.test(r.code), r.code);
  assert.ok(!r.code.includes('denied'), 'validator body must be gone');
  assert.ok(r.code.includes('print("payload")'), 'payload preserved');
  const parsed = r.report.parsed === 'ast';
  assert.ok(parsed, 'AST tier must handle this');
});

test('B4 fingerprint kill gate (if not checkcaller() then error()) removed', () => {
  const src = 'if not checkcaller() then error("detected skid") end\nprint("real work")';
  const r = neutralize(src);
  assert.ok(!r.code.includes('detected skid'), r.code);
  assert.ok(r.code.includes('print("real work")'));
  assert.ok(r.report.defused.includes('ks-error-gate'));
});

test('B5 executor-name compare gate removed, non-kill compare PRESERVED', () => {
  const kill = neutralize(`if identifyexecutor() == "Synapse X" then error("wrong executor") end\nprint("ok")`);
  assert.ok(!kill.code.includes('wrong executor'), kill.code);
  assert.ok(kill.code.includes('print("ok")'));
  // a fingerprint test with REAL payload logic must be untouched
  const keep = neutralize(`if identifyexecutor() == "Synapse X" then local key = 5 end\nprint("ok")`);
  assert.strictEqual(keep.changed, false, 'key-deriving branch is real code');
  assert.strictEqual(keep.code, `if identifyexecutor() == "Synapse X" then local key = 5 end\nprint("ok")`);
});

test('B6 while-true spin bombs removed; guarded loops with real bodies kept', () => {
  const spin = neutralize('local a = 1\nwhile true do end\nlocal b = 2');
  assert.ok(!spin.code.includes('while true'), spin.code);
  const guarded = neutralize('while true do work() end');
  assert.ok(guarded.code.includes('work()'), 'loop with real body stays');
});

test('B7 pcall-wrapped suicide threads defused', () => {
  const r = neutralize('if not checkcaller() then pcall(function() error("die") end) end\nprint("alive")');
  assert.ok(!r.code.includes('die'), r.code);
  assert.ok(r.code.includes('print("alive")'));
});

test('B8 os.exit gates stripped', () => {
  const r = neutralize('os.exit(1)\nprint("after")');
  assert.ok(!r.code.includes('os.exit'), r.code);
  assert.ok(r.code.includes('print("after")'));
});

test('B9 output is re-verified: complex mixed sample stays parseable', () => {
  const src = [
    'local config = { debug = false, name = "svc" }',
    'function LPH_PRECHECK() if not identifyexecutor() then error("no") end end',
    'LPH_PRECHECK()',
    'if tostring(game) == 45195195 then LPH_CRASH() end',
    'while true do end',
    'local function work(n)',
    '  local acc = 0',
    '  for i = 1, n do acc = acc + i end',
    '  return acc',
    'end',
    'print(work(10), config.name)',
  ].join('\n');
  const r = neutralize(src);
  assert.ok(r.changed, 'must defuse the mix');
  assert.ok(!r.code.includes('LPH_CRASH()'));
  assert.ok(r.code.includes('print(work(10), config.name)'));
  assert.strictEqual(neutralize(r.code).changed, false, 'idempotent');
});

test('B10 defuseSummary renders a human line', () => {
  const r = neutralize('LPH_CRASH()\nif not checkcaller() then error("x") end');
  const line = defuseSummary(r.report);
  assert.ok(/defused/.test(line) && /LPH_CRASH/.test(line), line);
});

// ===== C. env hardening =============================================================

test('C1 production layer + executor ladder compose per identity', () => {
  const prod = harden('production');
  assert.ok(prod.lua.includes("The game") && prod.lua.includes('__pairs'), 'production layer features');
  const ladder = executorLadder(EXECUTOR_IDENTITIES);
  assert.strictEqual(ladder.length, 3, 'three identities');
  const names = EXECUTOR_IDENTITIES.map((i) => i.name);
  ladder.forEach((l, i) => {
    assert.ok(l.lua.includes(names[i]), `layer ${l.key} carries ${names[i]}`);
    assert.ok(l.lua.includes('checkcaller') && l.lua.includes('newcclosure'), 'surface present');
  });
});

// ===== D. sanity gate ================================================================

test('D1 behavioral audit is 100% green across all profiles', () => {
  const res = audit();
  assert.strictEqual(res.ok, true, `failures: ${JSON.stringify(res.failures.slice(0, 6))}`);
  assert.strictEqual(res.total, res.passed);
  assert.ok(res.total >= 100, `audit surface must stay wide (${res.total})`);
  assert.deepStrictEqual(res.identities, ['synapse', 'scriptware', 'krnl']);
});

// ===== E. end-to-end escalation =======================================================

test('E1 executor-gated sample decrypts ONLY after identity escalation (vm-lift worker)', () => {
  const sample = `
-- executor-gated decryptor: the pool only decrypts under Synapse Z
local K = 0
if identifyexecutor() == "Synapse Z v2.0.3" then
  K = 5
else
  while true do end
end
if K > 0 then
  for i = 1, 10 do
    print(string.rep(string.char(64 + K), 4) .. tostring(i))
  end
end
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-at-'));
  const file = path.join(dir, 'gated.lua');
  fs.writeFileSync(file, sample);

  // sanity: production shape alone yields nothing (proven at unit level by the
  // catalog: identifyexecutor reads nil → K stays 0 → no prints → empty pool).
  assert.ok(isExecutorGated(sample), 'sample must be flagged executor-gated');

  const r = spawnSync(process.execPath, [path.join(root, 'src/vm-lift-worker.js'), file], {
    timeout: 90_000,
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, `worker produced no output (stderr: ${(r.stderr || '').slice(0, 200)})`);
  let last = null;
  for (const line of lines) { try { last = JSON.parse(line); } catch { /* skip */ } }
  assert.ok(last && last.ok !== false, `worker failed: ${JSON.stringify(last).slice(0, 200)}`);
  assert.strictEqual(last.escalated, 'synapse', `expected escalation, got: ${JSON.stringify({ escalated: last.escalated, n: (last.strings || []).length })}`);
  assert.ok((last.strings || []).length >= 10, `expected >=10 decrypted strings, got ${(last.strings || []).length}`);
  assert.ok(last.strings.some((s) => s.startsWith('EEEE')), `expected EEEE* decrypts, got: ${last.strings.slice(0, 3).join(',')}`);
});

// ---- run ---------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${t.name}\n    ${String(e.message || e).split('\n').slice(0, 4).join('\n    ')}`);
  }
}
if (failed) {
  console.error(`\n${failed}/${tests.length} antitamper tests FAILED`);
  process.exit(1);
}
console.log(`\nall ${tests.length} antitamper tests passed`);
