/**
 * Command context shapes:
 *  - slash: ctx = { isSlash: true, interaction, defer(), reply(payload) }
 *  - prefix: ctx = { isSlash: false, message, reply(payload) }
 * Both expose: options (map of resolved values), attachments (array), userId, client.
 */
import { AttachmentBuilder } from 'discord.js';
import { fetchFromUrl, looksLikeUrl } from './fetchurl.js';

export function makeCtx({ interaction = null, message = null, client }) {
  const isSlash = Boolean(interaction);
  const attachments = [];
  let url = null;
  if (interaction?.options) {
    const opt = interaction.options.getAttachment('file');
    if (opt) attachments.push(opt);
    const link = interaction.options.getString('link');
    if (link && looksLikeUrl(link)) url = link;
    const replied = interaction.options.getMessage('message');
    if (replied?.attachments?.size) attachments.push(...replied.attachments.values());
    if (!url && !attachments.length && replied?.content) {
      const found = replied.content.split(/\s+/).find(looksLikeUrl);
      if (found) url = found;
    }
  }
  if (message?.attachments?.size) attachments.push(...message.attachments.values());
  if (message?.reference?.messageId) attachments.referencedId = message.reference.messageId;

  return {
    isSlash,
    interaction,
    message,
    client,
    attachments,
    /** Link input (.deobf <url> / /deobf link:) — resolved by index.js for prefix. */
    url,
    userId: interaction?.user?.id || message?.author?.id || '0',
    userTag: interaction?.user?.tag || message?.author?.tag || 'unknown',
    prefix: message?._prefix || '.',

    async defer() {
      if (interaction) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply().catch(() => {});
        }
      } else if (message?.channel) {
        await message.channel.sendTyping().catch(() => {});
      }
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
    if (ctx.attachments.referencedId) return { error: 'The message I replied to has no attachment. Attach the file, reply to a message that has one, or pass a link.' };
    return { error: 'No input. Attach the obfuscated file, reply to a message that contains it, or pass a link (Pastefy, GitHub, Pastebin, gist, Discord message, direct URL).' };
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

/**
 * Unified input resolution for deobf/detect:
 *   1. link argument (.deobf <url> / /deobf link:) — fetched via fetchFromUrl
 *   2. direct attachment (slash file: or message attachment)
 *   3. referenced message (attachment or a link inside it)
 * @returns {{buffer, filename, note?, sourceUrl?} | {error: string}}
 */
export async function getInputBuffer(ctx, { maxBytes }) {
  if (ctx.url) {
    try {
      const got = await fetchFromUrl(ctx.url, { client: ctx.client, maxBytes });
      return { ...got, sourceUrl: ctx.url };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 400) };
    }
  }
  return getAttachmentBuffer(ctx, { maxBytes });
}

export { AttachmentBuilder };
