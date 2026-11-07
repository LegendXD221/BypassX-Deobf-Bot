/**
 * Pastefy (pastefy.app) paste client — the delivery channel for recovered code.
 *
 * Proven behavior (live-verified 2026-11, reused from the BypassX Deobf API):
 *  - POST https://pastefy.app/api/v2/paste with body {title, content, type}
 *  - Authorization header must be present but is not validated for anonymous
 *    unlisted pastes; a real PASTEFY_TOKEN ties pastes to an account
 *  - body field is `content` (older docs said `text`); expiry via `expireAt`
 *
 * Robustness: tries the documented shape first, then looser variants; each
 * attempt always serializes the CURRENT text (no shape caching of bodies).
 */
import { CONFIG } from './config.js';

const BASE = 'https://pastefy.app';
const ANON_TOKEN = 'bypassx-deobf-bot-anonymous';

function shapeForKey(key, { title, text, type, expireAt }) {
  if (key === 'text') return { title, text, type };
  if (key === 'content-only') return { title, content: text };
  const body = { title, content: text, type };
  if (expireAt) body.expireAt = expireAt;
  return body;
}

let workingShapeKey = null;

function buildShapes(spec) {
  const order = workingShapeKey ? [workingShapeKey, 'content', 'text', 'content-only'] : ['content', 'text', 'content-only'];
  const seen = new Set();
  const out = [];
  for (const k of order) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(shapeForKey(k, spec));
  }
  return out;
}

export function expiryIso(days) {
  return days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
}

/**
 * Create a paste. Returns { id, url, rawUrl, anonymous }.
 * Throws Error with .code on failure — callers degrade gracefully.
 */
export async function createPaste({ title, text, type = 'UNLISTED', expireAt = expiryIso(CONFIG.pastefyExpireDays), token = CONFIG.pastefyToken, timeoutMs = 15_000 }) {
  if (!text || !String(text).trim()) {
    const err = new Error('nothing to paste (empty content)');
    err.code = 'paste_empty';
    throw err;
  }
  const auth = token ? `Bearer ${token}` : `Bearer ${ANON_TOKEN}`;
  let lastErr = null;
  const attempt = async (body, authHeader = auth) => {
    const res = await fetch(`${BASE}/api/v2/paste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    const paste = data?.paste || (data?.id ? data : null);
    if (res.ok && paste?.id) {
      if (body.content !== undefined && body.text === undefined && body.type !== undefined) workingShapeKey = 'content';
      else if (body.text !== undefined) workingShapeKey = 'text';
      return {
        id: paste.id,
        url: `${BASE}/${paste.id}`,
        rawUrl: `${BASE}/${paste.id}/raw`,
        anonymous: !token,
      };
    }
    const err = new Error(`pastefy rejected paste: HTTP ${res.status} ${data?.error || data?.exception || data?.message || ''}`.trim());
    err.code = res.status === 401 || res.status === 403 ? 'paste_auth' : 'paste_rejected';
    err.status = res.status;
    throw err;
  };

  try {
    for (const body of buildShapes({ title, text, type, expireAt })) {
      try {
        return await attempt(body);
      } catch (e) {
        lastErr = e;
        if (e.code === 'paste_auth') break;
      }
    }
    // Some Pastefy setups expect the raw token without Bearer prefix.
    return await attempt(shapeForKey(workingShapeKey || 'content', { title, text, type, expireAt }), token || ANON_TOKEN);
  } catch (e) {
    lastErr = e;
  }
  throw lastErr || new Error('pastefy paste creation failed');
}
