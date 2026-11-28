/**
 * Lucid Deobf Bot — post-processing passes for recovered code.
 *
 * Output purity policy: the delivered code contains ONLY deobfuscated source.
 * No "honest wall" banners, no string-aggregate headers, no engine chatter.
 *
 *   1. WALL-MARKER STRIP — drop engine annotation banners (`-- ===== … =====`,
 *      "annotated VM dump", "honest wall") so the paste starts at real code.
 *   2. TRAILING-JUNK TIDY.
 *   3. LUA BEAUTIFY — conservative indentation (string-aware, no tokenizer).
 *   4. JS BEAUTIFY — brace-depth indentation (string/comment/template aware).
 *
 * All passes are pure functions over Buffer → Buffer; never throw.
 */
import path from 'node:path';
import { redactSecrets, sanitizePaths } from './redact.js';

const LUA_EXT = new Set(['.lua', '.luac', '.glua']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);

// v2.10.0 ReDoS fix: the anchors used to use `\s*` after `^` with the `m`
// flag — `\s` crosses newlines, so on whitespace-heavy input (CRLF floods,
// blank-line seas) the engine backtracked across the whole file per line:
// 100k blank lines burned ~55 s across three passes. `[ ^\S\n ]` keeps the
// same line-local semantics and stays linear.
const NW = '[^\\S\n]';
const WALL_HEADER_RE = new RegExp(`^${NW}*--${NW}*=+${NW}*\n(?:^${NW}*--${NW}.*\n){0,12}^${NW}*--${NW}*=+${NW}*\n`, 'gm');
const HONEST_WALL_RE = new RegExp(`^${NW}*--${NW}*(?:Lucid|BypassX)\\s+Deobf\\s*[—:-]\\s+.*?(?:honest wall|annotated VM dump|stop-gap|VM dump|Pending|envelope payload decoded).*?\n(?:^${NW}*--.*\n){0,8}`, 'gim');

function stripWallMarkers(text) {
  let out = text.replace(HONEST_WALL_RE, '');
  out = out.replace(WALL_HEADER_RE, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function tidyTrailingJunk(text) {
  let out = text.replace(/\s+$/g, '\n');
  out = out.replace(/^[^\S\n]*-{3,}[^\S\n]*$/gm, '');
  return out;
}

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while',
]);

const KNOWN_LUA_ROBLOX_GLOBALS = new Set([
  'game', 'workspace', 'script', 'shared', 'math', 'string', 'table', 'task',
  'bit32', 'buffer', 'utf8', 'os', 'coroutine', 'debug', 'Instance', 'Vector3',
  'Vector2', 'CFrame', 'Color3', 'UDim', 'UDim2', 'Rect', 'Ray', 'Enum',
  'Random', 'NumberRange', 'NumberSequence', 'ColorSequence', 'Players',
  'RunService', 'HttpService', 'UserInputService', 'ReplicatedStorage',
  'TweenService', 'StarterGui', 'CoreGui', 'Lighting', 'SoundService',
  'pairs', 'ipairs', 'next', 'type', 'typeof', 'tostring', 'tonumber',
  'pcall', 'xpcall', 'error', 'assert', 'select', 'unpack', 'loadstring',
  'spawn', 'wait', 'delay', 'tick', 'time', 'print', 'warn', 'rawget', 'rawset',
]);

/**
 * Conservative, syntax-preserving Lua idiom cleanup (ported from PostProcess.luau & finalize.py).
 */
function cleanLuaIdioms(text) {
  let out = text;
  // 1. Boolean negations: not (a == b) -> a ~= b, not (a ~= b) -> a == b
  out = out.replace(/\bnot\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*==\s*([A-Za-z0-9_."']+)\s*\)/g, '$1 ~= $2');
  out = out.replace(/\bnot\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*~=\s*([A-Za-z0-9_."']+)\s*\)/g, '$1 == $2');
  // 2. Unwrap getfenv()/getgenv()/getrenv()/_G/_ENV lookups for known globals
  out = out.replace(/\b(?:getfenv|getgenv|getrenv)\(\)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, g) => (KNOWN_LUA_ROBLOX_GLOBALS.has(g) ? g : m));
  out = out.replace(/\b(?:getfenv|getgenv|getrenv)\(\)\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, (m, g) => (KNOWN_LUA_ROBLOX_GLOBALS.has(g) ? g : m));
  out = out.replace(/\b(?:_G|_ENV)\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, (m, g) => (KNOWN_LUA_ROBLOX_GLOBALS.has(g) ? g : m));
  // 3. Simplify obj["Key"] -> obj.Key and { ["key"] = v } -> { key = v } for valid non-keyword identifiers
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\]/g, (m, obj, k) => (LUA_KEYWORDS.has(k) ? m : `${obj}.${k}`));
  out = out.replace(/\{\s*\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\]\s*=/g, (m, k) => (LUA_KEYWORDS.has(k) ? m : `{ ${k} =`));
  // 4. Method call sugar: obj.Method(obj, ...) -> obj:Method(...)
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\(\1\s*,\s*/g, '$1:$2(');
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\(\1\)/g, '$1:$2()');
  // 5. Fold simple literal string method calls: ("abc"):upper() -> "ABC"
  out = out.replace(/\("([^"\n\\]{1,120})"\):(upper|lower|reverse)\(\)/g, (_, s, fn) => {
    if (fn === 'upper') return `"${s.toUpperCase()}"`;
    if (fn === 'lower') return `"${s.toLowerCase()}"`;
    return `"${s.split('').reverse().join('')}"`;
  });
  return out;
}

function stripLuaStrings(line) {
  let out = line.replace(/--\[\[[^\]]*\]\]/g, '-- ');
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return out;
}

function beautifyLua(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let depth = 0;
  let inLongString = false;
  let longBracketLevel = 0;
  for (const line of lines) {
    if (inLongString) {
      out.push(line);
      const close = line.match(/\](=*)\]/);
      if (close && close[1].length === longBracketLevel) { inLongString = false; longBracketLevel = 0; }
      continue;
    }
    const open = line.match(/\[(=*)\[(?!.*\]\1\])/);
    if (open) {
      out.push(line);
      inLongString = true;
      longBracketLevel = open[1].length;
      continue;
    }
    const stripped = stripLuaStrings(line);
    if (/^\s*(end|until|\)|\}|\])\b/.test(stripped)) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + line.replace(/^\s+/, ''));
    const openers = (stripped.match(/\b(?:then|do|repeat|function)\b/g) || []).length;
    const closers = (stripped.match(/\bend\b/g) || []).length;
    const leadingClose = /^\s*(end|until|\)|\}|\])\b/.test(stripped) ? 1 : 0;
    const net = openers - closers + leadingClose
      + (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length
      + (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length;
    if (net > 0) depth += net;
  }
  return out.join('\n');
}

function stripJsStringsAndComments(line) {
  let out = line.replace(/\/\/[^\n]*/g, '');
  out = out.replace(/\/\*[^*]*\*\//g, '');
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  out = out.replace(/`(?:[^`\\]|\\.)*`/g, '``');
  return out;
}

function beautifyJs(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let depth = 0;
  let inBlockComment = false;
  let inTemplate = false;
  for (const raw of lines) {
    const line = raw;
    if (inBlockComment) {
      out.push(line);
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (inTemplate) {
      out.push(line);
      if (/`\s*;?\s*$/.test(line)) inTemplate = false;
      continue;
    }
    if (line.includes('/*') && !line.includes('*/')) inBlockComment = true;
    const backticks = (line.match(/`/g) || []).length;
    if (backticks % 2 === 1 && !/`.*`/.test(line)) inTemplate = true;
    const stripped = stripJsStringsAndComments(line);
    const leadingClose = /^\s*[}\])]/.test(stripped) ? 1 : 0;
    if (leadingClose) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + line.replace(/^\s+/, ''));
    const net = (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length
      + (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length
      + leadingClose;
    if (net > 0) depth += net;
    else if (net < 0) depth = Math.max(0, depth + net);
  }
  return out.join('\n');
}

/**
 * Post-process one recovered file. Returns { data, passes[] }.
 */
export function postprocessFile(name, data) {
  const passes = [];
  if (!Buffer.isBuffer(data) || data.length === 0) return { data, passes };
  if (data.subarray(0, 1024).includes(0)) return { data, passes };

  let text = data.toString('utf8');
  const original = text;

  let lang = null;
  const ext = path.extname(name).toLowerCase();
  if (LUA_EXT.has(ext)) lang = 'lua';
  else if (JS_EXT.has(ext)) lang = 'js';
  else if (/\blocal\s+(function|\w)/.test(text.slice(0, 4000)) && /\bend\b/.test(text.slice(0, 4000))) lang = 'lua';
  else if (/\b(function|const|let|var)\b/.test(text.slice(0, 4000))) lang = 'js';
  if (!lang) return { data, passes };

  try {
    const stripped = stripWallMarkers(text);
    if (stripped !== text) { text = stripped; passes.push('wall-marker strip'); }
  } catch { /* ignore */ }
  try {
    const tidied = tidyTrailingJunk(text);
    if (tidied !== text) { text = tidied; passes.push('trailing-junk tidy'); }
  } catch { /* ignore */ }
  if (lang === 'lua') {
    try {
      const cleaned = cleanLuaIdioms(text);
      if (cleaned !== text) { text = cleaned; passes.push('lua idiom cleanup'); }
    } catch { /* ignore */ }
  }
  try {
    const lines = text.split('\n');
    const avgLen = lines.reduce((s, l) => s + l.length, 0) / Math.max(1, lines.length);
    const indented = lines.filter((l) => /^\s+/.test(l)).length;
    if (avgLen > 90 || (avgLen > 50 && indented < lines.length * 0.15)) {
      const beautified = lang === 'lua' ? beautifyLua(text) : beautifyJs(text);
      if (beautified && beautified.length > 0 && beautified !== text) { text = beautified; passes.push(`${lang} beautify`); }
    }
  } catch { /* best effort */ }

  text = redactSecrets(sanitizePaths(text)).replace(/\s+$/g, '\n');
  if (text !== original) passes.push('pure-output tidy');
  return { data: Buffer.from(text, 'utf8'), passes };
}

/**
 * Forced beautify for the `.beautify` command — always re-indents (no size
 * heuristics), plus the tidy passes. Never throws.
 */
export function beautifyCode(name, data) {
  const passes = [];
  try {
    if (!Buffer.isBuffer(data) || data.length === 0 || data.subarray(0, 1024).includes(0)) {
      return { data, passes };
    }
    let text = data.toString('utf8');
    const ext = path.extname(name).toLowerCase();
    const lang = LUA_EXT.has(ext) ? 'lua'
      : JS_EXT.has(ext) ? 'js'
      : (/\blocal\s+(function|\w)\b/.test(text.slice(0, 4000)) && /\bend\b/.test(text.slice(0, 4000))) ? 'lua'
      : (/\b(function|const|let|var)\b/.test(text.slice(0, 4000)) && !/\bthen\b/.test(text.slice(0, 4000))) ? 'js'
      : null;
    if (!lang) return { data, passes };

    text = stripWallMarkers(text);
    text = tidyTrailingJunk(text);
    const beautified = lang === 'lua' ? beautifyLua(text) : beautifyJs(text);
    if (beautified && beautified !== text) { text = beautified; passes.push(`${lang} beautify`); }
    text = redactSecrets(sanitizePaths(text)).replace(/\s+$/g, '\n');
    return { data: Buffer.from(text, 'utf8'), passes };
  } catch {
    return { data, passes };
  }
}
