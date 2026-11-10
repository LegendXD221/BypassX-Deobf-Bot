/**
 * v2.8.0 final-scan exploit regressions:
 *   1. fengari-safe — invalid-UTF8 conversion never throws (the wYnFuscate
 *      pipeline crash), everywhere program-controlled bytes reach JS.
 *   2. reconstructPool — encrypted blobs / bytecode fragments / self-noise
 *      filtered; the real printable pool survives (escrow output quality).
 *   3. yield primitives resolve instantly (no more 'bx: wait not permitted'
 *      aborting builds whose init yields).
 */
import assert from 'node:assert/strict';
import { safeToJsString, safeBytesToJsString } from '../src/fengari-safe.js';
import { reconstructPool, harvestToLua } from '../src/harvest.js';
import { verifyCode } from '../src/validate.js';
import fengari from 'fengari';

const { lua, lauxlib, to_luastring } = fengari;

const ok = { total: 0, failed: 0 };
async function check(name, fn) {
  ok.total += 1;
  try { await fn(); console.log(`  PASS ${name}`); } catch (e) { ok.failed += 1; console.error(`  FAIL ${name}\n    ${String(e?.stack || e).split('\n').slice(0, 4).join('\n    ')}`); }
}

await check('safeBytesToJsString: invalid utf8 bytes → latin1, no throw', async () => {
  // 0xE3 0x92 0x97 = valid utf8 (㒗); append a bare 0xFF (invalid anywhere)
  const raw = new Uint8Array([0x48, 0x65, 0xff, 0x21]);
  const s = safeBytesToJsString(raw);
  assert.equal(typeof s, 'string');
  assert.ok(s.startsWith('He'), `prefix preserved: ${JSON.stringify(s)}`);
  assert.equal(s, 'He\xff!');
});

await check('safeToJsString: binary Lua string on stack never throws', async () => {
  const L = lauxlib.luaL_newstate();
  try {
    // push a string with raw invalid-utf8 bytes — lua_tojsstring used to throw
    const bytes = new Uint8Array([0x4b, 0x74, 0x1d, 0xff, 0x13, 0x4d, 0x73]);
    lua.lua_pushlstring(L, bytes, bytes.length);
    const s = safeToJsString(L, -1);
    assert.equal(typeof s, 'string');
    assert.equal(s.length, 7, 'latin1 mapping is byte-count preserving');
  } finally { lua.lua_close(L); }
});

await check('verifyCode: syntax error + binary literal → failed, NOT crash', async () => {
  // the exact final-scan crash: chunk contains invalid utf8 AND a parse error,
  // so fengari's error message embeds raw bytes from the chunk
  const code = 'local x = "raw\xff\xfe bytes"\nthis is not lua (';
  let r;
  assert.doesNotThrow(() => { r = verifyCode(code, { lang: 'lua', filename: 'x.lua' }); });
  assert.equal(r.status, 'failed', `expected failed, got ${JSON.stringify(r)}`);
});

await check('reconstructPool: drops blob/fragments/self-noise, keeps printable pool', async () => {
  const blob = 'kt\x1d\xff\x13Ms\x13\x00ee\x18%'; // binary garbage (sink-captured encrypted pool)
  const frags = ['\u3457', '\u3458', '\u349d']; // CJK single-char fragments
  const real = ['tonumber', 'string', 'char', 'table', 'RobloxScriptSec'];
  const noise = ['[string "local __BUD = ..."]:310: attempt to index a nil value',
    'bx: instruction budget exceeded', 'spawn-error: attempt to call nil'];
  const { kept, dropped } = reconstructPool([blob, ...frags, ...real, ...noise, 'char']);
  assert.deepEqual(kept, real, `kept should be exactly the real pool, got ${JSON.stringify(kept)}`);
  assert.equal(dropped, 8, `9 input − 5 kept = 4 (blob+3 frags) + 3 noise + 1 dup, got dropped=${dropped}`);
});

await check('harvestToLua: header reports filtered counts, body has only real strings', async () => {
  const text = harvestToLua({ strings: ['tonumber', 'ab\x00cd', '\u3470', 'tonumber'] }, { detectedName: 'MoonSec V2' });
  assert.match(text, /Recovered 1 pool strings \(3 binary\/encrypted\/duplicate fragments filtered\)/);
  assert.ok(text.includes('tonumber'));
  assert.ok(!text.includes('\u3470'), 'CJK fragment must not be emitted');
  // must still be valid Lua
  assert.equal(verifyCode(text, { lang: 'lua' }).status, 'verified');
});

await check('harvestToLua: long/multi-line strings use long-bracket literals, values round-trip byte-exact (v2.14.0)', async () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(300) + '/end';
  const multiLine = 'local x = 1\nlocal y = 2\nreturn x + y\n-- ]] trap\nprint("inside")';
  const withCr = 'line1\r\nline2\r\n';          // \r must stay quoted (lexer normalizes \r in long brackets)
  const withNul = 'a\x00b';                      // \0 must stay quoted
  const text = harvestToLua({ strings: [longUrl, multiLine, withCr, withNul, 'short'] }, { detectedName: 'IronBrew 2' });
  assert.equal(verifyCode(text, { lang: 'lua' }).status, 'verified', 'dump must stay valid Lua');
  assert.ok(text.includes('[[') && text.includes(']]'), 'long-bracket literal missing');
  assert.ok(!text.includes('https://example.com/aaa\\'), 'long URL must not be one-line escaped');
  assert.ok(text.includes('"line1\\r\\nline2\\r\\n"'), '\\r string must stay quoted');
  // \0 strings are binary — reconstructPool filters them upstream (defensive
  // longForm guard still exists for direct callers)
  assert.ok(!text.includes('"a\\0b"'), '\\0 string must be filtered, not emitted');
  // fengari round-trip: load the dump, compare every slot against the original
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const rc = lauxlib.luaL_dostring(L, to_luastring(text));
  assert.equal(rc, lua.LUA_OK, lua.lua_tojsstring(L, -1));
  // the dump is `local STRINGS = {...} return STRINGS` — the table is the
  // return value already sitting at the top of the stack after dostring
  const want = [longUrl, multiLine, withCr, 'short'];
  for (let i = 0; i < want.length; i++) {
    lua.lua_pushinteger(L, i + 1);
    lua.lua_gettable(L, -2);
    const got = safeToJsString(L, -1, '');
    assert.equal(got, want[i], `slot ${i + 1} round-trip mismatch`);
    lua.lua_pop(L, 1);
  }
});

await check('yield primitives: wait/spawn resolve — no abort error', async () => {
  const prelude = (await import('node:fs')).readFileSync(new URL('../src/jail-prelude.js', import.meta.url), 'utf8');
  assert.ok(/wait = function\(\) return 0 end/.test(prelude), 'wait must resolve, not error');
  assert.ok(!prelude.includes('wait not permitted'), 'hard-error wait shim must be gone');
  assert.ok(!prelude.includes("spawn = function() error"), 'hard-error spawn shim must be gone');
  assert.ok(/task\.wait = function\(\) return 0 end|wait = function\(\) return 0 end/.test(prelude));
});

console.log(`\n${ok.total - ok.failed}/${ok.total} checks passed`);
if (ok.failed) process.exit(1);
