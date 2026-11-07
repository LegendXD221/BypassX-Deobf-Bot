/**
 * V2 reply builders smoke test — serializes every reply the bot can emit.
 * Catches API misuse (forbidden fields, nesting, budget overflow) before go-live.
 * v1.3.0: also asserts NO GitHub button rides any reply.
 */
import {
  helpReply, familiesReply, detectionReply, successReply, failureReply,
  errorReply, cooldownReply, pongReply, inviteReply, statsReply, ownerOnlyReply,
  ownerOutputReply, logsReply, serversReply, statusSetReply, codeToolReply,
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
  verification: { status: 'verified', lang: 'lua', detail: 'Lua syntax OK (fengari parse)' },
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
  successParts: () => successReply(successSample, {
    url: 'https://pastefy.app/a1', rawUrl: 'https://pastefy.app/a1/raw',
    parts: [
      { id: 'a1', url: 'https://pastefy.app/a1', index: 1, of: 3 },
      { id: 'a2', url: 'https://pastefy.app/a2', index: 2, of: 3 },
      { id: 'a3', url: 'https://pastefy.app/a3', index: 3, of: 3 },
    ],
  }, 'gauntlet.lua'),
  successSource: () => successReply(successSample, { url: 'https://pastefy.app/abc', rawUrl: 'https://pastefy.app/abc/raw' }, 'x.lua', 'https://github.com/u/r/blob/main/x.lua', 'GitHub file'),
  successBinary: () => successReply({ ...successSample, binaryOutput: true, outputBuffer: Buffer.from([0x4d, 0x5a, 0x90]), code: '', codeName: 'unpacked.exe', verification: { status: 'unverifiable', lang: 'binary', detail: 'binary output' } }, null, 'packed.exe'),
  successPartial: () => successReply({ ...successSample, partialNote: 'Escrow build — string pool recovered.' }, { url: 'https://pastefy.app/abc', rawUrl: 'https://pastefy.app/abc/raw' }, 'x.lua'),
  successVerifyFailed: () => successReply({ ...successSample, verification: { status: 'failed', lang: 'lua', detail: '[string "verify"]:1: unexpected symbol' } }, null, 'x.lua'),
  failure: () => failureReply(failureSample, '.'),
  error: () => errorReply('Download failed', 'HTTP 404 for attachment'),
  cooldown: () => cooldownReply(4200),
  pong: () => pongReply({ wsPing: 42, uptimeS: 3661, engine: { available: true, version: 'engine 0.12.0' }, version: '1.3.0', guilds: 7 }),
  invite: () => inviteReply('https://discord.com/oauth2/authorize?client_id=123'),
  stats: () => statsReply({ version: '1.3.0', uptimeS: 86400 * 2 + 3600, engine: { available: true, version: 'engine 0.12.0' }, jobs: { total: 42, ok: 39, fail: 3, lastAt: null, lastFile: null }, guilds: 7, memoryMb: 321.4, discordReady: true, pingMs: 38, owner: '1134757298733064203' }),
  ownerOnly: () => ownerOnlyReply('exec'),
  ownerOutput: () => ownerOutputReply({ title: 'exec', ok: true, input: 'ls -la', output: 'total 3\ndrwxr-xr-x …', meta: ['120ms', 'bash'] }),
  logs: () => logsReply(['[2026-11-07T00:00:00Z] INFO bot ready', '[2026-11-07T00:00:01Z] INFO keepalive http listening']),
  servers: () => serversReply([{ name: 'Deobf HQ', id: '123', memberCount: 42 }, { name: 'Testers', id: '456', memberCount: 8 }]),
  statusSet: () => statusSetReply('.deobf | /deobf — best deobf bot'),
  codeTool: () => codeToolReply({
    title: '🧾 Paste created', subtitle: 'single paste',
    factsRows: [{ label: 'Size', value: '1.2 KB' }, { label: 'Name', value: 'x.lua' }],
    code: 'local a = 1\n', codeName: 'x.lua', paste: { url: 'https://pastefy.app/z9', rawUrl: 'https://pastefy.app/z9/raw' },
  }),
  codeToolBig: () => codeToolReply({
    title: '🔤 String table', subtitle: '120 unique strings',
    factsRows: [{ label: 'Strings', value: '120' }],
    code: 'x'.repeat(50), codeName: 'strings.txt', paste: null,
  }),
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
    // count total text chars (V2 budget 4000) + collect button URLs
    let textChars = 0;
    const urls = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.type === 10 && typeof o.content === 'string') textChars += o.content.length;
      if (o.type === 9 && Array.isArray(o.components)) o.components.forEach(walk);
      if (o.type === 2 && typeof o.url === 'string') urls.push(o.url); // buttons
      for (const k of ['components', 'items']) if (Array.isArray(o[k])) o[k].forEach(walk);
      if (o.accessory) walk(o.accessory);
    };
    json.forEach(walk);
    const hasFiles = Array.isArray(payload.files) && payload.files.length > 0;
    if (!IS_V2) throw new Error('IsComponentsV2 flag missing');
    if (textChars > 4000) throw new Error(`text budget exceeded: ${textChars}`);
    if (urls.some((u) => /github\.com/i.test(u))) throw new Error('GitHub button found — must be removed');
    console.log(`PASS ${name.padEnd(20)} containers=${json.length} textChars=${textChars}${hasFiles ? ' +files' : ''}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    fail += 1;
  }
}
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
