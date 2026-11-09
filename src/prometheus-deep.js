/**
 * BypassX Deobf Bot — Prometheus deep static pass (v2.13.0).
 *
 * Closes the gap the engine's lua-peel leaves on Prometheus (Weak preset and
 * lineage builds): today that route returns only the decrypted string pool —
 * the code body stays behind the ConstantArray + rotation + custom-alphabet
 * string-decoder scaffolding.
 *
 * This pass undoes that scaffolding BEHAVIORALLY — zero reimplementation of
 * the obfuscator's encoder (it changes between Prometheus versions/configs):
 *
 *   1. PARSE with ranges (luaparse) and locate the wrapper function body.
 *   2. LOCATE the scaffolding, all as raw source slices:
 *        · the string-table local      `local U = {"…"; "…"}`   (all literals)
 *        · the rotation loop           `for A,s in ipairs({{1,17},…}) do
 *                                        while s[1]<s[2] do U[s[1]],U[s[2]],…
 *                                        = U[s[2]],U[s[1]],s[1]+1,s[2]-1 …`
 *        · the accessor                `local function A(n) return U[n-K] end`
 *        · the decoder block           `do local …charmaps… end` (mutates U)
 *   3. EXECUTE those slices VERBATIM in a jailed fengari state (stdlib minus
 *      io/os/load — the decoder is pure string/table/math work) and read the
 *      decoded pool back index-by-index through the obfuscator's own accessor.
 *   4. REWRITE every `A(<num>)` call anywhere in the chunk to the decoded
 *      string literal, then delete the four scaffolding statements.
 *   5. GATES — abort (return null) unless:
 *        · 100% of literal-arg accessor calls resolved to strings
 *        · zero remaining references to the accessor / table names
 *        · output re-verifies (fengari real-grammar)
 *
 * Every gate failure falls through cleanly: the pipeline keeps its existing
 * routes (engine lua-peel → harvest → static-peel). The pass is pure and
 * never throws.
 */
import { createRequire } from 'node:module';
import fengari from 'fengari';
import luaparse from 'luaparse';
import { verifyCode } from './validate.js';

const require_ = createRequire(import.meta.url);
const { emitChunk } = require_('../vendor/white/lua/emit.js');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TABLE_ENTRIES = 262_144;
const SANDBOX_OP_BUDGET = 200_000_000; // count-hook budget (decoder is linear in bytes)

const DBG = process.env.BX_PROM_DEBUG ? (m) => console.error('[prom-deep]', m) : () => {};

const isNum = (n) => n && n.type === 'NumericLiteral';
const isStr = (n) => n && n.type === 'StringLiteral';
const isIdent = (n, name) => n && n.type === 'Identifier' && (name === undefined || n.name === name);

function slice(src, node) {
  return src.slice(node.range[0], node.range[1]);
}

/** Extract {lo,hi} numeric pairs from the ipairs({{1,17},{1,4},…}) table. */
function rotationPairs(forNode) {
  try {
    const call = forNode.iterators?.[0] ?? forNode.expression?.[0];
    if (!call || call.type !== 'CallExpression' || !isIdent(call.base, 'ipairs')) return null;
    const tbl = call.arguments?.[0];
    if (!tbl || tbl.type !== 'TableConstructorExpression' || !tbl.fields.length) return null;
    const pairs = [];
    for (const f of tbl.fields) {
      const row = f.value;
      if (!row || row.type !== 'TableConstructorExpression' || row.fields.length !== 2) return null;
      const a = row.fields[0].value;
      const b = row.fields[1].value;
      if (!isNum(a) || !isNum(b)) return null;
      pairs.push([a.value, b.value]);
    }
    return pairs;
  } catch {
    return null;
  }
}

/**
 * Accessor shape: `local function NAME(PARAM) return TBL[PARAM - K] end`
 * (also `+ K` and bare `TBL[PARAM]`). Returns { name, param, table, offset }.
 */
function matchAccessor(fn, tableName) {
  try {
    // luaparse types `local function f()` as FunctionDeclaration(isLocal=true)
    if (fn.type !== 'LocalFunctionStatement' && fn.type !== 'FunctionDeclaration') return null;
    if (fn.type === 'FunctionDeclaration' && fn.isLocal === false) return null;
    if (!fn.parameters || fn.parameters.length !== 1 || !isIdent(fn.parameters[0])) return null;
    const param = fn.parameters[0].name;
    // body is the statement array in luaparse function nodes
    const fnStmts = Array.isArray(fn.body) ? fn.body : fn.body?.body;
    if (!fnStmts || fnStmts.length !== 1) return null;
    const ret = fnStmts[0];
    if (ret.type !== 'ReturnStatement' || !ret.arguments || ret.arguments.length !== 1) return null;
    const idx = ret.arguments[0];
    // luaparse build types indexed access as IndexExpression { base, index }
    if (idx.type !== 'IndexExpression' && !(idx.type === 'MemberExpression' && idx.indexer === '[')) return null;
    if (!isIdent(idx.base, tableName)) return null;
    const key = idx.index ?? idx.identifier;
    if (isIdent(key, param)) return { name: fn.identifier.name, param, offset: 0 };
    if (key.type === 'BinaryExpression' && isIdent(key.left, param) && isNum(key.right)
      && (key.operator === '-' || key.operator === '+')) {
      return { name: fn.identifier.name, param, offset: key.operator === '-' ? key.right.value : -key.right.value };
    }
    return null;
  } catch {
    return null;
  }
}

/** Does this statement reference the identifier (as a variable)? */
function referencesIdent(node, name) {
  let hit = false;
  const visit = (n) => {
    if (hit || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (n.type === 'Identifier' && n.name === name) { hit = true; return; }
    // skip accessor-call sites — those are rewritten first, and a call
    // `A(39188)` legitimately contains the identifier we're checking
    for (const [k, v] of Object.entries(n)) {
      if (k === 'range' || k === 'loc') continue;
      visit(v);
    }
  };
  visit(node);
  return hit;
}

/**
 * Scope-aware dangling-reference check (v2.13.0).
 *
 * The obfuscator reuses short names in nested scopes (`local U = 12634606`
 * inside CFF handlers while `U` is also the string table), so a global
 * name-search aborts on legitimate shadowing. This walks the tree with real
 * Lua scoping: a reference only counts when it would bind to the (deleted)
 * outer scaffolding, i.e. no local declaration of the same name encloses it.
 * Declarations become visible AFTER their statement (init expressions still
 * see the outer scope), matching Lua's "local is visible after the statement"
 * rule; `local function f` sees itself (recursion).
 */
function danglingRefs(root, names) {
  const hits = new Set();
  const isBlockStmts = (n) => Array.isArray(n);

  const visit = (n, scopes) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c, scopes); return; }

    switch (n.type) {
      case 'Identifier': {
        if (names.has(n.name) && !scopes.some((s) => s.has(n.name))) hits.add(n.name);
        return;
      }
      case 'LocalStatement': {
        // init expressions evaluate BEFORE the names come into scope
        for (const e of n.init || []) visit(e, scopes);
        for (const v of n.variables || []) scopes[scopes.length - 1].add(v.name);
        return;
      }
      case 'AssignmentStatement':
      case 'CallStatement':
      case 'CallExpression':
      case 'ReturnStatement':
      case 'BinaryExpression':
      case 'UnaryExpression':
      case 'IndexExpression':
      case 'MemberExpression':
      case 'TableConstructorExpression':
      case 'NumericLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NilLiteral':
      case 'VarargLiteral':
      case 'LogicalExpression':
      default: {
        // function bodies & loop bodies introduce scopes; walk generically
        const isFn = n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression';
        const isLocalFn = isFn && n.isLocal === true;
        if (isLocalFn && n.identifier?.name) scopes[scopes.length - 1].add(n.identifier.name);
        if (isFn) {
          // params evaluate in a fresh scope with the function's own body
          const inner = new Set();
          for (const p of n.parameters || []) { if (p?.name) inner.add(p.name); }
          scopes.push(inner);
          visit(isBlockStmts(n.body) ? n.body : n.body?.body, scopes);
          scopes.pop();
          return;
        }
        const isLoop = n.type === 'ForGenericStatement' || n.type === 'ForNumericStatement';
        if (isLoop) {
          // header expressions live in the outer scope
          const header = n.type === 'ForGenericStatement' ? (n.iterators || []) : [n.start, n.stop, n.step].filter(Boolean);
          for (const e of header) visit(e, scopes);
          const inner = new Set();
          for (const v of n.variables || []) { if (v?.name) inner.add(v.name); }
          if (n.type === 'ForNumericStatement' && n.variable?.name) inner.add(n.variable.name);
          scopes.push(inner);
          visit(isBlockStmts(n.body) ? n.body : n.body?.body, scopes);
          scopes.pop();
          return;
        }
        if (n.type === 'WhileStatement') {
          visit(n.condition, scopes);
          visit(isBlockStmts(n.body) ? n.body : n.body?.body, scopes);
          return;
        }
        if (n.type === 'RepeatStatement') {
          // repeat: body is in scope for the until-condition
          const inner = new Set();
          scopes.push(inner);
          visit(isBlockStmts(n.body) ? n.body : n.body?.body, scopes);
          visit(n.condition, scopes);
          scopes.pop();
          return;
        }
        if (n.type === 'DoStatement' || n.type === 'Chunk') {
          visit(isBlockStmts(n.body) ? n.body : n.body?.body, scopes);
          return;
        }
        if (n.type === 'IfStatement' || n.type === 'IfClause' || n.type === 'ElseifClause' || n.type === 'ElseClause') {
          if (n.condition) visit(n.condition, scopes);
          visit(isBlockStmts(n.body) ? n.body : n.body?.body, scopes);
          if (n.clauses) for (const c of n.clauses) visit(c, scopes);
          return;
        }
        for (const [k, v] of Object.entries(n)) {
          if (k === 'range' || k === 'loc') continue;
          visit(v, scopes);
        }
      }
    }
  };

  visit(root, [new Set()]);
  return hits;
}

/** Rewrite `A(<num>)` calls to decoded literals. Returns count or -1 on any miss. */
function inlineAccessorCalls(node, accessorName, table, offset) {
  let count = 0;
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (n.type === 'CallExpression' && isIdent(n.base, accessorName)
      && n.arguments?.length === 1 && isNum(n.arguments[0])) {
      const i = n.arguments[0].value - offset; // call A(K+i) ↔ pool entry i
      if (!Number.isInteger(n.arguments[0].value) || i < 1 || i > table.length || typeof table[i - 1] !== 'string') {
        count = -1;
        return;
      }
      count += 1;
      // convert the node IN PLACE into a StringLiteral
      for (const k of Object.keys(n)) delete n[k];
      n.type = 'StringLiteral';
      n.value = table[i - 1];
      n.raw = null;
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'range' || k === 'loc') continue;
      visit(v);
    }
  };
  visit(node);
  return count;
}

/** Run the scaffolding slices in jailed fengari; return decoded pool [1..n]. */
function decodePoolInSandbox(tableSlice, rotationSrc, decoderSrc, accessorSrc, tableSize) {
  const m = /^local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(accessorSrc);
  if (!m) return null;
  const accName = m[1];

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // hard op budget BEFORE the chunk runs (the chunk itself nils debug)
  let ops = 0;
  lua.lua_sethook(L, () => {
    ops += SANDBOX_OP_BUDGET / 1000;
    if (ops > SANDBOX_OP_BUDGET * 2) {
      lauxlib.luaL_error(L, to_luastring('bx: decoder sandbox op budget exceeded'));
    }
  }, lua.LUA_MASKCOUNT, 1000);

  const queryChunk = `
os, io, require, dofile, loadfile, load, loadstring = nil, nil, nil, nil, nil, nil, nil
local U = ${tableSlice}
${rotationSrc}
${decoderSrc}
${accessorSrc}
local __out = {}
for i = 1, #U do
  local v = U[i]
  if type(v) == "string" then __out[i] = v else __out[i] = false end
end
_G.BX_POOL = __out
`;
  const rc = lauxlib.luaL_dostring(L, to_luastring(queryChunk));
  if (rc !== lua.LUA_OK) {
    return { err: lua.lua_tojsstring(L, -1) };
  }
  lua.lua_getglobal(L, to_luastring('BX_POOL'));
  const out = [];
  for (let i = 1; i <= tableSize; i++) {
    lua.lua_rawgeti(L, -1, i);
    const v = lua.lua_type(L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : null;
    out.push(v);
    lua.lua_pop(L, 1);
  }
  return { pool: out };
}

/**
 * Main entry. @param {Buffer} buffer — raw obfuscated input.
 * @returns {Promise<null | { code: string, inlined: number, poolSize: number, how: string }>}
 */
export async function prometheusDeepPass(buffer, { stage = null } = {}) {
  try {
    if (!buffer || buffer.length > MAX_BYTES) return null;
    const src = buffer.toString('utf8');
    // cheap shape gate before parsing
    if (!src.includes('ipairs(') || !src.includes('local function') || !src.includes('={')) {
      DBG('shape gate failed');
      return null;
    }

    let ast;
    try {
      ast = luaparse.parse(src, { ranges: true, luaVersion: '5.1' });
    } catch (e) {
      DBG(`parse failed: ${String(e.message).slice(0, 100)}`);
      return null;
    }

    // chunk → return(function(...) ... end)(...) wrapper
    // (luaparse types anonymous function expressions `FunctionDeclaration`)
    let wrapper = null;
    if (ast.body?.length === 1 && ast.body[0].type === 'ReturnStatement') {
      const e = ast.body[0].arguments?.[0];
      if (e?.type === 'CallExpression' && (e.base?.type === 'FunctionExpression' || e.base?.type === 'FunctionDeclaration')) wrapper = e.base;
    }
    if (!wrapper) return null;
    // luaparse function nodes carry the statement array directly on `.body`
    const body = Array.isArray(wrapper.body) ? wrapper.body : wrapper.body?.body;
    if (!Array.isArray(body) || body.length < 4) return null;

    // 1. string-table local (all-string entries)
    let tableStmt = null, tableName = null, tableNode = null;
    for (const st of body) {
      if (st.type !== 'LocalStatement' || st.variables?.length !== 1 || st.init?.length !== 1) continue;
      const t = st.init[0];
      if (t.type !== 'TableConstructorExpression' || t.fields.length < 2) continue;
      if (t.fields.every((f) => f.value && isStr(f.value))) {
        tableStmt = st; tableName = st.variables[0].name; tableNode = t;
        break;
      }
    }
    if (!tableStmt) { DBG('no string table'); return null; }
    if (tableNode.fields.length > MAX_TABLE_ENTRIES) return null;

    // 2. rotation loop
    let rotStmt = null;
    for (const st of body) {
      if (st.type !== 'ForGenericStatement') continue;
      const pairs = rotationPairs(st);
      if (pairs && referencesIdent(st, tableName)) { rotStmt = st; break; }
    }
    if (!rotStmt) { DBG('no rotation loop'); return null; }

    // 3. accessor
    let accStmt = null, acc = null;
    for (const st of body) {
      if (st.type !== 'LocalFunctionStatement' && st.type !== 'FunctionDeclaration') continue;
      const a = matchAccessor(st, tableName);
      if (a) { accStmt = st; acc = a; break; }
    }
    if (!accStmt) { DBG('no accessor'); return null; }

    // 4. decoder block: the first do…end that references the table
    let decStmt = null;
    for (const st of body) {
      if (st.type !== 'DoStatement') continue;
      if (referencesIdent(st, tableName)) { decStmt = st; break; }
    }
    if (!decStmt) { DBG('no decoder do-block'); return null; }

    // scaffolding must be distinct top-level statements
    const scaffolding = [tableStmt, rotStmt, accStmt, decStmt];
    if (new Set(scaffolding).size !== 4) { DBG('scaffolding not distinct'); return null; }

    // ---- behavioral decode: run the obfuscator's own code verbatim ----
    const tableSlice = slice(src, tableNode);
    const res = decodePoolInSandbox(
      tableSlice,
      slice(src, rotStmt),
      slice(src, decStmt),
      slice(src, accStmt),
      tableNode.fields.length,
    );
    if (!res || res.err) { DBG(`sandbox decode failed: ${res ? String(res.err).slice(0, 160) : 'no result'}`); return null; }
    const pool = res.pool;
    const decoded = pool.filter((v) => typeof v === 'string').length;
    DBG(`pool decoded ${decoded}/${pool.length}`);
    if (!decoded) return null;

    // ---- rewrite: A(<num>) → decoded literal, anywhere in the chunk ----
    // remove scaffolding first so their internal A() definitions don't count
    const removal = new Set(scaffolding);
    if (Array.isArray(wrapper.body)) wrapper.body = body.filter((st) => !removal.has(st));
    else wrapper.body.body = body.filter((st) => !removal.has(st));
    const inlined = inlineAccessorCalls(ast, acc.name, pool, acc.offset);
    if (inlined <= 0) { DBG(`inline failed (count ${inlined})`); return null; }

    // ---- gates ----
    const refs = danglingRefs(ast, new Set([acc.name, tableName]));
    if (refs.size) { DBG(`dangling refs (unshadowed): ${[...refs].join(',')}`); return null; }
    const code = emitChunk(ast);
    const v = verifyCode(code, { lang: 'lua', filename: 'prometheus-deep.lua' });
    if (v.status !== 'verified') { DBG(`verify: ${v.status} — ${String(v.detail).slice(0, 160)}`); return null; }

    return {
      code,
      inlined,
      poolSize: pool.length,
      decoded,
      how: `Prometheus deep static — string table (${decoded}/${pool.length} decoded) + rotation + decoder undone behaviorally, ${inlined} call site(s) inlined`,
    };
  } catch (e) {
    DBG(`exception: ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`);
    return null;
  }
}
