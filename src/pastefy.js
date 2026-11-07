/**
 * Pastefy (pastefy.app) paste client — the delivery channel for recovered code.
 *
 * Live-verified 2026-11 (v1.3.0 hardening):
 *  - POST https://pastefy.app/api/v2/paste, JSON body {title, content, type:
 *    'PASTE', visibility: 'UNLISTED'} → 200 {paste:{id,…}}  (anonymous OK)
 *  - `type: 'UNLISTED'` is NOT a valid type → HTTP 500 {error:true}; older
 *    builds of this bot tripped on that (first shape 500s). The real fix is
 *    the right shape, with looser shapes as fallbacks.
 *  - Pastefy rejects request bodies ≳1.1 MB with HTTP 413 — large recovered
 *    files used to fail to paste. Fix: automatic multi-part pastes at a safe
 *    900 KB chunk size (split on line boundaries, byte-aware).
 *  - Transient failures (429/5xx/network) are retried with backoff and
 *    Retry-After support.
 */
import { CONFIG } from './config.js';
import { logger } from './logger.js';

const BASE = 'https://pastefy.app';
const ANON_TOKEN = 'bypassx-deobf-bot-anonymous';
/**
 * Safe per-paste body budget, measured on the JSON-ESCAPED size (server 413s
 * at ~1.1 MB). String-heavy obfuscated code expands ~1.3-2.2x under JSON
 * escaping, so budgeting on raw bytes is what broke large pastes before.
 */
const CHUNK_ESCAPED_BYTES = 950_000;
const RETRIES = 3;

/** Size of `s` after JSON string escaping (without the surrounding quotes). */
function escapedLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 92 || c === 10 || c === 13 || c === 9 || c < 32) n += 2;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0xd800 || c >= 0xe000) n += 3;
    else n += 4; // surrogate pair
  }
  return n;
}

/** Split text into chunks whose escaped size stays ≤ maxBytes. join('') restores the original. */
export function splitForPaste(text, maxBytes = CHUNK_ESCAPED_BYTES) {
  const s = String(text ?? '');
  if (escapedLength(s) <= maxBytes) return [s];
  const endsNL = s.endsWith('\n');
  const lines = s.split('\n');
  const chunks = [];
  let cur = '';
  let curEsc = 0;
  const flush = () => { if (cur.length) { chunks.push(cur); cur = ''; curEsc = 0; } };
  const emitLine = (line, isLastOverall) => {
    const needsNL = !(isLastOverall && !endsNL);
    let lb = escapedLength(line) + (needsNL ? 1 : 0);
    if (lb > maxBytes) {
      // Oversized single line — hard-split by escaped size, no separators.
      const pieces = [];
      let piece = '';
      let pieceEsc = 0;
      for (const ch of line) {
        const cb = escapedLength(ch);
        if (pieceEsc + cb > maxBytes - 1) { pieces.push(piece); piece = ''; pieceEsc = 0; }
        piece += ch;
        pieceEsc += cb;
      }
      pieces.push(piece);
      for (let i = 0; i < pieces.length - 1; i++) chunks.push(pieces[i]);
      emitLine(pieces[pieces.length - 1], isLastOverall);
      return;
    }
    if (curEsc + lb > maxBytes) flush();
    cur += line + (needsNL ? '\n' : '');
    curEsc += lb;
  };
  for (let i = 0; i < lines.length; i++) emitLine(lines[i], i === lines.length - 1);
  flush();
  return chunks;
}

function shapeForKey(key, { title, text }) {
  if (key === 'standard') return { title, content: text, type: 'PASTE', visibility: 'UNLISTED' };
  if (key === 'content') return { title, content: text, type: 'PASTE' };
  if (key === 'text') return { title, text, type: 'PASTE' };
  return { title, content: text };
}

let workingShapeKey = 'standard';

function buildShapes(spec) {
  const order = [workingShapeKey, 'standard', 'content', 'text', 'content-only'];
  const seen = new Set();
  const out = [];
  for (const k of order) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(shapeForKey(k, spec));
  }
  return out;
}

/**
 * One POST attempt with retries for transient failures.
 * Returns { id } or throws Error with .code / .status.
 */
async function postPaste(body, authHeader, timeoutMs) {
  let lastErr = null;
  for (let i = 0; i < RETRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** i)));
    try {
      const res = await fetch(`${BASE}/api/v2/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after') || 0);
        await res.body?.cancel?.().catch(() => {});
        lastErr = Object.assign(new Error(`pastefy transient HTTP ${res.status}`), { code: 'paste_transient', status: res.status, retryAfterMs: ra ? ra * 1000 : null });
        continue;
      }
      const data = await res.json().catch(() => null);
      const paste = data?.paste && data.paste.id ? data.paste : (data?.id ? data : null);
      if (res.ok && paste?.id) {
        if (body.content !== undefined && body.text === undefined && body.visibility !== undefined) workingShapeKey = 'standard';
        else if (body.text !== undefined) workingShapeKey = 'text';
        else if (body.content !== undefined) workingShapeKey = workingShapeKey === 'text' ? 'text' : 'content';
        return paste;
      }
      throw Object.assign(
        new Error(`pastefy rejected paste: HTTP ${res.status} ${data?.error || data?.exception || data?.message || ''}`.trim()),
        { code: res.status === 401 || res.status === 403 ? 'paste_auth' : 'paste_rejected', status: res.status },
      );
    } catch (e) {
      if (e.code === 'paste_auth' || e.code === 'paste_rejected') throw e; // permanent
      lastErr = e; // transient / network — retry
    }
  }
  throw lastErr || new Error('pastefy paste creation failed');
}

/**
 * Create a paste (auto-chunked when large). Returns
 *   { id, url, rawUrl, anonymous, parts?: [{ id, url, index, of }] }
 * Throws Error with .code on failure — callers degrade gracefully.
 */
export async function createPaste({
  title, text, token = CONFIG.pastefyToken, timeoutMs = 20_000,
}) {
  if (!text || !String(text).trim()) {
    throw Object.assign(new Error('nothing to paste (empty content)'), { code: 'paste_empty' });
  }
  const auth = `Bearer ${token || ANON_TOKEN}`;
  const chunks = splitForPaste(text);
  const of = chunks.length;

  // Shape discovery on a tiny probe first — never risk the first real chunk
  // burning bytes on a wrong shape (413-class failures excluded: shapes only
  // differ in field names, sizes are identical).
  let shape = null;
  for (const body of buildShapes({ title: `${title}`.slice(0, 180), text: chunks[0] })) {
    try {
      shape = await postPaste(body, auth, timeoutMs);
      break;
    } catch (e) {
      if (e.code === 'paste_auth') throw e;
      if (e.code === 'paste_transient') throw e;
      // rejected shape → try next
    }
  }
  if (!shape) {
    throw Object.assign(new Error('pastefy rejected every known paste shape'), { code: 'paste_rejected' });
  }

  const parts = [{ id: shape.id, url: `${BASE}/${shape.id}`, index: 1, of }];
  // Remaining chunks — same shape fields, updated title/content. Gentle pace:
  // back-to-back multi-hundred-KB posts can trip the server's 500 guard.
  for (let i = 1; i < of; i++) {
    if (i > 1) await new Promise((r) => setTimeout(r, 400));
    const spec = { title: `${title} (Part ${i + 1}/${of})`.slice(0, 180), text: chunks[i] };
    const body = buildShapes(spec)[0];
    const p = await postPaste(body, auth, timeoutMs);
    parts.push({ id: p.id, url: `${BASE}/${p.id}`, index: i + 1, of });
  }

  logger.info({ parts: parts.length, bytes: Buffer.byteLength(text) }, 'pastefy: uploaded');
  return {
    id: shape.id,
    url: `${BASE}/${shape.id}`,
    rawUrl: `${BASE}/${shape.id}/raw`,
    anonymous: !token,
    parts: of > 1 ? parts : undefined,
  };
}
