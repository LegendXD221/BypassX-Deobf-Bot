'use strict';

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
  'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while', 'continue']);

const STDLIB = new Set(['bit32', 'string', 'table', 'math', 'os', 'coroutine', 'debug',
  'pcall', 'xpcall', 'select', 'type', 'error', 'assert', 'rawget', 'rawset', 'rawequal',
  'rawlen', 'tostring', 'tonumber', 'setmetatable', 'getmetatable', 'next', 'pairs',
  'ipairs', 'unpack', 'print', 'require', 'load', 'loadstring', 'newproxy', 'getfenv',
  'setfenv', '_G',

  'bxor', 'band', 'bor', 'bnot', 'lshift', 'rshift', 'arshift', 'lrotate', 'rrotate',
  'char', 'byte', 'sub', 'rep', 'gsub', 'gmatch', 'match', 'find', 'format', 'len',
  'concat', 'insert', 'remove', 'sort', 'pack', 'floor', 'ceil', 'abs', 'max', 'min',
  'huge', 'pi', 'fmod', 'n', '__index', '__call', '__add', '__sub', '__mul', '__div',
  '__mod', '__pow', '__idiv', '__concat', '__len', '__unm', '__eq', '__lt', '__le']);

const PUNCT3 = ['...'];
const PUNCT2 = ['==', '~=', '<=', '>=', '..', '::', '//'];

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '[') {
        const m = /^\[(=*)\[/.exec(src.slice(i + 2));
        if (m) {
          const close = ']' + m[1] + ']';
          const e = src.indexOf(close, i + 2 + m[0].length);
          i = e < 0 ? n : e + close.length;
          continue;
        }
      }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '[') {
      const m = /^\[(=*)\[/.exec(src.slice(i));
      if (m) {
        const close = ']' + m[1] + ']';
        const e = src.indexOf(close, i + m[0].length);
        const body = src.slice(i + m[0].length, e < 0 ? n : e);
        out.push({ t: 'str', v: body });
        i = e < 0 ? n : e + close.length;
        continue;
      }
    }

    if (c === '"' || c === "'") {
      let j = i + 1, buf = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          const d = src[j + 1];
          if (/\d/.test(d)) {
            const m = /^\d{1,3}/.exec(src.slice(j + 1));
            buf += String.fromCharCode(parseInt(m[0], 10));
            j += 1 + m[0].length;
          } else if (d === 'x') {
            const m = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(j + 1));
            if (m) { buf += String.fromCharCode(parseInt(m[1], 16)); j += 1 + m[0].length; }
            else { buf += d; j += 2; }
          } else if (d === 'z') {
            j += 2;
            while (j < n && /\s/.test(src[j])) j++;
          } else {
            const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
            buf += map[d] !== undefined ? map[d] : d;
            j += 2;
          }
        } else { buf += src[j]; j++; }
      }
      out.push({ t: 'str', v: buf });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.?[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i));
      const raw = m[0];
      const clean = raw.replace(/_/g, '');
      let v;
      if (/^0[bB]/.test(clean)) v = parseInt(clean.slice(2), 2);
      else v = Number(clean);
      out.push({ t: 'num', v });
      i += raw.length;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const w = m[0];
      out.push({ t: KEYWORDS.has(w) ? 'kw' : 'name', v: w });
      i += w.length;
      continue;
    }

    const three = src.substr(i, 3);
    if (PUNCT3.includes(three)) { out.push({ t: 'p', v: three }); i += 3; continue; }
    const two = src.substr(i, 2);
    if (PUNCT2.includes(two)) { out.push({ t: 'p', v: two }); i += 2; continue; }
    out.push({ t: 'p', v: c });
    i++;
  }
  return out;
}

function skeletonTokens(src, aliasTags) {
  const toks = tokenize(src);
  const out = [];
  for (const tk of toks) {
    if (tk.t === 'kw') out.push(tk.v);
    else if (tk.t === 'p') out.push(tk.v);
    else if (tk.t === 'num') out.push('#' + tk.v);
    else if (tk.t === 'str') out.push('"' + tk.v + '"');
    else {
      const tag = aliasTags && aliasTags.get(tk.v);
      if (tag) out.push(tag);
      else if (STDLIB.has(tk.v)) out.push(tk.v);
      else out.push('$V');
    }
  }
  return out;
}

function skeleton(src, aliasTags) {
  return skeletonTokens(src, aliasTags).join(' ');
}

module.exports = { tokenize, skeletonTokens, skeleton, KEYWORDS, STDLIB };
