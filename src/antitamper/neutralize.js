/**
 * BypassX Deobf Bot — AntiTamper V2 static neutralizer.
 *
 * Defuses anti-tamper kill switches in the source BEFORE any dynamic run:
 *
 *   1. LPH_CRASH / LPH_PRECHECK call statements        → removed (no-op `;`)
 *   2. LPH_PRECHECK / LPH_CRASH function definitions   → body emptied (callers
 *      then invoke a no-op validator instead of executing the whitelist)
 *   3. fingerprint-gated kill statements               → removed. An `if` whose
 *      test calls an executor/environment probe (identifyexecutor,
 *      checkcaller, islclosure, getrawmetatable, HttpGet, … or compares
 *      against executor names / the 45195195 Luraph magic) and whose body is
 *      ONLY kill statements (error / os.exit / LPH_CRASH / a known crash
 *      helper / `while true do end` / bare return) is pure kill logic — the
 *      probe's value is never used for decryption, so deleting it cannot
 *      change the payload.
 *   4. `while true do end` spin bombs                  → removed
 *   5. pcall/task.spawn-wrapped suicide threads        → removed when the
 *      spawned body is kill-only
 *
 * Safety contract (never break a build):
 *   • the output is re-parsed before it is returned — ANY transform that
 *     makes the file unparsable reverts the whole neutralization;
 *   • sources that do not parse at all (Luau-only syntax) get the conservative
 *     regex tier (complete-statement removals only);
 *   • a source with zero hits passes through BYTE-IDENTICAL.
 */

import luaparse from 'luaparse';
import { matchCatalog } from './catalog.js';

const FP_FUNCS = new Set([
  'identifyexecutor', 'getexecutorname', 'checkcaller', 'islclosure', 'isLclosure',
  'is_l_closure', 'iscclosure', 'checkclosure', 'isexecutorclosure',
  'is_executor_closure', 'newcclosure', 'hookfunction', 'replaceclosure',
  'hookmetamethod', 'getrawmetatable', 'getgenv', 'getrenv', 'getregistry',
  'getreg', 'getsenv', 'getcallingscript', 'getscriptbytecode',
  'getloadedmodules', 'gethui', 'cloneref', 'compareinstances',
  'getconnections', 'getgc', 'getconstants', 'getconstant', 'getprotos',
  'getupvalues', 'getupvalue', 'getstack', 'getthreadidentity', 'isreadonly',
  'setreadonly', 'gethiddenproperty', 'sethiddenproperty', 'queue_on_teleport',
  'HttpGet', 'HttpPost', 'readfile', 'isfile', 'writefile', 'appendfile',
  'isfolder', 'request', 'http_request', 'websocket',
]);

const KILL_FUNCS = new Set(['error', 'assert', 'os.exit', 'LPH_CRASH', 'LPH_PRECHECK']);
const EXECUTOR_NAME_RE = /(synapse|script.?ware|krnl|fluxus|hydrogen|oxygen.?u|sentinel|protosmasher|delta|solara|wave|swift)/i;
const LURAPH_MAGIC = 45195195;
const CRASH_NAME_RE = /^(crash|die|kill|anticrash|fail|suicide|_crash|__crash)/i;

// ---- AST helpers -----------------------------------------------------------

function walk(node, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, cb); return; }
  if (typeof node.type !== 'string') return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'range' || key === 'loc' || key === 'comments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walk(v, cb);
  }
}

/** Name of a called function, or '' (covers Identifier + MemberExpression). */
function calleeName(expr) {
  if (!expr) return '';
  if (expr.type === 'Identifier') return expr.name || '';
  if (expr.type === 'MemberExpression') {
    const id = expr.identifier;
    return id && id.name ? id.name : '';
  }
  return '';
}

/** Full dotted name for MemberExpression bases like `os.exit` → 'os.exit'. */
function calleeDotted(expr) {
  if (!expr) return '';
  if (expr.type === 'Identifier') return expr.name || '';
  if (expr.type === 'MemberExpression') {
    const base = calleeDotted(expr.base);
    const id = expr.identifier && expr.identifier.name ? expr.identifier.name : '';
    return base ? `${base}.${id}` : id;
  }
  return '';
}

function isCallStmt(stmt) { return stmt && stmt.type === 'CallStatement'; }
function isTrueCond(cond) {
  return cond && cond.type === 'BooleanLiteral' && cond.value === true;
}

/** Does this statement subtree contain ONLY kill logic? */
function isKillOnlyStatement(stmt, crashFns) {
  if (!stmt || typeof stmt !== 'object') return false;
  switch (stmt.type) {
    case 'CallStatement': {
      const name = calleeDotted(stmt.expression && stmt.expression.base);
      if (KILL_FUNCS.has(name)) return true;
      if (crashFns.has(calleeName(stmt.expression && stmt.expression.base))) return true;
      // pcall/task.spawn-wrapped suicide threads (kill-only function target)
      if (name === 'pcall' || name === 'task.spawn' || name === 'spawn' || name === 'task.defer') {
        const first = (stmt.expression && stmt.expression.arguments || [])[0];
        if (fnIsKillOnly(first, crashFns)) return true;
      }
      return false;
    }
    case 'WhileStatement':
      return isTrueCond(stmt.condition) && (stmt.body.length === 0 || stmt.body.every((s) => isKillOnlyStatement(s, crashFns)));
    case 'RepeatStatement':
      return stmt.body.every((s) => isKillOnlyStatement(s, crashFns));
    case 'DoStatement':
      return (stmt.body || []).length === 0 || stmt.body.every((s) => isKillOnlyStatement(s, crashFns));
    case 'ReturnStatement':
      return true; // bare/silent return gate
    default:
      return false;
  }
}

function blockIsKillOnly(body, crashFns) {
  if (!Array.isArray(body)) return false;
  if (body.length === 0) return true;
  return body.every((s) => isKillOnlyStatement(s, crashFns));
}

/** Does the expression tree call a fingerprint probe / compare executor names / the Luraph magic? */
function testIsFingerprint(node) {
  let hit = false;
  walk(node, (n) => {
    if (hit || !n.type) return;
    if (n.type === 'CallExpression') {
      const name = calleeName(n.base);
      if (FP_FUNCS.has(name)) { hit = true; return; }
    }
    if (n.type === 'StringLiteral' && typeof n.raw === 'string' && EXECUTOR_NAME_RE.test(n.raw)) hit = true;
    if (n.type === 'NumericLiteral' && n.value === LURAPH_MAGIC) hit = true;
  });
  return hit;
}

/** Body of a function node that is kill-only (suicide threads). */
function fnIsKillOnly(fnNode, crashFns) {
  // this luaparse types inline `function() ... end` arguments as
  // FunctionDeclaration — accept every function shape
  return fnNode && (fnNode.type === 'FunctionExpression' || fnNode.type === 'FunctionDeclaration' || fnNode.type === 'ArrowFunctionExpression')
    && blockIsKillOnly(fnNode.body, crashFns);
}

// ---- parser wrapper ---------------------------------------------------------

function tryParse(src) {
  try {
    return luaparse.parse(src, { luaVersion: '5.3', ranges: true, comments: false });
  } catch {
    try {
      return luaparse.parse(src, { luaVersion: 'LuaJIT', ranges: true, comments: false });
    } catch {
      return null;
    }
  }
}

function parseOk(src) { return tryParse(src) !== null; }

// ---- core AST pass -----------------------------------------------------------

/**
 * Collect edits (start, end, text) from the AST.
 * @returns {Array<{start,end,text,id}>}
 */
function collectEdits(src, ast) {
  const edits = [];
  const crashFns = new Set();

  // pass 1: find named crash helpers (kill-only bodies)
  walk(ast, (n) => {
    if ((n.type === 'FunctionDeclaration') && n.identifier && n.identifier.name && CRASH_NAME_RE.test(n.identifier.name)) {
      if (blockIsKillOnly(n.body, crashFns)) crashFns.add(n.identifier.name);
    }
  });

  // pass 2: transform sites
  walk(ast, (n) => {
    // 1+2. LPH_CRASH / LPH_PRECHECK statements and definitions
    if (n.type === 'FunctionDeclaration' && n.identifier && (n.identifier.name === 'LPH_PRECHECK' || n.identifier.name === 'LPH_CRASH')) {
      const kw = n.isLocal ? 'local function ' : 'function ';
      edits.push({ start: n.range[0], end: n.range[1], text: `${kw}${n.identifier.name}() end`, id: n.identifier.name === 'LPH_PRECHECK' ? 'lph-precheck' : 'lph-crash' });
      return;
    }
    if (isCallStmt(n)) {
      const cname = calleeName(n.expression && n.expression.base);
      const dotted = calleeDotted(n.expression && n.expression.base);
      if (cname === 'LPH_CRASH' || cname === 'LPH_PRECHECK') {
        edits.push({ start: n.range[0], end: n.range[1], text: ';', id: cname === 'LPH_CRASH' ? 'lph-crash' : 'lph-precheck' });
        return;
      }
      // named crash helper call sites (defused only when helper is kill-only)
      if (crashFns.has(cname) && n.range) {
        edits.push({ start: n.range[0], end: n.range[1], text: ';', id: 'ks-crash-func' });
        return;
      }
      // pcall/task.spawn suicide threads
      if (dotted === 'pcall' || dotted === 'task.spawn' || dotted === 'spawn' || dotted === 'task.defer') {
        const args = (n.expression && n.expression.arguments) || [];
        const first = args[0];
        if (fnIsKillOnly(first, crashFns) && n.range) {
          edits.push({ start: n.range[0], end: n.range[1], text: ';', id: 'ks-pcall-suicide' });
          return;
        }
      }
      // os.exit direct call (jail os has no exit — this is kill-only by shape)
      if (dotted === 'os.exit' && n.range) {
        edits.push({ start: n.range[0], end: n.range[1], text: ';', id: 'ks-os-exit' });
      }
      return;
    }

    // 3. fingerprint-gated kill if-statements
    if (n.type === 'IfStatement' && n.range) {
      const clauses = n.clauses || [];
      if (!clauses.length) return;
      const first = clauses[0];
      if (!testIsFingerprint(first.condition)) return;
      if (!blockIsKillOnly(first.body, crashFns)) return;
      // all remaining clauses (elseif/else) must also be kill-only or absent
      const rest = clauses.slice(1);
      if (!rest.every((c) => blockIsKillOnly(c.body, crashFns))) return;
      edits.push({ start: n.range[0], end: n.range[1], text: ';', id: 'ks-error-gate' });
      return;
    }

    // 4. while true do end spin bombs (standalone, empty body)
    if (n.type === 'WhileStatement' && n.range && isTrueCond(n.condition) && Array.isArray(n.body) && n.body.length === 0) {
      edits.push({ start: n.range[0], end: n.range[1], text: ';', id: 'ks-while-true' });
      return;
    }
    // 4b. while true do <kill-only> end (e.g. while true do error(...) end)
    if (n.type === 'WhileStatement' && n.range && isTrueCond(n.condition) && Array.isArray(n.body)
      && n.body.length > 0 && n.body.every((s) => isKillOnlyStatement(s, crashFns))) {
      edits.push({ start: n.range[0], end: n.range[1], text: ';', id: 'ks-error-gate' });
    }
  });

  // overlap resolution: later-in-list edits must not overlap earlier ones —
  // sort by start; drop any edit overlapping a kept one (keeps outer, drops nested)
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const e of edits) {
    const last = kept[kept.length - 1];
    if (last && e.start < last.end) continue;
    kept.push(e);
  }
  return kept;
}

// ---- conservative regex tier (Luau sources that do not parse) ----------------

const REGEX_RULES = [
  { re: /\bLPH_CRASH\s*\(\s*\)\s*;?/g, text: '', id: 'lph-crash' },
  { re: /\bLPH_PRECHECK\s*\(\s*\)\s*;?/g, text: '', id: 'lph-precheck' },
  { re: /while\s+true\s+do\s+end/g, text: '', id: 'ks-while-true' },
];

// ---- public API ---------------------------------------------------------------

/**
 * Neutralize anti-tamper logic in a Lua source.
 * @param {string} source
 * @param {{catalogScan?: boolean}} [opts]
 * @returns {{code: string, changed: boolean, report: {
 *   parsed: 'ast'|'regex'|'none', edits: Array<{id, kind, count}>,
 *   defused: string[], bytesSaved: number, hits: number[] }}}
 */
export function neutralize(source, opts = {}) {
  const original = String(source || '');
  const emptyReport = { parsed: 'none', edits: [], defused: [], bytesSaved: 0, hits: [] };
  if (!original) return { code: original, changed: false, report: emptyReport };

  const ast = original.length <= 8 * 1024 * 1024 ? tryParse(original) : null;

  if (ast) {
    const edits = collectEdits(original, ast);
    if (!edits.length) {
      return { code: original, changed: false, report: { ...emptyReport, parsed: 'ast' } };
    }
    let out = original;
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    if (out === original) {
      // edits produced byte-identical output (e.g. re-neutralizing an already
      // stubbed LPH_PRECHECK) — report unchanged, stay idempotent
      return { code: original, changed: false, report: { ...emptyReport, parsed: 'ast' } };
    }
    if (!parseOk(out)) {
      // never break a build — revert to the original bytes
      return { code: original, changed: false, report: { ...emptyReport, parsed: 'ast' } };
    }
    return { code: out, changed: true, report: summarize(original, out, edits, 'ast') };
  }

  // regex tier for unparsable (Luau) sources — complete-statement removals only
  if (original.length > 8 * 1024 * 1024) return { code: original, changed: false, report: { ...emptyReport, parsed: 'none' } };
  const edits = [];
  let out = original;
  for (const rule of REGEX_RULES) {
    out = out.replace(rule.re, (m, ...a) => {
      if (m) edits.push({ start: (a.length > 1 ? a[a.length - 2] : 0), end: 0, text: rule.text, id: rule.id });
      return rule.text;
    });
  }
  if (!edits.length) return { code: original, changed: false, report: { ...emptyReport, parsed: 'none' } };
  // normalize edit records for the summary (positions are unreliable here)
  const summaryEdits = groupEdits(edits.map((e) => ({ ...e, start: 0, end: 0 })));
  return { code: out, changed: true, report: { parsed: 'regex', ...summaryEdits, bytesSaved: original.length - out.length, hits: [] } };
}

function groupEdits(edits) {
  const byId = new Map();
  for (const e of edits) {
    const rec = byId.get(e.id) || { id: e.id, kind: kindOf(e.id), count: 0 };
    rec.count += 1;
    byId.set(e.id, rec);
  }
  const list = [...byId.values()];
  return { edits: list, defused: list.map((e) => e.id) };
}

function kindOf(id) {
  if (id.startsWith('lph')) return 'luraph-macro';
  if (id === 'ks-crash-func' || id === 'ks-pcall-suicide' || id === 'ks-os-exit') return 'kill-primitive';
  if (id === 'ks-while-true') return 'spin-bomb';
  return 'kill-gate';
}

function summarize(original, out, edits, parsed) {
  const { edits: list, defused } = groupEdits(edits);
  // catalog cross-reference: which catalog vectors did we touch?
  const hits = matchCatalog(original).map((h) => h.id);
  return {
    parsed,
    edits: list,
    defused,
    bytesSaved: original.length - out.length,
    hits: hits.filter((id) => defused.includes(id)),
  };
}

/**
 * Scan-only variant used by the pipeline for detection/telemetry.
 * @returns {boolean} true when the sample is executor-gated (escalation trigger)
 */
export { isExecutorGated } from './catalog.js';
