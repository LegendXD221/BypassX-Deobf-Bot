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
    await ctx.defer();

    let att;
    try {
      att = await getInputBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply(errorReply('Download failed', String(e.message || e).slice(0, 300)));
    }
    if (att.error) return ctx.reply(errorReply('No input', att.error));

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
        return ctx.reply(failureReply(result, ctx.prefix));
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
      return ctx.reply(successReply(result, paste, att.filename, att.sourceUrl, att.note));
    } catch (e) {
      bumpJob(false);
      logger.error({ err: String(e?.stack || e).slice(0, 500) }, 'deobf: crashed');
      return ctx.reply(errorReply('Unexpected error', String(e.message || e).slice(0, 500)));
    }
  },
};
