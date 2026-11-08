/**
 * BypassX Deobf Bot — multi-layer obfuscation analysis (v2.4.0).
 *
 * Two questions, asked at different times in the pipeline:
 *
 *  1. detectLayers(buffer)    — BEFORE peeling: which obfuscator families are
 *     stacked inside this file? Banner co-occurrence (e.g. Luraph macros AND a
 *     MoonSec V3 header in one file) plus wrapper-generation counting
 *     (decrypt-then-load generations). Drives the "multi-layer" report.
 *
 *  2. residualObfuscation()   — AFTER each peel: does this text still look
 *     obfuscated by ANY scheme — family banners, VM dispatchers, string-array
 *     floods, encoded blobs, machine identifiers, keyword starvation? Drives
 *     the pipeline's peel loop (peel again until plain code or no progress).
 *
 * Both are pure functions over text. Never throw. Tuned to keep honest
 * hand-written code on the "not obfuscated" side (ground truth: `print("x")`
 * scores 0) while every real obfuscator family we support trips ≥1 strong or
 * ≥2 medium signals.
 */

import { detectService } from './detect.js';

// ---- helpers -----------------------------------------------------------------

function countRe(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function perKb(n, bytes) {
  return (n * 1024) / Math.max(1, bytes);
}

const MACHINE_ID_RE = /\b(?:_0x[0-9a-fA-F]{3,}|[vVwWlLoOuU]_?\d{1,4}(?:_\d{1,4})?|[lI1]{4,}[oO0]?)\b/g;
const DECIMAL_ESCAPE_RE = /\\[0-9]{1,3}/g;
const HEX_ESCAPE_RE = /\\x[0-9a-fA-F]{2}/g;
const B64_BLOB_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;
const NUMERIC_TOKEN_RE = /\b\d{2,}\b/g;

const LUA_KEYWORDS_RE = /\b(?:local|function|end|if|then|else|elseif|for|while|do|return|repeat|until)\b/g;
const JS_KEYWORDS_RE = /\b(?:function|var|let|const|return|if|else|for|while|class)\b/g;

const BYTECODE_MAGIC_RE = /\x1bLua|^RSB1/;

// ---- residual obfuscation ----------------------------------------------------

/**
 * Score how obfuscated a piece of (recovered) code still looks.
 * @param {string} text recovered code
 * @param {string} lang 'lua' | 'js' | 'unknown'
 * @returns {{ obfuscated:boolean, confidence:number, signals:Array<{label:string,weight:number}>, residualFamily: {id,name,version,confidence}|null }}
 */
export function residualObfuscation(text, lang = 'lua') {
  const signals = [];
  let score = 0;
  const bytes = text.length;
  const lines = text.split('\n');
  const codeLines = lines.filter((l) => l.trim().length > 0);
  const nonEmpty = Math.max(1, codeLines.length);

  // 1. Giant-line ratio — obfuscator output lives on a few enormous lines.
  const giant = codeLines.filter((l) => l.length > 1000).length;
  const longest = codeLines.reduce((m, l) => Math.max(m, l.length), 0);
  if (nonEmpty <= 3 && bytes > 2048) {
    signals.push({ label: `one-liner payload (${nonEmpty} lines, ${bytes} B)`, weight: 25 });
    score += 25;
  } else if (giant / nonEmpty > 0.3 && giant >= 2) {
    signals.push({ label: `${giant} giant lines (>1000 chars)`, weight: 22 });
    score += 22;
  } else if (longest > 4000) {
    signals.push({ label: `longest line ${longest} chars`, weight: 10 });
    score += 10;
  }

  // 2. Escape floods — decimal/hex string escapes are the classic string-hiding layer.
  const decEsc = countRe(text, DECIMAL_ESCAPE_RE);
  const hexEsc = countRe(text, HEX_ESCAPE_RE);
  const escTotal = decEsc + hexEsc;
  if (perKb(escTotal, bytes) > 30 && escTotal > 100) {
    signals.push({ label: `string-escape flood (${escTotal} escapes)`, weight: 25 });
    score += 25;
  } else if (escTotal > 60) {
    signals.push({ label: `heavy string escaping (${escTotal} escapes)`, weight: 12 });
    score += 12;
  }

  // 3. Base64/hex blobs.
  const blobs = text.match(B64_BLOB_RE) || [];
  const blobBytes = blobs.reduce((s, b) => s + b.length, 0);
  if (blobBytes > bytes * 0.25 && blobBytes > 512) {
    signals.push({ label: `encoded payload blobs (${(blobBytes / 1024).toFixed(1)} KB base64-shaped)`, weight: 22 });
    score += 22;
  }

  // 4. Numeric flood — VM bytecode delivered as number arrays.
  const nums = countRe(text, NUMERIC_TOKEN_RE);
  if (perKb(nums, bytes) > 120 && nums > 200) {
    signals.push({ label: `numeric bytecode flood (${nums} numeric tokens)`, weight: 25 });
    score += 25;
  } else if (perKb(nums, bytes) > 50 && nums > 80) {
    signals.push({ label: `high numeric density (${nums} numeric tokens)`, weight: 12 });
    score += 12;
  }
  // 4b. Encoded numeric payload run — byte-code-as-text loaders: one long
  // space-separated digit run feeding string.char/load (any file size).
  if (/\d+(?:[ \t]\d+){39,}/.test(text)) {
    signals.push({ label: 'encoded numeric payload run (byte-code-as-text loader)', weight: 18 });
    score += 18;
  }

  // 5. Machine-generated identifier density.
  const ids = countRe(text, MACHINE_ID_RE);
  if (perKb(ids, bytes) > 30 && ids > 40) {
    signals.push({ label: `machine identifier flood (${ids} mangled names)`, weight: 25 });
    score += 25;
  } else if (perKb(ids, bytes) > 10 && ids > 15) {
    signals.push({ label: `mangled identifiers (${ids})`, weight: 12 });
    score += 12;
  }

  // 6. VM dispatcher shapes.
  const whileTrue = countRe(text, /\bwhile\s+(?:true|1)\s+do\b/g);
  const opcodeCmp = countRe(text, /(?:==|>=|<=|<|>)\s*\d{2,}/g);
  const bitops = countRe(text, /\bbit(?:32)?\s*\.\s*(?:bxor|band|bor|bnot|rshift|lshift|arshift)\b|\bband\(|\bbor\(|\bbxor\(/g);
  const metatables = countRe(text, /\bsetmetatable\s*\(/g);
  const coroutines = countRe(text, /\bcoroutine\.(?:wrap|resume|create)\b/g);
  const stringChar = countRe(text, /\bstring\.char\b|\bload(?:string)?\s*\(/g);
  // load(<non-literal>) — a payload compiled from runtime-built code is THE
  // structural marker of a loader/decrypt layer wrapping another layer.
  const dynamicLoads = countRe(text, /\bload(?:string)?\s*\(\s*(?!["'])/g);
  let vmScore = 0;
  if (whileTrue >= 1 && opcodeCmp >= 4) vmScore += 14;
  if (bitops >= 6) vmScore += 10;
  if (coroutines >= 2 && metatables >= 1) vmScore += 8;
  if (stringChar >= 3) vmScore += 6;
  if (dynamicLoads >= 1) vmScore += dynamicLoads >= 2 ? 20 : 18;
  if (BYTECODE_MAGIC_RE.test(text)) vmScore += 35;
  if (vmScore >= 10) {
    signals.push({ label: `VM dispatcher shapes (while-true×${whileTrue}, opcode cmp×${opcodeCmp}, bitops×${bitops})`, weight: Math.min(28, vmScore) });
    score += Math.min(28, vmScore);
  }

  // 7. Keyword starvation — real code is full of keywords; VM payloads are not.
  const kwRe = lang === 'js' ? JS_KEYWORDS_RE : LUA_KEYWORDS_RE;
  const kws = countRe(text, kwRe);
  if (bytes > 3072 && perKb(kws, bytes) < 4) {
    signals.push({ label: `keyword starvation (${kws} keywords in ${(bytes / 1024).toFixed(1)} KB)`, weight: 18 });
    score += 18;
  }

  // 8. Family banner still present — the strongest single signal.
  let residualFamily = null;
  try {
    const det = detectService(Buffer.from(text, 'utf8'));
    if (det.best && det.best.confidence >= 45) {
      residualFamily = {
        id: det.best.service.id,
        name: det.best.service.name,
        version: det.best.version || null,
        confidence: det.best.confidence,
      };
      const w = det.best.confidence >= 60 ? 35 : 20;
      signals.push({ label: `${residualFamily.name}${residualFamily.version ? ` ${residualFamily.version}` : ''} banner still present (${det.best.confidence}%)`, weight: w });
      score += w;
    }
  } catch { /* detection is advisory here */ }

  const confidence = Math.max(0, Math.min(97, Math.round(score)));
  return { obfuscated: confidence >= 45, confidence, signals, residualFamily };
}

// ---- static layer stack ------------------------------------------------------

/**
 * Detect stacked obfuscator layers in a buffer BEFORE peeling.
 * A file is multi-layer when evidence for ≥2 distinct families is present
 * (banners of different obfuscators, or ≥2 wrapper generations).
 *
 * @param {Buffer} buf
 * @returns {{ layers: Array<{id,name,version,confidence,evidence[]}>, multi:boolean, wrapperGenerations:number, summary:string }}
 */
export function detectLayers(buf) {
  const det = detectService(buf);
  const candidates = (det.candidates || []).filter((c) => c.confidence >= 30);

  // Wrapper generations: distinct decrypt-then-load plumbing generations.
  const text = buf.subarray(0, 512 * 1024).toString('latin1').replace(/\0/g, '');
  const loadCalls = countRe(text, /\bload(?:string)?\s*\(/g);
  const b64Blobs = (text.match(B64_BLOB_RE) || []).length;
  const escapeFlood = countRe(text, DECIMAL_ESCAPE_RE) + countRe(text, HEX_ESCAPE_RE);
  let wrapperGenerations = 0;
  if (loadCalls >= 1 && (b64Blobs >= 1 || escapeFlood > 50)) wrapperGenerations = Math.min(4, 1 + Math.floor(b64Blobs / 2));

  // Filter family candidates: keep families that plausibly co-exist. Same
  // family listed once; sub-40% single-heuristic hits are noise unless a
  // stronger layer already exists.
  const layers = candidates
    .filter((c, i) => c.confidence >= 55 || candidates.length >= 2)
    .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);

  const multi = layers.length >= 2 || (layers.length >= 1 && wrapperGenerations >= 2);
  const summary = stackSummary(layers, wrapperGenerations);
  return { layers, multi, wrapperGenerations, summary };
}

/**
 * Human summary of a layer stack, outermost first.
 * @param {Array<{name:string,version?:string|null}>} layers
 * @param {number} wrapperGenerations
 */
export function stackSummary(layers, wrapperGenerations = 0) {
  const names = (layers || []).map((l) => `${l.name}${l.version ? ` ${l.version}` : ''}`);
  for (let i = 0; i < wrapperGenerations; i++) names.push('runtime loader layer');
  if (!names.length) return 'single layer (or none)';
  return names.join(' → ');
}

/**
 * Merge pipeline peel iterations into one compact layer report for replies.
 * @param {Array<{family:string,version?:string|null,how?:string,residual?:number}>} iterations
 */
export function peelSummary(iterations) {
  if (!iterations || !iterations.length) return null;
  const parts = iterations.map((it, i) => {
    const fam = `${it.family || 'Unknown'}${it.version ? ` ${it.version}` : ''}`;
    return `L${i + 1}: ${fam}${it.residual != null ? ` (residual ${it.residual}%)` : ''}`;
  });
  return parts.join(' → ');
}
