/**
 * BypassX Deobf Bot — post-processing passes for recovered code.
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

const LUA_EXT = new Set(['.lua', '.luac', '.glua']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);

const WALL_HEADER_RE = /^\s*--\s*=+\s*\n(?:^\s*--\s.*\n){0,12}^\s*--\s*=+\s*\n/gm;
const HONEST_WALL_RE = /^\s*--\s*BypassX\s+Deobf\s*[—:-]\s+.*?(?:honest wall|annotated VM dump|stop-gap|VM dump|Pending|envelope payload decoded).*?\n(?:^\s*--.*\n){0,8}/gim;

function stripWallMarkers(text) {
  let out = text.replace(HONEST_WALL_RE, '');
  out = out.replace(WALL_HEADER_RE, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function tidyTrailingJunk(text) {
  let out = text.replace(/\s+$/g, '\n');
  out = out.replace(/^\s*-{3,}\s*$/gm, '');
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
    const openers = stripped.match(/\b(?:then|do|repeat)\b/g) || [];
    const trailingFn = /function\b[^end]*$/.test(stripped);
    const net = openers.length + (trailingFn ? 1 : 0)
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
    if (/^\s*[}\])]/.test(stripped)) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + line.replace(/^\s+/, ''));
    const net = (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length
      + (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length;
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
  try {
    const lines = text.split('\n');
    const avgLen = lines.reduce((s, l) => s + l.length, 0) / Math.max(1, lines.length);
    const indented = lines.filter((l) => /^\s+/.test(l)).length;
    if (avgLen > 90 || (avgLen > 50 && indented < lines.length * 0.15)) {
      const beautified = lang === 'lua' ? beautifyLua(text) : beautifyJs(text);
      if (beautified && beautified.length > 0 && beautified !== text) { text = beautified; passes.push(`${lang} beautify`); }
    }
  } catch { /* best effort */ }

  text = text.replace(/\s+$/g, '\n');
  if (text !== original) passes.push('pure-output tidy');
  return { data: Buffer.from(text, 'utf8'), passes };
}
