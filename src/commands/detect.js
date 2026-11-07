/**
 * .detect / /detect — identify the obfuscator + confidence %, no deobfuscation.
 */
import { CONFIG } from '../config.js';
import { detectService, guessLanguage } from '../detect.js';
import { detectionEmbed, errorEmbed } from '../replies.js';
import { getAttachmentBuffer } from '../ctx.js';

export default {
  name: 'detect',
  description: 'Identify the obfuscator/packer of an attached file with a confidence percentage',
  usage: '.detect <attach file>',
  slash: {
    options: [
      { name: 'file', description: 'The file to identify', type: 'ATTACHMENT', required: true },
    ],
  },

  async run(ctx) {
    await ctx.defer();
    let att;
    try {
      att = await getAttachmentBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply({ embeds: [errorEmbed('Download failed', String(e.message || e).slice(0, 300))] });
    }
    if (att.error) return ctx.reply({ embeds: [errorEmbed('No file', att.error)] });

    const det = detectService(att.buffer);
    const lang = guessLanguage(att.buffer);
    const detected = det.best
      ? { ...det.best, lang, candidates: det.candidates }
      : { id: 'unknown', name: 'Unknown', confidence: 0, lang, candidates: [] };

    const sizeLabel = `${(att.buffer.length / 1024).toFixed(1)} KB`;
    return ctx.reply({
      embeds: [detectionEmbed(ctx.prefix, detected, { sizeLabel, fileLabel: att.filename || 'file' })],
    });
  },
};
