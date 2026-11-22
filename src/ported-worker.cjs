'use strict';
/**
 * Ported-family worker — runs the vendored OmniDBF family deobfuscators
 * (vendor/omnidbf/, CommonJS) in an isolated child process so the main bot
 * (ESM, hardened) never loads third-party code into its own heap.
 *
 * Protocol (mirrors harvester-worker.js):
 *   argv = [worker, modRel, detectFn, deobfFn, inputPath, maxOutBytes]
 *   stdout: exactly ONE JSON line:
 *     { ok:true,  output, stats?, meta? }
 *     { ok:false, error, meta? }
 *   Diagnostics go to stderr. Never prints the input or the token env.
 *
 * Called only via src/ported.js -> spawnHardened (scrubbed env, hard timeout,
 * SIGKILL) — never directly.
 */
const path = require('path');
const fs = require('fs');

const [, , modRel, detectFn, deobfFn, inputPath, maxOutArg] = process.argv;
const maxOut = Math.min(Number(maxOutArg) || 8 * 1024 * 1024, 32 * 1024 * 1024);
const MOD_ROOT = path.resolve(__dirname, '..', 'vendor', 'omnidbf', 'deobfuscators');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function firstStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

async function main() {
  if (!modRel || !deobfFn || !inputPath) throw new Error('worker argv missing');
  const src = fs.readFileSync(inputPath, 'utf8');
  const mod = require(path.join(MOD_ROOT, modRel));

  // Optional family detector — only used for metadata; the pipeline's own
  // detect.js stays the source of truth for routing.
  let meta = null;
  if (detectFn && typeof mod[detectFn] === 'function') {
    try {
      const d = mod[detectFn](src);
      if (d && typeof d === 'object') {
        meta = {
          mode: d.mode ?? null,
          version: d.version ?? null,
          score: d.score ?? null,
          hosted: d.hosted ?? null,
        };
      }
    } catch { /* detection hints are best-effort */ }
  }

  // ---- per-module calling conventions (match OmniDBF bot.js usage) --------
  if (deobfFn === 'prostone:deobfuscate') {
    // ProstoneDeobf deobfuscate(source, { name, detect }) -> { code, ... }.
    // Their own identify() throws NotPrometheusError for non-family input —
    // their bot retries with detect:false, we do the same.
    const { deobfuscate } = mod;
    let r = null;
    let lastErr = null;
    for (const detect of [true, false]) {
      try {
        r = deobfuscate(src, { name: path.basename(inputPath), detect });
        break;
      } catch (e) {
        lastErr = e;
        if (detect === false) throw e;
      }
    }
    const code = String(r?.code || '');
    if (!code.trim()) throw new Error(lastErr ? String(lastErr.message || lastErr).slice(0, 300) : 'empty Prostone output');
    if (code.length > maxOut) throw new Error(`output ${code.length}B exceeds budget`);
    return emit({ ok: true, output: code, stats: { type: 'Prostone', mode: 'ast-vm-pipeline' }, meta });
  }

  if (deobfFn === 'luaobf:deobf') {
    // LuaObf-Deobf deobf(source, { log }) -> { reconstructed | lifted | disasm }.
    const { deobf } = mod;
    const r = await deobf(src, { log: false });
    const output = firstStr(r?.reconstructed, r?.lifted, r?.disasm).replace(/^\uFEFF/, '');
    if (!output.trim()) throw new Error('no reconstructed/lifted output');
    if (output.length > maxOut) throw new Error(`output ${output.length}B exceeds budget`);
    return emit({ ok: true, output, stats: { type: 'LuaObfuscator', mode: r?.reconstructed ? 'reconstructed' : r?.lifted ? 'lifted' : 'disasm' }, meta });
  }

  // ---- generic OmniDBF contract: { success, output, stats?, error? } ------
  const fn = mod[deobfFn];
  if (typeof fn !== 'function') throw new Error(`module has no export ${deobfFn}`);
  const r = await fn(src);
  if (!r || typeof r !== 'object') throw new Error('deobfuscator returned no result');
  if (!r.success) {
    return emit({ ok: false, error: String(r.error || 'deobfuscator reported failure').slice(0, 500), meta: meta || r.stats || null });
  }
  const output = firstStr(r.output, r.code);
  if (!output.trim()) throw new Error('success reported but output empty');
  if (output.length > maxOut) throw new Error(`output ${output.length}B exceeds budget`);
  emit({ ok: true, output, stats: r.stats || null, meta });
}

main()
  .then(() => { process.exit(0); })
  .catch((e) => {
    try { emit({ ok: false, error: String(e && e.message || e).slice(0, 500) }); } catch { /* stderr only */ }
    process.stderr.write(`ported-worker: ${String(e && e.stack || e).slice(0, 800)}\n`);
    process.exit(0);
  });
