/**
 * .deobf / /deobf — full pipeline: detect → deobfuscate → Pastefy (pure code).
 */
import { deobfuscate } from '../pipeline.js';
import { createPaste } from '../pastefy.js';
import { checkCooldown } from '../rate-limit.js';
import { successReply, failureReply, errorReply, cooldownReply } from '../replies.js';
import { getAttachmentBuffer } from '../ctx.js';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';
import { bumpJob } from '../keepalive.js';

export default {
  name: 'deobf',
  description: 'Deobfuscate an attached file — auto-detect + pure code via Pastefy',
  usage: '.deobf <attach file> (or reply to a message with a file)',
  slash: {
    options: [
      { name: 'file', description: 'The obfuscated file (.lua/.js/.py/.exe…)', type: 'ATTACHMENT', required: true },
    ],
  },
  heavy: true,

  async run(ctx) {
    const cd = checkCooldown(ctx.userId);
    if (!cd.ok) return ctx.reply(cooldownReply(cd.remainingMs));
    await ctx.defer();

    let att;
    try {
      att = await getAttachmentBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply(errorReply('Download failed', String(e.message || e).slice(0, 300)));
    }
    if (att.error) return ctx.reply(errorReply('No file', att.error));

    try {
      const result = await deobfuscate({ buffer: att.buffer, filename: att.filename });
      if (!result.ok) {
        bumpJob(false);
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
      logger.info({ name: att.filename, size: result.recoveredSize, paste: paste?.id || null }, 'deobf: success');
      return ctx.reply(successReply(result, paste, att.filename));
    } catch (e) {
      bumpJob(false);
      logger.error({ err: String(e?.stack || e).slice(0, 500) }, 'deobf: crashed');
      return ctx.reply(errorReply('Unexpected error', String(e.message || e).slice(0, 500)));
    }
  },
};
