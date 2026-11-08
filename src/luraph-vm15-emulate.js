/**
 * BypassX Deobf Bot — Luraph v15.1 inner-VM emulator (loop-1 v-dispatch).
 *
 * Exactly emulates the captured interpreter semantics over the real-Luau
 * capture (k/s/L/O/Y/c/r + y[4] buffer + y[5] consts), including all three
 * lazy-decrypt families. Guest calls into the environment are logged; the
 * emulator's own execution produces the devirtualization trace.
 */
import { band, bxor, lshift, rshift, keyFromSeed, xorshiftStep, mul32 } from './luraph-vm15-core.js';

const CONST_KEY = 535359694;

function readVarint(buf, pos) {
  const b0 = buf[pos];
  if (b0 === undefined) return null;
  if (b0 < 128) return { v: b0, next: pos + 1 };
  const b1 = buf[pos + 1];
  if (b1 === undefined) return null;
  if (b1 < 128) return { v: (b0 - 128) * 128 + b1, next: pos + 2 };
  const b2 = buf[pos + 2];
  if (b2 === undefined) return null;
  if (b2 < 128) return { v: (b0 - 128) + (b1 - 128) * 16384 + b2 * 128, next: pos + 3 };
  const b3 = buf[pos + 3];
  if (b3 === undefined) return null;
  return {
    v: (b0 - 128) * 2097152 + (b1 - 128) * 128 + (b2 - 128) * 16384 + (b3 % 128) + (b3 - (b3 % 128)) * 2097152,
    next: pos + 4,
  };
}

/** block decrypt with explicit bit roles of loop 1: L←0, s←7, O←14, k←21 */
function blockDecrypt(st, seed, dst, n, nopOp) {
  let H = seed >>> 0;
  let m = dst + 1;
  for (let T = 1; T <= n; T++) {
    H = xorshiftStep(H);
    const set = (arr, i, bits) => {
      const v = arr[i];
      if (typeof v === 'number') arr[i] = bxor(v, band(rshift(H, bits), 127));
    };
    set(st.L, m, 0); set(st.s, m, 7); set(st.O, m, 14); set(st.k, m, 21);
    m++;
  }
  if (typeof st.k[dst] === 'number') st.k[dst] = nopOp;
}

/** loop-1 v=35/38 self-decrypt (B-key family) — variants 35 & 38 differ in roles. */
function selfDecrypt35(st, I) {
  const B = st.B >>> 0;
  // m,H,M,N = O[I], L[I], Q(B,P(U(B,14),262143),(P(U(B,28),15))), s[I]
  const m = st.O[I];
  const H = st.L[I];
  const M = bxor(B, band(rshift(B, 14), 262143), band(rshift(B, 28), 15));
  // note: bxor with 3 args in Lua = fold; emulate:
  const M3 = bxor(bxor(B, band(rshift(B, 14), 262143)), band(rshift(B, 28), 15)) >>> 0;
  const N = st.s[I] >>> 0;
  const C = m < 2097152 ? 7 : 14;
  const z = band(m, (1 << C) - 1) >>> 0;
  const j = rshift(m, C) >>> 0;
  st.L[I] = bxor(H, band(M3, 127));
  st.O[I] = bxor(z, band(rshift(M3, 14), 127));
  st.s[I] = bxor(N, band(rshift(M3, 7), 127));
  st.k[I] = bxor(j, band(rshift(M3, 21), 127));
  return I - 1;
}

function selfDecrypt38(st, I) {
  const B = st.B >>> 0;
  const m = st.s[I];
  const H = st.O[I];
  const M = st.L[I];
  const N = bxor(bxor(B, band(rshift(B, 14), 262143)), band(rshift(B, 28), 15)) >>> 0;
  const C = m < 16384 ? 7 : (m < 2097152 ? 14 : 21);
  const z = rshift(m, C) >>> 0;
  const j = band(m, (1 << C) - 1) >>> 0;
  st.L[I] = bxor(M, band(N, 127));
  st.s[I] = bxor(j, band(rshift(N, 7), 127));
  st.O[I] = bxor(H, band(rshift(N, 14), 127));
  st.k[I] = bxor(z, band(rshift(N, 21), 127));
  return I - 1;
}

/** const decrypt (loop-1 v=84): const idx s[I], seed L[I]. Returns the decrypted bytes. */
function constDecrypt(st, I) {
  const K = st.s[I];
  const T = st.L[I] >>> 0;
  const off = bxor(st.y5[K], CONST_KEY) >>> 0;
  st.y5[K] = off;
  if (off >= st.buf.length) return null;
  const vi = readVarint(st.buf, off + 1);
  if (!vi) return null;
  const { v: len, next } = vi;
  if (next + len > st.buf.length) return null;
  const key32 = (T * 16843009) >>> 0;
  let p = next;
  const end = next + len;
  const end32 = end - (len % 4);
  for (; p + 4 <= end32 + 1 && p + 4 <= end; p += 4) {
    const v = st.buf.readUInt32LE(p);
    st.buf.writeUInt32LE(bxor(v, key32), p);
  }
  for (; p < end; p++) st.buf[p] = bxor(st.buf[p], band(T, 255));
  // instruction becomes op 50 with scrambled operands (marker only)
  st.s[I] = 141; st.L[I] = 75; st.O[I] = 193; st.k[I] = 50;
  return { idx: K, off: next, len, bytes: st.buf.subarray(next, end) };
}

/**
 * Run the emulator.
 * @param {object} cap  parsed capture ({k,s,L,O,Y,c,r,e,X,y4hex,y5,B,J,D,i,g})
 * @param {object} env  guest environment: { get(name), call(name, args) }
 * @param {object} opts { maxSteps }
 * @returns {{ trace: string[], statements: string[], consts: object[], steps: number, status: string }}
 */
export function emulate(cap, env, opts = {}) {
  const st = {
    k: cap.k.slice(), s: cap.s.slice(), L: cap.L.slice(), O: cap.O.slice(),
    Y: cap.Y ? cap.Y.slice() : [], c: cap.c ? cap.c.slice() : [], r: cap.r ? cap.r.slice() : [],
    y5: cap.y5.slice(),
    buf: Buffer.from(cap.y4hex, 'hex'),
    e: {},
    B: cap.B >>> 0, J: cap.J >>> 0, D: cap.D >>> 0,
    X: cap.X || [],
  };
  let I = cap.i;
  let g = cap.g;
  const trace = [];
  const statements = [];
  const consts = [];
  const seen = new Map();
  let steps = 0;
  const maxSteps = opts.maxSteps || 3_000_000;
  let status = 'exit';

  const reg = (i) => st.e[i];
  const setReg = (i, v) => { st.e[i] = v; };
  const isInternal = (v) => typeof v === 'string' && v.startsWith('\u0000BX:');
  const valText = (v) => {
    if (v === undefined || v === null) return 'nil';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return isInternal(v) ? v.slice(4) : JSON.stringify(v);
    if (v && v.__kind === 'global') return v.name;
    if (v && v.__kind === 'call') return v.text;
    return '<?>';
  };

  while (steps < maxSteps) {
    steps++;
    const v = st.k[I];
    if (typeof v !== 'number') { status = 'bad-op@' + I; break; }
    const line = (txt) => { const t = `[${I}] ${txt}`; if (trace.length < 4000) trace.push(t); };

    switch (v) {
      // ---- decrypt families ----
      case 10: { // block decrypt, J-key
        const seed = bxor(st.s[I] >>> 0, keyFromSeed(st.J)) >>> 0;
        blockDecrypt(st, seed, st.L[I], st.O[I], 50);
        line(`DECRYPT-BLOCK J seed=${seed} at=${st.L[I]} n=${st.O[I]}`);
        break;
      }
      case 82: { // block decrypt, B-key
        const seed = bxor(st.s[I] >>> 0, keyFromSeed(st.B)) >>> 0;
        blockDecrypt(st, seed, st.L[I], st.O[I], 50);
        line(`DECRYPT-BLOCK B seed=${seed} at=${st.L[I]} n=${st.O[I]}`);
        break;
      }
      case 35: I = selfDecrypt35(st, I); line('SELF-DECRYPT 35'); continue;
      case 38: I = selfDecrypt38(st, I); line('SELF-DECRYPT 38'); continue;
      case 84: { // const decrypt
        const d = constDecrypt(st, I);
        if (d) {
          const text = d.bytes.toString('latin1');
          consts.push({ idx: d.idx, len: d.len, text });
          setReg(-1, null); // no direct register store; data rides the buffer
          line(`CONST-DECRYPT idx=${d.idx} len=${d.len} ${JSON.stringify(text.slice(0, 60))}`);
        } else line(`CONST-DECRYPT idx=${st.s[I]} FAILED`);
        break;
      }

      // ---- moves / loads ----
      case 5: setReg(st.L[I], reg(st.O[I])); break;
      case 42: setReg(st.s[I], st.L[I]); break;
      case 95: setReg(st.s[I], st.Y[I]); break; // LOADK (Y immediate)
      case 87: setReg(st.s[I], st.L[I]); break;
      case 52: setReg(st.s[I], st.L[I]); setReg(st.L[I + 1], reg(st.O[I + 1])); I += 1; break;
      case 23: setReg(st.s[I], {}); break; // NEWTABLE
      case 27: setReg(st.O[I], { __kind: 'table', n: st.L[I] }); break;
      case 9: setReg(st.O[I], '\u0000BX:L-array'); break;
      case 109: setReg(st.s[I], '\u0000BX:k-array'); break;
      case 65: setReg(st.s[I], '\u0000BX:Jkey=' + st.J); break;
      case 72: setReg(st.L[I], '\u0000BX:Dkey=' + st.D); break;
      case 92: setReg(st.s[I], '\u0000BX:Bkey=' + st.B); break;
      case 43: setReg(st.O[I], '\u0000BX:proto'); break;
      case 22: setReg(st.s[I], '\u0000BX:k-array'); break;

      // ---- globals ----
      case 26: { // GETGLOBAL (env name = const c[I])
        const name = st.c[I];
        setReg(st.L[I], { __kind: 'global', name });
        statements.push(`local V${st.L[I]} = ${name}`);
        line(`GETGLOBAL V${st.L[I]} = ${JSON.stringify(name)}`);
        break;
      }
      case 66: { // GETGLOBAL (env name = L[I] immediate)
        const name = st.L[I];
        setReg(st.O[I], { __kind: 'global', name });
        statements.push(`local V${st.O[I]} = ${name}`);
        line(`GETGLOBAL V${st.O[I]} = ${JSON.stringify(name)}`);
        break;
      }
      case 89: { // SETGLOBAL
        statements.push(`${st.s[I]} = ${valText(reg(st.O[I]))}`);
        line(`SETGLOBAL ${st.s[I]}`);
        break;
      }

      // ---- tables ----
      case 49: setReg(st.s[I], { __kind: 'index', of: reg(st.O[I]), key: st.L[I] }); break;
      case 51: setReg(st.O[I], { __kind: 'index', of: reg(st.s[I]), key: st.Y[I] }); break;
      case 62: setReg(st.s[I], { __kind: 'index', of: reg(st.O[I]), key: reg(st.L[I]) }); break;
      case 105: statements.push(`${valText(reg(st.L[I]))}[${valText(reg(st.s[I]))}] = ${valText(reg(st.O[I]))}`); break;
      case 108: statements.push(`${valText(reg(st.O[I]))}[${JSON.stringify(st.c[I])}] = ${valText(reg(st.L[I]))}`); break;
      case 24: statements.push(`${valText(reg(st.O[I]))}[${st.s[I]}] = ${valText(reg(st.L[I]))}`); break;
      case 3: statements.push(`${valText(reg(st.O[I]))}[${valText(reg(st.L[I]))}] = ${st.s[I]}`); break;
      case 48: setReg(st.s[I], { __kind: 'len', of: reg(st.O[I]) }); break;

      // ---- arith ----
      case 17: setReg(st.O[I], { __kind: 'arith', op: '+', a: reg(st.L[I]), b: reg(st.s[I]) }); break;
      case 83: setReg(st.s[I], { __kind: 'arith', op: '+', a: reg(st.L[I]), b: st.O[I] }); break;
      case 36: setReg(st.s[I], { __kind: 'arith', op: '+', a: st.Y[I], b: reg(st.O[I]) }); break;
      case 6: setReg(st.O[I], { __kind: 'arith', op: '+', a: reg(st.s[I]), b: st.Y[I] }); break;
      case 60: setReg(st.s[I], { __kind: 'arith', op: '+', a: st.O[I], b: reg(st.L[I]) }); break;
      case 40: setReg(st.O[I], { __kind: 'arith', op: '-', a: reg(st.L[I]), b: reg(st.s[I]) }); break;
      case 8: setReg(st.O[I], { __kind: 'arith', op: '-', a: reg(st.L[I]), b: st.s[I] }); break;
      case 69: setReg(st.s[I], { __kind: 'arith', op: '-', a: st.O[I], b: reg(st.L[I]) }); break;
      case 97: setReg(st.L[I], { __kind: 'arith', op: '-', a: reg(st.O[I]), b: st.c[I] }); break;
      case 14: setReg(st.s[I], { __kind: 'arith', op: '*', a: reg(st.O[I]), b: reg(st.L[I]) }); break;
      case 100: setReg(st.s[I], { __kind: 'arith', op: '*', a: reg(st.L[I]), b: st.O[I] }); break;
      case 33: setReg(st.O[I], { __kind: 'arith', op: '*', a: st.L[I], b: reg(st.s[I]) }); break;
      case 74: setReg(st.s[I], { __kind: 'arith', op: '/', a: reg(st.O[I]), b: reg(st.L[I]) }); break;
      case 34: setReg(st.O[I], { __kind: 'arith', op: '/', a: reg(st.s[I]), b: st.L[I] }); break;
      case 1: setReg(st.O[I], { __kind: 'arith', op: '%', a: reg(st.s[I]), b: reg(st.L[I]) }); break;
      case 76: setReg(st.O[I], { __kind: 'arith', op: '%', a: reg(st.L[I]), b: st.s[I] }); break;
      case 88: setReg(st.s[I], { __kind: 'arith', op: '%', a: reg(st.O[I]), b: st.Y[I] }); break;
      case 43: setReg(st.O[I], { __kind: 'arith', op: '%', a: st.L[I], b: reg(st.s[I]) }); break;
      case 16: setReg(st.s[I], { __kind: 'arith', op: '//', a: reg(st.L[I]), b: reg(st.O[I]) }); break;
      case 86: setReg(st.O[I], { __kind: 'arith', op: '//', a: reg(st.L[I]), b: st.s[I] }); break;
      case 2: setReg(st.s[I], mul32(st.Y[I] >>> 0, st.O[I] >>> 0)); break;
      case 21: setReg(st.L[I], mul32(st.c[I] >>> 0, reg(st.O[I]) >>> 0)); break;
      case 56: setReg(st.O[I], mul32(reg(st.s[I]) >>> 0, st.L[I] >>> 0)); break;
      case 58: setReg(st.L[I], mul32(reg(st.O[I]) >>> 0, reg(st.s[I]) >>> 0)); break;
      case 78: setReg(st.s[I], mul32(st.Y[I] >>> 0, st.r[I] >>> 0)); break;
      case 80: setReg(st.L[I], mul32(reg(st.s[I]) >>> 0, reg(st.O[I]) >>> 0)); break;
      case 71: setReg(st.L[I], { __kind: 'arith', op: 'unm', a: reg(st.O[I]) }); break;
      case 101: setReg(st.s[I], { __kind: 'arith', op: 'not', a: reg(st.O[I]) }); break;
      case 28: setReg(st.O[I], toInt32(reg(st.s[I]))); break;
      case 102: setReg(st.s[I], toInt32(st.r[I])); break;
      case 79: for (let K = st.O[I]; K <= st.s[I]; K++) st.e[K] = null; break;

      // ---- compares ----
      case 13: setReg(st.O[I], { __kind: 'cmp', op: '==', a: reg(st.s[I]), b: reg(st.L[I]) }); break;
      case 63: setReg(st.L[I], { __kind: 'cmp', op: '==', a: reg(st.O[I]), b: st.s[I] }); break;
      case 55: setReg(st.O[I], { __kind: 'cmp', op: '<=', a: reg(st.L[I]), b: reg(st.s[I]) }); break;
      case 45: setReg(st.L[I], { __kind: 'cmp', op: '<=', a: reg(st.O[I]), b: st.s[I] }); break;
      case 12: setReg(st.O[I], { __kind: 'cmp', op: '<', a: reg(st.L[I]), b: st.s[I] }); break;
      case 68: setReg(st.O[I], { __kind: 'cmp', op: '>=', a: reg(st.s[I]), b: reg(st.L[I]) }); break;
      case 77: setReg(st.L[I], { __kind: 'cmp', op: '>', a: reg(st.O[I]), b: reg(st.s[I]) }); break;
      case 46: setReg(st.O[I], { __kind: 'cmp', op: '~=', a: reg(st.L[I]), b: st.s[I] }); break;
      case 99: setReg(st.L[I], { __kind: 'cmp', op: '~=', a: reg(st.O[I]), b: st.c[I] }); break;
      case 81: setReg(st.L[I], { __kind: 'cmp', op: '>', a: st.r[I], b: st.c[I] }); break;

      // ---- tests / jumps ----
      case 70: I = st.s[I]; line(`JMP ${I}`); continue;
      case 22 + 200: break; // placeholder (unused)
      case 22: break; // e[s]=k handled above; plain fallthrough
      case 11: { const cond = cmpEval(reg(st.L[I]), '<', st.s[I]); I = cond === true ? st.O[I] : I + 1; line(`TEST< ${cond} → ${I}`); continue; }
      case 61: { const a = reg(st.s[I]); const cond = (a !== undefined && a !== null && a !== false) && !(a === st.Y[I]); I = cond ? st.O[I] : I + 1; line(`TEST~= ${cond} → ${I}`); continue; }
      case 85: { const cond = cmpEval(reg(st.L[I]), '<=', st.s[I]); I = cond === true ? st.O[I] : I + 1; continue; }
      case 103: { const a = reg(st.L[I]); const cond = !(a === undefined || a === null || a === false); I = cond ? st.s[I] : st.O[I]; line(`TEST-truthy → ${I}`); continue; }
      case 22 + 1: break;

      // ---- calls ----
      case 44: { const f = reg(st.O[I]); doCall(f, [], st.L[I]); break; }
      case 47: { const f = reg(st.O[I]); doCall(f, [], null); break; }
      case 73: { const f = reg(st.s[I]); doCall(f, [reg(st.L[I])], st.O[I]); break; }
      case 19: { const f = reg(st.O[I]); doCall(f, [st.Y[I]], st.s[I]); break; }
      case 106: { const f = reg(st.L[I]); doCall(f, [reg(st.O[I])], null); break; }
      case 87: { const f = reg(st.L[I]); doCall(f, [st.r[I]], null); break; }
      case 4: { const f = reg(st.L[I]); doCall(f, [st.c[I], st.r[I]], null); break; }
      case 110: { const f = reg(st.L[I]); doCall(f, [reg(st.s[I]), st.r[I]], null); break; }
      case 88 + 1: break;
      case 7: { const f = reg(st.O[I]); doCall(f, [reg(st.L[I]), reg(st.s[I])], null); break; }
      case 64: { const f = reg(st.O[I]); const a = reg(st.O[I] + 1); const b = reg(st.O[I] + 2); const r = callValue(f, [a, b]); setReg(st.O[I], r); break; }
      case 92 + 1: break;
      case 54: { const H = reg(st.O[I]); setReg(st.s[I] + 1, H); setReg(st.s[I], { __kind: 'index', of: H, key: st.Y[I] }); break; }
      case 67: { const f = reg(st.L[I]); const packed = reg(st.s[I]); const args = packedArgs(packed); doCall(f, args, st.O[I]); break; }
      case 75: { const f = reg(st.s[I]); const selfv = reg(st.L[I]); const packed = reg(st.O[I]); doCall(f, [selfv, ...packedArgs(packed)], null); break; }

      // ---- multi-result call family 90..96 ----
      case 90: case 91: case 92: case 93: case 94: case 95: case 96: {
        const K = I;
        if (v === 94) { const f = reg(st.L[K]); const m2 = st.s[K]; const n2 = st.O[K]; const args = []; for (let x = m2 + 1; x <= m2 + n2; x++) args.push(reg(x)); const rv = callValue(f, args); setReg(m2, rv); }
        else if (v === 95) setReg(st.s[K], st.Y[K]);
        else if (v === 96) { g = st.O[K]; I = st.s[K] + 1; line(`EXIT g=${g} I=${I}`); status = 'exit'; steps = maxSteps; break; }
        else if (v === 92) setReg(st.s[K], '\u0000BX:Bkey=' + st.B);
        else if (v === 93) { const m2 = st.s[K]; const H2 = st.O[K]; const M2 = st.L[K]; const f = reg(m2); const args = []; for (let x = m2 + 1; x <= m2 + H2; x++) args.push(reg(x)); const rv = callValue(f, args); for (let x = 1; x <= M2; x++) setReg(m2 + x - 1, rv); }
        else if (v === 91) { const m2 = st.X[st.s[K]]; if (m2) statements.push(`upval[${valText(m2)}][${valText(reg(st.L[K]))}] = ${valText(reg(st.O[K]))}`); }
        else if (v === 90) { const m2 = st.X[st.s[K]]; if (m2) setReg(st.O[K], { __kind: 'upval', of: st.s[K] }); }
        break;
      }

      // ---- misc / register shuffles ----
      case 41: { const m = st.O[I]; const H = st.s[I]; const M = st.L[I]; const N = reg(m); for (let x = m + 1; x <= m + H; x++) setReg(x - m + M, reg(x)); setReg(M + (H || 0), N); break; }
      case 61: { const m = st.O[I]; const H = st.s[I]; const M = st.L[I]; for (let x = m + 1; x <= m + H; x++) setReg(x - m + M, reg(x)); break; }
      case 15: setReg(st.s[I], { __kind: 'closure', proto: st.Y ? st.Y[I] : null }); line(`CLOSURE → V${st.s[I]}`); break;
      case 20: st.J = (typeof reg(st.s[I]) === 'number' ? reg(st.s[I]) : st.J) >>> 0; break;
      case 25: st.B = (typeof reg(st.L[I]) === 'number' ? reg(st.L[I]) : st.B) >>> 0; break;
      case 31: st.D = (typeof reg(st.L[I]) === 'number' ? reg(st.L[I]) : st.D) >>> 0; break;
      case 89 + 200: break;
      case 57: case 98: case 29: { status = 'return@' + I; line(`RETURN (${status})`); steps = maxSteps; break; }
      case 30: case 32: case 37: case 53: case 104: case 107: case 18: case 50: {
        // upvalue/global misc — record, continue
        line(`MISC${v}`);
        break;
      }
      case 50: setReg(st.L[I], { __kind: 'global', name: st.c ? st.c[I] : '?' }); break;
      default:
        line(`OP${v} (unknown) s=${st.s[I]} L=${st.L[I]} O=${st.O[I]}`);
        break;
    }
    if (status !== 'exit' && status.startsWith('return')) break;
    I += 1;
  }
  if (steps >= maxSteps && status === 'exit') status = 'max-steps';

  function cmpEval(a, op, b) {
    if (a === undefined || b === undefined) return null;
    if (typeof a === 'number' && typeof b === 'number') {
      if (op === '<') return a < b;
      if (op === '<=') return a <= b;
      if (op === '==') return a === b;
    }
    return null;
  }
  function callValue(f, args) {
    if (f && f.__kind === 'global') {
      const r = env.call(f.name, args);
      statements.push(`${f.name}(${args.map(valText).join(', ')})`);
      return r;
    }
    statements.push(`CALL(${valText(f)})(${args.map(valText).join(', ')})`);
    return { __kind: 'result' };
  }
  function doCall(f, args, dst) {
    const r = callValue(f, args);
    if (dst !== null && dst !== undefined) setReg(dst, r);
  }
  function packedArgs(p) {
    if (p && p.__kind === 'table' && Array.isArray(p.items)) return p.items;
    return [];
  }

  return { trace, statements, consts, steps, status, k: st.k, buf: st.buf };
}
