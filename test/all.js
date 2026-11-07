/**
 * Unit test runner — executes every offline suite in sequence.
 * (test/run.js remains the manual sample harness: node test/run.js <files>)
 *
 * Run: npm test
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'static-peel.js',    // unconditional no-walls fallback (v1.7.0)
  'harvest-chunks.js', // load()-chunk capture + Roblox env shaping (v1.8.0)
  'confirm-gate.js',   // L3 confirm gate (the "confirm cancels" regression)
  'owner-guard.js',    // L1/L2/L4/L5 + DB fallback + eval harness jail
  'dashboard.js',      // dashboard routes, brute-force guard, DB protection
  'v2-smoke.js',       // every Components V2 reply builder serializes
  'chunk-paste.js',    // pastefy chunking round-trips
  'links.js',          // url detection / normalization / SSRF guards
  'luau-shim.js',      // Luau shim: compound assigns + if-expressions (v1.6.0)
];

let failed = 0;
for (const suite of SUITES) {
  const res = spawnSync(process.execPath, [path.join(here, suite)], {
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (res.status !== 0) {
    console.error(`\n✗ suite failed: ${suite}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) FAILED`);
  process.exit(1);
}
console.log(`\nALL ${SUITES.length} TEST SUITES PASSED`);
