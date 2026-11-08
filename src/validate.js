/**
 * BypassX Deobf Bot — output accuracy verification (v1.3.0).
 *
 * The bot claims 100% accurate output; this module is how we enforce and
 * prove it. Every recovered file is parsed (never executed):
 *   • Lua  → fengari (Lua 5.3) compile-only load: full real grammar check.
 *     Luau-specific syntax that plain 5.3 rejects (compound assignment etc.)
 *     gets one retry through the Luau→Lua shim — if the shim parses, the
 *     original is still Luau-valid, so we report "verified (Luau)".
 *   • JS   → `new vm.Script()` compile: V8-grade full parse, zero execution.
 *   • other languages / binary outputs → honestly "unverifiable", never faked.
 *
 * `verifyBest()` also drives best-candidate picking: when several engine
 * outputs are available, the pipeline picks the FIRST one that parses.
 */
import vm from 'node:vm';
import fengari from 'fengari';
import { transformLuauToLua } from './luau-shim.js';
import { safeBytesToJsString } from './fengari-safe.js';

const { lua, lauxlib, to_luastring, to_jsstring } = fengari;

const MAX_VERIFY_BYTES = 3 * 1024 * 1024;

function checkLuaParse(code) {
  const L = lauxlib.luaL_newstate();
  try {
    const chunk = to_luastring(code);
    const status = lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('verify'));
    if (status === lua.LUA_OK) return { ok: true };
    const errRaw = lua.lua_tostring(L, -1);
    // v2.8.0: to_jsstring THROWS on non-UTF8 error bytes (binary string
    // literals in the verified chunk) — that RangeError used to escape
    // verifyCode and crash the whole pipeline. latin1 mapping never throws.
    const msg = errRaw ? safeBytesToJsString(errRaw, 'syntax error') : 'syntax error';
    return { ok: false, error: msg };
  } finally {
    lua.lua_close(L);
  }
}

/**
 * Verify one code string.
 * @returns {{status:'verified'|'unverifiable'|'failed', lang:string, detail:string}}
 */
export function verifyCode(code, { lang = null, filename = '' } = {}) {
  const src = String(code ?? '');
  const langId = lang || guessVerifyLang(src, filename);

  if (!src.trim()) return { status: 'unverifiable', lang: langId || '—', detail: 'empty output' };
  if (Buffer.byteLength(src, 'utf8') > MAX_VERIFY_BYTES) {
    return { status: 'unverifiable', lang: langId || '—', detail: 'output too large to parse-check in-process' };
  }

  if (langId === 'lua' || langId === 'luau') {
    const first = checkLuaParse(src);
    if (first.ok) return { status: 'verified', lang: langId, detail: 'Lua syntax OK (fengari parse)' };
    // Luau retry through the shim (compound assignment, etc.)
    try {
      const shimmed = transformLuauToLua(src);
      if (shimmed && shimmed !== src && checkLuaParse(shimmed).ok) {
        return { status: 'verified', lang: 'luau', detail: 'Luau syntax OK (verified via Lua shim)' };
      }
    } catch { /* shim refused — original error stands */ }
    return { status: 'failed', lang: langId, detail: first.error.slice(0, 220) };
  }

  if (langId === 'js') {
    try {
      // Compile only — the Script is never run.
      new vm.Script(src, { filename: 'verify.js' });
      return { status: 'verified', lang: 'js', detail: 'JS syntax OK (V8 parse)' };
    } catch (e) {
      return { status: 'failed', lang: 'js', detail: String(e?.message || e).split('\n')[0].slice(0, 220) };
    }
  }

  return { status: 'unverifiable', lang: langId || '—', detail: 'no parser for this language yet' };
}

export function guessVerifyLang(src, filename = '') {
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (['lua', 'luau'].includes(ext)) return 'lua';
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) return 'js';
  if (ext === 'py') return 'python';
  const head = src.slice(0, 4096);
  if (/\blocal\s+(function|\w)\b|\bthen\b\s*$|--\[\[/.test(head) || /\bend\b\s*\)?\s*$/.test(src.slice(-200))) return 'lua';
  if (/\b(?:const|let|var)\b|=>|function\s*\(|\bclass\b/.test(head) && /[{};]/.test(head)) return 'js';
  if (/^\s*def\s+\w+\s*\(.*\)\s*:/m.test(head) || /^#!\s*\S*python/m.test(head)) return 'python';
  return null;
}

/**
 * Verify a set of candidate outputs and pick the best.
 * Candidates: [{ name, buffer }] — already passthrough-filtered, in engine
 * preference order (largest first per engine output).
 * @returns {{ chosen: {name, buffer}|null, verification, attempts: [] }}
 */
export function verifyBest(candidates, { lang = null } = {}) {
  const attempts = [];
  let fallback = null;
  for (const cand of candidates) {
    if (!cand?.buffer?.length) continue;
    const src = cand.buffer.toString('utf8');
    const v = verifyCode(src, { lang, filename: cand.name });
    attempts.push({ name: cand.name, status: v.status, detail: v.detail });
    if (v.status === 'verified') return { chosen: cand, verification: { ...v, attempts }, attempts };
    if (!fallback) fallback = { cand, v };
  }
  if (fallback) {
    return {
      chosen: fallback.cand,
      verification: { ...fallback.v, attempts },
      attempts,
    };
  }
  return { chosen: null, verification: null, attempts };
}
