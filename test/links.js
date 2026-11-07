/**
 * Link-support test suite (v1.2.0) — unit + live fetch tests, no Discord needed.
 *
 *   node test/links.js            # unit tests + live network tests
 *   node test/links.js --unit     # unit tests only (offline)
 *
 * Exit 0 when all required tests pass (live tests SKIP gracefully on network
 * hiccups, but a real failure of a supported host is a FAIL).
 */
import { looksLikeUrl, normalizeUrl, isPrivateIp, guessExtFromContent, fetchFromUrl, safeFetch } from '../src/fetchurl.js';

const unit = [];
const live = [];
let pass = 0, fail = 0, skip = 0;
const unitOnly = process.argv.includes('--unit');

function check(name, fn, list = unit) { list.push([name, fn]); }
function ok(name) { pass++; console.log(`  PASS ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name} — ${String(err?.message || err).slice(0, 200)}`); }
function skipped(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

// ---- unit tests ---------------------------------------------------------------

check('looksLikeUrl: https URL', () => {
  if (!looksLikeUrl('https://pastefy.app/AbCd1234')) throw new Error('should match');
});
check('looksLikeUrl: bare domain', () => {
  if (!looksLikeUrl('pastefy.app/AbCd1234')) throw new Error('should match');
});
check('looksLikeUrl: github blob', () => {
  if (!looksLikeUrl('https://github.com/u/r/blob/main/a/x.lua')) throw new Error('should match');
});
check('looksLikeUrl: rejects plain word', () => {
  if (looksLikeUrl('hello')) throw new Error('should not match');
});
check('looksLikeUrl: rejects bare IP', () => {
  if (looksLikeUrl('192.168.1.1/x')) throw new Error('should not match');
});
check('normalizeUrl: adds https + strips <>', () => {
  const u = normalizeUrl('<pastefy.app/abc>');
  if (u.href !== 'https://pastefy.app/abc') throw new Error(`got ${u.href}`);
});
check('normalizeUrl: rejects ftp', () => {
  try { normalizeUrl('ftp://example.com/x'); throw new Error('should have thrown'); }
  catch (e) { if (!/http\(s\)/i.test(e.message)) throw e; }
});
check('isPrivateIp: loopback/metadata/private blocked', () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1', '172.16.0.9', '100.64.0.1', '::1', 'fe80::1', 'fd00::5']) {
    if (!isPrivateIp(ip)) throw new Error(`${ip} should be private`);
  }
});
check('isPrivateIp: public allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.18.32.7', '2606:4700::1111']) {
    if (isPrivateIp(ip)) throw new Error(`${ip} should be public`);
  }
});
check('guessExtFromContent: lua/js/exe', () => {
  if (guessExtFromContent(Buffer.from('local x = 1\nif x then end')) !== '.lua') throw new Error('lua ext wrong');
  if (guessExtFromContent(Buffer.from('const a = _0x1f2e("x");\nvar b = 2;')) !== '.js') throw new Error('js ext wrong');
  if (guessExtFromContent(Buffer.from([0x4d, 0x5a, 0x90, 0x00])) !== '.exe') throw new Error('exe ext wrong');
});
check('safeFetch: blocks loopback (SSRF)', async () => {
  try { await safeFetch('http://127.0.0.1:9/x'); throw new Error('should have thrown'); }
  catch (e) { if (!/Blocked|non-public/i.test(e.message)) throw e; }
});
check('safeFetch: blocks cloud metadata (SSRF)', async () => {
  try { await safeFetch('http://169.254.169.254/latest/meta-data/'); throw new Error('should have thrown'); }
  catch (e) { if (!/Blocked|non-public/i.test(e.message)) throw e; }
});
check('safeFetch: blocks localhost hostname (SSRF)', async () => {
  try { await safeFetch('http://localhost/x'); throw new Error('should have thrown'); }
  catch (e) { if (!/Blocked|non-public/i.test(e.message)) throw e; }
});

// ---- live tests ---------------------------------------------------------------

check('fetch: github blob → raw', async () => {
  const r = await fetchFromUrl('https://github.com/LegendXD221/BypassX-Deobf-Bot/blob/main/package.json');
  if (!r.buffer.toString('utf8').trimStart().startsWith('{')) throw new Error('not JSON');
  if (r.filename !== 'package.json') throw new Error(`filename ${r.filename}`);
}, live);

check('fetch: direct raw URL', async () => {
  const r = await fetchFromUrl('https://raw.githubusercontent.com/LegendXD221/BypassX-Deobf-Bot/main/README.md');
  if (!r.buffer.toString('utf8').includes('BypassX')) throw new Error('content mismatch');
}, live);

check('fetch: pastefy round-trip', async () => {
  const marker = `-- bypassx link test ${Date.now()}`;
  const src = `${marker}\nlocal secret = "LPH_abcdef"\nprint(secret)\n`;
  const cr = await fetch('https://pastefy.app/api/v2/paste', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: src, title: 'bypassx-link-test', type: 'PASTE', visibility: 'UNLISTED' }),
  });
  const cj = await cr.json();
  const id = cj?.paste?.id || cj?.id;
  if (!id) throw new Error(`paste create failed: HTTP ${cr.status}`);
  try {
    const r = await fetchFromUrl(`https://pastefy.app/${id}`);
    if (!r.buffer.toString('utf8').includes(marker)) throw new Error('content mismatch');
    if (r.note !== 'Pastefy paste') throw new Error(`note ${r.note}`);
  } finally {
    fetch(`https://pastefy.app/api/v2/paste/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}, live);

check('fetch: blocked host error is friendly', async () => {
  try { await fetchFromUrl('https://internal.svc.local/secret.lua'); throw new Error('should have thrown'); }
  catch (e) { if (!/resolve|Blocked/i.test(e.message)) throw e; }
}, live);

// ---- run ----------------------------------------------------------------------

console.log('unit tests:');
for (const [name, fn] of unit) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
}

if (!unitOnly) {
  console.log('live tests:');
  for (const [name, fn] of live) {
    try { await fn(); ok(name); } catch (e) {
      const msg = String(e?.message || e);
      if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network error|timed out/i.test(msg)) skipped(name, msg.slice(0, 80));
      else bad(name, e);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
