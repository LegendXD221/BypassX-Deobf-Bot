/**
 * BypassX Deobf Bot — fetch obfuscated input from a link (v1.2.0 "link support").
 *
 * Supported hosts:
 *   • Pastefy            pastefy.app/<id>            (API raw content)
 *   • GitHub             github.com/u/r/(blob|raw)/… → raw.githubusercontent.com
 *   • GitHub Gists       gist.github.com/u/<id>      (API, first file)
 *   • Pastebin           pastebin.com/<id>           → /raw/<id>
 *   • Discord messages   discord.com/channels/…/<msg> (bot resolves the
 *                        message's first attachment — or its text content)
 *   • Anything else      direct fetch (raw file hosts, CDNs, …)
 *
 * Security (SSRF guard): every hop of every redirect is DNS-resolved and
 * blocked if it lands on a private/reserved/metadata address. Only http(s)
 * is allowed, bodies are size-capped, redirects are followed manually
 * (max 5 hops) so no hop can escape the check.
 */
import dns from 'node:dns';
import net from 'node:net';
import { CONFIG } from './config.js';

const UA = 'BypassXDeobfBot/1.2 (+https://github.com/LegendXD221/BypassX-Deobf-Bot)';
const MAX_REDIRECTS = 5;

// ---- URL helpers ------------------------------------------------------------

/** True if the token plausibly is a URL (used to pick the link out of args). */
export function looksLikeUrl(token) {
  if (!token) return false;
  const t = String(token).trim().replace(/^[<("']+|[,>)"']+$/g, '');
  if (/\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return Boolean(safeParse(t));
  // bare domain form: pastefy.app/AbC, github.com/u/r/blob/main/x.lua
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)
    && Boolean(safeParse(`https://${t}`));
}

function safeParse(s) {
  try { return new URL(s); } catch { return null; }
}

/** Normalize a user-provided URL: add https://, trim decoration, validate. */
export function normalizeUrl(raw) {
  const t = String(raw || '').trim().replace(/^[<("']+|[,>)"']+$/g, '');
  if (!t) throw new Error('Empty link.');
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.exec(t)?.[0]?.slice(0, -2);
  if (explicit && !/^https?:$/i.test(explicit)) {
    throw new Error('Only http(s) links are supported.');
  }
  const withScheme = explicit ? t : `https://${t}`;
  const u = safeParse(withScheme);
  if (!u || !u.hostname) throw new Error(`Not a valid link: \`${t.slice(0, 120)}\``);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Only http(s) links are supported.');
  }
  u.protocol = 'https:'; // never send plaintext
  return u;
}

// ---- SSRF guard ---------------------------------------------------------------

const PRIVATE_V4_CIDRS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip) {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    if (n === null) return true;
    return PRIVATE_V4_CIDRS.some(([cidr, bits]) => {
      const [base] = cidr.split('/');
      const bn = v4ToInt(base);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (bn & mask);
    });
  }
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped) return isPrivateIp(mapped[1]);
  // fc00::/7 (unique local), fe80::/10 (link local), ff00::/8 (multicast)
  return /^(f[cd]|fe[89ab]|ff)/.test(low);
}

const BLOCKED_HOST_SUFFIX = ['localhost', '.local', '.internal', '.home.arpa', '.localdomain'];

/** DNS-resolve the hostname and refuse private/reserved/metadata targets. */
export async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_HOST_SUFFIX.some((s) => host === s.slice(1) || host.endsWith(s))) {
    throw new Error('Blocked: link points to a non-public host.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Blocked: link points to a private/reserved address.');
    return;
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve \`${host}\` — check the link.`);
  }
  if (!addrs.length) throw new Error(`Could not resolve \`${host}\` — check the link.`);
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Blocked: link points to a private/reserved address.');
  }
}

// ---- capped body reader -----------------------------------------------------

async function readCapped(body, maxBytes, label) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`File too large: over ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit from ${label}.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch with per-hop SSRF checks + manual redirects + size cap.
 * @returns {Promise<{buffer: Buffer, contentType: string, finalUrl: URL}>}
 */
export async function safeFetch(rawUrl, { maxBytes, timeoutMs = 30_000, headers = {} } = {}) {
  let cur = rawUrl instanceof URL ? rawUrl : normalizeUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(cur.hostname);
    let res;
    try {
      res = await fetch(cur, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': UA, ...headers },
      });
    } catch (e) {
      if (String(e?.name) === 'TimeoutError') throw new Error(`Timed out fetching \`${cur.host}\`.`);
      throw new Error(`Network error fetching \`${cur.host}\`: ${String(e?.message || e).slice(0, 120)}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirect (HTTP ${res.status}) without a Location header.`);
      res.body?.cancel?.().catch(() => {});
      cur = new URL(loc, cur);
      if (cur.protocol !== 'https:' && cur.protocol !== 'http:') throw new Error('Redirect to a non-http(s) URL — blocked.');
      continue;
    }
    if (!res.ok) {
      const hint = res.status === 404 ? ' — the file or paste does not exist (or is private)'
        : res.status === 403 ? ' — the host refused the download (private paste or bot block)'
        : '';
      res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status} from \`${cur.host}\`${hint}.`);
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) {
      res.body?.cancel?.().catch(() => {});
      throw new Error(`File too large: ${(len / 1024 / 1024).toFixed(2)} MB (limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
    }
    const buffer = await readCapped(res.body, maxBytes, cur.host);
    return { buffer, contentType: res.headers.get('content-type') || '', finalUrl: cur };
  }
  throw new Error('Too many redirects (max 5).');
}

// ---- filename / language guessing ------------------------------------------

/** Guess a file extension from content sniffing (first bytes win). */
export function guessExtFromContent(buf) {
  const b = Buffer.isBuffer(buf) ? buf.subarray(0, 4096) : Buffer.alloc(0);
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return '.exe';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return '.gz';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return '.zip';
  if (b.subarray(0, 5).toString() === '%PDF-') return '.pdf';
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return '.elf';
  const s = b.toString('utf8');
  if (/\bend\s*\)?\s*$|\bthen\b|\bfunction\s+\w+\s*\(/.test(s) && /\blocal\b|--\[\[/.test(s)) return '.lua';
  if (/\b(?:function|const|let|var|import)\b/.test(s) && /[;{}]\s*$/m.test(s)) return '.js';
  if (/^\s*def\s+\w+\s*\(.*\)\s*:|^\s*import\s+\w+|#!\s*\S*python/m.test(s)) return '.py';
  return '.txt';
}

function basename(url) {
  try {
    const p = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return p.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120);
  } catch { return ''; }
}

function fromTitle(title, fallback) {
  const t = String(title || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 100);
  return t || fallback;
}

// ---- host resolvers -----------------------------------------------------------

const GITHUB_BLOB = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/;

async function fetchPastefy(u, maxBytes) {
  if (!/(^|\.)pastefy\.app$/i.test(u.hostname)) return null;
  const id = u.pathname.split('/').filter(Boolean)[0];
  if (!id || id === 'api') return null;
  const { buffer, contentType } = await safeFetch(`https://pastefy.app/api/v2/paste/${encodeURIComponent(id)}`, { maxBytes });
  let content = null;
  let title = '';
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    content = json?.paste?.content ?? json?.content ?? null;
    title = json?.paste?.title || json?.title || '';
  } catch { /* not JSON — fall through */ }
  if (content == null) throw new Error('That Pastefy paste has no readable content.');
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > maxBytes) throw new Error(`File too large: paste exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  const ext = guessExtFromContent(buf);
  const name = fromTitle(title, `paste-${id}${ext}`);
  return { buffer: buf, filename: /\.[a-z0-9]{1,6}$/i.test(name) ? name : `${name}${ext}`,
    note: 'Pastefy paste', contentType };
}

async function fetchGitHub(u, maxBytes) {
  if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
  const m = GITHUB_BLOB.exec(u.pathname);
  if (!m) return null;
  const [, owner, repo, branch, path] = m;
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  try {
    const { buffer } = await safeFetch(raw, { maxBytes });
    return { buffer, filename: basename(raw) || 'github-file', note: 'GitHub file', finalUrl: raw };
  } catch (e) {
    const authWalled = /HTTP (404|403)\b/.test(String(e?.message || e));
    if (authWalled && CONFIG.githubToken) {
      // Private repo — raw.githubusercontent 404s without auth. Retry with
      // the server's token (never forwarded anywhere else).
      const priv = await safeFetch(raw, {
        maxBytes,
        headers: { authorization: `Bearer ${CONFIG.githubToken}` },
      });
      return { buffer: priv.buffer, filename: basename(raw) || 'github-file', note: 'GitHub file (private)', finalUrl: raw };
    }
    if (authWalled) {
      throw new Error('GitHub file not found — check the link. Private repos work only when the bot server has a GITHUB_TOKEN configured.');
    }
    throw e;
  }
}

async function fetchGist(u, maxBytes) {
  // gist.github.com/<user>/<id> (or /<id>)
  if (!/(^|\.)gist\.github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const id = parts.length >= 2 ? parts[parts.length - 1] : null;
  if (!id || !/^[0-9a-f]{16,}$|^[\w-]{8,}$/.test(id)) return null;
  const headers = { accept: 'application/vnd.github+json' };
  if (CONFIG.githubToken) headers.authorization = `Bearer ${CONFIG.githubToken}`;
  const { buffer } = await safeFetch(`https://api.github.com/gists/${encodeURIComponent(id)}`, { maxBytes, headers });
  let files;
  try { files = JSON.parse(buffer.toString('utf8'))?.files || {}; } catch { files = {}; }
  const entry = Object.values(files).find((f) => f?.content) || Object.values(files)[0];
  if (!entry) throw new Error('That gist is empty or private.');
  if (entry.content) {
    const buf = Buffer.from(entry.content, 'utf8');
    return { buffer: buf, filename: entry.filename || 'gist-file', note: 'GitHub gist' };
  }
  const raw = await safeFetch(entry.raw_url, { maxBytes });
  return { buffer: raw.buffer, filename: entry.filename || 'gist-file', note: 'GitHub gist' };
}

async function fetchPastebin(u, maxBytes) {
  const segs = u.pathname.split('/').filter(Boolean);
  if (u.hostname !== 'pastebin.com' || segs.length === 0) return null;
  let rawUrl = null;
  if (segs.length === 1 && !/^(?:u|tools|settings|signup|login|doc|faq|archive|widget|scrape|languages|privacy|dmca|jobs|features|pricing)$/i.test(segs[0])) {
    rawUrl = `https://pastebin.com/raw/${encodeURIComponent(segs[0])}`;
  } else if (segs.length === 2 && segs[0] === 'raw') {
    rawUrl = u.href;
  }
  if (!rawUrl) return null;
  const { buffer } = await safeFetch(rawUrl, { maxBytes });
  return { buffer, filename: basename(rawUrl) || 'pastebin.txt', note: 'Pastebin paste' };
}

const DISCORD_MSG = /^\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)$/;

async function fetchDiscordMessage(u, maxBytes, client) {
  if (!/(^|\.)discord(?:app)?\.com$/i.test(u.hostname)) return null;
  const m = DISCORD_MSG.exec(u.pathname);
  if (!m) return null;
  if (!client) throw new Error('Discord message links need the bot online — try again shortly.');
  const [, channelId, messageId] = m;
  let msg;
  try {
    const channel = await client.channels.fetch(channelId);
    msg = await channel?.messages?.fetch(messageId);
  } catch {
    throw new Error('I cannot read that Discord message — I must share that server and have Read Message History there.');
  }
  if (!msg) throw new Error('Discord message not found.');
  const att = [...(msg.attachments?.values() || [])].sort((a, b) => b.size - a.size)[0];
  if (att) {
    if (att.size > maxBytes) throw new Error(`File too large: ${(att.size / 1024 / 1024).toFixed(2)} MB (limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
    const dl = await safeFetch(att.url, { maxBytes });
    return { buffer: dl.buffer, filename: att.name || 'discord-file', note: 'Discord message attachment' };
  }
  const text = (msg.content || '').trim();
  if (!text) throw new Error('That Discord message has no attachment and no text content.');
  const buf = Buffer.from(text, 'utf8');
  return { buffer: buf, filename: `message-${messageId}${guessExtFromContent(buf)}`, note: 'Discord message text' };
}

// ---- public API ----------------------------------------------------------------

/**
 * Fetch obfuscated input from a link.
 * @returns {Promise<{buffer: Buffer, filename: string, note: string, url: string}>}
 * @throws {Error} with a friendly, user-safe message.
 */
export async function fetchFromUrl(raw, { client = null, maxBytes = CONFIG.maxUploadBytes } = {}) {
  const u = normalizeUrl(raw);
  const cap = Math.max(64 * 1024, maxBytes);
  const opts = { client, maxBytes: cap };

  let res = await fetchPastefy(u, cap).catch((e) => { if (isOurError(e)) throw e; return null; })
    ?? await fetchGitHub(u, cap).catch((e) => { if (isOurError(e)) throw e; return null; })
    ?? await fetchGist(u, cap).catch((e) => { if (isOurError(e)) throw e; return null; })
    ?? await fetchPastebin(u, cap).catch((e) => { if (isOurError(e)) throw e; return null; })
    ?? await fetchDiscordMessage(u, cap, client).catch((e) => { if (isOurError(e)) throw e; return null; });

  // Marked-for-this-host errors (HTTP 404/403, too large, …) should surface
  // even if a resolver returned null — direct fetch will hit the same wall,
  // so re-run the failing path explicitly for accurate messages.
  if (!res) {
    res = await fetchDirect(u, cap);
  }
  if (res.buffer.length > cap) {
    throw new Error(`File too large: ${(res.buffer.length / 1024 / 1024).toFixed(2)} MB (limit ${(cap / 1024 / 1024).toFixed(0)} MB).`);
  }
  return { ...res, url: u.href };
}

function isOurError(e) {
  return /\bHTTP \d|too large|Blocked|redirect|non-public|resolve|timed out|network error|no readable|empty or private|cannot read that discord|has no attachment|not a valid link|only http/i
    .test(String(e?.message || e));
}

async function fetchDirect(u, maxBytes) {
  const { buffer, contentType, finalUrl } = await safeFetch(u, { maxBytes });
  let name = basename(finalUrl);
  if (name && !/\.[a-z0-9]{1,8}$/i.test(name)) name += guessExtFromContent(buffer);
  return {
    buffer,
    filename: name || `download${guessExtFromContent(buffer)}`,
    note: 'Direct link',
    contentType,
  };
}
