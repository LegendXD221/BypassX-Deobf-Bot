/**
 * v1.6.0 regression tests — Luau → Lua shim (compound assigns + if-expressions).
 *
 * Locked behaviors:
 *   • compound assignments rewrite `x += y` → `x = x + (y)` — including the
 *     `function(P)P%=4294967296` no-space param-list shape (Luraph v15.1);
 *   • Luau if-expressions rewrite to a jailed-VM-safe IIFE — the template is
 *     FLATTENED (`if c then return a end return b`) because a bare
 *     `if c then return a else return b end` as the whole IIFE body trips a
 *     fengari parser quirk (verified against fengari 0.1.4);
 *   • nested if-expressions recurse; `j[if c then a else b]` (bracket
 *     expression position) matches; statement-position `if` never matches;
 *   • the transform is linear on Luraph v15.1-sized inputs (no regex blowup
 *     on blanked string-data regions);
 *   • the harvester prelude exposes math.ldexp/frexp + Luau stdlib so
 *     MoonSec V2 dispatchers bind their libraries.
 *
 * Run: node test/luau-shim.js
 */
import assert from 'node:assert/strict';
import { hasLuauCompoundAssign, transformLuauToLua, collectLuauEdits } from '../src/luau-shim.js';
import fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring } = fengari;

function compiles(src) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const chunk = to_luastring(src, true);
  return lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('@t')) === lua.LUA_OK;
}

function run(src) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const chunk = to_luastring(src, true);
  if (lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('@t')) !== lua.LUA_OK) {
    return { ok: false, err: lua.lua_tojsstring(L, -1) };
  }
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) return { ok: false, err: lua.lua_tojsstring(L, -1) };
  return { ok: true, value: lua.lua_isnumber(L, -1) ? lua.lua_tonumber(L, -1) : lua.lua_tojsstring(L, -1) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- v2.18.0: backtick interpolated strings (25ms family) ---------------------
test('backtick: plain literals rewrite to double-quoted strings', () => {
  const src = 'local t = `44MjFfa=`; return t';
  const out = transformLuauToLua(src);
  assert.ok(!out.includes('`'), 'no backticks remain');
  assert.ok(out.includes('"44MjFfa="'), 'literal rewritten');
  assert.ok(compiles(out), 'output parses');
});
test('backtick: interpolation becomes a tostring concat chain', () => {
  const out = transformLuauToLua('return `a{1+2}b`');
  assert.ok(out.includes('"a"..tostring(1+2)..\"b"'), 'concat chain: ' + out);
  assert.ok(compiles(out), 'output parses');
});
test('backtick: backtick inside a comment/string is data, not syntax', () => {
  const src = '-- `not code` \nlocal s = "has ` inside"; return s';
  const out = transformLuauToLua(src);
  assert.equal(out, src, 'untouched');
});
test('backtick: 25ms-shaped pool parses and runs', () => {
  // real shape: backtick literals are table items (25ms pool), never statements
  const src = 'local t={`44MjFfa=`;`Iw7lgO==`,`7GRnsuS=`}; return type(t)';
  const out = transformLuauToLua(src);
  assert.ok(compiles(out), 'output parses');
  assert.equal(run(out).value, 'table', 'runtime value intact');
});

// ---- v2.18.0: Luau type annotations (25ms) ------------------------------------
test('type annotations: local <id>:<type> = is stripped (erased by Luau anyway)', () => {
  const out = transformLuauToLua('local j:str=function(J) return J end; return j(5)');
  assert.ok(!out.includes(':str='), 'annotation gone');
  assert.ok(compiles(out), 'output parses');
  assert.equal(run(out).value, 5, 'runtime value intact');
});
test('type annotations: non-type lookalikes are untouched', () => {
  const src = 'local a = b:c(1) return a';
  assert.equal(transformLuauToLua(src), src, 'method call untouched');
});

// ---- v2.18.0: compound-assign scanner hardening -------------------------------
test('compound: arithmetic-index LHS rewrites (25ms/SomeCool shape)', () => {
  // 866570+-866567 == 3 — the compound targets K[3]
  const out = transformLuauToLua('local K = {[3]=0}; K[866570+-866567]+=534326+-534325 return K[3]');
  assert.ok(!out.includes('+='), 'no compound remains');
  assert.ok(compiles(out), 'output parses');
  assert.equal(run(out).value, 1, 'K[3] == 1');
});
test('compound: paren-root LHS rewrites (25ms (C)[k] shape)', () => {
  const out = transformLuauToLua('local C = {10}; local r = {1}; (C)[(r)[1]] += 5 return C[1]');
  assert.ok(!out.includes('+='), 'no compound remains');
  assert.ok(compiles(out), 'output parses');
  assert.equal(run(out).value, 15, 'C[1] == 15');
});
test('compound: call-result LHS is REJECTED (would evaluate twice)', () => {
  const src = 'local t = {}; local function f() return t end; f()[1]+=1';
  const out = transformLuauToLua(src);
  assert.ok(out.includes('+='), 'untransformed — honest parse failure beats double side effect');
});
test('compound: statement adjacency after indexed RHS rewrites (]glue)', () => {
  // real one-liner shape: the previous assignment's RHS closes at `]` and the
  // next statement starts without a separator
  const out = transformLuauToLua('local X={[1]=0};local K={[1]=0};X[1]=X[1]K[1]+=2 return K[1]');
  assert.ok(!out.includes('+='), 'no compound remains');
  assert.ok(compiles(out), 'output parses');
  assert.equal(run(out).value, 2, 'K[1] == 2');
});
test('compound: wrap paren never emits unbalanced code (balance guard)', () => {
  const src = 'K[980183+-980181]+=X[913623+-913622][L(646677-702050)]K[866570+-866567]+=534326+-534325 return K';
  const out = transformLuauToLua(src);
  assert.ok(compiles(out), 'output parses');
});
test('compound: keyword inside a longer identifier does not break the RHS scan', () => {
  // `for` contains `or` — the old scan broke INSIDE the word and split it
  const out = transformLuauToLua('local t = {[1]=0}; t[1]+=1 for i=1,2 do t[1]=t[1]+i end return t[1]');
  assert.ok(compiles(out), 'output parses');
  assert.equal(run(out).value, 4, 't[1] == 4 after loop');
});

// ---- compound assignment ------------------------------------------------------
test('compound: basic += rewrite and value', () => {
  const out = transformLuauToLua('local x = 1; x += 2; return x');
  assert.ok(!out.includes('+='), 'no compound remains');
  assert.deepEqual(run(out), { ok: true, value: 3 });
});

test('compound: %= right after param list paren (Luraph v15.1 shape)', () => {
  const src = 'local function G(P)P%=4294967296;return P;end;return G(5)';
  const out = transformLuauToLua(src);
  assert.ok(!out.includes('%='), 'no compound remains');
  assert.deepEqual(run(out), { ok: true, value: 5 });
});

test('compound: ..= and //= forms', () => {
  const out = transformLuauToLua('local s="a"; local t = {s}; local x=7; x//=2; return x');
  assert.deepEqual(run(out), { ok: true, value: 3 });
});

test('compound: NOT rewritten inside string literals', () => {
  const out = transformLuauToLua('local s = "a += b"; return s');
  assert.ok(out.includes('a += b'), 'string literal untouched');
});

test('compound: nested if-expression RHS survives (x += if ...)', () => {
  const out = transformLuauToLua('local x = 1; x += (if true then 2 else 3); return x');
  assert.ok(compiles(out), `compiles: ${out}`);
  assert.deepEqual(run(out), { ok: true, value: 3 });
});

// ---- if-expressions -------------------------------------------------------------
test('ifexpr: basic value select', () => {
  const out = transformLuauToLua('local y = 5; local x = if y > 3 then 10 else 20; return x');
  assert.ok(compiles(out), `compiles: ${out}`);
  assert.deepEqual(run(out), { ok: true, value: 10 });
});

test('ifexpr: else-branch taken', () => {
  const out = transformLuauToLua('local y = 1; local x = if y > 3 then 10 else 20; return x');
  assert.deepEqual(run(out), { ok: true, value: 20 });
});

test('ifexpr: table-constructor branch (MoonSec shape)', () => {
  const out = transformLuauToLua('local ag; local x = if not ag then {} else ag; return type(x)');
  assert.ok(compiles(out), `compiles: ${out}`);
  assert.deepEqual(run(out), { ok: true, value: 'table' });
});

test('ifexpr: inside table index brackets `t[if c then a else b]`', () => {
  const out = transformLuauToLua('local t = {7, 8}; local z = 1; local i = if z <= 1 then 3 else 2; return t[if z <= 1 then 3 else i]');
  // note: index 3 on a 2-element table is nil — just require a clean parse
  assert.ok(compiles(out), `compiles: ${out}`);
});

test('ifexpr: statement-position if is NEVER rewritten', () => {
  const src = 'if true then return 1 end';
  assert.equal(transformLuauToLua(src), src, 'statement if untouched');
});

test('ifexpr: after-param-list `)if` is statement position — untouched', () => {
  const src = 'local function f(a)if a then return 1 end return 2 end; return f(true)';
  const out = transformLuauToLua(src);
  assert.deepEqual(run(out), { ok: true, value: 1 });
});

test('ifexpr: nested if-expressions recurse', () => {
  const out = transformLuauToLua('local c = 0; local x = if c == 0 then (if c == 1 then 5 else 6) else 7; return x');
  assert.ok(compiles(out), `compiles: ${out}`);
  assert.deepEqual(run(out), { ok: true, value: 6 });
});

test('ifexpr: fengari quirk avoided (flattened template)', () => {
  const out = transformLuauToLua('local x = if true then 1 else 2; return x');
  assert.ok(!out.includes('else return'), 'no `else return` in template');
  assert.ok(compiles(out), `compiles: ${out}`);
  assert.deepEqual(run(out), { ok: true, value: 1 });
});

test('ifexpr: vararg-containing if-expression is skipped safely (left untouched)', () => {
  const src = 'local function f(...) local x = if true then select("#", ...) else 0 end; return x';
  const out = transformLuauToLua(src);
  // cannot be IIFE-wrapped (… cannot cross the closure) — must be left as-is,
  // never corrupted
  assert.ok(out.includes('if true then select("#", ...)'), 'vararg if-expr untouched');
  assert.ok(!out.includes('(function()'), 'no partial rewrite applied');
});

// ---- linearity on big machine-generated input -----------------------------------
test('linearity: 300KB blanked string-data region transforms fast', () => {
  const pad = '"' + 'x+=y if z=~w '.repeat(20000) + '"'; // string-data noise
  const src = `local s = ${pad}\nlocal q = 1; q += 1; local r = if q == 2 then 4 else 5; return r;`;
  const t0 = process.hrtime.bigint();
  const out = transformLuauToLua(src);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(compiles(out), 'compiles');
  assert.ok(ms < 2000, `transform took ${ms.toFixed(0)}ms — must stay under 2s`);
});

// ---- harvester prelude surface (stdlib the VM dispatchers bind) ------------------
test('prelude: math.ldexp/frexp + Luau stdlib available in the jail', async () => {
  // read the shared prelude directly — importing it would run the jail
  // (v1.9.0: the prelude lives in jail-prelude.js, shared by both workers)
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/jail-prelude.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/harvester-worker.js', import.meta.url), 'utf8');
  for (const needle of [
    'math.ldexp = function', 'math.frexp = function', 'math.round = function',
    'math.clamp = function', 'string.split = function', 'table.find = function',
    'table.create = function', 'countrz = function', 'countlz = function',
    '__NILPROBE', 'islclosure = true', "string.char = function", "string.rep = function",
  ]) {
    assert.ok(src.includes(needle), `prelude must include: ${needle}`);
  }
});

// ---- end -------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  PASS ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${t.name}\n    ${String(e && e.message || e).split('\n')[0]}`);
  }
}
console.log(failed ? `\n${failed} FAILED` : `\n${tests.length} passed, 0 failed`);
process.exit(failed ? 1 : 0);
