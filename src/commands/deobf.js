/**
 * .deobf / /deobf — full pipeline: detect → deobfuscate → Pastefy (pure code).
 */
import { AttachmentBuilder } from 'discord.js';
import { CONFIG } from '../config.js';
import { deobfuscate } from '../pipeline.js';
import { createPaste } from '../pastefy.js';
import { checkCooldown } from '../rate-limit.js';
import { successEmbed, failureEmbed, errorEmbed } from '../replies.js';
import { getAttachmentBuffer } from '../ctx.js';
import { logger } from '../logger.js';

export default {
  name: 'deobf',
  description: 'Deobfuscate an attached file — auto-detects the obfuscator, returns pure deobfuscated code via Pastefy',
  usage: '.deobf <attach file> (or reply to a message with a file)',
  slash: {
    options: [
      { name: 'file', description: 'The obfuscated file (.lua/.js/.py/.exe…)', type: 'ATTACHMENT', required: true },
    ],
  },
  heavy: true,

  async run(ctx) {
    const cd = checkCooldown(ctx.userId);
    if (!cd.ok) {
      return ctx.reply({ embeds: [errorEmbed('Slow down', `Try again in ${Math.ceil(cd.remainingMs / 1000)}s.`)], ephemeral: true });
    }
    await ctx.defer();

    let att;
    try {
      att = await getAttachmentBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply({ embeds: [errorEmbed('Download failed', String(e.message || e).slice(0, 300))] });
    }
    if (att.error) return ctx.reply({ embeds: [errorEmbed('No file', att.error)] });

    try {
      const result = await deobfuscate({ buffer: att.buffer, filename: att.filename });
      if (!result.ok) {
        logger.info({ name: att.filename, detected: result.detected?.id }, 'deobf: no recovery');
        return ctx.reply({ embeds: [failureEmbed(ctx.prefix, result)] });
      }
      let paste = null;
      if (result.binaryOutput) {
        // Unpacked native binaries ride back as a Discord attachment.
        const file = new AttachmentBuilder(result.outputBuffer, { name: result.codeName || 'unpacked.bin' });
        logger.info({ name: att.filename, size: result.recoveredSize }, 'deobf: success (binary)');
        return ctx.reply({
          embeds: [successEmbed(ctx.prefix, { ...result, engine: result.engine }, null)],
          files: [file],
        });
      }
      try {
        paste = await createPaste({
          title: `BypassX Deobf — ${result.detected.name}${result.detected.version ? ` ${result.detected.version}` : ''} — ${att.filename}`,
          text: result.code,
        });
      } catch (e) {
        logger.warn({ err: String(e.message || e) }, 'pastefy upload failed');
      }
      logger.info({ name: att.filename, size: result.recoveredSize }, 'deobf: success');
      return ctx.reply({ embeds: [successEmbed(ctx.prefix, result, paste)] });
    } catch (e) {
      logger.error({ err: String(e?.stack || e).slice(0, 500) }, 'deobf: crashed');
      return ctx.reply({ embeds: [errorEmbed('Unexpected error', String(e.message || e).slice(0, 500))] });
    }
  },
};
