/**
 * BypassX Deobf Bot — deobfuscation pipeline orchestrator.
 *
 * detect → route → multi-stage engine run → post-process → result.
 * Stages, timings, and the detection verdict ride along in the result so the
 * Discord reply can show exactly what happened.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONFIG, ensureVarDir } from './config.js';
import { logger } from './logger.js';
import { detectService, guessLanguage } from './detect.js';
import * as engine from './engine.js';
import { postprocessFile } from './postprocess.js';
import { spawnHardened } from './security.js';
import { harvestConstants, harvestToLua } from './harvest.js';
import { verifyCode } from './validate.js';

// ---- global job semaphore ---------------------------------------------------
const jobState = { active: 0, queue: [] };
async function withJobSlot(fn) {
  if (jobState.active >= CONFIG.maxConcurrent) {
    if (jobState.queue.length >= CONFIG.maxQueue) throw Object.assign(new Error('busy — too many jobs queued, try again shortly'), { code: 'busy' });
    await new Promise((resolve) => jobState.queue.push(resolve));
  }
  jobState.active += 1;
  try { return await fn(); } finally {
    jobState.active -= 1;
    const next = jobState.queue.shift();
    if (next) next.resolve();
  }
}

/**
 * Full pipeline over an uploaded buffer.
 * Returns result document:
 * { ok, code, codeName, detected{...}, stages[], originalSize, recoveredSize,
 *   durationMs, note, lang }
 */
export async function deobfuscate({ buffer, filename = 'input.lua', hintId = null }) {
  const t0 = Date.now();
  return withJobSlot(async () => {
    const stages = [];
    const stage = (name, detail) => { stages.push({ name, detail }); logger.info({ detail }, `stage: ${name}`); };

    const detection = detectService(buffer);
    const lang = guessLanguage(buffer);

    // Persist input in an isolated 0700 dir with a safe name.
    const safeExt = path.extname(filename) || '.bin';
    const inDir = ensureVarDir(`jobs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const inputPath = path.join(inDir, `input${safeExt}`);

    // Signature shim: the engine's family detectors require canonical marker
    // comments that some obfuscator builds emit in different shapes. The bot's
    // detection is broader, so when we positively identify a family whose
    // engine marker is missing, prepend the canonical marker as a comment.
    const shim = engineMarkerShim(buffer, hintId || detection.best?.service?.id);
    await fsp.writeFile(inputPath, shim.buffer, { mode: 0o600 });

    try {
      const chosen = detection.best?.service || null;
      const detected = {
        id: chosen?.id || 'unknown',
        name: chosen?.name || 'Unknown',
        version: detection.best?.version || null,
        confidence: detection.best?.confidence ?? 0,
        tier: chosen?.tier || null,
        evidence: detection.best?.evidence || [],
        candidates: detection.candidates,
      };

      let outcome = null;
      const route = pickRoute(detected, lang, buffer);
      stage('detect', `${detected.name} ${detected.version || ''} (${detected.confidence}%) → route ${route}`);

      if (route === 'pyarmor') outcome = await runPyarmorRoute(inputPath, detected, stage, buffer);
      else if (route === 'webcrack') outcome = await runWebcrackRoute(inputPath, buffer, stage);
      else if (route === 'lua-engine') outcome = await runLuaEngineRoute(inputPath, detected, stage);
      else outcome = await runAutoRoute(inputPath, detected, stage);

      if (!outcome.ok) {
        // Last resort: opposite toolchain — engine auto for JS-looking input
        // that webcrack refused, webcrack for engine-refused JS-ish output…
        if (route !== 'auto') {
          stage('fallback:auto', 'final generic engine pass');
          const fb = await engine.autoRun(inputPath, { maxDepth: 6 });
          if (fb.ok) {
            // Skip stubs the generic pass may have merely extracted.
            const filtered = [];
            for (const f of fb.files) {
              const d = await engine.readCodeFile(f);
              if (!isPassthrough(d, buffer, shim.shimLine, detected.id)) filtered.push(f);
            }
            if (filtered.length) outcome = { ...fb, files: filtered, how: 'engine auto (fallback)' };
            else if (fb.workDir) await engine.cleanupWorkDir(fb.workDir);
          }
        }
        if (route !== 'webcrack' && !outcome.ok && looksLikeJs(buffer)) {
          const wc = await webcrackRun(inputPath);
          if (wc.ok) outcome = { ...wc, how: 'webcrack (fallback)' };
        }
      }

      const durationMs = Date.now() - t0;
      if (!outcome.ok || !outcome.files.length) {
        // Last tier: jailed dynamic constant harvest (escrow builds decrypt
        // their string pool at VM init — capture it without running anything
        // outside the sandbox).
        const h = await tryHarvest(inputPath, detected, lang, stage, stages, t0, buffer, filename);
        if (h) return h;
        return {
          ok: false,
          detected, stages, durationMs, lang,
          note: outcome.note || 'No recoverable code found — the sample may use an unsupported scheme, be corrupted, or be encrypted beyond static recovery.',
          originalSize: buffer.length,
        };
      }

      // Choose the best recovered file — accuracy-first: drop passthrough
      // echoes, post-process, then pick the FIRST candidate whose output
      // parses (verifyBest semantics). Verification rides the result so the
      // reply can show a real "syntax ✓" badge instead of a promise.
      const verifyLang = lang === 'js' ? 'js' : lang === 'lua' ? 'lua' : null;
      let picked = null; // { name, data, post, verification }
      const candidateCount = Math.min(outcome.files.length, 6);
      for (let i = 0; i < candidateCount; i++) {
        const f = outcome.files[i];
        let raw;
        try {
          raw = f.buffer || (await engine.readCodeFile(f));
        } catch { continue; }
        if (isPassthrough(raw, buffer, shim.shimLine, detected.id)) continue;

        // Binary-output guard: unpacked native binaries (UPX etc.) cannot ride
        // a text paste and have no parser — accept them directly.
        const probe = raw.subarray(0, 4096);
        let nuls = 0;
        for (const b of probe) if (b === 0) nuls += 1;
        const binaryOutput = nuls > probe.length * 0.05;
        const post = binaryOutput ? { data: raw, passes: [] } : postprocessFile(f.name, raw);
        const verification = binaryOutput
          ? { status: 'unverifiable', lang: 'binary', detail: 'binary output — no source parser' }
          : verifyCode(post.data.toString('utf8'), { lang: verifyLang, filename: f.name });

        if (!picked || verification.status === 'verified' || binaryOutput) {
          picked = { name: f.name, data: post.data, post, verification, binaryOutput, path: f.path };
          if (verification.status === 'verified') stage('verify', verification.detail);
          else stage('verify', `${verification.status} — ${verification.detail}`);
          if (i > 0 && (verification.status === 'verified' || binaryOutput)) {
            stage('accuracy:pick', `candidate ${i + 1}/${candidateCount} (${f.name}) parses — promoted over the first`);
          }
          if (verification.status === 'verified' || binaryOutput) break;
        }
      }

      if (!picked) {
        // Every candidate was a passthrough echo — try the dynamic harvester.
        stage('passthrough-guard', 'all engine outputs identical to input');
        const h = await tryHarvest(inputPath, detected, lang, stage, stages, t0, buffer, filename);
        if (h) return h;
        return {
          ok: false,
          detected, stages, durationMs: Date.now() - t0, lang,
          note: 'The sample was recognized, but this build keeps its constant pool behind runtime keys (anti-tamper) that are not recoverable statically — no code could be lifted.',
          originalSize: buffer.length,
        };
      }

      const best = { name: picked.name, path: picked.path };
      const data = picked.data;
      const binaryOutput = picked.binaryOutput;
      if (picked.post.passes.length) stage('post-process', picked.post.passes.join(', '));

      // Output consumed — reap the engine workdir and temp artifacts.
      if (outcome.workDir) await engine.cleanupWorkDir(outcome.workDir);
      if (!binaryOutput) { try { await fsp.rm(best.path, { force: true }); } catch { /* tmp */ } }

      return {
        ok: true,
        code: binaryOutput ? '' : data.toString('utf8'),
        binaryOutput,
        outputBuffer: binaryOutput ? data : null,
        codeName: best.name,
        detected, stages, durationMs, lang,
        verification: picked.verification,
        originalSize: buffer.length,
        recoveredSize: data.length,
        how: outcome.how || 'engine',
        engine: await engine.probe(),
      };
    } finally {
      try { await fsp.rm(inDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
}

function pickRoute(detected, lang, buffer) {
  if (detected.id === 'pyarmor') return 'pyarmor';
  if (detected.id === 'upx' || detected.id === 'native_generic') return 'auto';
  if (detected.id === 'obfuscator_io' || detected.id === 'js_generic') return 'webcrack';
  if (ENGINE_FAMILY_BY_DETECT_ID[detected.id]) return 'lua-engine';
  if (lang === 'lua') return 'lua-engine'; // includes best-effort VM families → engine auto + sweep
  if (lang === 'js' || looksLikeJs(buffer)) return 'webcrack';
  return 'auto';
}

// ---- dynamic constant harvest (last tier) -------------------------------------
// Applies to Lua VM families (incl. the newest escrow/anti-tamper builds) and
// unknown Lua samples: run the VM init inside the jailed fengari sandbox and
// capture the decrypted string pool.
const HARVEST_ELIGIBLE = new Set([
  'luraph', 'moonsec_v1', 'moonsec_v2', 'moonsec_v3', 'ironbrew1', 'ironbrew2', 'ironbrew3',
  'psu', 'boronide', 'darksec', 'luaobfuscator_com', 'wearedevs', 'slua', 'moonveil',
  '77fuscator', 'xhider', 'goofyscator', 'ironveil', '25ms', 'synapsexen', 'wynfuscate',
  'unknown',
]);

async function tryHarvest(inputPath, detected, lang, stage, stages, t0, inBuffer, filename) {
  const eligible = (lang === 'lua' && HARVEST_ELIGIBLE.has(detected.id)) || lang === 'unknown';
  if (!eligible) return null;
  stage('harvest', 'jailed VM run — dynamic constant recovery');
  let h;
  try {
    h = await harvestConstants(inputPath, { timeoutMs: Math.min(CONFIG.engineTimeoutMs, 120_000) });
  } catch (e) {
    stage('harvest:miss', String(e.message || e).slice(0, 120));
    return null;
  }
  if (!h.ok || (h.strings || []).length < 3) {
    stage('harvest:miss', h.error || `only ${(h.strings || []).length} strings`);
    return null;
  }
  stage('harvest:hit', `${h.strings.length} strings decrypted${h.ran ? '' : ' (VM init incomplete)'}`);
  const luaText = harvestToLua(h, { detectedName: detected.name, version: detected.version });
  let data = Buffer.from(luaText, 'utf8');
  const post = postprocessFile('constants.lua', data);
  data = post.data;
  const verification = verifyCode(data.toString('utf8'), { lang: 'lua', filename: 'recovered-constants.lua' });
  return {
    ok: true,
    code: data.toString('utf8'),
    binaryOutput: false,
    outputBuffer: null,
    codeName: 'recovered-constants.lua',
    detected,
    stages,
    durationMs: Date.now() - t0,
    lang,
    verification,
    originalSize: inBuffer.length,
    recoveredSize: data.length,
    how: 'dynamic constant harvest (sandboxed VM)',
    partialNote: `This build keeps its bytecode behind runtime keys — I recovered the **decrypted string constant pool** (${h.strings.length} strings) via a jailed sandboxed VM run. Static devirtualization of this build is on the roadmap.`,
    engine: await engine.probe(),
  };
}

const ENGINE_FAMILY_BY_DETECT_ID = {
  luraph: 'luraph',
  moonsec_v3: 'moonsec-v3',
  moonsec_v2: 'moonsec-v2',
  moonsec_v1: 'moonsec-v1',
  ironbrew2: 'ironbrew2',
  ironbrew1: 'aztup-brew',
  prometheus: 'prometheus',
  hercules: 'hercules',
  psu: 'psu',
  boronide: 'boronide',
  darksec: 'dark-sec',
  luaobfuscator_com: 'luaobfuscator-com',
  wearedevs: 'wearedevs',
  slua: 'slua',
};

function isEngineLuaFamily(id) {
  return Boolean(ENGINE_FAMILY_BY_DETECT_ID[id]);
}

function looksLikeJs(buffer) {
  const head = buffer.subarray(0, 4096).toString('utf8').replace(/\0/g, '');
  // Bare `function` also exists in Lua — require JS-only signals.
  return /\b(?:const|let|var)\b|=>|\beval\b|_0x[0-9a-f]{4}/.test(head) && /[{};]/.test(head);
}

// ---- engine marker shim -----------------------------------------------------
// Canonical markers the Rust engine's family detectors grep for. Some
// obfuscator builds emit their banner in a different shape (e.g. MoonSec V3's
// `([[This file was protected with MoonSec V3]])` vs the engine's
// `--[[ MoonSec V3 ]]`); the shim bridges the gap using OUR detection.
function engineMarkerShim(buffer, detectedId) {
  const shims = {
    moonsec_v3: { marker: '--[[ MoonSec V3 ]]', line: '--[[ MoonSec V3 ]]\n' },
    moonsec_v2: { marker: '--[[ MoonSec V2 ]]', line: '--[[ MoonSec V2 ]]\n' },
    moonsec_v1: { marker: '--[[ MoonSec V1 ]]', line: '--[[ MoonSec V1 ]]\n' },
  };
  const shim = shims[detectedId];
  if (shim && !buffer.includes(shim.marker)) {
    return { buffer: Buffer.concat([Buffer.from(shim.line), buffer]), shimLine: shim.line };
  }
  return { buffer, shimLine: null };
}

function isPassthrough(outData, inBuffer, shimLine, detectedId) {
  try {
    if (outData.equals(inBuffer)) return true;
    if (shimLine) {
      const stripped = outData.subarray(Buffer.byteLength(shimLine));
      if (stripped.equals(inBuffer)) return true;
    }
    // Still-obfuscated stub checks for families whose "extraction" can yield
    // the original wrapper (e.g. archives). The _0x flood alone is NOT enough:
    // a successfully deobfuscated file can still carry leftover hex parameter
    // names, so require the output to be near input-sized (real deobf output
    // shrinks dramatically once the string array + control flow are undone).
    const head4k = outData.subarray(0, 4096).toString('utf8');
    if (detectedId === 'pyarmor' && /__pyarmor__|pyarmor_runtime|Pyarmor\s+\d/i.test(head4k)) return true;
    if (detectedId === 'obfuscator_io') {
      const flood = (head4k.match(/_0x[0-9a-f]{4,}/g) || []).length;
      if (flood >= 30 && outData.length >= inBuffer.length * 0.9) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---- routes -----------------------------------------------------------------
async function runLuaEngineRoute(inputPath, detected, stage) {
  const fam = ENGINE_FAMILY_BY_DETECT_ID[detected.id];
  if (fam) {
    stage('lua-peel', `targeted family ${fam}`);
    const a = await engine.luaPeel(inputPath, fam);
    if (a.ok) return { ...a, how: `lua peel (${fam})` };
    stage('lua-peel:miss', `exit ${a.exitCode}`);
  }
  stage('auto', 'engine auto pipeline (depth 6)');
  const b = await engine.autoRun(inputPath, { maxDepth: 6 });
  if (b.ok) return { ...b, how: 'engine auto' };
  if (b.workDir) await engine.cleanupWorkDir(b.workDir);
  stage('sweep', 'all engine lua families');
  for (const f of engine.ENGINE_LUA_FAMILIES) {
    if (f === fam) continue;
    const c = await engine.luaPeel(inputPath, f);
    if (c.ok) { stage('sweep:hit', f); return { ...c, how: `lua sweep (${f})` }; }
  }
  return { ok: false, note: familyWallNote(detected) };
}

async function runAutoRoute(inputPath, _detected, stage) {
  stage('auto', 'engine auto pipeline (depth 6, packer chains included)');
  const b = await engine.autoRun(inputPath, { maxDepth: 6 });
  if (b.ok) return { ...b, how: 'engine auto' };
  if (b.workDir) await engine.cleanupWorkDir(b.workDir);
  stage('sweep', 'all engine lua families');
  for (const f of engine.ENGINE_LUA_FAMILIES) {
    const c = await engine.luaPeel(inputPath, f);
    if (c.ok) { stage('sweep:hit', f); return { ...c, how: `lua sweep (${f})` }; }
  }
  return { ok: false, note: 'The engine auto pipeline (packer chains included) recovered nothing from this sample.' };
}

// Family-specific honest-wall notes for the newest-generation VM obfuscators.
const FAMILY_WALL_NOTES = {
  moonveil: 'MoonVeil 2.x is a full VM obfuscator — the original code is not present in the file at all. Detection is reliable; static recovery of the VM bytecode is not possible yet (roadmap: dynamic capture).',
  '77fuscator': '77fuscator 0.6.x ships a custom VM with control-flow flattening and encrypted constants. Detection is reliable; the current build is not statically devirtualizable yet.',
  goofyscator: 'GoofyScator uses a polymorphic VM with proxy-locals and anti-tamper. Detection is reliable; static recovery of the current build is not possible yet.',
  ironveil: 'Ironveil is VM-based in current builds. Detection is reliable; static recovery is not possible yet.',
  xhider: 'Xhider wraps code in a MoonSec-style VM. Detection is reliable; the current build is not statically devirtualizable yet.',
  '25ms': '25ms-branded builds route through VM obfuscators (often Luraph-family). This sample hit a VM wall — no static recovery path found.',
  moonsec_v3: 'This MoonSec V3 build derives its constant-pool keys at runtime (escrow/anti-tamper). Static-key V3 builds recover fully; this one cannot be lifted statically.',
  moonsec_v2: 'This MoonSec V2 build derives its keys at runtime (escrow mode). Older static-key V2 builds recover fully; this one cannot be lifted statically.',
};

function familyWallNote(detected) {
  return FAMILY_WALL_NOTES[detected?.id]
    || 'The engine could not peel this sample with any known strategy — it may use an unsupported scheme or encrypted bytecode beyond static recovery.';
}

async function runPyarmorRoute(inputPath, detected, stage, buffer) {
  stage('pyarmor-unpack', 'static unpack (v6/v7 hook + v8/v9-pro)');
  const a = await engine.pyarmorUnpack(inputPath);
  if (a.ok) return { ...a, how: 'pyarmor static unpack' };
  stage('pyarmor:miss', `exit ${a.exitCode} — trying archive layout chain`);

  // v8/v9 ship pyarmor_runtime_* as a sibling directory — the unpack needs
  // that layout, so extract the user's archive and re-unpack each entry .py.
  if (buffer && buffer.subarray(0, 4).toString('latin1') === 'PK\x03\x04') {
    const b = await engine.autoRun(inputPath, { maxDepth: 3 });
    const entries = (b.all || [])
      .filter((f) => f.name.toLowerCase().endsWith('.py') && f.size > 0 && f.size < 2 * 1024 * 1024)
      .sort((x, y) => x.name.split('/').length - y.name.split('/').length)
      .slice(0, 5);
    for (const entry of entries) {
      const u = await engine.pyarmorUnpack(entry.path);
      if (u.ok) {
        stage('pyarmor-extract:hit', entry.name);
        if (b.workDir) await engine.cleanupWorkDir(b.workDir);
        // Reconstructed .pyc → try full source decompile; else deliver the
        // honest disasm fallback the engine emits.
        const pyc = u.files.find((f) => f.name.toLowerCase().endsWith('.pyc'));
        if (pyc) {
          const d = await engine.pyDecompile(pyc.path);
          const best = d.files[0];
          if (best) {
            const buf = await engine.readCodeFile(best);
            const isRefused = buf.subarray(0, 4096).toString('utf8').includes('# decompile-error');
            stage(isRefused ? 'py-decompile:disasm' : 'py-decompile', best.name);
            if (d.workDir) await engine.cleanupWorkDir(d.workDir);
            if (u.workDir) await engine.cleanupWorkDir(u.workDir);
            return {
              ok: true,
              // bytes already read — workdirs are reaped, so carry the buffer
              files: [{ name: best.name, path: best.path, size: best.size, buffer: buf }],
              how: isRefused ? 'pyarmor unpack + disasm fallback (source recovery refused placeholders)' : 'pyarmor unpack + pyc decompile',
            };
          }
          if (d.workDir) await engine.cleanupWorkDir(d.workDir);
        }
        if (u.workDir) await engine.cleanupWorkDir(u.workDir);
        return { ...u, how: 'pyarmor static unpack (bytecode)' };
      }
    }
    if (b.workDir) await engine.cleanupWorkDir(b.workDir);
  }

  return { ok: false, note: 'pyArmor unpack failed — v8/v9 builds ship a `pyarmor_runtime_*` folder that must be next to the script. Zip the WHOLE obfuscator output (script + runtime folder) and upload the zip.' };
}

async function webcrackRun(inputPath) {
  const outPath = path.join(os.tmpdir(), `bxbot-wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`);
  const workerPath = new URL('./webcrack-worker.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const r = await spawnHardened(process.execPath, [workerPath, inputPath, outPath], {
    timeoutMs: 160_000,
    label: 'webcrack',
    maxBuffer: 8 * 1024 * 1024,
  });
  const st = await fsp.stat(outPath).catch(() => null);
  if (r.code === 0 && st && st.size > 0) {
    // Keep the temp file alive until readCodeFile() consumes it; the OS tmp
    // reaper (and run cleanup) handles the remainder.
    return { ok: true, files: [{ name: 'deobfuscated.js', path: outPath, size: st.size }], how: 'webcrack' };
  }
  return { ok: false, note: 'webcrack could not process this JavaScript.' };
}

async function runWebcrackRoute(inputPath, buffer, stage) {
  stage('webcrack', 'obfuscator.io / unminify / bundle unpack');
  const a = await webcrackRun(inputPath);
  if (a.ok) return a;
  stage('webcrack:miss', 'trying engine auto (JS pass)');
  const b = await engine.autoRun(inputPath, { maxDepth: 6 });
  if (b.ok) return { ...b, how: 'engine auto (JS)' };
  return { ok: false, note: a.note };
}
