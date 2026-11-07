/**
 * V2 reply builders smoke test — serializes every reply the bot can emit.
 * Catches API misuse (forbidden fields, nesting, budget overflow) before go-live.
 */
import {
  helpReply, familiesReply, detectionReply, successReply, failureReply,
  errorReply, cooldownReply, pongReply, inviteReply,
} from '../src/replies.js';

const fakeClient = { user: { displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png' } };

const detectedSample = {
  id: 'moonsec_v3', name: 'MoonSec V3', version: null, confidence: 99,
  tier: 'full', lang: 'lua',
  evidence: ['MoonSec V3 header', 'MoonSec V3 token'],
  candidates: [
    { id: 'moonsec_v3', name: 'MoonSec V3', confidence: 99 },
    { id: 'psu', name: 'PSU', confidence: 42 },
  ],
};

const successSample = {
  detected: detectedSample,
  stages: [{ name: 'detect' }, { name: 'lua-peel' }, { name: 'post-process', detail: 'lua beautify' }],
  originalSize: 336_864, recoveredSize: 129_612, durationMs: 6300,
  code: 'local x = 42\nprint("recovered")\n',
  binaryOutput: false, outputBuffer: null,
  codeName: 'recovered.lua',
  engine: { available: true, version: 'bypassx_deobf 0.12.0' },
  partialNote: null,
};

const failureSample = {
  detected: detectedSample,
  stages: [{ name: 'detect', detail: 'MoonSec V3 (99%)' }, { name: 'lua-peel', detail: 'targeted family moonsec-v3' }],
  note: 'This build keeps its constant pool behind runtime keys.',
};

const tests = {
  help: () => helpReply('.', fakeClient),
  families: () => familiesReply('.'),
  detectionHit: () => detectionReply(detectedSample, { sizeLabel: '329.0 KB', fileLabel: 'gauntlet.lua' }, '.'),
  detectionUnknown: () => detectionReply({ id: 'unknown', name: 'Unknown', confidence: 0, lang: 'lua', candidates: [] }, { sizeLabel: '12.0 KB', fileLabel: 'x.lua' }, '.'),
  success: () => successReply(successSample, { url: 'https://pastefy.app/abc', rawUrl: 'https://pastefy.app/abc/raw' }, 'gauntlet.lua'),
  successNoPaste: () => successReply(successSample, null, 'gauntlet.lua'),
  successBinary: () => successReply({ ...successSample, binaryOutput: true, outputBuffer: Buffer.from([0x4d, 0x5a, 0x90]), code: '', codeName: 'unpacked.exe' }, null, 'packed.exe'),
  successPartial: () => successReply({ ...successSample, partialNote: 'Escrow build — string pool recovered.' }, { url: 'https://pastefy.app/abc', rawUrl: 'https://pastefy.app/abc/raw' }, 'x.lua'),
  failure: () => failureReply(failureSample, '.'),
  error: () => errorReply('Download failed', 'HTTP 404 for attachment'),
  cooldown: () => cooldownReply(4200),
  pong: () => pongReply({ wsPing: 42, uptimeS: 3661, engine: { available: true, version: 'engine 0.12.0' }, version: '1.1.0', guilds: 7 }),
  invite: () => inviteReply('https://discord.com/oauth2/authorize?client_id=123'),
};

let pass = 0;
let fail = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    const payload = fn();
    const json = payload.components.map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));
    // validate flag
    const flags = typeof payload.flags === 'bigint' ? payload.flags : BigInt(payload.flags || 0);
    const IS_V2 = (flags & (1n << 15n)) !== 0n;
    // count total text chars (V2 budget 4000)
    let textChars = 0;
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.type === 10 && typeof o.content === 'string') textChars += o.content.length;
      if (o.type === 9 && Array.isArray(o.components)) o.components.forEach(walk);
      for (const k of ['components', 'items']) if (Array.isArray(o[k])) o[k].forEach(walk);
      if (o.accessory) walk(o.accessory);
    };
    json.forEach(walk);
    const hasFiles = Array.isArray(payload.files) && payload.files.length > 0;
    if (!IS_V2) throw new Error('IsComponentsV2 flag missing');
    if (textChars > 4000) throw new Error(`text budget exceeded: ${textChars}`);
    console.log(`PASS ${name.padEnd(18)} containers=${json.length} textChars=${textChars}${hasFiles ? ' +files' : ''}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    fail += 1;
  }
}
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
