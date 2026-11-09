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
