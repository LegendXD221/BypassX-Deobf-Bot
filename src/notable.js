/**
 * Lucid Deobf Bot — notable-string classifier (dumper upgrade, v2.25.0).
 *
 * The dumpers produce thousands of decrypted strings; almost all are noise.
 * The strings that MATTER for the user's safety decision are the ones that
 * reveal what the script actually DOES — exfil endpoints, credentials,
 * loader chains. classifyStrings() tags each retained string with a kind so
 * the Environment Logger and the deobf replies can surface them FIRST.
 *
 * Kinds (checked in priority order — first match wins):
 *   webhook        discord.com/api/webhooks / discordapp.com/api/webhooks
 *   guild-join     guilds joined by an inviteresolver-style payload (gateway URL)
 *   token          discord bot-token shape (id.timestamp.hmac)
 *   ip-endpoint    host:port / bare IPv4
 *   url            http(s)://… (non-webhook)
 *   asset          roblox asset/library CDN paths + ids
 *   secret         keyword hits near credential-bearing names (password=, api_key…)
 *   loader         loadstring/game:HttpGet chains — second-stage loader markers
 *   base64         long base64-looking blobs (≥48 chars, likely payload)
 * Every other string is unclassified (undefined kind).
 */

const RE_WEBHOOK = /(?:(?:canary\.|ptb\.)?discord(?:app)?\.com|discord\.gg)\/api\/(?:v\d+\/)?webhooks\/|(?:webhook\.lewisakura\.moe|hooks\.hyra\.io|hooks\.slack\.com|api\.telegram\.org\/bot|webhook\.site|requestbin\.\w+|ngrok(?:-free)?\.app|ngrok\.io|pipedream\.net|oastify\.com|burpcollaborator\.net)/i;
const RE_IPLOGGER = /\b(?:api\.ipify\.org|grabify\.link|iplogger\.org|ip-api\.com|icanhazip\.com|ifconfig\.me|checkip\.amazonaws\.com|ipinfo\.io)\b/i;
const RE_STEALER = /\.ROBLOSECURITY|Local Storage[\\/]leveldb|discord[\\/]Local Storage|io\.popen\s*\(|os\.execute\s*\(|require\s*\(\s*["'](?:ffi|lfs)["']\s*\)/i;
const RE_GATEWAY = /(?:gateway|discord)\.(?:com|app|gg|status)\//i;
// Discord bot-token shape: three dot-separated segments (id.timestamp.hmac).
// Not \b-anchored per-part — ids are mixed-alphabet base64 (e.g. 'AAAABBBB…').
const RE_TOKEN = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{27,}/;
const RE_URL = /\bhttps?:\/\/[^\s"'`<>\\]{4,}/i;
const RE_IP = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/;
// Strong asset hosts win BEFORE the generic URL check (c0.rbxcdn.com/…).
// The weak ':<6 digits>' alternative stays with the generic position.
const RE_ASSET_STRONG = /\b(?:rbxcdn\.com|assetdelivery\.roblox\.com|roblox\.com\/(?:v\d+\/)?assets|rbxasset(?:id)?:)\//i;
const RE_ASSET = /\b(?:rbxasset|rbxcdn|assetdelivery)\b|:\d{6,}\b/i;
const RE_B64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{44,}[A-Za-z0-9+/=]{4}(?![A-Za-z0-9+/=])/;
const RE_LOADER = /\b(?:loadstring|load|require|getgenv|queue_on_teleport|HttpService)[^\n]{0,80}(?:game:HttpGet(?:Async)?|HttpGet(?:Async)?|GetAsync|syn\.request|http_request|http\.request|request)\b/i;
// Keyword proximity — snake_case boundaries: \b fails between '_' and 'a'
// ('_api_key_' has word chars on both sides), so the guard excludes only
// REAL word-start/end chars (letters/digits) and treats '_' as a boundary.
const RE_SECRET_KW = /(?:^|[^A-Za-z0-9])(?:password|passwd|api[_-]?key|apikey|secret|token|cookie|hwid|license|auth|webhook)(?:[^A-Za-z0-9]|$)/i;

export const NOTABLE_KINDS = ['webhook', 'token', 'stealer', 'iplogger', 'loader', 'guild-join', 'ip-endpoint', 'url', 'secret', 'asset', 'base64'];

/**
 * Classify one string → kind or null.
 * @param {string} s
 * @returns {string|null}
 */
export function classifyString(s) {
  if (typeof s !== 'string' || s.length < 4) return null;
  if (RE_WEBHOOK.test(s)) return 'webhook';
  if (RE_TOKEN.test(s)) return 'token';
  if (RE_STEALER.test(s)) return 'stealer';
  if (RE_IPLOGGER.test(s)) return 'iplogger';
  if (RE_GATEWAY.test(s) && RE_URL.test(s)) return 'guild-join';
  if (RE_ASSET_STRONG.test(s)) return 'asset';
  if (RE_LOADER.test(s)) return 'loader';
  if (RE_URL.test(s)) return 'url';
  if (RE_IP.test(s)) return 'ip-endpoint';
  if (RE_ASSET.test(s)) return 'asset';
  if (s.length >= 8 && RE_SECRET_KW.test(s)) return 'secret';
  if (RE_B64.test(s)) return 'base64';
  return null;
}

/**
 * Classify a string list; returns notable entries sorted by severity order
 * (kinds earlier in NOTABLE_KINDS first, then by string length desc).
 * @param {string[]} strings
 * @param {{cap?: number}} opts
 * @returns {Array<{s: string, kind: string}>}
 */
export function classifyStrings(strings, { cap = 24 } = {}) {
  const order = new Map(NOTABLE_KINDS.map((k, i) => [k, i]));
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(strings) ? strings : []) {
    const s = String(raw ?? '');
    if (s.length < 4 || seen.has(s)) continue;
    seen.add(s);
    const kind = classifyString(s);
    if (kind) out.push({ s, kind });
  }
  out.sort((a, b) => (order.get(a.kind) - order.get(b.kind)) || (b.s.length - a.s.length));
  return out.slice(0, cap);
}

/** One-line human label for a kind (embeds/reports). */
export function kindLabel(kind) {
  switch (kind) {
    case 'webhook': return 'exfil webhook';
    case 'token': return 'credential token';
    case 'stealer': return 'stealer / dangerous API';
    case 'iplogger': return 'IP logger';
    case 'guild-join': return 'gateway/guild endpoint';
    case 'ip-endpoint': return 'IP endpoint';
    case 'url': return 'URL';
    case 'asset': return 'Roblox asset';
    case 'secret': return 'credential keyword';
    case 'loader': return 'second-stage loader';
    case 'base64': return 'payload blob';
    default: return 'notable';
  }
}
