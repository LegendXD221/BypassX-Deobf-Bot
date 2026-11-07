/**
 * Local test harness — runs the full pipeline without Discord.
 *
 *   node test/run.js <file> [file...]        # detect + deobfuscate + paste
 *   node test/run.js --detect-only <file>    # detection report only
 *
 * Exit code 0 when every non-detect-only file deobfuscated successfully.
 */
import fs from 'node:fs';
import { detectService, guessLanguage } from '../src/detect.js';
import { deobfuscate } from '../src/pipeline.js';
import { createPaste } from '../src/pastefy.js';
import { probe as probeEngine } from '../src/engine.js';

const args = process.argv.slice(2);
const detectOnly = args.includes('--detect-only');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('usage: node test/run.js [--detect-only] <file> [file...]');
  process.exit(2);
}

const engine = await probeEngine();
console.log(`engine: ${engine.available ? engine.version : 'NOT AVAILABLE'}`);

let pass = 0;
let fail = 0;

for (const file of files) {
  console.log('\n' + '='.repeat(72));
  console.log(`file: ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
  const buf = fs.readFileSync(file);

  // ---- detection ----
  const det = detectService(buf);
  const lang = guessLanguage(buf);
  console.log(`language: ${lang}`);
  if (det.best) {
    console.log(`detected: ${det.best.service.name}${det.best.version ? ` ${det.best.version}` : ''} — ${det.best.confidence}% (tier ${det.best.service.tier})`);
    for (const ev of det.best.evidence) console.log(`  evidence: ${ev}`);
  } else {
    console.log('detected: unknown');
  }
  for (const c of det.candidates.slice(1, 3)) {
    console.log(`  runner-up: ${c.name} ${c.confidence}%`);
  }
  if (detectOnly) continue;

  // ---- pipeline ----
  const t0 = Date.now();
  const result = await deobfuscate({ buffer: buf, filename: file });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.log(`result: FAILED in ${dt}s — ${result.note}`);
    for (const s of result.stages) console.log(`  stage: ${s.name} ${s.detail || ''}`);
    fail += 1;
    continue;
  }

  console.log(`result: OK in ${dt}s — ${result.stages.map((s) => s.name).join(' → ')}`);
  console.log(`  size: ${result.originalSize} → ${result.recoveredSize} bytes`);
  console.log(`  head: ${result.code.slice(0, 200).replace(/\n/g, '\\n')}`);

  try {
    const paste = await createPaste({
      title: `BypassX Deobf Bot test — ${result.detected.name} — ${file.split('/').pop()}`,
      text: result.code,
    });
    console.log(`  paste: ${paste.url}`);
  } catch (e) {
    console.log(`  paste: FAILED — ${e.message}`);
  }
  pass += 1;
}

console.log(`\nsummary: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
