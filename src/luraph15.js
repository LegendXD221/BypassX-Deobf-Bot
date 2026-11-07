/**
 * BypassX Deobf Bot — Luraph v15.x payload devirtualization stage.
 *
 * The Rust engine (0.12.0) peels the v15.x wire format (quoted carrier +
 * ascii85) and returns a chunk inventory plus the raw VM payload. This module
 * turns that payload into something a human can use:
 *
 *   1. payload structure parse — records are delimited by 4 zero bytes, each
 *      prefixed by a 12-byte per-build header (key material + length tag).
 *   2. per-build key capture — Luraph v15.1 derives its build keys from string
 *      carriers embedded in the obfuscated file (quoted-carrier scheme). We
 *      extract the high-entropy long literals and fingerprint them so a future
 *      engine release (or offline analysis) can replay the exact key schedule.
 *   3. lzma-block flag detection — `lzma_inflated` chunks start with the LZMA
 *      props byte + dict-size pattern.
 *
 * It is deliberately side-effect free: no execution, no network — pure bytes.
 */
import { createHash } from 'node:crypto';

const ZERO4 = Buffer.from([0, 0, 0, 0]);

/** Parse the ascii85-decoded v15.x payload into records. */
export function parsePayload(payloadBuf) {
  const records = [];
  let pos = 0;
  while (pos + 12 <= payloadBuf.length) {
    const header = payloadBuf.subarray(pos, pos + 12);
    // record body runs until the next 4-zero separator (or EOF)
    let end = payloadBuf.indexOf(ZERO4, pos + 12);
    if (end === -1) end = payloadBuf.length;
    const body = payloadBuf.subarray(pos + 12, end);
    const entropy = entropyBitsPerByte(body);
    records.push({
      offset: pos,
      headerHex: header.toString('hex'),
      keySeedHex: header.subarray(0, 8).toString('hex'),
      tagHex: header.subarray(8, 12).toString('hex'),
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex').slice(0, 16),
      entropy,
      lzmaLike: body.length > 13 && body[0] <= 3 && body.subarray(1, 5).toString('hex') === '00000000' && (body[13] ?? -1) !== 0,
    });
    pos = end + 4;
  }
  return { records, total: payloadBuf.length, trailing: Math.max(0, payloadBuf.length - pos) };
}

/** Shannon entropy in bits/byte (0–8) — encrypted blocks sit near 8.0. */
function entropyBitsPerByte(buf) {
  if (!buf.length) return 0;
  const freq = new Array(256).fill(0);
  for (const b of buf) freq[b] += 1;
  let h = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / buf.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 100) / 100;
}

/**
 * Per-build key-carrier capture: Luraph v15.1 hides per-build key material in
 * long string literals inside the file (the "quoted carrier"). Long literals
 * that are NOT the payload itself are key candidates. Returns a compact
 * fingerprint list (never the full bytes — they stay in the sample).
 */
export function captureKeyCarriers(sourceText) {
  const carriers = [];
  const re = /"((?:[^"\\\n]|\\.|\\x[0-9a-fA-F]{2}|\\[0-7]{1,3}|\\[abfnrtv]){64,})"/g;
  let m;
  while ((m = re.exec(sourceText))) {
    if (carriers.length >= 32) break;
    const raw = m[1];
    // unescape \xNN / \NNN to measure true entropy
    const bytes = unescapeLua(raw);
    if (bytes.length < 32) continue;
    const entropy = entropyBitsPerByte(bytes);
    carriers.push({
      at: m.index,
      bytes: bytes.length,
      entropy,
      sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      // prose ~4.0–4.5 bits/byte; base85/base64 text ~5.2–6.2; binary ~7+
      looksKeyish: entropy >= 5.2,
    });
  }
  return carriers;
}

function unescapeLua(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
    const n = raw[i + 1];
    if (n === 'x') { out.push(parseInt(raw.slice(i + 2, i + 4), 16) || 0); i += 3; }
    else if (n >= '0' && n <= '7') {
      let j = i + 1, v = 0, digits = 0;
      while (j < raw.length && digits < 3 && raw[j] >= '0' && raw[j] <= '7') { v = v * 8 + (raw.charCodeAt(j) - 48); j += 1; digits += 1; }
      out.push(v & 0xff); i = j - 1;
    } else {
      const map = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10 };
      out.push(map[n] ?? n?.charCodeAt(0) ?? 0);
      i += 1;
    }
  }
  return Buffer.from(out);
}

/** Does an engine output file look like a v15.x payload inventory? */
export function looksLikeLuraphInventory(text) {
  return text.includes('payload_ascii85_decoded_b64') || /magic\s*=\s*"LPH[?!+!]/.test(text);
}

/** Build the devirtualization report appended to the inventory file. */
export function formatReport(parsed, carriers, { version } = {}) {
  const lines = [
    '',
    '-- ---- BypassX Deobf Bot: Luraph ' + (version || 'v15.x') + ' devirtualization report ----',
    `-- payload: ${parsed.total} bytes in ${parsed.records.length} records${parsed.trailing ? ` (+${parsed.trailing} trailing bytes)` : ''}`,
    ...parsed.records.map((r, i) =>
      `-- record ${i}: off=${r.offset} size=${r.size} entropy=${r.entropy} hdr=${r.keySeedHex} tag=${r.tagHex} sha256=${r.sha256}${r.lzmaLike ? ' (lzma-like)' : ''}`),
    `-- per-build key carriers: ${carriers.length} long literals, ${carriers.filter((c) => c.looksKeyish).length} key-like`,
    ...carriers.slice(0, 12).map((c, i) =>
      `-- carrier ${i}: at=${c.at} bytes=${c.bytes} entropy=${c.entropy} sha256=${c.sha256}${c.looksKeyish ? ' [key-like]' : ''}`),
    '-- keys are derived per build from the carriers above; the jailed-VM',
    '-- harvester replays the build\'s own key schedule at runtime to recover',
    '-- the decrypted constant pool (see recovered-constants.lua when present).',
  ];
  return lines.join('\n') + '\n';
}
