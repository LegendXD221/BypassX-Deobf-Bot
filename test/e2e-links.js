/**
 * E2E: link → deobfuscate — mirrors `.deobf <link>` in production.
 *   1. GitHub raw resolver → real obfuscated Prometheus VMify sample
 *   2. Pastefy resolver  → same obfuscated sample through a paste
 *   3. pipeline.deobfuscate on each link-fetched buffer
 */
import { fetchFromUrl } from '../src/fetchurl.js';
import { deobfuscate } from '../src/pipeline.js';
import { probe as probeEngine } from '../src/engine.js';

const SRC = 'https://github.com/LegendXD221/BypassX-Deobf/raw/main/corpus/lua/prometheus/vmify/obfuscated.lua';

const engine = await probeEngine();
console.log(`engine: ${engine.available ? engine.version : 'NOT AVAILABLE'}`);
if (!engine.available) process.exit(2);

console.log('\n[1] GitHub link fetch…');
const gh = await fetchFromUrl(SRC);
console.log(`  got ${gh.buffer.length} B, filename=${gh.filename}, note=${gh.note}`);

console.log('\n[2] Pastefy link fetch (obfuscated content round-trip)…');
const cr = await fetch('https://pastefy.app/api/v2/paste', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: gh.buffer.toString('utf8'), title: 'bypassx-e2e-v12', type: 'PASTE', visibility: 'UNLISTED' }),
});
const cid = (await cr.json())?.paste?.id;
if (!cid) { console.error('  pastefy create failed'); process.exit(1); }
const pf = await fetchFromUrl(`https://pastefy.app/${cid}`);
console.log(`  got ${pf.buffer.length} B, filename=${pf.filename}, note=${pf.note}`);
fetch(`https://pastefy.app/api/v2/paste/${cid}`, { method: 'DELETE' }).catch(() => {});

let fail = 0;
for (const [label, buf] of [['github-link', gh.buffer], ['pastefy-link', pf.buffer]]) {
  console.log(`\n[3] deobfuscate(${label})…`);
  const t0 = Date.now();
  const result = await deobfuscate({ buffer: buf, filename: 'obfuscated.lua' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const det = result.detected || {};
  console.log(`  ok=${result.ok} detected=${det.name || '?'} ${det.confidence ?? 0}% recovered=${result.recoveredSize ?? 0}B in ${secs}s`);
  console.log(`  preview: ${String(result.code || '').slice(0, 90).replace(/\n/g, '\\n')}`);
  if (!result.ok) fail++;
}

console.log(fail ? `\nE2E FAIL (${fail})` : '\nE2E PASS — both link sources deobfuscated');
process.exit(fail ? 1 : 0);
