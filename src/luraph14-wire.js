/**
 * Luraph v14.7 wire decoder — pure static extraction (no execution).
 *
 * The v14.7 loader embeds two base85 blobs (`local q,o=N([=[LPH:…]=]),N([=[LPH?…]=])`)
 * and decompresses them with an LZMA1 range decoder implemented in pure Lua.
 * Running that decoder inside the fengari jail balloons past 950 MB heap
 * (measured live) because the output is built as a Lua table of boxed numbers
 * — so this module ports the loader's EXACT decoder to JS instead:
 *
 *   blob text → drop 4-char "LPH:" magic (loader does S:sub(5))
 *             → gsub 'z' → '!!!!!' (ascii85 zero)
 *             → ascii85 groups of 5, value packed as little-endian <I4
 *             → LZMA1 stream (hardcoded lc=3, lp=0, pb=0; 5-byte rc init;
 *               end-marker distance 0xFFFFFFFF terminates early)
 *
 * Ported mechanically from the loader's own Lua (var/external/bf-decomp-lua.txt),
 * preserving its floor/float semantics. Byte-exact with the loader's output.
 */

import zlib from 'node:zlib';

const POW2 = [];
for (let i = 0, v = 1; i < 33; i++, v *= 2) POW2[i] = v;

/** The loader's base85 N() — S:sub(5), z→'!!!!!', 5-char groups → <I4 LE. */
export function b85decode(raw) {
  // string.sub(S, 5) — drop the first FOUR chars, keep from the 5th
  let s = raw.slice(4);
  s = s.replace(/z/g, '!!!!!');
  const out = [];
  let i = 0;
  const n = s.length;
  while (i + 5 <= n) {
    const c1 = s.charCodeAt(i) - 33;
    const c2 = s.charCodeAt(i + 1) - 33;
    const c3 = s.charCodeAt(i + 2) - 33;
    const c4 = s.charCodeAt(i + 3) - 33;
    const c5 = s.charCodeAt(i + 4) - 33;
    // loader: F = c5 + c4*85 + c3*85² + c2*85³ + c1*85⁴  (byte1 = highest weight)
    let F = c1;
    F = F * 85 + c2;
    F = F * 85 + c3;
    F = F * 85 + c4;
    F = F * 85 + c5;
    // string.pack('<I4', F) — little-endian uint32
    out.push(F & 255, (F >>> 8) & 255, (F >>> 16) & 255, (F >>> 24) & 255);
    i += 5;
  }
  return Uint8Array.from(out);
}

const STATE_TABLE = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 4, 5]; // LZMA kStateUpdate

/**
 * LZMA1 decoder — faithful port of the loader's Lua:
 *   5-byte rc init (code), hardcoded lc=3/lp=0/pb=0 (posState≡0, litCtx=hi 3
 *   bits of prev byte), no props/size header, while input remains; end-marker
 *   distance 0xFFFFFFFF returns early.
 * Returns Uint8Array of the decompressed bytes (Y[1..#Y] — slot 0 excluded).
 */
export function lzmaDecode(input) {
  let E = 0;                       // input position (pre-increment, 0-based)
  const L = input.length;
  let X = 0xFFFFFFFF;              // range
  let code = 0;                    // code (the loader's `l`)
  const readByte = () => { E += 1; return input[E - 1]; };
  for (let h = 0; h < 5; h++) code = code * 256 + readByte();

  // --- range decoder primitives (float-exact with the Lua port) ---
  function decodeDirect(nBits) {
    let w = 0;
    for (let z = nBits; z >= 1; z--) {
      X = X / 2; X = X - (X % 1);
      w = w * 2;
      if (!(code < X)) { code -= X; w += 1; }
      if (X <= 0x00FFFFFF) { X *= 256; code = code * 256 + readByte(); }
    }
    return w;
  }
  function decodeBit(P, Z) {
    let y = X / 2048; y = y - (y % 1);
    let Y = P[Z];
    const t = y * Y;
    let bit;
    if (code < t) {
      X = t;
      y = (2048 - Y) / 32; y = y - (y % 1); Y = Y + y;
      bit = 0;
    } else {
      X -= t; code -= t;
      y = Y / 32; y = y - (y % 1); Y = Y - y;
      bit = 1;
    }
    P[Z] = Y;
    if (X <= 0x00FFFFFF) { X *= 256; code = code * 256 + readByte(); }
    return bit;
  }
  function tree(nBits, P, offset) {
    let Z = 1;
    for (let y = 1; y <= nBits; y++) Z = Z * 2 + decodeBit(P, Z);
    return Z - offset;
  }
  function reverseTree(nBits, P, offset) {
    let y = 0, Y = 1;
    for (let i = 0; i <= nBits - 1; i++) {
      const b = decodeBit(P, offset + Y);
      Y = Y * 2 + b;
      y += b * POW2[i];
    }
    return y;
  }
  // matched/normal literal decoder (loader's w(Z,y))
  function decodeLiteral(matchByte, P) {
    let Y = 1;
    for (let i = 7; i >= 0; i--) {
      let t = (matchByte / POW2[i]) % 2; t = t - (t % 1);
      const b = decodeBit(P, Y + t * 256 + 256);
      Y = Y * 2 + b;
      if (t !== b) {
        while (Y < 0x100) Y = Y * 2 + decodeBit(P, Y);
        break;
      }
    }
    return Y % 256;
  }
  // length decoder (loader's y(Y,i)) — model: {choice, choice2, low, mid, high}
  function decodeLength(ps, M) {
    if (decodeBit(M, 1) === 0) return tree(3, M[3][ps], 8);
    if (decodeBit(M, 2) === 0) return 8 + tree(3, M[4][ps], 8);
    return tree(8, M[5], 256) + 16.0;
  }
  const newLenModel = () => [null, 1024.0, 1024.0, [new Float64Array(8).fill(1024)], [new Float64Array(8).fill(1024)], new Float64Array(256).fill(1024)];

  // --- model state (loader's U()) ---
  const litProbs = [];                    // t(8,0x300)
  for (let i = 0; i < 8; i++) litProbs[i] = new Float64Array(0x300).fill(1024);
  const isMatch = [];                     // t(12,1) — 12 states × 1 posState
  for (let s = 0; s < 12; s++) isMatch[s] = new Float64Array(1).fill(1024);
  const isRep = new Float64Array(12).fill(1024);
  const isRepG0 = new Float64Array(12).fill(1024);
  const isRepG1 = new Float64Array(12).fill(1024);
  const isRepG2 = new Float64Array(12).fill(1024);
  const isRep0Long = [];                  // t(12,1)
  for (let s = 0; s < 12; s++) isRep0Long[s] = new Float64Array(1).fill(1024);
  const posSlotProbs = [];                // t(4,64)
  for (let i = 0; i < 4; i++) posSlotProbs[i] = new Float64Array(64).fill(1024);
  const posDecoders = new Float64Array(115).fill(1024);
  const alignProbs = new Float64Array(16).fill(1024);
  const matchLenProbs = newLenModel();
  const repLenProbs = newLenModel();

  let state = 0;   // loader's Z
  let pos = 0;     // loader's A — output position
  const out = [];  // loader's Y — out[0]=0 excluded from the result
  out[0] = 0;

  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;  // V=rep0, h=rep1, D=rep2, Q=rep3

  while (E <= L) {
    const ps = pos % 1;  // ≡ 0 (pb=0)
    if (decodeBit(isMatch[state], ps) === 0) {
      // literal
      const prevByte = out[pos];
      const litCtx = Math.floor(prevByte / 32) % 8;
      pos += 1;
      out[pos] = state < 7
        ? tree(8, litProbs[litCtx], 256)
        : decodeLiteral(out[pos - rep0 - 1], litProbs[litCtx]);
      state = STATE_TABLE[state];
    } else {
      let len = 0;
      if (decodeBit(isRep, state) !== 0) {
        // rep match
        if (decodeBit(isRepG0, state) === 0) {
          if (decodeBit(isRep0Long[state], ps) === 0) {
            state = state < 7 ? 9 : 11;
            len = 1;
          }
        } else {
          let Ld;
          if (decodeBit(isRepG1, state) === 0) {
            Ld = rep1;                    // loader: L=h
          } else {
            if (decodeBit(isRepG2, state) === 0) {
              Ld = rep2;                  // loader: L=D
            } else {
              Ld = rep3;                  // loader: L=Q
              rep3 = rep2;                // loader: Q=D
            }
            rep2 = rep1;                  // loader: D=h
          }
          rep1 = rep0;                    // loader: h=V
          rep0 = Ld;                      // loader: V=L
        }
        if (len === 0) {
          state = state < 7 ? 8 : 11;
          len = 2 + decodeLength(ps, repLenProbs);
        }
      } else {
        // simple match
        rep3 = rep2; rep2 = rep1; rep1 = rep0;   // loader: Q=D; D=h; h=V
        len = 2 + decodeLength(ps, matchLenProbs);
        let E2 = len - 2;
        if (E2 >= 4) E2 = 3;
        rep0 = tree(6, posSlotProbs[E2], 64);
        if (rep0 >= 4) {
          const slot = rep0;
          const nDirect = Math.floor(slot / 2 - 1);
          rep0 = (2 + (slot % 2)) * POW2[nDirect];
          if (slot < 14) {
            rep0 += reverseTree(nDirect, posDecoders, rep0 - slot);
          } else {
            rep0 += decodeDirect(nDirect - 4) * 16 + reverseTree(4, alignProbs, 0);
            if (rep0 === 0xFFFFFFFF) return packOut(out, pos, true); // end marker
          }
        }
        state = state < 7 ? 7 : 10;
        if (rep0 >= pos) return packOut(out, pos, false);
      }
      const endPos = pos + len;
      for (let i = pos + 1; i <= endPos; i++) out[i] = out[i - rep0 - 1];
      pos = endPos;
    }
  }
  return packOut(out, pos, false);
}

/** Assemble Y[1..pos] into bytes. */
function packOut(out, pos) {
  const buf = new Uint8Array(pos);
  for (let i = 1; i <= pos; i++) buf[i - 1] = out[i] & 255;
  return buf;
}

/** Locate the two [=[LPH…]=] blobs in a v14.7 loader source. */
export function findWireBlobs(src) {
  const blobs = [];
  for (const m of src.matchAll(/\[(=*)\[LPH/g)) {
    const close = ']' + m[1] + ']';
    const end = src.indexOf(close, m.index + m[0].length);
    if (end < 0) continue;
    // text = the FULL Lua string value (starts with the "LPH" magic) — the
    // loader's N() drops the first 4 chars via S:sub(5), so b85decode does too
    const text = src.slice(m.index + 2 + m[1].length, end);
    blobs.push({ open: m[0], start: m.index, text, len: text.length });
  }
  return blobs;
}

function decompressWireStream(raw) {
  // Check Zstd frame magic (28 B5 2F FD) first if Node zlib exposes zstdDecompressSync
  if (raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
    if (typeof zlib.zstdDecompressSync === 'function') {
      try { return new Uint8Array(zlib.zstdDecompressSync(raw)); } catch { /* fallback */ }
    }
  }
  return lzmaDecode(raw);
}

/** Full v14.7 static unwrap: blobs → base85 → LZMA/Zstd → { vmChunk, data }. */
export function unwrapV14Wire(src) {
  const blobs = findWireBlobs(src);
  if (blobs.length < 2) return { error: `expected 2 LPH blobs, found ${blobs.length}` };
  // loader order: local q,o = N(blob1), N(blob2) → s=LZMA/Zstd(q) (VM chunk), data=LZMA/Zstd(o)
  const vmChunk = decompressWireStream(b85decode(blobs[0].text));
  const data = decompressWireStream(b85decode(blobs[1].text));
  return { vmChunk, data, blobs: blobs.map((b) => b.len) };
}

/**
 * Static constant-pool extraction from v14.7 bytecode. The VM's serialized
 * stream interleaves instructions with inline string constants tagged
 * 0xDB + 1-byte length + raw bytes (verified: db 09 "FromValue", db 0b
 * "currentline", db 04 "gsub"). Printable-run validation + an alpha-ratio
 * filter kills binary-noise false positives.
 */
export function extractV14Pool(data) {
  const strings = [];
  for (let i = 0; i < data.length - 2; i++) {
    if (data[i] === 0xdb) {
      const len = data[i + 1];
      if (len >= 4 && len <= 120 && i + 2 + len <= data.length) {
        let ok = true;
        for (let k = 0; k < len; k++) {
          const c = data[i + 2 + k];
          if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127))) { ok = false; break; }
        }
        if (ok) {
          strings.push(Buffer.from(data.slice(i + 2, i + 2 + len)).toString('latin1'));
          i += 1 + len;
        }
      }
    }
  }
  const meaningful = strings.filter((s) => {
    const alpha = (s.match(/[A-Za-z]/g) || []).length;
    return alpha >= Math.ceil(s.length / 2);
  });
  return { strings: [...new Set(meaningful)], total: strings.length };
}
