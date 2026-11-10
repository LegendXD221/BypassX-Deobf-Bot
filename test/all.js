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
  { name: 'static-peel.js' },    // unconditional no-walls fallback (v1.7.0)
  { name: 'harvest-chunks.js' }, // load()-chunk capture + Roblox env shaping (v1.8.0)
  { name: 'confirm-gate.js' },   // L3 confirm gate (the "confirm cancels" regression)
  { name: 'owner-guard.js' },    // L1/L2/L4/L5 + DB fallback + eval harness jail
  { name: 'dashboard.js' },      // dashboard routes, brute-force guard, DB protection
  { name: 'v2-smoke.js' },       // every Components V2 reply builder serializes
  { name: 'chunk-paste.js' },    // pastefy chunking round-trips
  { name: 'links.js' },          // url detection / normalization / SSRF guards
  { name: 'env-sanity.js' },     // jail exploit floor + detection catalog + unparser alignment (v2.12.0)
  { name: 'luau-shim.js' },      // Luau shim: compound assigns + if-expressions (v1.6.0)
  { name: 'vm-lift.js', timeoutMs: 300_000 },        // VM devirtualization engine (v1.9.0) + CHECK*-lite branch comments (v2.13.0)
  { name: 'prometheus-deep.js', timeoutMs: 300_000 }, // Prometheus deep static pass — behavioral decoder undo (v2.13.0)
  { name: 'luraph-ext.js', timeoutMs: 300_000 }, // vendored v15 full-source lift (v2.1.0)
  { name: 'layers.js', timeoutMs: 420_000 },     // multi-layer peel loop + readability (v2.4.0)
  { name: 'luraph14.js', timeoutMs: 420_000 },   // Luraph v14 runtime-state devirtualizer (v2.6.0)
  { name: 'deobf-ack.js', timeoutMs: 120_000 },  // .deobf mention-status + background delivery (v2.7.1)
  { name: 'final-scan-fixes.js', timeoutMs: 120_000 }, // utf8-safe conversion + pool reconstruction (v2.8.0)
  { name: 'jte-lift.js', timeoutMs: 120_000 },  // jte bytecode-lift adapter — graceful absence + sniffing (v2.14.0)
  { name: 'service-commands.js', timeoutMs: 300_000 }, // per-service commands + environment logger (v2.8.0)
  { name: 'thirdparty-samples.js', timeoutMs: 420_000 }, // leaked-corpus regression floor + 25ms techniques (v2.10.0)
];

let failed = 0;
for (const suite of SUITES) {
  const res = spawnSync(process.execPath, [path.join(here, suite.name)], {
    stdio: 'inherit',
    timeout: suite.timeoutMs || 120_000,
  });
  if (res.status !== 0) {
    console.error(`\n✗ suite failed: ${suite.name}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) FAILED`);
  process.exit(1);
}
console.log(`\nALL ${SUITES.length} TEST SUITES PASSED`);
