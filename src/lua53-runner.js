/**
 * Lucid Deobf Bot — jailed 64-bit Lua 5.3 runner (when `lua5.3` is installed).
 *
 * Fengari (our in-process JS Lua 5.3 VM) uses 32-bit JS bitwise ops
 * (math.maxinteger == 2^31-1), which overflows on 64-bit Lua 5.3 builds such
 * as Luraph v13.8.1 (`x << 6 >> 29`, `math.tointeger`, `string.unpack('>i8')`).
 * When `lua5.3` is available on the host, this runner executes the sample
 * inside the exact same PRELUDE jail with a strict instruction hook and wall
 * timeout, returning { ok, ran, runError, strings, chunks, log, envlog }.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnHardened } from './security.js';
import { PRELUDE } from './jail-prelude.js';

let _hasLua53 = null;
export function hasLua53() {
  if (_hasLua53 !== null) return _hasLua53;
  try {
    execFileSync('lua5.3', ['-v'], { stdio: 'ignore', timeout: 2000 });
    _hasLua53 = true;
  } catch {
    _hasLua53 = false;
  }
  return _hasLua53;
}

const LUA53_HARNESS_TAIL = `
local __fn, __lerr = __bx_raw_load(__BX_SRC, 'bypassx')
local __ran = false
local __rerr = nil
if not __fn then
  __rerr = tostring(__lerr)
else
  local __steps = 0
  debug.sethook(function()
    __steps = __steps + 1
    if __steps > 3000 then error('BX_BUDGET') end
  end, '', 10000)
  local __ok, __res = pcall(__fn)
  debug.sethook()
  if __ok then
    __ran = true
    if type(__res) == 'function' then
      local __steps2 = 0
      debug.sethook(function()
        __steps2 = __steps2 + 1
        if __steps2 > 2000 then error('BX_BUDGET') end
      end, '', 10000)
      pcall(__res)
      debug.sethook()
    end
  else
    __rerr = tostring(__res)
  end
end

local function __hex(s)
  return (tostring(s):gsub('.', function(c)
    return string.format('%02x', string.byte(c))
  end))
end

__BX_OUT('OK:' .. (__ran and '1' or '0') .. ':' .. __hex(__rerr or '') .. '\\n')
for _, s in ipairs(_BX_SINK or {}) do
  __BX_OUT('S:' .. __hex(s) .. '\\n')
end
for _, c in ipairs(_BX_CHUNKS or {}) do
  __BX_OUT('C:' .. __hex(c) .. '\\n')
end
for _, l in ipairs(_BX_LOG or {}) do
  __BX_OUT('L:' .. __hex(l) .. '\\n')
end
`;

function unhex(h) {
  return Buffer.from(h, 'hex').toString('utf8');
}

export async function runLua53Jailed(inputPath, { timeoutMs = 30_000 } = {}) {
  if (!hasLua53()) return { ok: false, error: 'lua5.3 not installed' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-l53-'));
  const runnerPath = path.join(dir, 'run.lua');
  try {
    const prologue = `
local __bx_io_open = io.open
local __bx_raw_load = load
local __bx_stdout_write = function(s) io.stdout:write(s) end
local __f = assert(__bx_io_open(${JSON.stringify(inputPath)}, 'rb'))
local __BX_SRC = __f:read('*a')
__f:close()
local __BX_OUT = __bx_stdout_write
`;
    fs.writeFileSync(runnerPath, `${prologue}\n${PRELUDE}\n${LUA53_HARNESS_TAIL}`, 'utf8');
    const r = await spawnHardened('lua5.3', [runnerPath], {
      timeoutMs: Math.min(timeoutMs, 30_000),
      label: 'lua53-jail',
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = String(r.stdout || '').split('\n').filter(Boolean);
    let ran = false;
    let runError = null;
    const strings = [];
    const chunks = [];
    const log = [];
    for (const line of lines) {
      if (line.startsWith('OK:')) {
        const parts = line.split(':');
        ran = parts[1] === '1';
        runError = parts[2] ? unhex(parts[2]) : null;
      } else if (line.startsWith('S:')) {
        strings.push(unhex(line.slice(2)));
      } else if (line.startsWith('C:')) {
        chunks.push(unhex(line.slice(2)));
      } else if (line.startsWith('L:')) {
        log.push(unhex(line.slice(2)));
      }
    }
    if (!lines.some((l) => l.startsWith('OK:'))) {
      return { ok: false, error: `lua5.3 exit ${r.code}${r.killed ? ' (timeout)' : ''}` };
    }
    return { ok: true, ran, runError, strings, chunks, log };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
