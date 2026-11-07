/**
 * BypassX Deobf Bot — webcrack worker (isolated child process).
 *
 * Runs in a separate node process so a pathological input that trips a
 * babel/webcrack crash cannot take the bot down. Spawned via spawnHardened
 * (env scrub, timeout, SIGKILL). Reads: argv[2]=input file, argv[3]=output.
 * Exit 0 + non-empty output = success.
 */
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: webcrack-worker <in> <out>');
  process.exit(2);
}

const deadline = setTimeout(() => {
  console.error('webcrack worker: timed out');
  process.exit(124);
}, 150_000);

try {
  const { webcrack } = await import('webcrack');
  const code = fs.readFileSync(input, 'utf8');
  const result = await webcrack(code, {
    jsx: false,
    unminify: true,
    deobfuscate: true,
    mangle: false,
  });
  const out = result?.code || '';
  if (!out.trim()) {
    console.error('webcrack produced empty output');
    process.exit(1);
  }
  fs.writeFileSync(output, out);
  clearTimeout(deadline);
  process.exit(0);
} catch (e) {
  console.error(String(e?.message || e).slice(0, 400));
  process.exit(1);
}
