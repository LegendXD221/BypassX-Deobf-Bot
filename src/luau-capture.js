/**
 * BypassX Deobf Bot — Luraph v15.1 real-Luau capture stage.
 *
 * Runs the sample inside the bundled real Luau CLI with two instrumentation
 * layers (both injected by source transform, no monkey-patching — the CLI
 * locks its stdlib):
 *
 *   1. INNER-VM CHECKPOINTS — the obfuscator's own register-VM interpreter
 *      loop (`while true do local v=k[I]`) is located textually; every 512
 *      instructions the full VM state (opcode/operand arrays, registers,
 *      const-offset table, decrypt-key registers B/J/D) is serialized to JSON.
 *      The bytecode buffer is captured once on the first hit.
 *   2. DECRYPT-EVENT LOG — every lazy block-decrypt loop in the file (9
 *      polymorphic variants) plus every const-decrypt site gets a logging
 *      statement that records its exact runtime operands (seed, start,
 *      count, key registers).
 *
 * The decrypt log replays deterministically in JS (see luraph15-devirt.js):
 * every region of the instruction stream the VM decrypted at runtime becomes
 * readable here — that is the devirtualization payload.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnHardened } from './security.js';
import { logger } from './logger.js';

const HEAD_MARKER = 'local v=k[I];';

function findPreludePath() {
  return new URL('./luau-prelude-runtime.lua', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

/** Locate the inner-VM loop head; null if the shape is absent. */
export function findVmHead(sampleText) {
  const at = sampleText.indexOf(HEAD_MARKER);
  return at < 0 ? null : at;
}

/** Inject the checkpoint + decrypt-log instrumentation. */
export function buildInstrumented(sampleText, { maxSteps = 3_000_000, maxCaps = 400, capEvery = 512 } = {}) {
  const at = findVmHead(sampleText);
  if (at < 0) return null;

  // 1. decrypt-event logging at every xorshift block-decrypt loop
  const SIG = 'H=P(Q(H,(w(H,13))),536870911);H=Q(H,(U(H,13)));H=P(Q(H,(w(H,14))),536870911);';
  let out = sampleText;
  const sites = [];
  let pos = 0;
  while ((pos = out.indexOf(SIG, pos)) !== -1) { sites.push(pos); pos += 1; }
  const roles = {};
  for (let si = sites.length - 1; si >= 0; si--) {
    const at2 = sites[si];
    const back = Math.max(out.lastIndexOf(' for ', at2), out.lastIndexOf(';for ', at2));
    if (back < 0 || at2 - back > 500) continue;
    const endAt = out.indexOf('m=m+1;end;', at2);
    if (endAt < 0) continue;
    // widen backward: the `H,m=<seed>,<start>+1` init sits BEFORE the `for`
    const pre0 = Math.max(0, back - 400);
    const initIdx = out.lastIndexOf('H,m=', back);
    const bodyStart = initIdx >= 0 && back - initIdx < 400 ? initIdx : back;
    const body = out.slice(bodyStart, endAt + 10);
    const initM = /H,m=([^;]+);/.exec(body);
    const countM = /for \w+=1,([A-Za-z_\[\]I+0-9]+),1 do/.exec(body);
    const roleMap = {};
    const roleRe = /(s|L|O|k)\[m\]=Q\(\1\[m\],\(P\(U\(H,(\d+)\),127\)\)\)/g;
    let rm;
    while ((rm = roleRe.exec(body))) roleMap[rm[1]] = Number(rm[2]);
    roles[si] = { roles: roleMap };
    const logLine = `;__BX_DLOG[#__BX_DLOG+1]={${si},I,${initM ? initM[1] : '0'},${countM ? countM[1] : '0'},B,J,D,(__BX_HIT or 0)}`;
    out = out.slice(0, back) + logLine + out.slice(back);
  }

  // 2. const-decrypt site logging — each site sets __BX_Y4DIRTY so the next
  //    VM-loop checkpoint re-dumps the bytecode buffer AFTER the const region
  //    has been decrypted (hit-1 alone captures it pre-decryption).
  const constShapes = [
    'local K,T,h=s[I],L[I],y[5]',
    'local T,Rq,Fq=O[I],s[I],y[5]',
    'local K,B,T=s[I],L[I],y[5]',
  ];
  const CONST_INJ = '__BX_DLOG[#__BX_DLOG+1]={100,I,s[I],L[I],O[I],B,J,D,(__BX_HIT or 0)};__BX_Y4DIRTY=true;';
  for (const shape of constShapes) {
    let p2 = out.indexOf(shape);
    while (p2 !== -1) {
      out = out.slice(0, p2) + CONST_INJ + out.slice(p2);
      // resume AFTER the injected text + the moved occurrence (else the same
      // site is re-found forever — injection length exceeds the old skip).
      p2 = out.indexOf(shape, p2 + CONST_INJ.length + shape.length);
    }
  }
  {
    const anchor = ',y[5];local Yq=Q(Fq[T],535359694)';
    let p3 = out.indexOf(anchor);
    while (p3 !== -1) {
      const lAt = out.lastIndexOf('local ', p3);
      if (lAt >= 0 && p3 - lAt < 120) {
        out = out.slice(0, lAt) + CONST_INJ + out.slice(lAt);
        p3 = out.indexOf(anchor, lAt + 200);
      } else p3 = out.indexOf(anchor, p3 + anchor.length);
    }
  }

  // 2b. CONST-TEXT DUMP — inject at each const handler's self-patch epilogue,
  //  where the region is decrypted and the buffer/start/len locals are live.
  //  Logs "<idx>:<hexbytes>" so the bot receives the plaintext strings the
  //  VM itself just decrypted (no seed derivation, no buffer-base puzzles).
  const STR_INJ = '__BX_STRS[#__BX_STRS+1]=tostring(s[I])..":" .. (function()local __t={};';
  const constEpilogues = [
    // shape 1 (K,T,h): locals h=buffer, Yq=start, Rq=end
    { ep: 's[I]=141;L[I]=75;O[I]=193;k[I]=50;', buf: 'h', from: 'Yq', to: 'Rq' },
    // shape 2 (T,Rq,Fq): locals Fq=buffer, Lq=start, Yq=end
    { ep: 's[I]=140;O[I]=162;L[I]=209;k[I]=94;', buf: 'Fq', from: 'Lq', to: 'Yq' },
    // shape 3 (K,B,T): locals T=buffer, p=start, K=end
    { ep: 's[I]=54;L[I]=148;k[I]=242;O[I]=27;', buf: 'T', from: 'p', to: 'K' },
  ];
  for (const ce of constEpilogues) {
    let p4 = out.indexOf(ce.ep);
    while (p4 !== -1) {
      const inj = `${STR_INJ}for __x=${ce.from},${ce.to}-1,1 do __t[__x-${ce.from}+1]=string.format('%02x',n(${ce.buf},__x)) end;return table.concat(__t) end)();`;
      out = out.slice(0, p4) + inj + out.slice(p4);
      p4 = out.indexOf(ce.ep, p4 + inj.length + ce.ep.length);
    }
  }

  // 3. checkpoint injection at the inner-VM loop head (re-locate: injections above shifted offsets)
  const at3 = out.indexOf(HEAD_MARKER);
  if (at3 < 0) return null;
  const capCode = `
__BX_HIT = (__BX_HIT or 0) + 1
if __BX_HIT == 1 or __BX_HIT % ${capEvery} == 0 then
  __BX_NCAPS = (__BX_NCAPS or 0) + 1
  if __BX_NCAPS <= ${maxCaps} then
    pcall(function()
      local parts = { '{' }
      local function serArr(t, name)
        parts[#parts + 1] = '"' .. name .. '":['
        local buf = {}
        local n = #t
        if n > 12000 then n = 12000 end
        for i = 1, n do
          local v = t[i]
          local tv = type(v)
          if v == nil then buf[i] = '0'
          elseif tv == 'number' then
            if v == math.floor(v) and math.abs(v) < 9007199254740992 then buf[i] = string.format('%d', v)
            else buf[i] = string.format('%.17g', v) end
          elseif tv == 'string' then
            local esc = {}
            for j = 1, math.min(#v, 120) do
              local b = string.byte(v, j)
              if b == 34 then esc[j] = '\\\\"'
              elseif b == 92 then esc[j] = '\\\\\\\\'
              elseif b >= 32 and b <= 126 then esc[j] = string.char(b)
              else esc[j] = string.format('\\\\u%04x', b) end
            end
            buf[i] = '"s:' .. table.concat(esc) .. '"'
          elseif tv == 'boolean' then buf[i] = v and 'true' or 'false'
          elseif tv == 'function' then buf[i] = '"F"'
          else buf[i] = '"T"' end
        end
        parts[#parts + 1] = table.concat(buf, ',') .. ']'
      end
      parts[#parts + 1] = '"hit":' .. __BX_HIT .. ',"i":' .. string.format('%d', I) .. ','
      serArr(k, 'k', parts); parts[#parts + 1] = ','
      serArr(s, 's', parts); parts[#parts + 1] = ','
      serArr(L, 'L', parts); parts[#parts + 1] = ','
      serArr(O, 'O', parts); parts[#parts + 1] = ','
      serArr(Y, 'Y', parts); parts[#parts + 1] = ','
      serArr(c, 'c', parts); parts[#parts + 1] = ','
      serArr(r, 'r', parts); parts[#parts + 1] = ','
      serArr(e, 'e', parts); parts[#parts + 1] = ','
      if (__BX_HIT == 1 or __BX_Y4DIRTY) and type(y) == 'table' and y[4] ~= nil then
        local __B = '0123456789abcdef'
        local __bs = buffer.tostring(y[4])
        local hx = {}
        for i = 1, #__bs do
          local b = string.byte(__bs, i)
          hx[i * 2 - 1] = __B:sub(math.floor(b / 16) + 1, math.floor(b / 16) + 1)
          hx[i * 2] = __B:sub((b % 16) + 1, (b % 16) + 1)
        end
        parts[#parts + 1] = '"y4hex":"' .. table.concat(hx) .. '",'
        parts[#parts + 1] = '"y4hit":' .. __BX_HIT .. ','
        __BX_Y4DIRTY = false
      end
      if type(y) == 'table' and type(y[5]) == 'table' then
        local cs = {}
        for i = 1, math.min(#y[5], 12000) do
          local v2 = y[5][i]
          cs[i] = (v2 == nil) and '0' or (type(v2) == 'number' and string.format('%.17g', v2) or '0')
        end
        parts[#parts + 1] = '"y5":[' .. table.concat(cs, ',') .. '],'
      end
      if type(y) == 'table' and type(y[6]) == 'table' then
        local cs = {}
        for i = 1, math.min(#y[6], 4000) do
          local v2 = y[6][i]
          local tv = type(v2)
          if v2 == nil then cs[i] = '0'
          elseif tv == 'number' then cs[i] = string.format('%.17g', v2)
          elseif tv == 'string' then
            local esc = {}
            for j = 1, math.min(#v2, 300) do
              local b = string.byte(v2, j)
              if b >= 32 and b <= 126 and b ~= 34 and b ~= 92 then esc[j] = string.char(b)
              else esc[j] = string.format('\\\\u%04x', b) end
            end
            cs[i] = '"s:' .. table.concat(esc) .. '"'
          else cs[i] = '"T"' end
        end
        parts[#parts + 1] = '"y6":[' .. table.concat(cs, ',') .. '],'
      end
      parts[#parts + 1] = '"B":' .. tostring(B) .. ',"J":' .. tostring(J) .. ',"D":' .. tostring(D) .. '}'
      __BX_CAPT = __BX_CAPT or {}
      __BX_CAPT[#__BX_CAPT + 1] = table.concat(parts)
    end)
  end
end
`;
  out = out.slice(0, at3 + HEAD_MARKER.length) + capCode + out.slice(at3 + HEAD_MARKER.length);
  out = out.replace(/(local v=k\[I\];)/, `$1 __BX_VN=(__BX_VN or 0)+1 if __BX_VN>${maxSteps} then error("BX_CAP") end`);

  const body = out.replace(/\):rH\(\)\(\.\.\.\);\s*$/, '):rH()(__BX_ARGS)');
  if (body === out) return null;
  const tail = body.replace(/^return (setmetatable\(\{)/m, '__BX_RUN = function() __BX_ARGS = nil return $1') + '\nend\nlocal __ok, __err = pcall(__BX_RUN)';

  const dump = `
print('BXRUN ok=' .. tostring(__ok) .. ' hits=' .. tostring(__BX_HIT) .. ' dlog=' .. tostring(__BX_DLOG and #__BX_DLOG or 0))
print('__BX_DLOG_BEGIN__')
if __BX_DLOG then
  for _i = 1, #__BX_DLOG do
    local ev = __BX_DLOG[_i]
    local flds = {}
    for _j = 1, #ev do flds[_j] = tostring(ev[_j]) end
    print('DL ' .. table.concat(flds, ' '))
  end
end
print('__BX_DLOG_END__')
print('__BX_CAPS_BEGIN__')
if __BX_CAPT then for _i = 1, #__BX_CAPT do print(__BX_CAPT[_i]) end end
print('__BX_CAPS_END__')
print('__BX_STRS_BEGIN__')
if __BX_STRS then for _i = 1, #__BX_STRS do print('ST ' .. __BX_STRS[_i]) end end
print('__BX_STRS_END__')
`;

  return { script: '__BX_DLOG = {}\n__BX_STRS = {}\n' + tail + '\n' + dump, sites: sites.length, roles };
}

/**
 * Run the capture. Returns { ok, events, checkpoints, error }.
 */
export async function captureLuraph15(sampleText, { luauBin, timeoutMs = 120_000, maxSteps } = {}) {
  if (!luauBin || !fs.existsSync(luauBin)) return { ok: false, error: 'luau runtime not bundled' };
  const built = buildInstrumented(sampleText, { maxSteps });
  if (!built) return { ok: false, error: 'VM head shape not found' };

  const preludePath = findPreludePath();
  let prelude = '';
  try { prelude = fs.readFileSync(preludePath, 'utf8'); } catch { /* optional */ }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bxl15-'));
  const scriptPath = path.join(dir, 'run.lua');
  await fsp.writeFile(scriptPath, prelude + '\n' + built.script, { mode: 0o600 });

  try {
    const r = await spawnHardened(luauBin, [scriptPath], {
      timeoutMs,
      label: 'luau-capture',
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = (r.stdout || '').toString('utf8');
    const events = [];
    const checkpoints = [];
    const strings = [];
    let section = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('__BX_DLOG_BEGIN__')) { section = 'dl'; continue; }
      if (line.startsWith('__BX_DLOG_END__')) { section = null; continue; }
      if (line.startsWith('__BX_CAPS_BEGIN__')) { section = 'cap'; continue; }
      if (line.startsWith('__BX_CAPS_END__')) { section = null; continue; }
      if (line.startsWith('__BX_STRS_BEGIN__')) { section = 'str'; continue; }
      if (line.startsWith('__BX_STRS_END__')) { section = null; continue; }
      if (section === 'dl' && line.startsWith('DL ')) {
        const p = line.slice(3).trim().split(/\s+/).map((x) => {
          const n = Number(x);
          return Number.isFinite(n) ? n : 0;
        });
        if (p.length >= 8) events.push(p);
      } else if (section === 'cap' && line.startsWith('{')) {
        try { checkpoints.push(JSON.parse(line)); } catch { /* partial */ }
      } else if (section === 'str' && line.startsWith('ST ')) {
        const body = line.slice(3).trim();
        const c = body.indexOf(':');
        if (c > 0) {
          const idx = Number(body.slice(0, c));
          const hexs = body.slice(c + 1).trim();
          if (Number.isFinite(idx) && /^[0-9a-f]*$/.test(hexs)) {
            strings.push({ idx, hex: hexs, text: Buffer.from(hexs, 'hex').toString('latin1') });
          }
        }
      }
    }
    const meta = /^BXRUN (.*)$/m.exec(text);
    return { ok: events.length > 0 || checkpoints.length > 0 || strings.length > 0, events, checkpoints, strings, meta: meta ? meta[1] : null, sites: built.sites, roles: built.roles || {} };
  } finally {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}
