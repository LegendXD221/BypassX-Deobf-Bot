'use strict';

const ESC = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };

function ws(s, i) {
  for (;;) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
    if (s[i] === '-' && s[i + 1] === '-') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    return i;
  }
}

function readString(s, i) {
  const q = s[i++];
  let out = '';
  for (;;) {
    if (i >= s.length) throw new Error('unterminated string');
    const c = s[i];
    if (c === q) return [out, i + 1];
    if (c !== '\\') { out += c; i++; continue; }
    i++;
    const e = s[i];
    if (e >= '0' && e <= '9') {
      let d = '';
      while (d.length < 3 && s[i] >= '0' && s[i] <= '9') d += s[i++];
      out += String.fromCharCode(parseInt(d, 10) & 0xFF);
      continue;
    }
    if (e === 'x' || e === 'X') {
      let d = '';
      i++;
      while (d.length < 2 && /[0-9a-fA-F]/.test(s[i] || '')) d += s[i++];
      out += String.fromCharCode(parseInt(d, 16));
      continue;
    }
    if (e === 'z') { i++; i = ws(s, i); continue; }
    if (ESC[e] === undefined) throw new Error('unknown escape \\' + e);
    out += ESC[e];
    i++;
  }
}

function readValue(s, i) {
  i = ws(s, i);
  const c = s[i];
  if (c === undefined) throw new Error('value expected');
  if (c === '"' || c === "'") return readString(s, i);
  if (c === '{') return readTable(s, i);
  if (c === '-' || (c >= '0' && c <= '9')) {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(s.slice(i));
    if (!m) throw new Error('bad number at ' + i);
    const t = m[0];
    const neg = t[0] === '-';
    const body = neg ? t.slice(1) : t;
    const v = /^0[xX]/.test(body) ? parseInt(body, 16) : parseFloat(body);
    return [neg ? -v : v, i + t.length];
  }
  const w = /^[A-Za-z_]\w*/.exec(s.slice(i));
  if (!w) throw new Error('value expected at ' + i);
  const id = w[0];
  const j = i + id.length;
  if (id === 'true') return [true, j];
  if (id === 'false') return [false, j];
  if (id === 'nil') return [null, j];
  return [{ ident: id }, j];
}

function readTable(s, i) {
  if (s[i] !== '{') throw new Error('table expected');
  i = ws(s, i + 1);
  const arr = [];
  const keys = new Map();
  if (s[i] === '}') return [arr, i + 1];
  for (;;) {
    i = ws(s, i);
    let key = null;
    if (s[i] === '[') {
      const r = readValue(s, i + 1);
      key = r[0];
      i = ws(s, r[1]);
      if (s[i] !== ']') throw new Error('] expected');
      i = ws(s, i + 1);
      if (s[i] !== '=') throw new Error('= expected');
      i++;
    } else {
      const nm = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(s.slice(i));
      if (nm) { key = nm[1]; i += nm[0].length; }
    }
    const r = readValue(s, i);
    if (key === null) arr.push(r[0]); else keys.set(key, r[0]);
    i = ws(s, r[1]);
    if (s[i] === ',' || s[i] === ';') { i = ws(s, i + 1); if (s[i] === '}') { i++; break; } continue; }
    if (s[i] === '}') { i++; break; }
    throw new Error(', or } expected at ' + i);
  }
  if (keys.size) Object.defineProperty(arr, 'keys', { value: keys, enumerable: false });
  return [arr, i];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tableOf(core, name) {
  const re = new RegExp(`(^|[;\\n])\\s*(?:local\\s+)?${esc(name)}\\s*=\\s*\\{`, 'g');
  const hits = [];
  for (const m of core.matchAll(re)) hits.push(m.index + m[0].length - 1);
  if (hits.length !== 1) throw new Error(`${name}: ${hits.length} table assignments`);
  return readTable(core, hits[0])[0];
}

function entryCall(core) {
  const all = [...core.matchAll(/return\s+([A-Za-z_]\w*)\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/gm)];
  for (let i = all.length - 1; i >= 0; i--) {
    const args = splitArgs(all[i][2]);
    if (args.length < 7) continue;
    if (args[3] !== '{}') continue;
    const nParams = Number(args[4]), maxRegs = Number(args[5]);
    if (!Number.isFinite(nParams) || !Number.isFinite(maxRegs)) continue;
    if (args[6] !== 'true' && args[6] !== 'false') continue;
    if (!/^[A-Za-z_]\w*$/.test(args[0]) || !/^[A-Za-z_]\w*$/.test(args[1])) continue;
    return {
      run: all[i][1], kName: args[0], codeName: args[1], protoName: args[2],
      nParams, maxRegs, isVararg: args[6] === 'true',
    };
  }
  throw new Error('no runner entry call');
}

function splitArgs(text) {
  const out = [];
  let depth = 0, cur = '', q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === '\\') { cur += text[++i] || ''; } else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function chainNames(core) {
  const m = core.match(
    /([A-Za-z_]\w*)=function\(_0ps\) for _,_0p in ipairs\(_0ps\) do ([A-Za-z_]\w*)\(_0p\[1\]\);([A-Za-z_]\w*)\(_0p\[1\]\);if _0p\[3\] then \1\(_0p\[3\]\) end end end/);
  if (!m) throw new Error('no proto walker');
  return { walker: m[1], pre: m[2], all: m[3] };
}

function chainOrder(core, allName) {
  const body = fnBody(core, allName);

  let m = body.match(/for _0oi=1,#([A-Za-z_]\w*) do ([A-Za-z_]\w*)\[\1\[_0oi\]\]\(_0K\) end/);
  if (m) {
    const ord = tableOf(core, m[1]);
    const tbl = tableOf(core, m[2]);
    const keys = tbl.keys || new Map();
    return ord.map((k) => {
      const fn = keys.get(k) !== undefined ? keys.get(k) : tbl[k - 1];
      if (!fn || !fn.ident) throw new Error('chain slot ' + k + ' is not a function');
      return fn.ident;
    });
  }

  const guarded = [...body.matchAll(/if [^;]*? then ([A-Za-z_]\w*)\(_0K\) end/g)].map(x => x[1]);
  if (guarded.length) return guarded;

  const bare = [...body.matchAll(/([A-Za-z_]\w*)\(_0K\)/g)].map(x => x[1]);
  if (bare.length) return bare;
  throw new Error('chain driver unreadable');
}

function fnBody(core, name) {
  const m = core.match(new RegExp(`(^|[;\\n])\\s*(?:local\\s+)?${esc(name)}\\s*=\\s*function\\(`));
  if (!m) throw new Error(name + ': no function');
  let i = core.indexOf('(', m.index + m[0].length - 1);
  i = core.indexOf(')', i) + 1;
  const start = i;
  let depth = 1, q = '';
  const toDo = (j) => {
    const d = /\bdo\b/.exec(core.slice(j));
    return d ? j + d.index + 2 : j;
  };
  while (i < core.length) {
    if (q) { if (core[i] === '\\') i++; else if (core[i] === q) q = ''; i++; continue; }
    const ch = core[i];
    if (ch === '"' || ch === "'") { q = ch; i++; continue; }
    if (/\w/.test(core[i - 1] || '')) { i++; continue; }
    const rest = core.slice(i, i + 10);
    if (/^elseif\b/.test(rest)) { i += 6; continue; }
    let kw = /^(function|if|do)\b/.exec(rest);
    if (kw) { depth++; i += kw[1].length; continue; }
    kw = /^(while|for)\b/.exec(rest);
    if (kw) { depth++; i = toDo(i + kw[1].length); continue; }
    if (/^end\b/.test(rest)) { depth--; i += 3; if (depth === 0) return core.slice(start, i - 3); continue; }
    i++;
  }
  throw new Error(name + ': unbalanced function');
}

const SALT = 'local _0s=bit32.band(_0i-1,0xFF)';

function classify(core, name) {
  const body = fnBody(core, name);
  if (/type\(_0K\[_0i\]\)=="string"/.test(body) && /string\.byte\(/.test(body)) return { kind: 'pre' };
  if (/string\.char\(_0v\[_0j\]\)/.test(body) && /_0K\[_0i\]=/.test(body)) return { kind: 'final' };
  if (!body.includes(SALT)) throw new Error(name + ': not salted, so it is a decoy');
  let m;
  m = body.match(/bxor\(_0v\[_0j\],\(([A-Za-z_]\w*)\[\(_0j-1\)%512\]\+_0s\)%251\)/);
  if (m) { const l = spiralLut(core, m[1]); return { kind: 'spiral', wrap: true, SP: l.SP, SO: l.SO }; }
  m = body.match(/local _0a=(\d+)\+_0s;[\s\S]*?_0a%251\);_0a=_0a\+(\d+)/);
  if (m) return { kind: 'spiral', wrap: false, SO: +m[1], SP: +m[2] };
  m = body.match(/bxor\(_0v\[_0j\],\(\(_0j-1\)\*(\d+)\+(\d+)\+_0s\)%251\)/);
  if (m) return { kind: 'spiral', wrap: false, SP: +m[1], SO: +m[2] };
  m = body.match(/_0k=bit32\.band\((\d+)\+_0s\+_0h\*(\d+),0xFF\) else _0k=bit32\.band\((\d+)\+_0s\+_0h\*(\d+),0xFF\)/);
  if (m) return { kind: 'check', KA: +m[1], SA: +m[2], KB: +m[3], SB: +m[4] };
  m = body.match(/band\((\d+)\+_0s\+math\.floor\(\(_0j-1\)\/2\)\*(\d+),0xFF\)[\s\S]*?band\((\d+)\+_0s\+math\.floor\(\(_0j-1\)\/2\)\*(\d+),0xFF\)/);
  if (m) return { kind: 'check', KA: +m[1], SA: +m[2], KB: +m[3], SB: +m[4] };
  m = body.match(/local _0ea,_0eb=(\d+)\+_0s,(\d+)\+_0s;[\s\S]*?_0ea=_0ea\+(\d+)[\s\S]*?_0eb=_0eb\+(\d+)/);
  if (m) return { kind: 'check', KA: +m[1], KB: +m[2], SA: +m[3], SB: +m[4] };
  m = body.match(/band\(_0v\[_0j-1\]\*(\d+)\+(\d+)\+_0s,0xFF\)/);
  if (m) return { kind: 'cascade', CM: +m[1], CK: +m[2] };
  m = body.match(/local _0p=_0v\[1\];[\s\S]*?band\(_0p\*(\d+)\+(\d+)\+_0s,0xFF\)/);
  if (m) return { kind: 'cascade', CM: +m[1], CK: +m[2] };
  m = body.match(/\[_0k\]=bit32\.band\((\d+)\+_0s\+\(_0k-1\)\*(\d+),0xFF\)/);
  if (m) return { kind: 'helix', HS: +m[1], HM: +m[2] };
  m = body.match(/local _0a=(\d+)\+_0s;[\s\S]*?\+256,0xFF\);_0a=_0a\+(\d+)/);
  if (m) return { kind: 'helix', HS: +m[1], HM: +m[2] };
  m = body.match(/band\(_0v\[_0j\]-bit32\.band\((\d+)\+_0s\+\(_0j-1\)\*(\d+),0xFF\)\+256,0xFF\)/);
  if (m) return { kind: 'helix', HS: +m[1], HM: +m[2] };
  m = body.match(/bxor\(([A-Za-z_]\w*)\[_0v\[_0j\]\+1\],bit32\.band\(_0s\+_0j-1,0xFF\)\)/);
  if (m) return { kind: 'sbox', inv: sboxInverse(core, body, m[1]) };
  throw new Error(name + ': transform not recognised');
}

function spiralLut(core, name) {
  const m = core.match(new RegExp(`${esc(name)}\\[_0k\\]=\\(_0k\\*(\\d+)\\+(\\d+)\\)%251`));
  if (!m) throw new Error(name + ': spiral table has no builder');
  return { SP: +m[1], SO: +m[2] };
}

function numsOf(core, name) {
  const t = tableOf(core, name);
  for (const v of t) if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(name + ': not a byte table');
  return t;
}

function sboxInverse(core, body, name) {
  const inline = body.match(new RegExp(`local ${esc(name)}\\s*=\\s*\\{`));
  if (inline) return permCheck(readTable(body, body.indexOf('{', inline.index))[0], name);
  const n = esc(name);
  let m = core.match(new RegExp(`for _0k=1,128 do ${n}\\[_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] end;for _0k=1,128 do ${n}\\[128\\+_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] end`));
  if (m) return permCheck(numsOf(core, m[1]).concat(numsOf(core, m[2])), name);
  m = core.match(new RegExp(`if _0k<=64 then ${n}\\[_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] else ${n}\\[_0k\\]=([A-Za-z_]\\w*)\\[_0k-64\\][\\s\\S]*?if _0k<=64 then ${n}\\[128\\+_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] else ${n}\\[192\\+_0k-64\\]=([A-Za-z_]\\w*)\\[_0k-64\\]`));
  if (!m) m = core.match(new RegExp(`for _0k=1,64 do ${n}\\[_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] end;for _0k=1,64 do ${n}\\[64\\+_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] end;for _0k=1,64 do ${n}\\[128\\+_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] end;for _0k=1,64 do ${n}\\[192\\+_0k\\]=([A-Za-z_]\\w*)\\[_0k\\] end`));
  if (!m) {
    const s = core.match(new RegExp(`local ([A-Za-z_]\\w*)=\\{([A-Za-z_]\\w*),([A-Za-z_]\\w*),([A-Za-z_]\\w*),([A-Za-z_]\\w*)\\};for _0k=0,255 do [\\s\\S]*?${n}\\[_0k\\+1\\]=\\1\\[`));
    if (s) m = [s[0], s[2], s[3], s[4], s[5]];
  }
  if (!m) throw new Error(name + ': s-box table has no builder');
  let out = [];
  for (let i = 1; i <= 4; i++) {
    const part = numsOf(core, m[i]);
    if (part.length !== 64) throw new Error(m[i] + ': quarter is ' + part.length + ' long');
    out = out.concat(part);
  }
  return permCheck(out, name);
}

function permCheck(t, name) {
  if (t.length !== 256) throw new Error(name + ': s-box is ' + t.length + ' long');
  const seen = new Uint8Array(256);
  for (const v of t) {
    if (typeof v !== 'number' || v < 0 || v > 255 || !Number.isInteger(v)) throw new Error(name + ': entry out of range');
    if (seen[v]) throw new Error(name + ': entry ' + v + ' repeats');
    seen[v] = 1;
  }
  return t;
}

function step(d, v, s) {
  const n = v.length;
  if (d.kind === 'spiral') {
    for (let j = 0; j < n; j++) {
      const t = d.wrap ? j % 512 : j;
      v[j] ^= (((t * d.SP + d.SO) % 251) + s) % 251;
    }
    return v;
  }
  if (d.kind === 'check') {
    for (let j = 0; j < n; j++) {
      const h = j >> 1;
      v[j] ^= (j & 1) === 0 ? (d.KA + s + h * d.SA) & 0xFF : (d.KB + s + h * d.SB) & 0xFF;
    }
    return v;
  }
  if (d.kind === 'cascade') {
    for (let j = 1; j < n; j++) v[j] ^= (v[j - 1] * d.CM + d.CK + s) & 0xFF;
    return v;
  }
  if (d.kind === 'helix') {
    for (let j = 0; j < n; j++) v[j] = (v[j] - ((d.HS + s + j * d.HM) & 0xFF) + 256) & 0xFF;
    return v;
  }
  if (d.kind === 'sbox') {
    for (let j = 0; j < n; j++) v[j] = d.inv[v[j]] ^ ((s + j) & 0xFF);
    return v;
  }
  if (d.kind === 'final') {
    let out = '';
    for (let j = 0; j < n; j++) out += String.fromCharCode(v[j]);
    return out;
  }
  throw new Error('unknown step ' + d.kind);
}

function chainOver(pool, steps) {
  for (let i = 0; i < pool.length; i++) {
    const v = pool[i];
    if (v === null || v === undefined) break;
    if (typeof v === 'string') pool[i] = strBytes(v);
  }
  for (const d of steps) {
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (v === null || v === undefined) break;
      if (!Array.isArray(v)) continue;
      pool[i] = step(d, v, i & 0xFF);
    }
  }
  return pool;
}

function strBytes(s) {
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
  return out;
}

function decodeStream(code, tConsts, shufMap, slots) {
  if (code.length % 4 !== 0) throw new Error('code stream is ' + code.length + ' words, not whole instructions');
  const [tA, tB, tC] = tConsts;
  const out = new Array(code.length);
  for (let i = 0; i < code.length; i += 4) {
    const w = code[i];
    if (!Number.isInteger(w) || w < 0 || w > 255) throw new Error('word ' + i + ' is not an opcode byte');
    const h = i + 1;
    const enc = w ^ ((tA + h * tB + Math.imul(h, h) * tC) & 0xFF);
    const canon = shufMap[String(enc)];
    if (canon === undefined) throw new Error('opcode ' + enc + ' at word ' + i + ' has no handler');
    const op = Number(canon);
    const p = slots[String(enc)];
    if (!p && op !== 0) throw new Error('opcode ' + enc + ' at word ' + i + ' has no operand layout');
    const q = p || [1, 2, 3];
    out[i] = op;
    out[i + 1] = code[i + q[0]];
    out[i + 2] = code[i + q[1]];
    out[i + 3] = code[i + q[2]];
  }
  return out;
}

const KINDS = 'spiral,check,cascade,helix,sbox,final';

function protoList(core, list, steps, inv) {
  return list.map((p) => {
    if (!Array.isArray(p)) throw new Error('proto is not a table');
    if (p[0] === undefined && p.keys) throw new Error('proto uses named fields');
    if (!Array.isArray(p[1])) throw new Error('proto has no code');
    return {
      K: chainOver(Array.isArray(p[0]) ? p[0] : [], steps),
      code: decodeStream(p[1], inv.tConsts, inv.shufMap, inv.slots),
      protos: Array.isArray(p[2]) ? protoList(core, p[2], steps, inv) : [],
      upvalues: Array.isArray(p[3]) ? p[3].map(u => [u[0] | 0, u[1] | 0]) : [],
      nParams: p[4] | 0,
      maxRegs: p[5] | 0,
      isVararg: p[6] === true,
    };
  });
}

function recover(core, inv) {
  const e = entryCall(core);
  const names = chainNames(core);
  if (classify(core, names.pre).kind !== 'pre') throw new Error('pre pass is not the byte splitter');
  const order = chainOrder(core, names.all);
  if (order.length !== 6) throw new Error('chain runs ' + order.length + ' steps, not 6');
  const steps = order.map(n => classify(core, n));
  const got = steps.map(s => s.kind).join(',');
  if (got !== KINDS) throw new Error('chain order is ' + got);
  const protos = e.protoName === '{}' ? [] : tableOf(core, e.protoName);
  return {
    K: chainOver(tableOf(core, e.kName), steps),
    code: decodeStream(tableOf(core, e.codeName), inv.tConsts, inv.shufMap, inv.slots),
    protos: protoList(core, protos, steps, inv),
    nParams: e.nParams,
    maxRegs: e.maxRegs,
    isVararg: e.isVararg,
  };
}

module.exports = {
  recover, decodeStream, chainOver, classify, sboxInverse,
  chainNames, chainOrder, entryCall, tableOf, fnBody, splitArgs,
  readTable, readValue, strBytes,
};
