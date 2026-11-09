/**
 * .l / /l — Environment Logger (Most Recommended).
 *
 * "Run Script In A Dumper Tool And See What It Records."
 *
 * The command IS a dumper tool: the uploaded script runs inside the jailed,
 * offline Lua VM sandbox with the instrumentation suite attached, and the
 * recording is delivered as a paste:
 *   • every load()/loadstring() chunk the script decrypted (full source or
 *     bytecode handed over by the obfuscator itself — complete recovery),
 *   • the decrypted string constant pool,
 *   • every URL the payload touched,
 *   • whether the VM reached its payload at all (anti-tamper verdict).
 *
 * Same UX contract as the deobf family: instant "@user …" ack, background
 * work, ✅/❌ status flip, result card as a new message, never-fail.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { liftVM, reconstructPool, harvestToLua } from '../harvest.js';
import { createPaste } from '../pastefy.js';
import { checkCooldown } from '../rate-limit.js';
import { getInputBuffer } from '../ctx.js';
import { CONFIG, ensureVarDir } from '../config.js';
import { loggerReply, errorReply, cooldownReply } from '../replies.js';
import { logger } from '../logger.js';
import { bumpJob } from '../keepalive.js';
import { detectService } from '../detect.js';
import { verifyCode } from '../validate.js';
import { describe as dbDescribe, logDeobf, stat } from '../db.js';

/** Classify one captured chunk: source (lua/js), bytecode, or data. */
function classifyChunkBasic(text) {
  if (text.charCodeAt(0) === 0x1b && text.startsWith('\x1bLua')) return { kind: 'bytecode', format: 'lua', text };
  if (text.startsWith('RSB1')) return { kind: 'bytecode', format: 'luau', text };
  if (verifyCode(text, { lang: 'lua', filename: 'chunk.lua' }).status === 'verified') return { kind: 'source', lang: 'lua', text };
  if (verifyCode(text, { lang: 'js', filename: 'chunk.js' }).status === 'verified') return { kind: 'source', lang: 'js', text };
  return { kind: 'data', text };
}

/**
 * Build the logger report from a liftVM result (pure — no I/O).
 * Verdict ladder: source > bytecode > pool > clean > norecord.
 */
export function buildLoggerReport(h = {}) {
  const strings = Array.isArray(h.strings) ? h.strings : [];
  const { kept, dropped } = reconstructPool(strings);

  const seen = new Set();
  const chunks = [];
  for (const raw of Array.isArray(h.chunks) ? h.chunks : []) {
    const s = String(raw ?? '');
    if (s.length < 12 || seen.has(s)) continue;
    seen.add(s);
    chunks.push(classifyChunkBasic(s));
  }
  const counts = {
    total: chunks.length,
    sources: chunks.filter((c) => c.kind === 'source').length,
    bytecode: chunks.filter((c) => c.kind === 'bytecode').length,
    data: chunks.filter((c) => c.kind === 'data').length,
  };

  const urls = [...new Set(
    [...kept, ...(h.log || [])]
      .map((s) => String(s).match(/https?:\/\/[^\s"'`\\><]+/g) || [])
      .flat(),
  )].slice(0, 12);

  const verdict = counts.sources > 0 ? 'source'
    : counts.bytecode > 0 ? 'bytecode'
      : kept.length >= 3 ? 'pool'
        : h.ran ? 'clean'
          : 'norecord';

  return {
    verdict,
    chunks,
    counts,
    strings: { kept, dropped },
    urls,
    ran: Boolean(h.ran),
    runError: h.runError || h.error || null,
  };
}

/** Render the recording as a paste document (pure). A LONE source chunk with
 *  nothing else recorded ships as PURE code; anything else ships as an
 *  annotated Lua report so no recorded artifact is ever dropped. */
export function buildRecordingText(report, { filename = 'input.lua' } = {}) {
  const sources = report.chunks.filter((c) => c.kind === 'source');
  if (sources.length === 1 && report.counts.total === 1 && report.strings.kept.length === 0) {
    return [
      '--[[ BypassX Deobf — Environment Logger',
      `File: ${filename}`,
      'Verdict: full source captured at load() — the obfuscator decrypted its',
      'own payload and handed it over inside the dumper sandbox.',
      ']]',
      sources[0].text,
    ].join('\n');
  }

  const parts = [[
    '--[[ BypassX Deobf — Environment Logger recording',
    `File: ${filename}`,
    `Verdict: ${report.verdict}`,
    `Chunks captured at load(): ${report.counts.total} (${report.counts.sources} source, ${report.counts.bytecode} bytecode, ${report.counts.data} data)`,
    `Decrypted pool strings: ${report.strings.kept.length}${report.strings.dropped ? ` (${report.strings.dropped} noise fragments filtered)` : ''}`,
    `URLs recorded: ${report.urls.length}`,
    ']]',
  ].join('\n')];

  let n = 0;
  for (const c of report.chunks) {
    if (c.kind === 'source') {
      n += 1;
      parts.push(`--==== captured chunk ${n} (source, ${c.text.length} bytes) ====\n${c.text}`);
    } else if (c.kind === 'bytecode') {
      parts.push(`--==== captured ${c.format} bytecode chunk (${c.text.length} bytes — binary, not printable) ====`);
    }
  }
  if (report.strings.kept.length) {
    parts.push(harvestToLua({ strings: report.strings.kept }, { detectedName: 'Environment Logger recording' }));
  }
  if (report.urls.length) {
    parts.push(`--==== URLs recorded ==== \n${report.urls.map((u) => `-- ${u}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * @param ctx  command context
 * @param opts lift — injectable dumper runner (tests); default liftVM
 */
export async function runLogger(ctx, { lift = liftVM } = {}) {
  const cd = checkCooldown(ctx.userId);
  if (!cd.ok) return ctx.reply(cooldownReply(cd.remainingMs));

  const known = ctx.attachments.find(Boolean)?.name
    || (ctx.url ? 'link' : (ctx.attachments.referencedId ? 'replied message' : null));
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const status = await ctx.statusReply(
    `<@${ctx.userId}> running Your Code in the environment logger${known ? ` (\`${known}\`)` : ''} …`,
  );

  let att;
  try {
    att = await getInputBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
  } catch (e) {
    await status.update(`❌ <@${ctx.userId}> couldn't download the input (${secs()}) — details below.`);
    return ctx.send(errorReply('Download failed', String(e.message || e).slice(0, 300)));
  }
  if (att.error) {
    await status.update(`❌ <@${ctx.userId}> no valid input — details below.`);
    return ctx.send(errorReply('No input', att.error));
  }

  const dir = ensureVarDir(`logger/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inputPath = path.join(dir, `input${path.extname(att.filename || '') || '.lua'}`);
  await fsp.writeFile(inputPath, att.buffer, { mode: 0o600 });

  try {
    // Signature context for the card ("what the dumper thinks this is").
    let signature = 'no known signature';
    try {
      const sig = detectService(att.buffer);
      if (sig.best) {
        signature = `${sig.best.service.name}${sig.best.version ? ` ${sig.best.version}` : ''} — ${sig.best.confidence}%`;
      }
    } catch { /* advisory only */ }

    let h = null;
    try {
      h = await lift(inputPath, { timeoutMs: Math.min(CONFIG.engineTimeoutMs, 120_000) });
    } catch (e) {
      logger.warn({ err: String(e.message || e).slice(0, 200) }, 'logger: dumper run failed');
      h = { ok: false, error: String(e.message || e).slice(0, 300) };
    }

    const report = buildLoggerReport(h || {});
    report.signature = signature;

    const recordingText = buildRecordingText(report, { filename: att.filename });
    let paste = null;
    try {
      paste = await createPaste({
        title: `BypassX Deobf — Environment Logger — ${att.filename}`,
        text: recordingText,
      });
    } catch (e) {
      logger.warn({ err: String(e.message || e) }, 'logger: pastefy upload failed — file attachment instead');
    }

    const success = report.verdict !== 'norecord';
    bumpJob(success);
    try {
      const d = dbDescribe();
      if (d.enabled) {
        logDeobf({
          userId: ctx.userId,
          guildId: ctx.interaction?.guildId || ctx.message?.guildId || null,
          command: 'l',
          family: 'environment-logger',
          confidence: null,
          success,
          filename: att.filename,
          size: att.buffer.length,
          durationMs: Date.now() - t0,
          pasteUrl: paste?.url || null,
          source: att.sourceUrl ? 'link' : 'upload',
        });
        stat('deobf_total', 1);
        if (success) stat('deobf_ok', 1);
      }
    } catch { /* db optional */ }

    logger.info({ name: att.filename, verdict: report.verdict, paste: paste?.id || null }, 'logger: recording complete');
    await status.update(`✅ <@${ctx.userId}> recording complete in ${secs()} — the dump is below 👇`);
    return ctx.send(loggerReply(report, paste, att.filename, ctx.prefix, Buffer.from(recordingText, 'utf8')));
  } catch (e) {
    bumpJob(false);
    logger.error({ err: String(e?.stack || e).slice(0, 500) }, 'logger: crashed');
    await status.update(`❌ <@${ctx.userId}> logger crashed after ${secs()} — details below.`);
    return ctx.send(errorReply('Environment logger failed', String(e.message || e).slice(0, 500)));
  } finally {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export default {
  name: 'l',
  description: 'Run the script in a dumper tool and see what it records (most recommended)',
  usage: '.l <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The script to dump (.lua/.txt)', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a raw URL (Pastefy, GitHub, Pastebin, gist, direct)', type: 'STRING', required: false },
    ],
  },
  heavy: true,
  serviceCmd: true,

  async run(ctx) {
    return runLogger(ctx);
  },
};
