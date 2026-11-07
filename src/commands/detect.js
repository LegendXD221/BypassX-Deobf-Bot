/**
 * .detect / /detect — identify the obfuscator + confidence %, no deobfuscation.
 * Accepts a file attachment or a link.
 */
import { CONFIG } from '../config.js';
import { detectService, guessLanguage } from '../detect.js';
import { detectionReply, errorReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { describe as dbDescribe, logDeobf } from '../db.js';

export default {
  name: 'detect',
  description: 'Identify the obfuscator/packer of a file or link with a confidence percentage',
  usage: '.detect <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The file to identify', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a link (Pastefy, GitHub, Pastebin, gist, Discord message, direct)', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    await ctx.defer();
    let att;
    try {
      att = await getInputBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply(errorReply('Download failed', String(e.message || e).slice(0, 300)));
    }
    if (att.error) return ctx.reply(errorReply('No input', att.error));

    const det = detectService(att.buffer);
    const lang = guessLanguage(att.buffer);
    const detected = det.best
      ? { ...det.best, lang, candidates: det.candidates }
      : { id: 'unknown', name: 'Unknown', confidence: 0, lang, candidates: [] };

    const sizeLabel = `${(att.buffer.length / 1024).toFixed(1)} KB`;
    try {
      if (dbDescribe().enabled) {
        logDeobf({
          userId: ctx.userId,
          guildId: ctx.interaction?.guildId || ctx.message?.guildId || null,
          command: 'detect',
          family: detected.name === 'Unknown' ? null : detected.name,
          confidence: detected.confidence,
          success: detected.id !== 'unknown',
          filename: att.filename,
          size: att.buffer.length,
          source: att.sourceUrl ? 'link' : 'upload',
        });
      }
    } catch { /* db optional */ }
    return ctx.reply(detectionReply(
      detected,
      { sizeLabel, fileLabel: att.filename || 'file', sourceUrl: att.sourceUrl, sourceNote: att.note },
      ctx.prefix,
    ));
  },
};
