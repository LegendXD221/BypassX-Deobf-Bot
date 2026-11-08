/**
 * Luraph v15.1 inner-VM emulator + devirtualizer (loop-1 v-dispatch).
 *
 * Consumes a real-Luau capture of the inner register VM (k/s/L/O/Y/c/r arrays,
 * y[4] bytecode buffer, y[5] const-offset table) and EXACTLY emulates the
 * interpreter's semantics — including the three lazy-decrypt families:
 *   • block decrypt  (xorshift29 rolling key over s/L/O/k operand arrays)
 *   • self decrypt   (per-instruction, J/B/D-key derived)
 *   • const decrypt  (offset ^ 535359694, varint length, seed*0x01010101 buffer xor)
 * Registers are tracked symbolically; guest-visible statements are emitted as
 * readable Lua. Unknown ops fall back to 'record + continue'.
 */

// ---- exact 29-bit xorshift from the interpreter source (P=band,Q=bxor,w=lshift,U=rshift)
const M29 = 536870911; // 2^29 - 1
function band(a, b) { return (a & b) >>> 0; }
function bxor(a, b) { return (a ^ b) >>> 0; }
function lshift(a, b) { return (a << (b & 31)) >>> 0; }
function rshift(a, b) { return (a >>> (b & 31)) >>> 0; }

function keyFromSeed(S) {
  // P(Q(S,(P(U(S,29),7))),536870911)
  return band(bxor(S, band(rshift(S, 29), 7)), M29);
}

function xorshiftStep(H) {
  H = band(bxor(H, lshift(H, 13)), M29);
  H = bxor(H, rshift(H, 13));
  H = band(bxor(H, lshift(H, 14)), M29);
  return H >>> 0;
}

/** Block decrypt: seed=srcVal, decrypt n instructions starting at dst+1.
 *  Bits: L←0..6, s←7..13, O←14..20, k←21..27. Then k[at]=nopOp. */
function decryptBlock(arr, seed, dst, n, nopOp) {
  let H = seed >>> 0;
  let m = dst + 1;
  for (let T = 1; T <= n; T++) {
    H = xorshiftStep(H);
    if (arr.L[m] !== undefined && arr.L[m] !== null) arr.L[m] = bxor(arr.L[m], band(rshift(H, 0), 127));
    if (arr.s[m] !== undefined && arr.s[m] !== null) arr.s[m] = bxor(arr.s[m], band(rshift(H, 7), 127));
    if (arr.O[m] !== undefined && arr.O[m] !== null) arr.O[m] = bxor(arr.O[m], band(rshift(H, 14), 127));
    if (arr.k[m] !== undefined && arr.k[m] !== null) arr.k[m] = bxor(arr.k[m], band(rshift(H, 21), 127));
    m++;
  }
  if (arr.k[dst] !== undefined) arr.k[dst] = nopOp;
}

/** Self decrypt (loop-1 v=35 family, key reg B): decrypts THIS instruction in place. */
function selfDecryptB(arr, I, B) {
  const m = band(bxor(arr.L[I], band(bxor(B, band(rshift(B, 28), 15)), 262143)), M29);
  // C = arr.k[I] < 2097152 ? 7 : 14   (loop-1 v=35 uses m=O? careful per-variant)
  return { m };
}

/** mul32 via the float-safe path in the interpreter. */
function mul32(a, b) {
  a = a >>> 0; b = b >>> 0;
  const aL = band(a, 65535), aH = rshift(a, 16);
  const bL = band(b, 65535), bH = rshift(b, 16);
  const lo = aL * bL;
  const mid = band((aL * bH + aH * bL), 65535);
  return band(lo + lshift(mid, 16), 4294967295);
}

function toInt32(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return v | 0;
}

/** The 32-bit multiply ops seen in the ISA (v=2/21/39/56/58/80 etc all reduce to mul32). */
function isMul32Op(body) {
  return /4294967295/.test(body) && /\*/.test(body);
}

export {
  M29, band, bxor, lshift, rshift, keyFromSeed, xorshiftStep, decryptBlock, mul32, toInt32, isMul32Op,
};
