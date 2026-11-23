/**
 * fengari-safe — crash-proof Lua→JS string conversion.
 *
 * fengari's lua_tojsstring()/to_jsstring() THROW RangeError("cannot convert
 * invalid utf8…") on byte strings that are not valid UTF-8. Obfuscated builds
 * routinely build such strings (string.char packs, binary blobs, encrypted
 * pools) — final-scan finding: a wYnFuscate sample crashed the whole pipeline
 * from inside verifyCode(). Every conversion of PROGRAM-CONTROLLED data must
 * go through this module:
 *   - valid UTF-8  → identical to lua_tojsstring (no behaviour change);
 *   - invalid UTF-8 → lossless latin1 mapping (byte 0xNN → U+00NN), never throws.
 */
import fengari from 'fengari';

const { lua } = fengari;

/**
 * Safe lua_tojsstring: returns a JS string for any string value on the stack,
 * or `dflt` (default null) when the value is not a string/number.
 */
export function safeToJsString(L, idx, dflt = null) {
  try {
    return lua.lua_tojsstring(L, idx) ?? dflt;
  } catch {
    // invalid UTF-8 — fall back to the raw byte view, mapped 1:1 via latin1
    try {
      const raw = lua.lua_tolstring(L, idx);
      if (!raw) return dflt;
      return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
    } catch {
      return dflt;
    }
  }
}

/** Safe to_jsstring for a raw Uint8Array byte string (validate.js path). */
export function safeBytesToJsString(u8, dflt = null) {
  if (!u8) return dflt;
  try {
    return fengari.to_jsstring(u8);
  } catch {
    try {
      return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('latin1');
    } catch {
      return dflt;
    }
  }
}

/**
 * env logger V2 (v2.25.0): read the prelude's _BX_ENVLOG recorder
 * ({ r = {[name]=hits}, w = {...} }) off a fengari state and return sorted
 * top-N lists. Crash-proof: any malformed state yields an empty record.
 * @returns {{reads: Array<{n: string, c: number}>, writes: Array<{n: string, c: number}>}}
 */
export function readEnvlog(L, { names = 64 } = {}) {
  const empty = { reads: [], writes: [] };
  if (!L) return empty;
  try {
    const { lua, to_luastring } = fengari;
    const readSide = (side) => {
      const out = [];
      lua.lua_getglobal(L, to_luastring('_BX_ENVLOG'));
      if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return out; }
      lua.lua_getfield(L, -1, to_luastring(side));
      if (lua.lua_istable(L, -1)) {
        lua.lua_pushnil(L);
        while (lua.lua_next(L, -2) !== 0) {
          // stack: [envlog, side, key, value]
          const n = safeToJsString(L, -2);
          const c = lua.lua_tointeger(L, -1) || 0;
          if (n && c > 0) out.push({ n, c });
          lua.lua_pop(L, 1);
        }
      }
      lua.lua_pop(L, 2); // side table + _BX_ENVLOG
      out.sort((a, b) => b.c - a.c || a.n.localeCompare(b.n));
      return out.slice(0, names);
    };
    return { reads: readSide('r'), writes: readSide('w') };
  } catch {
    return empty;
  }
}
