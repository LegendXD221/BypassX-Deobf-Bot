/**
 * Command context shapes:
 *  - slash: ctx = { isSlash: true, interaction, defer(), reply(payload) }
 *  - prefix: ctx = { isSlash: false, message, reply(payload) }
 * Both expose: options (map of resolved values), attachments (array), userId, client.
 */
import { AttachmentBuilder } from 'discord.js';

export function makeCtx({ interaction = null, message = null, client }) {
  const isSlash = Boolean(interaction);
  const attachments = [];
  if (interaction?.options) {
    const opt = interaction.options.getAttachment('file');
    if (opt) attachments.push(opt);
    const replied = interaction.options.getMessage('message');
    if (replied?.attachments?.size) attachments.push(...replied.attachments.values());
  }
  if (message?.attachments?.size) attachments.push(...message.attachments.values());
  if (message?.reference?.messageId) attachments.referencedId = message.reference.messageId;

  return {
    isSlash,
    interaction,
    message,
    client,
    attachments,
    userId: interaction?.user?.id || message?.author?.id || '0',
    prefix: message?._prefix || '.',

    async defer() {
      if (interaction) await interaction.deferReply();
      else if (message?.channel) await message.channel.sendTyping().catch(() => {});
    },
    async reply(payload) {
      if (interaction) {
        if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
        return interaction.reply(payload);
      }
      if (message) return message.reply(payload);
    },
  };
}

/** Resolve the attachment buffer + filename, or return an error string. */
export async function getAttachmentBuffer(ctx, { maxBytes }) {
  const att = ctx.attachments.find(Boolean);
  if (!att) {
    if (ctx.attachments.referencedId) return { error: 'The message I replied to has no attachment. Attach the file to your command or reply to a message that has one.' };
    return { error: 'No file attached. Attach the obfuscated file to the command (or reply to a message that contains it).' };
  }
  if (att.size > maxBytes) {
    return { error: `File too large: ${(att.size / 1024 / 1024).toFixed(2)} MB (limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB).` };
  }
  const url = att.url || att.proxyURL;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return { error: `Failed to download the attachment (HTTP ${res.status}).` };
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, filename: att.name || 'input.bin', attachment: att };
}

export { AttachmentBuilder };
