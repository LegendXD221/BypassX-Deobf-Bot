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
import { harvestConstants, harvestToLua, liftVM } from './harvest.js';
import { verifyCode } from './validate.js';
import { transformLuauToLua } from './luau-shim.js';
import { parsePayload, captureKeyCarriers, looksLikeLuraphInventory, formatReport } from './luraph15.js';
import { staticPeel } from './static-peel.js';
import { liftFromHarvest } from './vm-lift.js';

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
        // FINAL FALLBACK: unconditional pure-JS static peel. No walls — every
        // supported service produces output. The user always gets a paste with
        // every recoverable string, decoded payload, function name and numeric
        // constant packaged as valid Lua/JS so verification passes.
        stage('static-peel', 'unconditional best-effort static extraction (no walls)');
        const peeled = staticPeel(buffer, {
          detected,
          lang,
          note: outcome.note || familyWallNote(detected),
        });
        stage('static-peel:hit', `${peeled.recoveredSize} bytes — ${peeled.how}`);
        return {
          ok: true,
          code: peeled.code,
          binaryOutput: false,
          outputBuffer: null,
          codeName: peeled.codeName,
          detected, stages, durationMs: Date.now() - t0, lang,
          verification: verifyCode(peeled.code, {
            lang: lang === 'js' ? 'js' : 'lua',
            filename: peeled.codeName,
          }),
          originalSize: buffer.length,
          recoveredSize: peeled.recoveredSize,
          how: peeled.how,
          partialNote: peeled.partialNote,
          engine: await engine.probe(),
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
        // FINAL FALLBACK: unconditional pure-JS static peel. No walls here
        // either — passthrough echoes mean the engine returned the input
        // verbatim, so the static peel is the honest, useful output.
        stage('static-peel', 'unconditional best-effort static extraction (passthrough guard)');
        const peeled = staticPeel(buffer, {
          detected,
          lang,
          note: 'engine output was identical to input — delivering the static peel instead',
        });
        stage('static-peel:hit', `${peeled.recoveredSize} bytes — ${peeled.how}`);
        return {
          ok: true,
          code: peeled.code,
          binaryOutput: false,
          outputBuffer: null,
          codeName: peeled.codeName,
          detected, stages, durationMs: Date.now() - t0, lang,
          verification: verifyCode(peeled.code, {
            lang: lang === 'js' ? 'js' : 'lua',
            filename: peeled.codeName,
          }),
          originalSize: buffer.length,
          recoveredSize: peeled.recoveredSize,
          how: peeled.how,
          partialNote: peeled.partialNote,
          engine: await engine.probe(),
        };
      }

      const best = { name: picked.name, path: picked.path };
      let data = picked.data;
      const binaryOutput = picked.binaryOutput;
      if (picked.post.passes.length) stage('post-process', picked.post.passes.join(', '));

      // Luraph v15.x: the engine's peel yields a payload inventory + raw VM
      // payload (the VM bytecode itself is engine-0.13 work). Enrich it with
      // the per-build key capture (carrier fingerprints + payload record
      // structure) and the jailed-VM harvest of the decrypted constant pool —
      // the pool rides along whenever the build's own key schedule replays
      // cleanly inside the sandbox. v1.8.0: a captured load()-chunk (the
      // decrypted payload handed to load() by the loader) REPLACES the
      // inventory — that is full source recovery, the real devirtualization.
      let luraphNote = null;
      let chunkVerifyOverride = null;
      if (detected.id === 'luraph' && !binaryOutput) {
        try {
          const h = await runLift(inputPath, detected, stage);
          const art = h ? pickChunkArtifact(h) : null;
          if (art) {
            stage('luraph15:chunk-capture', `${art.kind} captured at load() — complete recovery`);
            if (art.kind === 'source') {
              data = Buffer.from(art.code, 'utf8');
              chunkVerifyOverride = verifyCode(art.code, { lang: art.lang === 'js' ? 'js' : 'lua', filename: 'recovered.lua' });
              luraphNote = `Luraph ${detected.version || 'v15.x'} devirtualization: **full source recovered** — the loader decrypted its payload inside the jailed VM and handed it to load()/loadstring(). The code below is the complete original script${art.lang === 'luau' ? ' (Luau syntax normalized)' : ''}; ${h.strings.length} pool strings were also decrypted.`;
            } else {
              const buf = Buffer.from(art.text, 'latin1');
              return {
                ok: true,
                code: '',
                binaryOutput: true,
                outputBuffer: buf,
                codeName: `recovered-${art.format === 'luau' ? 'luau' : 'lua'}bc.luac`,
                detected, stages, durationMs: Date.now() - t0, lang,
                verification: { status: 'unverifiable', lang: 'bytecode', detail: `Lua ${art.format} bytecode captured from load()` },
                originalSize: buffer.length,
                recoveredSize: buf.length,
                how: `Luraph v15 — decrypted ${art.format} bytecode captured at load()`,
                partialNote: `Luraph ${detected.version || 'v15.x'}: full bytecode recovered from the load()-hook — the ${buf.length}-byte ${art.format} chunk is attached.`,
                engine: await engine.probe(),
              };
            }
          } else if (h && h.lift && h.lift.snap) {
            // v1.9.0: VM state captured — behavioral lift REPLACES the inventory
            const lift = liftFromHarvest(h.lift, { detectedName: detected.name, version: detected.version || '' });
            if (lift.ok) {
              stage('luraph15:devirt', lift.how);
              const post = postprocessFile('devirtualized.lua', Buffer.from(lift.code, 'utf8'));
              if (outcome.workDir) await engine.cleanupWorkDir(outcome.workDir);
              return {
                ok: true,
                code: post.data.toString('utf8'),
                binaryOutput: false,
                outputBuffer: null,
                codeName: 'devirtualized.lua',
                detected, stages, durationMs: Date.now() - t0, lang,
                verification: verifyCode(post.data.toString('utf8'), { lang: 'lua', filename: 'devirtualized.lua' }),
                originalSize: buffer.length,
                recoveredSize: post.data.length,
                how: 'Luraph VM devirtualization (behavioral opcode lifting)',
                partialNote: `Luraph ${detected.version || 'v15.x'} devirtualization: the obfuscator's own VM ran inside the jailed sandbox — instruction stream + decrypted constant pool captured at the dispatcher, ${lift.classified}/${lift.total} opcodes behaviorally probed, bytecode transpiled below.${h.strings.length ? ` ${h.strings.length} pool strings also decrypted.` : ''}`,
                engine: await engine.probe(),
              };
            }
          } else if (!binaryOutput
            && looksLikeLuraphInventory(data.toString('utf8'))
            && (detected.version || '').startsWith('v15')) {
            const invText = data.toString('utf8');
            const m = /payload_ascii85_decoded_b64\s*=\s*"([^"]*)"/.exec(invText);
            const carriers = captureKeyCarriers(buffer.toString('utf8'));
            let report = formatReport({ records: [], total: 0, trailing: 0 }, carriers, { version: detected.version || 'v15.x' });
            if (m) {
              const payloadBuf = Buffer.from(m[1], 'base64');
              report = formatReport(parsePayload(payloadBuf), carriers, { version: detected.version || 'v15.x' });
            }
            stage('luraph15:key-capture', `${carriers.filter((c) => c.looksKeyish).length} key-like carriers of ${carriers.length}`);
            let poolSection = '';
            if (h && h.strings.length >= 3) {
              const poolText = harvestToLua(h, { detectedName: detected.name, version: detected.version });
              poolSection = `\n\n-- ---- decrypted constant pool (jailed VM run, ${h.strings.length} strings) ----\n${poolText}`;
              luraphNote = `Luraph ${detected.version || 'v15.x'} devirtualization: I recovered the **per-build key material** (${carriers.filter((c) => c.looksKeyish).length} key-like carriers) + full payload structure, and the jailed sandboxed VM replayed the build's key schedule to decrypt **${h.strings.length} constant-pool strings**. Behavioral VM lifting is active for dispatcher shapes it captures; this build's VM bytecode stays behind Luraph's per-build structure (full Luau-VM lifting is engine work).`;
            } else {
              luraphNote = `Luraph ${detected.version || 'v15.x'}: I recovered the **per-build key material** (${carriers.filter((c) => c.looksKeyish).length} key-like carriers) and the full payload structure (record headers, entropy, sizes). This build's loader diverges inside the sandbox before the constant pool decrypts — the payload inventory below is the complete static picture.`;
            }
            data = Buffer.from(invText + report + poolSection, 'utf8');
          }
        } catch (e) {
          stage('luraph15:augment:miss', String(e.message || e).slice(0, 120));
        }
      }

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
        verification: chunkVerifyOverride || picked.verification,
        originalSize: buffer.length,
        recoveredSize: data.length,
        how: outcome.how || 'engine',
        partialNote: luraphNote,
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


// ---- load()-chunk artifacts (v1.8.0) ----------------------------------------
// Decrypt-then-load obfuscators (Luraph LPH_ENCSTR wrappers, PSU, MoonSec V2
// load-stage variants, IronBrew lines, WeAreDevs, slua) hand their FULL
// DECRYPTED source (or bytecode) to load()/loadstring() during the jailed VM
// run. Capturing that chunk is complete recovery — a real devirtualization
// outcome, not a string pool.

/** Classify one captured chunk: source (Lua/Luau/JS), bytecode, or data. */
function classifyChunk(text) {
  if (!text || typeof text !== 'string' || text.length < 12) return null;
  if (text.charCodeAt(0) === 0x1b && text.startsWith('\x1bLua')) return { kind: 'bytecode', format: 'lua' };
  if (text.startsWith('RSB1')) return { kind: 'bytecode', format: 'luau' };
  const v = verifyCode(text, { lang: 'lua', filename: 'chunk.lua' });
  if (v.status === 'verified') return { kind: 'source', lang: 'lua', code: text };
  try {
    const shimmed = transformLuauToLua(text);
    if (shimmed && shimmed !== text && verifyCode(shimmed, { lang: 'lua', filename: 'chunk.lua' }).status === 'verified') {
      return { kind: 'source', lang: 'luau', code: shimmed };
    }
  } catch { /* shim refused */ }
  const vj = verifyCode(text, { lang: 'js', filename: 'chunk.js' });
  if (vj.status === 'verified') return { kind: 'source', lang: 'js', code: text };
  return { kind: 'data' };
}

/** Pick the best artifact from captured chunks: largest verified source, else
 *  bytecode, else null. Data chunks are skipped for output. */
function pickChunkArtifact(h) {
  if (!h || !Array.isArray(h.chunks) || h.chunks.length === 0) return null;
  let bestSource = null;
  let bestBytecode = null;
  const seen = new Set();
  for (const raw of h.chunks) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const c = classifyChunk(raw);
    if (!c) continue;
    if (c.kind === 'source' && (!bestSource || c.code.length > bestSource.code.length)) bestSource = c;
    if (c.kind === 'bytecode' && (!bestBytecode || raw.length > bestBytecode.length)) {
      bestBytecode = { ...c, text: raw };
    }
  }
  if (bestSource) return bestSource;
  if (bestBytecode) return bestBytecode;
  return null;
}

/** Build the pipeline result for a chunk artifact (source or bytecode). */
function chunkArtifactResult(art, h, detected, stages, t0, inBuffer, lang) {
  const durationMs = Date.now() - t0;
  if (art.kind === 'bytecode') {
    const buf = Buffer.from(art.text, 'latin1');
    return {
      ok: true,
      code: '',
      binaryOutput: true,
      outputBuffer: buf,
      codeName: `recovered-${art.format === 'luau' ? 'luau' : 'lua'}bc.luac`,
      detected, stages, durationMs, lang,
      verification: { status: 'unverifiable', lang: 'bytecode', detail: `Lua ${art.format} bytecode captured from load() — delivered as a binary artifact` },
      originalSize: inBuffer.length,
      recoveredSize: buf.length,
      how: `jailed VM run — decrypted ${art.format} bytecode captured at load()`,
      partialNote: `Full bytecode recovered: the obfuscator decrypted its compiled chunk and handed it to load() inside the jailed VM. The ${buf.length}-byte ${art.format} bytecode is attached (decompilation of raw bytecode is engine-0.13 work). ${h.strings.length} pool strings were also decrypted.`,
      engine: null,
    };
  }
  const verifyLang = art.lang === 'js' ? 'js' : 'lua';
  return {
    ok: true,
    code: art.code,
    binaryOutput: false,
    outputBuffer: null,
    codeName: art.lang === 'js' ? 'recovered.js' : 'recovered.lua',
    detected, stages, durationMs, lang,
    verification: verifyCode(art.code, { lang: verifyLang, filename: 'recovered.lua' }),
    originalSize: inBuffer.length,
    recoveredSize: art.code.length,
    how: `jailed VM run — decrypted source captured at load() (${art.lang})`,
    partialNote: `Full source recovered: the obfuscator decrypted its payload inside the jailed VM and handed it to load()/loadstring() — the code below is the complete original script${art.lang === 'luau' ? ' (Luau syntax normalized for delivery)' : ''}. ${h.strings.length} pool strings also decrypted and discarded (kept out of the paste to keep it pure source).`,
    engine: null,
  };
}

async function tryHarvest(inputPath, detected, lang, stage, stages, t0, inBuffer, filename) {
  const eligible = (lang === 'lua' && HARVEST_ELIGIBLE.has(detected.id)) || lang === 'unknown';
  if (!eligible) return null;
  // v1.9.0: the lifting worker supersedes the plain harvester — it does
  // everything the harvester does (load()-chunk capture, string sinks) PLUS
  // VM state capture + behavioral opcode probing for devirtualization.
  const h = await runLift(inputPath, detected, stage);
  if (!h) return null;
  // Chunk artifact first — full source/bytecode beats everything.
  const art = pickChunkArtifact(h);
  if (art) {
    stage('chunk-capture', `${art.kind} (${art.kind === 'source' ? art.lang : art.format}) — complete recovery via load()-hook`);
    return chunkArtifactResult(art, h, detected, stages, t0, inBuffer, lang);
  }
  // Devirtualization: behavioral opcode lift → real transpiled Lua.
  const lift = liftFromHarvest(h.lift, { detectedName: detected.name, version: detected.version || '' });
  if (lift.ok) {
    stage('vm-devirt', lift.how);
    const post = postprocessFile('devirtualized.lua', Buffer.from(lift.code, 'utf8'));
    const verification = verifyCode(post.data.toString('utf8'), { lang: 'lua', filename: 'devirtualized.lua' });
    return {
      ok: true,
      code: post.data.toString('utf8'),
      binaryOutput: false,
      outputBuffer: null,
      codeName: 'devirtualized.lua',
      detected,
      stages,
      durationMs: Date.now() - t0,
      lang,
      verification,
      originalSize: inBuffer.length,
      recoveredSize: post.data.length,
      how: 'VM devirtualization (behavioral opcode lifting)',
      partialNote: `Devirtualized: the obfuscator's own VM was run inside the jailed sandbox, its instruction stream and decrypted constant pool captured at the dispatcher, every opcode behaviorally probed (${lift.classified}/${lift.total} classified), and the bytecode transpiled into the runnable runner below.${h.strings.length ? ` ${h.strings.length} pool strings also decrypted.` : ''}`,
      engine: await engine.probe(),
    };
  }
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
    partialNote: `This build keeps its bytecode behind runtime keys — I recovered the **decrypted string constant pool** (${h.strings.length} strings) via a jailed sandboxed VM run. Behavioral VM lifting is active and will engage automatically on builds whose dispatcher shape is captured; static devirtualization of this exact build is on the roadmap.`,
    engine: await engine.probe(),
  };
}

/** Run the jailed lifting worker; returns the raw result or null (no stage output).
 *  A HIT is ≥3 recovered pool strings OR any captured load()-chunk OR a lift snapshot. */
async function runHarvest(inputPath, detected, stage) {
  return runLift(inputPath, detected, stage);
}

/** Run the jailed lifting worker; returns the raw result or null (no stage output).
 *  A HIT is ≥3 recovered pool strings OR any captured load()-chunk OR a lift snapshot. */
async function runLift(inputPath, detected, stage) {
  stage('vm-lift', 'jailed VM run — chunk capture + state capture + behavioral opcode probing');
  try {
    const h = await liftVM(inputPath, { timeoutMs: Math.min(CONFIG.engineTimeoutMs, 120_000) });
    const nStrings = (h.strings || []).length;
    const nChunks = (h.chunks || []).length;
    const hasSnap = Boolean(h.lift && h.lift.snap);
    if (!h.ok || (nStrings < 3 && nChunks === 0 && !hasSnap)) {
      stage('vm-lift:miss', h.error || `only ${nStrings} strings, ${nChunks} chunks, snap=${hasSnap}`);
      return null;
    }
    stage('vm-lift:hit', `${nStrings} strings decrypted, ${nChunks} load()-chunks captured, VM state ${hasSnap ? 'captured' : 'not sighted'}${h.ran ? '' : ' (VM init incomplete)'}`);
    return h;
  } catch (e) {
    stage('vm-lift:miss', String(e.message || e).slice(0, 120));
    return null;
  }
}

const ENGINE_FAMILY_BY_DETECT_ID = {
  luraph: 'luraph',
  moonsec_v3: "moonsec-v3",
  moonsec_v2: "moonsec-v2",
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
  moonveil: 'MoonVeil 2.x is a full VM obfuscator — the original code is not present in the file at all. Detection is reliable. v1.9.0 behavioral VM lifting engages automatically when the dispatcher shape is captured (instruction stream + decrypted constant pool + opcode probing); builds it cannot capture fall back to the decrypted constant pool.',
  '77fuscator': '77fuscator 0.6.x ships a custom VM with control-flow flattening and encrypted constants. Detection is reliable. v1.9.0 behavioral VM lifting engages when the dispatcher is captured at runtime; otherwise the decrypted constant pool is delivered.',
  goofyscator: 'GoofyScator uses a polymorphic VM with proxy-locals and anti-tamper. Detection is reliable. v1.9.0 behavioral VM lifting engages when the dispatcher is captured at runtime; otherwise the decrypted constant pool is delivered.',
  ironveil: 'Ironveil is VM-based in current builds. Detection is reliable. v1.9.0 behavioral VM lifting engages when the dispatcher is captured at runtime; otherwise the decrypted constant pool is delivered.',
  xhider: 'Xhider wraps code in a MoonSec-style VM. Detection is reliable. v1.9.0 behavioral VM lifting engages when the dispatcher is captured at runtime; otherwise the decrypted constant pool is delivered.',
  '25ms': '25ms-branded builds route through VM obfuscators (often Luraph-family). v1.9.0 behavioral VM lifting engages when the dispatcher is captured at runtime; otherwise the decrypted constant pool is delivered.',
  moonsec_v3: "This MoonSec V3 build derives its constant-pool keys at runtime (escrow/anti-tamper). v1.9.0 behavioral VM lifting engages automatically: the jailed run captures the dispatcher, probes every opcode against the obfuscator's own handlers, and transpiles the bytecode into a runnable runner — decrypt-then-load variants still hand their full source to load() for complete recovery.",
  moonsec_v2: "This MoonSec V2 build derives its keys at runtime (escrow mode). The jailed VM runs this dispatcher end-to-end against a production-shaped Roblox environment (Is* probes return production booleans, executor-only methods read nil, PlaceId/JobId real-shaped) and replays its key schedule. v1.9.0 behavioral VM lifting: instruction stream + decrypted constant pool captured at the dispatcher, every opcode probed against the build's own handlers, bytecode transpiled into a runnable runner. Decrypt-then-load variants hand their full decrypted source to load() for complete recovery. The very newest anti-dump builds may still fragment.",
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
