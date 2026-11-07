/**
 * Chunked paste test — v1.3.0 fix for "failed to paste" on big outputs.
 * 1. 1.5MB content (previously HTTP 413) → must produce multi-part pastes
 * 2. Each part must be fetchable and concatenation must round-trip
 * 3. splitForPaste unit checks (line boundaries, oversized single lines)
 */
import { createPaste, splitForPaste } from '../src/pastefy.js';
import { fetchFromUrl } from '../src/fetchurl.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('unit: splitForPaste');
{
  const small = splitForPaste('a\nb\nc');
  t('small → 1 chunk', small.length === 1 && small[0] === 'a\nb\nc');
  const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-${'x'.repeat(50)}`);
  const chunks = splitForPaste(lines.join('\n'), 100_000);
  t('5000 lines @100KB budget → several chunks', chunks.length > 2, `(${chunks.length})`);
  t('chunks respect budget (escaped)', chunks.every((c) => c.length < 200_000));
  t('rejoin preserves content', chunks.join('') === lines.join('\n'));
  const hugeLine = 'z'.repeat(250_000);
  const hardChunks = splitForPaste(hugeLine, 100_000);
  t('oversized single line hard-split', hardChunks.length === 3 && hardChunks.join('') === hugeLine);
  const unicode = 'héllo wörld '.repeat(20_000);
  const uChunks = splitForPaste(unicode, 100_000);
  t('multibyte-safe', uChunks.join('') === unicode);
}

console.log('live: 1.5MB multi-part paste (previously 413)');
{
  const marker = `-- chunk test ${Date.now()}`;
  const big = `${marker}\n${Array.from({ length: 20000 }, (_, i) => `local v${i} = ${i} -- padding line with realistic content for the chunking test ${i % 7}`).join('\n')}`;
  const bytes = Buffer.byteLength(big);
  try {
    const paste = await createPaste({ title: 'bypassx chunk test', text: big });
    t('createPaste ok', Boolean(paste.id), `(${paste.url})`);
    t('multi-part produced', Array.isArray(paste.parts) && paste.parts.length > 1, `(${paste.parts?.length} parts)`);
    // Verify first + last part fetch back with the right content.
    const first = await fetchFromUrl(paste.url);
    t('part 1 round-trip starts with marker', first.buffer.toString('utf8').startsWith(marker));
    const last = paste.parts[paste.parts.length - 1];
    const lastRes = await fetchFromUrl(last.url);
    t('last part fetches', lastRes.buffer.length > 0, `(${lastRes.buffer.length} B)`);
    const expectedTail = big.slice(big.length - lastRes.buffer.toString('utf8').length + 1);
    t('last part content matches tail', big.endsWith(lastRes.buffer.toString('utf8')));
    void expectedTail;
    console.log(`  info: payload ${bytes} B → ${paste.parts.length} parts`);
  } catch (e) {
    fail++;
    console.log('  FAIL createPaste:', String(e.message || e).slice(0, 200));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
