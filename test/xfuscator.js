/**
 * Xfuscator (v2.20.0) — BypassX's own obfuscator.
 *
 * Proves the full chain for every build (v1 / v2 / v2.1):
 *   1. JS mirror decode(encrypt(src)) === src (the emit gate);
 *   2. header line is exactly-once, first line, exact text;
 *   3. the emitted loader COMPILES in fengari;
 *   4. the emitted loader RUNS in fengari and reproduces the original
 *      program's printed output byte-for-byte (semantics preserved);
 *   5. escaping survives quotes / backslashes / non-UTF8-adjacent bytes /
 *      long sources (multi-chunk blob concatenation);
 *   6. tamper resistance: a wrong seed refuses to produce the original
 *      output (v2/v2.1: silent MAC refusal; v1: loud load failure);
 *   7. double-obfuscation is refused.
 */
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {
  xfuscate, jsDecode, jsEncryptBlob, isXfuscated, xfuscatorHeader,
  XFUSCATOR_VERSIONS, XFUSCATOR_DEFAULT,
} from '../src/xfuscator.js';
import { safeToJsString } from '../src/fengari-safe.js';

const { lua, lauxlib, lualib, to_luastring } = fengari;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  FAIL ${name}\n    ${String(e?.stack || e).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

// ---- fengari runner with print capture ---------------------------------------

/**
 * Run Lua source in a fresh fengari state, capturing every print() line.
 * print is replaced by a C closure so numbers/strings come through like the
 * real thing (tab-joined, like Lua's print).
 */
function runLuaWithCapture(src) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const out = [];
  lua.lua_pushcfunction(L, (state) => {
    const n = lua.lua_gettop(state);
    const parts = [];
    for (let i = 1; i <= n; i += 1) {
      const s = safeToJsString(state, i, null);
      parts.push(s === null ? String(lua.lua_tonumber(state, i)) : s);
    }
    out.push(parts.join('\t'));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('print'));
  const chunk = to_luastring(src, true);
  if (lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('@xf')) !== lua.LUA_OK) {
    const err = safeToJsString(L, -1, 'parse error');
    lua.lua_close(L);
    return { ok: false, err, out };
  }
  if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
    const err = safeToJsString(L, -1, 'runtime error');
    lua.lua_close(L);
    return { ok: false, err, out };
  }
  lua.lua_close(L);
  return { ok: true, err: null, out };
}

// ---- fixtures ------------------------------------------------------------------

const SAMPLE = `local function greet(name)
  local msg = "Hello, " .. name .. "! You have " .. 3 .. " messages."
  print(msg)
  return msg
end
local t = {5, 10, 15}
local sum = 0
for i = 1, #t do
  sum = sum + t[i]
end
print("sum=" .. sum)
if sum == 30 then print("tab ok") else print("tab bad") end
while sum > 0 do sum = sum - 10 end
print("while ok " .. sum)
repeat sum = sum + 5 until sum >= 5
print("repeat ok " .. sum)
greet("world")
`;

const ESCAPE_SAMPLE = [
  'local q = "quote \\" inside"',
  "local s = 'single \\' inside'",
  'local b = "backslash \\\\ done"',
  'local d = "\\65\\66\\67"', // decimal escapes in the ORIGINAL source
  'print(q) print(s) print(b) print(d)',
  'print("h\\195\\169llo utf8")',
].join('\n');
// héllo as raw UTF-8 through the pipeline: the source above uses \195\169 escapes,
// and additionally a literal accented char sample:
const UTF8_SAMPLE = 'print("héllo — dash")\n';

const ORIGINAL_OUT = runLuaWithCapture(SAMPLE);
const ESCAPE_OUT = runLuaWithCapture(ESCAPE_SAMPLE);
const UTF8_OUT = runLuaWithCapture(UTF8_SAMPLE);

// ---- checks --------------------------------------------------------------------

await check('fixtures: originals run clean in fengari', () => {
  assert.ok(ORIGINAL_OUT.ok, `sample broke: ${ORIGINAL_OUT.err}`);
  assert.equal(ORIGINAL_OUT.out.length, 5);
  assert.ok(ORIGINAL_OUT.out.includes('sum=30'), `unexpected output: ${ORIGINAL_OUT.out}`);
  assert.ok(ESCAPE_OUT.ok, `escape sample broke: ${ESCAPE_OUT.err}`);
  assert.ok(UTF8_OUT.ok, `utf8 sample broke: ${UTF8_OUT.err}`);
});

for (const version of XFUSCATOR_VERSIONS) {
  const r = xfuscate(SAMPLE, { version });
  const tag = `Xfuscator ${version}`;

  await check(`${tag}: xfuscate ok + mirror decode round-trip`, () => {
    assert.ok(r.ok, `xfuscate failed: ${r.error}`);
    const blob = jsEncryptBlob(Buffer.from(SAMPLE, 'utf8'), r.seed, version);
    const plain = jsDecode(blob, r.seed, version);
    assert.equal(plain.toString('utf8'), SAMPLE, 'mirror decode must reproduce the exact source');
  });

  await check(`${tag}: header exact + first line + exactly once`, () => {
    const lines = r.code.split('\n');
    assert.equal(lines[0], xfuscatorHeader(version), 'first line must be the exact header');
    const count = r.code.split(xfuscatorHeader(version)).length - 1;
    assert.equal(count, 1, 'header must appear exactly once');
    assert.ok(r.code.includes('dc.gg/bypassx'));
  });

  await check(`${tag}: emitted loader compiles in fengari`, () => {
    assert.ok(r.ok, 'no output');
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const chunk = to_luastring(r.code, true);
    const status = lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('@xf'));
    if (status !== lua.LUA_OK) {
      const err = safeToJsString(L, -1, 'parse error');
      lua.lua_close(L);
      assert.fail(`loader did not compile: ${err}`);
    }
    lua.lua_close(L);
  });

  await check(`${tag}: emitted loader RUNS and reproduces original output`, () => {
    const run = runLuaWithCapture(r.code);
    assert.ok(run.ok, `loader failed at runtime: ${run.err}`);
    assert.deepEqual(run.out, ORIGINAL_OUT.out);
  });

  await check(`${tag}: escapes + quotes + backslashes survive`, () => {
    const r2 = xfuscate(ESCAPE_SAMPLE, { version, seed: 12345 });
    assert.ok(r2.ok, `xfuscate failed: ${r2.error}`);
    const run = runLuaWithCapture(r2.code);
    assert.ok(run.ok, `escape build failed: ${run.err}`);
    assert.deepEqual(run.out, ESCAPE_OUT.out);
  });

  await check(`${tag}: UTF-8 source survives`, () => {
    const r2 = xfuscate(UTF8_SAMPLE, { version, seed: 777 });
    assert.ok(r2.ok, `xfuscate failed: ${r2.error}`);
    const run = runLuaWithCapture(r2.code);
    assert.ok(run.ok, `utf8 build failed: ${run.err}`);
    assert.deepEqual(run.out, UTF8_OUT.out);
  });

  await check(`${tag}: multi-chunk blob (40 KB) runs identically`, () => {
    const lines = [];
    for (let i = 0; i < 1200; i += 1) {
      lines.push(`if ${i} * 2 > 100 then print("big ${i}", ${i} * 2) end`);
    }
    const big = lines.join('\n');
    assert.ok(big.length > 40_000, 'fixture too small for multi-chunk');
    const ref = runLuaWithCapture(big);
    assert.ok(ref.ok, 'big fixture itself broke');
    const r2 = xfuscate(big, { version, seed: 987654321 });
    assert.ok(r2.ok, `xfuscate failed: ${r2.error}`);
    const run = runLuaWithCapture(r2.code);
    assert.ok(run.ok, `big build failed: ${run.err}`);
    assert.deepEqual(run.out, ref.out);
  });

  await check(`${tag}: tampered seed never reproduces the original output`, () => {
    const r2 = xfuscate(SAMPLE, { version, seed: 20250101 });
    assert.ok(r2.ok);
    const seedStr = String(r2.stats.seed);
    // Replace every occurrence of the seed literal (blob coincidences only
    // corrupt further — the verdict is the same: original output must not run).
    const tampered = r2.code.split(seedStr).join(String(r2.stats.seed ^ 1));
    const run = runLuaWithCapture(tampered);
    const printed = run.out.join('\n');
    assert.ok(!printed.includes('Hello, world'), 'tampered build must not run the original program');
    if (version === 'v1') {
      // v1 has no MAC — loud failure (load of garbage) is the expected shape.
      assert.ok(!run.ok || !printed.includes('sum=30'), 'v1 tamper must not run the original program');
    } else {
      // v2/v2.1: MAC mismatch → SILENT refusal (no output, no crash).
      assert.ok(run.ok, `v2+ tamper should refuse silently, not crash: ${run.err}`);
      assert.equal(run.out.length, 0, 'v2+ tamper must print nothing');
    }
  });

  await check(`${tag}: double-obfuscation refused`, () => {
    const r2 = xfuscate(r.code, { version });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /already obfuscated/i);
  });
}

await check('isXfuscated detects every build + default version sanity', () => {
  for (const version of XFUSCATOR_VERSIONS) {
    const r = xfuscate('print("x")', { version });
    assert.ok(r.ok);
    assert.equal(isXfuscated(r.code), true);
    assert.equal(isXfuscated('print("x")'), false);
  }
  assert.equal(XFUSCATOR_DEFAULT, 'v2.1');
});

await check('invalid versions + empty input rejected cleanly', () => {
  assert.equal(xfuscate('print(1)', { version: 'v9' }).ok, false);
  assert.equal(xfuscate('   ').ok, false);
  assert.equal(xfuscate('').ok, false);
});

// ---- .obf command smoke (registry wiring + delivery card) ----------------------

// Load the command registry FIRST (same import order as src/index.js — the
// benign cycle TDZs otherwise).
import '../src/commands-index.js';
import obf from '../src/commands/obf.js';
import { makeCtx } from '../src/ctx.js';
import { toSlashJson } from '../src/commands-index.js';

const OBF_LUA = 'local greeting = "hi"\nprint(greeting .. " there")\n';
// Exact-size ArrayBuffer (Buffer pooling would expose NUL-filled pool bytes
// and trip the command's binary guard).
const OBF_AB = new TextEncoder().encode(OBF_LUA).buffer;
const obfCalls = [];
const obfPastes = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  obfCalls.push(`fetch:${u.slice(0, 60)}`);
  if (u.startsWith('https://attach.mock/obf')) {
    return { ok: true, status: 200, arrayBuffer: async () => OBF_AB, headers: new Map() };
  }
  if (u.startsWith('https://pastefy.app/api/v2/paste')) {
    try { obfPastes.push(JSON.parse(init?.body || '{}')); } catch { /* ignore */ }
    return { ok: true, status: 200, json: async () => ({ paste: { id: 'obfPaste1' } }), headers: new Map() };
  }
  return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
};

function obfMockInteraction(userId, version) {
  return {
    user: { id: userId, tag: 'obftest' },
    guildId: 'guild1',
    deferred: false,
    replied: false,
    options: {
      getAttachment: () => ({ name: 'myscript.lua', size: OBF_LUA.length, url: 'https://attach.mock/obf/myscript.lua' }),
      getString: (name) => (name === 'version' ? (version || null) : null),
      getMessage: () => null,
    },
    async deferReply() { this.deferred = true; obfCalls.push('deferReply'); },
    async editReply(p) { this.deferred = true; this.replied = true; obfCalls.push(`editReply:${JSON.stringify(p).slice(0, 200)}`); },
    async reply(p) { this.replied = true; obfCalls.push(`interaction.reply:${JSON.stringify(p).slice(0, 600)}`); },
    async followUp(p) { this.replied = true; obfCalls.push(`followUp:${JSON.stringify(p).slice(0, 600)}`); },
    channel: { async send(p) { obfCalls.push(`channel.send:${JSON.stringify(p).slice(0, 600)}`); } },
  };
}

await check('.obf slash: status-first, card delivered, paste carries the Xfuscator header', async () => {
  obfCalls.length = 0;
  obfPastes.length = 0;
  const interaction = obfMockInteraction('5550001', 'v2.1');
  await obf.run(makeCtx({ interaction, client: {} }));
  const seq = obfCalls.map((c) => c.split(':')[0]).filter((s) => s !== 'fetch');
  assert.deepEqual(seq, ['deferReply', 'editReply', 'editReply', 'followUp'], `unexpected order: ${seq.join(' → ')}`);
  assert.ok(obfCalls.some((c) => c.includes('obfuscating Your Code') && c.includes('Xfuscator (v2.1)')), 'status must announce the Xfuscator build');
  const fu = obfCalls.find((c) => c.startsWith('followUp:'));
  assert.ok(fu && fu.includes('Xfuscator complete'), `result card must announce completion: ${fu}`);
  assert.ok(obfPastes.length >= 1, 'paste upload must happen');
  const text = obfPastes[0].content || obfPastes[0].text || '';
  assert.ok(text.startsWith(`${xfuscatorHeader('v2.1')}\n`), `paste must open with the exact Xfuscator header, got: ${JSON.stringify(text.slice(0, 100))}`);
  assert.ok(obfPastes[0].title.includes('Xfuscator (v2.1)'), 'paste title must name the build');
});

await check('.obf slash: version choice reaches the Discord slash JSON', () => {
  const json = toSlashJson(obf);
  const ver = (json.options || []).find((o) => o.name === 'version');
  assert.ok(ver, 'version option must exist on /obf');
  assert.ok(Array.isArray(ver.choices) && ver.choices.length === 3, 'version choices must be registered');
  assert.deepEqual(ver.choices.map((c) => c.value), ['v1', 'v2', 'v2.1']);
});

await check('.obf prefix: explicit version arg wins, unknown version gets an error card', async () => {
  obfCalls.length = 0;
  const message = {
    author: { id: '5550002', tag: 'obftest' },
    guildId: 'guild1',
    _prefix: '.',
    content: '.obf v1',
    attachments: new Map([['1', { name: 'myscript.lua', size: OBF_LUA.length, url: 'https://attach.mock/obf/myscript.lua' }]]),
    reference: null,
    async reply(p) { obfCalls.push(`msg.reply:${JSON.stringify(p).slice(0, 600)}`); return { async edit() {} }; },
  };
  const ctx = makeCtx({ message, client: {} });
  ctx.args = ['v1'];
  await obf.run(ctx);
  assert.ok(obfCalls.some((c) => c.includes('Xfuscator (v1)')), 'v1 arg must select build v1');
  assert.ok(obfCalls.some((c) => c.startsWith('msg.reply:') && c.includes('Xfuscator complete')), 'card must be delivered as a reply');

  obfCalls.length = 0;
  const message2 = {
    ...message,
    author: { id: '5550003', tag: 'obftest' },
  };
  const ctx2 = makeCtx({ message: message2, client: {} });
  ctx2.args = ['v9'];
  await obf.run(ctx2);
  assert.ok(obfCalls.some((c) => c.includes('Unknown version')), 'unknown version must produce the error card');
});

await check('.obf rejects already-Xfuscated input', async () => {
  obfCalls.length = 0;
  const r = xfuscate(OBF_LUA, { version: 'v1', seed: 42 });
  assert.ok(r.ok);
  const obfAb = new TextEncoder().encode(r.code).buffer;
  globalThis.fetch = async (url) => {
    const u = String(url);
    obfCalls.push(`fetch:${u.slice(0, 60)}`);
    if (u.startsWith('https://attach.mock/obf')) {
      return { ok: true, status: 200, arrayBuffer: async () => obfAb, headers: new Map() };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
  };
  const interaction = obfMockInteraction('5550004', null);
  await obf.run(makeCtx({ interaction, client: {} }));
  assert.ok(obfCalls.some((c) => c.includes('already obfuscated by Xfuscator')), `double-obf must be refused: ${obfCalls.join(' | ')}`);
});

// (blob regeneration now uses the exported jsEncryptBlob — one shared ground
// truth for encrypt and decode; no duplicated stream logic in this test.)

console.log(`\nxfuscator: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
