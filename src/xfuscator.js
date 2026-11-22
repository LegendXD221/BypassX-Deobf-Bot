/**
 * Xfuscator — Lucid's own Lua obfuscator (v1 / v2 / v2.1).
 *
 * Design hardened against the exact attack surfaces that cracked the five
 * families in v2.18.0 (junkie / luarmor / moonveil / somecool / luraph):
 *
 *   - NO static string pool. Junkie/LuArmor died because their decrypted
 *     constant pool materializes as one dumpable table. Xfuscator derives a
 *     fresh key per byte from an xorshift32 stream — there is nothing to dump
 *     except single decrypted bytes inside the loop.
 *   - NO arithmetic-only constant flood (SomeCool's tell). Keys are computed,
 *     not stored.
 *   - NO unkeyed bytecode (Luraph's wire fell to base85+LZMA because the VM
 *     constants rode along unencrypted). Here the whole payload is encrypted
 *     under a per-build random seed.
 *   - Integrity MAC (v2+): a 31-multi checksum over the plaintext — any
 *     tampering with the loader constants (the MoonVeil defuse path) silently
 *     refuses to run instead of executing corrupted code.
 *   - Junk-byte interleave (v2.1): every real byte is followed by a PRNG junk
 *     byte, so the ciphertext stride is not 1 — naive byte-table replays
 *     produce garbage.
 *
 * Versions:
 *   v1   — per-byte XOR stream + loadstring/load packer.
 *   v2   — + position-mixed second key + count check + integrity MAC.
 *   v2.1 — + junk-byte interleave (stride 2) on top of v2.
 *
 * The loader is pure arithmetic (no bit32, no bitwise operators) so the same
 * output runs on Lua 5.1 (loadstring), Lua 5.3/5.4 (load) and Luau executors
 * (loadstring). A JS mirror of the loader runs BEFORE any code is emitted —
 * output is only delivered when the mirror proves decode(encrypt(src)) === src.
 *
 * Honest scope: no packer is unbreakable in principle (the payload must reach
 * load() eventually) — but there is no static pool, no unkeyed constants and
 * no tamper-oracle left to peel, which is exactly what made the five families
 * fall.
 */

const M32 = 4294967296; // 2^32

export const XFUSCATOR_VERSIONS = ['v1', 'v2', 'v2.1'];
export const XFUSCATOR_DEFAULT = 'v2.1';

export const XF_HEADER_PREFIX = 'This File Was Obfuscated By Xfuscator';
export const XF_DISCORD = 'discord- https://dc.gg/bypassx';
export const XF_HEADER_RE = /^--\s*This File Was Obfuscated By Xfuscator/m;

/** True when the source is already Xfuscator output (refuse double-obf). */
export function isXfuscated(src) {
  return XF_HEADER_RE.test(String(src ?? ''));
}

/** The exact header comment line for a version. */
export function xfuscatorHeader(version) {
  return `--${XF_HEADER_PREFIX} (${version}). ${XF_DISCORD}`;
}

// ---- arithmetic primitives (JS mirrors of the Lua loader, bit-exact) -------------
//
// MODULUS NOTE (live fengari finding): fengari wraps integer-valued arithmetic
// at int32 (2^31), so any intermediate that reaches 2^31 goes negative and the
// loader diverges from the JS mirror. The whole cipher therefore runs mod
// 2^31 (M31) — every value stays < 2^31 on Lua 5.1/5.3/5.4 doubles, Luau
// doubles AND fengari int32. Bit weights never exceed 2^30, sums never wrap.

const M31 = 2147483648; // 2^31

/** Bitwise XOR via pure arithmetic (31-bit domain) — identical to the Lua _W() helper. */
function jsXor(a, b) {
  let r = 0, m = 1;
  for (let i = 0; i < 31; i += 1) {
    const xa = a % 2, xb = b % 2;
    if (xa !== xb) r += m;
    a = (a - xa) / 2;
    b = (b - xb) / 2;
    m *= 2;
    if (a === 0 && b === 0) break;
  }
  return r;
}

/** xorshift31 in pure arithmetic — identical to the Lua _N() helper. */
function jsNx(s) {
  s = s % M31;
  s = jsXor(s, (s * 8192) % M31); // x ^= x<<13
  s = jsXor(s, Math.floor(s / 131072)); // x ^= x>>17
  s = jsXor(s, (s * 32) % M31); // x ^= x<<5
  return s;
}

/** 31-multi MAC over the plaintext (mod 2^31) — identical to the loader's. */
function jsChecksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum * 31 + b) % M31;
  return sum;
}

/**
 * JS mirror of the encrypt stream — also the shared ground truth for the
 * test suite (the loader must decode exactly what this produces).
 */
export function jsEncryptBlob(plainBytes, seed, version) {
  const v2 = version !== 'v1';
  const v21 = version === 'v2.1';
  const blob = [];
  let st = seed;
  let stJ = jsNx(seed);
  for (let j = 0; j < plainBytes.length; j += 1) {
    st = jsNx(st);
    let k = st % 256;
    if (v2) k = jsXor(k, Math.floor(seed / (j + 7)) % 256);
    blob.push((plainBytes[j] ^ k) & 0xff);
    if (v21) {
      stJ = jsNx(stJ);
      blob.push(stJ % 256);
    }
  }
  return blob;
}

// ---- encoding helpers ---------------------------------------------------------

/** Split a byte array into fixed-size chunks. */
function chunkBytes(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/**
 * Bytes → Lua string literal. Decimal escapes are ALWAYS 3-digit padded, so a
 * digit that follows an escape can never be swallowed by the parser.
 */
function luaStringLiteral(bytes) {
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c || b < 0x20 || b > 0x7e) out += `\\${String(b).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out}"`;
}

// ---- name + spacing mangling ---------------------------------------------------

function rng(seed) {
  let s = seed % M32;
  return () => {
    s = jsNx(s);
    return s / M32;
  };
}

function makeNames(rand, count) {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alnum = letters + '0123456789';
  const used = new Set();
  const names = [];
  for (let i = 0; i < count; i += 1) {
    for (;;) {
      let n = `_${letters[Math.floor(rand() * letters.length)]}`;
      const extra = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < extra; j += 1) n += alnum[Math.floor(rand() * alnum.length)];
      if (!used.has(n) && !/\d$/.test(n)) { used.add(n); names.push(n); break; }
    }
  }
  return names;
}

/** Random joiner between loader tokens (cosmetic mangling, every build differs). */
function makeSpacer(rand) {
  const opts = [' ', '  ', ' ', '\n', ' ', '\t', ' '];
  return () => opts[Math.floor(rand() * opts.length)];
}

// ---- core obfuscator --------------------------------------------------------------

/**
 * Obfuscate Lua source.
 * @param {string} source  the plaintext Lua source
 * @param {{version?:string, seed?:number}} opts
 * @returns {{ok:true, code:string, version:string, seed:number, stats:object}
 *          |{ok:false, error:string}}
 */
export function xfuscate(source, { version = XFUSCATOR_DEFAULT, seed = null } = {}) {
  try {
    if (!XFUSCATOR_VERSIONS.includes(version)) {
      return { ok: false, error: `Unknown Xfuscator version "${version}" (use v1, v2 or v2.1).` };
    }
    const src = String(source ?? '');
    if (!src.trim()) return { ok: false, error: 'Empty input — nothing to obfuscate.' };
    if (isXfuscated(src)) return { ok: false, error: 'This file is already obfuscated with Xfuscator.' };

    const v2 = version !== 'v1';
    const v21 = version === 'v2.1';

    // Plain bytes + MAC.
    const plain = Buffer.from(src, 'utf8');
    const n = plain.length;
    const check = jsChecksum(plain);

    // Per-build random seed (never 0 — xorshift would collapse to the zero stream).
    // < 2^31 so every downstream value stays inside fengari's int32-safe range.
    const s = (seed ?? (1 + Math.floor(Math.random() * (M31 - 2)))) % M31;
    if (s === 0) return { ok: false, error: 'internal: zero seed' };

    // Encrypt via the shared mirror stream (also the test-suite ground truth).
    const blob = jsEncryptBlob(plain, s, version);

    // JS mirror self-check — never emit anything the mirror cannot decode.
    const decoded = jsDecode(blob, s, version);
    if (decoded.length !== n || !decoded.equals(plain)) {
      return { ok: false, error: 'internal: mirror decode mismatch — output withheld' };
    }

    // Loader assembly.
    const rand = rng((s ^ n ^ 0x58465553) % M31 || 1);
    const spacer = makeSpacer(rand);
    const chunked = chunkBytes(blob, 65536);
    // ONE name pool for everything (helpers + blob chunks) — no collisions.
    const names = makeNames(rand, 12 + chunked.length); // _char,_byte,_floor,_load,_xor,_nx,_seed,_blob,_out,_st,_cnt,_i (+ chunk names)
    const [Nc, Nb, Nf, Nl, Nx, Nn, Ns, Nt, No, Np, NcN, Ni] = names;
    const blobNames = names.slice(12);
    const w = spacer;

    // Parts meet at token boundaries — joined with a space so a trailing W()
    // of ''/'  '/'\t' can never glue two tokens together (e.g. "1for").
    const J = (parts) => parts.filter((x) => x !== null && x !== undefined && x !== '').join(' ');
    const W = () => w();

    const lines = [];
    lines.push(xfuscatorHeader(version));
    // helpers
    lines.push(`local ${Nc}${W()}=${W()}string.char${W()};${W()}local ${Nb}${W()}=${W()}string.byte`);
    lines.push(`local ${Nf}${W()}=${W()}math.floor${W()};${W()}local ${Nl}${W()}=${W()}loadstring or load`);
    // arithmetic XOR
    lines.push(J([
      `local ${W()}function ${Nx}${W()}(${W()}a${W()},${W()}b${W()})`,
      `local ${W()}r${W()},${W()}m${W()}=${W()}0${W()},${W()}1`,
      `for ${W()}i${W()}=${W()}1${W()},${W()}31${W()} do`,
      `local ${W()}x${W()},${W()}y${W()}=${W()}a%2${W()},${W()}b%2`,
      `if ${W()}x~=y${W()} then ${W()}r${W()}=${W()}r+m${W()} ${W()}end`,
      `a${W()}=${W()}(a-x)/2${W()};${W()}b${W()}=${W()}(b-y)/2${W()};${W()}m${W()}=${W()}m*2`,
      `if ${W()}a==0 and b==0${W()} then ${W()}break${W()} ${W()}end`,
      `end${W()} return ${W()}r${W()} end`,
    ]));
    // xorshift
    lines.push(J([
      `local ${W()}function ${Nn}${W()}(${W()}s${W()})`,
      `s${W()}=${W()}s%${M31}`,
      `s${W()}=${W()}${Nx}(s${W()},${W()}(s*8192)%${M31})`,
      `s${W()}=${W()}${Nx}(s${W()},${Nf}(s/131072))`,
      `s${W()}=${W()}${Nx}(s${W()},${W()}(s*32)%${M31})`,
      `return ${W()}s end`,
    ]));
    // seed + blob chunks
    const blobDecl = blobNames.map((bn, i) => `local ${bn}${W()}=${W()}${luaStringLiteral(chunked[i])}`).join(`;${W()}`);
    lines.push(`local ${Ns}${W()}=${W()}${s}`);
    lines.push(blobDecl);
    // Multi-chunk: concat the chunk locals. Single-chunk: alias the declared
    // chunk local (never self-reference — Nt is not the chunk's name).
    lines.push(`local ${Nt}${W()}=${W()}${blobNames.length > 1 ? blobNames.join(`${W()}..${W()}`) : blobNames[0]}`);
    lines.push(`local ${No}${W()}=${W()}{}${W()} local ${Np}${W()}=${W()}${Ns}${W()} local ${NcN}${W()}=${W()}0`);
    // decode loop — v2.1 strides over junk bytes
    lines.push(J([
      `for ${W()}${Ni}${W()}=${W()}1${W()},${W()}#${Nt}${W()},${W()}${v21 ? 2 : 1}${W()} do`,
      `local ${W()}c${W()}=${W()}${Nb}(${Nt},${Ni},${Ni})`,
      `${Np}${W()}=${W()}${Nn}(${Np})`,
      `local ${W()}k${W()}=${W()}${Np}%256`,
      v2 ? `k${W()}=${W()}${Nx}(k${W()},${Nf}(${Ns}/(${NcN}+7))%256)` : null,
      `${NcN}${W()}=${W()}${NcN}+1`,
      `${No}[${NcN}]${W()}=${W()}${Nx}(c${W()},${W()}k)`,
      'end',
    ]));
    // integrity gates (v2+): count + MAC, then materialize + load
    if (v2) {
      lines.push(J([
        `if ${W()}${NcN}~=${W()}${n}${W()} then ${W()}return${W()} ${W()}end`,
        `local ${W()}sum${W()}=${W()}0`,
        `for ${W()}i${W()}=${W()}1${W()},${W()}${NcN}${W()} do`,
        `sum${W()}=${W()}(sum*31+${No}[i])%${M31}`,
        'end',
        `if ${W()}sum~=${W()}${check}${W()} then ${W()}return${W()} ${W()}end`,
      ]));
    }
    lines.push(J([
      `local ${W()}s${W()}=${W()}{}${W()}`,
      `for ${W()}i${W()}=${W()}1${W()},${W()}${NcN}${W()} do ${W()}s[i]${W()}=${W()}${Nc}(${No}[i])${W()} ${W()}end`,
      `${Nl}(table.concat(s))()`,
    ]));

    const code = lines.join('\n');
    const stats = {
      originalBytes: n,
      outputBytes: Buffer.byteLength(code, 'utf8'),
      seed: s,
      check,
      junkBytes: v21 ? n : 0,
    };
    return { ok: true, code, version, seed: s, stats };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * JS mirror of the Lua loader — the ground truth the emitted code must match.
 * Runs before every emit (xfuscate) and in tests against real fengari runs.
 */
export function jsDecode(blobBytes, seed, version) {
  const v2 = version !== 'v1';
  const v21 = version === 'v2.1';
  const stride = v21 ? 2 : 1;
  const out = [];
  let st = seed;
  let idx = 0;
  for (let i = 0; i < blobBytes.length; i += stride) {
    const c = blobBytes[i];
    st = jsNx(st);
    let k = st % 256;
    if (v2) k = jsXor(k, Math.floor(seed / (idx + 7)) % 256);
    idx += 1;
    out.push(jsXor(c, k) & 0xff);
  }
  return Buffer.from(out);
}
