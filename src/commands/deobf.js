/**
 * .deobf / /deobf — full pipeline: detect → deobfuscate → Pastefy (pure code).
 * Accepts a file attachment, a link (Pastefy/GitHub/Pastebin/gist/Discord
 * message/direct URL), or a reply to a message with a file.
 */
import { deobfuscate } from '../pipeline.js';
import { createPaste } from '../pastefy.js';
import { checkCooldown } from '../rate-limit.js';
import { successReply, failureReply, errorReply, cooldownReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';
import { bumpJob } from '../keepalive.js';
import { describe as dbDescribe, logDeobf, stat } from '../db.js';

function recordDb(ctx, { success, family, confidence, filename, size, durationMs, pasteUrl, source }) {
  try {
    const d = dbDescribe();
    if (!d.enabled) return;
    logDeobf({
      userId: ctx.userId,
      guildId: ctx.interaction?.guildId || ctx.message?.guildId || null,
      command: 'deobf',
      family, confidence, success, filename, size, durationMs, pasteUrl, source,
    });
    stat('deobf_total', 1);
    if (success) stat('deobf_ok', 1);
  } catch { /* db optional */ }
}

export default {
  name: 'deobf',
  description: 'Deobfuscate a file or link — auto-detect + pure code via Pastefy',
  usage: '.deobf <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The obfuscated file (.lua/.js/.py/.exe…)', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a link (Pastefy, GitHub, Pastebin, gist, Discord message, direct)', type: 'STRING', required: false },
    ],
  },
  heavy: true,

  async run(ctx) {
    const cd = checkCooldown(ctx.userId);
    if (!cd.ok) return ctx.reply(cooldownReply(cd.remainingMs));

    // v2.7.1 — instant acknowledgement, then background work. The user sees
    // "@user deobfuscating Your Code …" IMMEDIATELY; the pipeline keeps
    // running and the deobfuscated code is delivered as a follow-up message
    // the moment it is ready.
    const known = ctx.attachments.find(Boolean)?.name
      || (ctx.url ? 'link' : (ctx.attachments.referencedId ? 'replied message' : null));
    const t0 = Date.now();
    const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    const status = await ctx.statusReply(`<@${ctx.userId}> deobfuscating Your Code${known ? ` (\`${known}\`)` : ''} …`);

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
    if (att.filename && att.filename !== known) {
      await status.update(`<@${ctx.userId}> deobfuscating Your Code (\`${att.filename}\`) …`);
    }

    try {
      const result = await deobfuscate({ buffer: att.buffer, filename: att.filename });
      if (!result.ok) {
        bumpJob(false);
        recordDb(ctx, {
          success: false,
          family: result.detected?.name,
          confidence: result.detected?.confidence,
          filename: att.filename,
          size: att.buffer.length,
          durationMs: result.durationMs,
          source: att.sourceUrl ? 'link' : 'upload',
        });
        logger.info({ name: att.filename, detected: result.detected?.id }, 'deobf: no recovery');
        await status.update(`❌ <@${ctx.userId}> couldn't fully deobfuscate \`${att.filename}\` (${secs()}) — report below.`);
        return ctx.send(failureReply(result, ctx.prefix));
      }
      let paste = null;
      if (!result.binaryOutput) {
        try {
          paste = await createPaste({
            title: `BypassX Deobf — ${result.detected.name}${result.detected.version ? ` ${result.detected.version}` : ''} — ${att.filename}`,
            text: result.code,
          });
        } catch (e) {
          logger.warn({ err: String(e.message || e) }, 'pastefy upload failed — delivering file attachment instead');
        }
      }
      bumpJob(true);
      recordDb(ctx, {
        success: true,
        family: result.detected?.name,
        confidence: result.detected?.confidence,
        filename: att.filename,
        size: att.buffer.length,
        durationMs: result.durationMs,
        pasteUrl: paste?.url,
        source: att.sourceUrl ? 'link' : 'upload',
      });
      logger.info({ name: att.filename, size: result.recoveredSize, paste: paste?.id || null }, 'deobf: success');
      await status.update(`✅ <@${ctx.userId}> done in ${secs()} — your deobfuscated code is below 👇`);
      return ctx.send(successReply(result, paste, att.filename, att.sourceUrl, att.note));
    } catch (e) {
      bumpJob(false);
      logger.error({ err: String(e?.stack || e).slice(0, 500) }, 'deobf: crashed');
      await status.update(`❌ <@${ctx.userId}> unexpected error after ${secs()} — details below.`);
      return ctx.send(errorReply('Unexpected error', String(e.message || e).slice(0, 500)));
    }
  },
};
