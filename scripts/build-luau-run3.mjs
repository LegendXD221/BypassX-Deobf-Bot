// Build the checkpoint capture runner on the PROVEN diag6 structure:
// pcall-wrapped run + captures every 512 hits (full state incl. live registers).
import fs from 'node:fs';
import { patchBindings } from './patch-bindings.mjs';

let sample = fs.readFileSync('/home/z/my-project/download/bypassx-deobf-bot/test/fixtures/luraph-v15.1-real-sample.lua', 'utf8');
const prelude = fs.readFileSync('/home/z/my-project/download/bypassx-deobf-bot/research/luau-prelude.lua', 'utf8');
const basePrelude = prelude.slice(0, prelude.indexOf('-- instrumentation: surface swallowed errors'));

const headMarker = 'local v=k[I];';
const at = sample.indexOf(headMarker);
if (at < 0) { console.error('head not found'); process.exit(1); }

const CAP = `
__BX_HIT = (__BX_HIT or 0) + 1
if __BX_HIT == 1 or __BX_HIT % 512 == 0 then
  __BX_NCAPS = (__BX_NCAPS or 0) + 1
  if __BX_NCAPS <= 600 then
    local __okC, __errC = pcall(function()
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
      if type(X) == 'table' then
        local xp = {}
        local xn = 0
        for xi, xv in pairs(X) do
          xn = xn + 1
          if xn > 40 then break end
          if type(xv) == 'table' then
            local inner = {}
            local i6 = xv[6]
            if type(i6) == 'table' then
              local ik = 0
              for ik2, iv in pairs(i6) do
                ik = ik + 1
                if ik > 30 then break end
                local tv = type(iv)
                inner[#inner + 1] = tostring(ik2) .. '=' .. (tv == 'string' and ('s:' .. iv:sub(1, 80)) or tv == 'number' and tostring(iv) or tv)
              end
            end
            xp[#xp + 1] = tostring(xi) .. ':[5]=' .. tostring(xv[5]) .. ' {' .. table.concat(inner, ',') .. '}'
          end
        end
        parts[#parts + 1] = '"Xdeep":' .. string.format('%q', table.concat(xp, ' | ')) .. ','
      end
      if __BX_HIT == 1 and type(y) == 'table' and y[4] ~= nil then
        local __B = '0123456789abcdef'
        local __bs = buffer.tostring(y[4])
        local hx = {}
        for i = 1, #__bs do
          local b = string.byte(__bs, i)
          hx[i * 2 - 1] = __B:sub(math.floor(b / 16) + 1, math.floor(b / 16) + 1)
          hx[i * 2] = __B:sub((b % 16) + 1, (b % 16) + 1)
        end
        parts[#parts + 1] = '"y4hex":"' .. table.concat(hx) .. '",'
      end
      if type(y) == 'table' and type(y[5]) == 'table' then
        local cs = {}
        for i = 1, math.min(#y[5], 12000) do
          local v2 = y[5][i]
          cs[i] = (v2 == nil) and '0' or (type(v2) == 'number' and string.format('%.17g', v2) or '"' .. tostring(v2) .. '"')
        end
        parts[#parts + 1] = '"y5":[' .. table.concat(cs, ',') .. '],'
      end
      parts[#parts + 1] = '"B":' .. tostring(B) .. ',"J":' .. tostring(J) .. ',"D":' .. tostring(D) .. '}'
      __BX_CAPT = __BX_CAPT or {}
      __BX_CAPT[#__BX_CAPT + 1] = table.concat(parts)
    end)
    if not __okC then __BX_CAPT = __BX_CAPT or {}; __BX_CAPT[#__BX_CAPT + 1] = '{"err":"' .. tostring(__errC):sub(1, 60) .. '"}' end
  end
end
`;

let patched = sample.slice(0, at + headMarker.length) + CAP + sample.slice(at + headMarker.length);
patched = patched.replace(/(local v=k\[I\];)/, '$1 __BX_VN=(__BX_VN or 0)+1 if __BX_VN>3000000 then error("BX_CAP") end');

const body = patched.replace(/\):rH\(\)\(\.\.\.\);\s*$/, '):rH()(__BX_ARGS)');
if (body === patched) { console.error('TAIL NOT FOUND'); process.exit(1); }
const tail = body.replace(/^return (setmetatable\(\{)/m, '__BX_RUN = function() __BX_ARGS = nil return $1') + '\nend\nlocal __ok, __err = pcall(__BX_RUN)';

const dump = `
print('RUN ok=' .. tostring(__ok) .. ' err=' .. tostring(__err):sub(1, 120) .. ' hits=' .. tostring(__BX_HIT) .. ' caps=' .. tostring(__BX_NCAPS))
print('=== LOG (' .. #__LOG .. ') ===')
for i = 1, #__LOG do print('LOG ' .. i .. ': ' .. __LOG[i]) end
print('__BX_CAPS_BEGIN__')
if __BX_CAPT then for _i = 1, #__BX_CAPT do print(__BX_CAPT[_i]) end end
print('__BX_CAPS_END__')
`;

fs.writeFileSync('/tmp/luau-run3.lua', basePrelude + '\n' + tail + '\n' + dump);
console.log(`written /tmp/luau-run3.lua`);
