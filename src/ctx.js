/**
 * Command context shapes:
 *  - slash: ctx = { isSlash: true, interaction, defer(), reply(payload) }
 *  - prefix: ctx = { isSlash: false, message, reply(payload) }
 * Both expose: options (map of resolved values), attachments (array), userId, client.
 */
import { AttachmentBuilder } from 'discord.js';
import { fetchFromUrl, looksLikeUrl } from './fetchurl.js';
import { logger } from './logger.js';

const MAX_FALLBACK_FILE = 8 * 1024 * 1024;

function extractFallbackTextAndLinks(payload) {
  const texts = [];
  const urls = [];
  const walk = (node) => {
    if (!node) return;
    const j = typeof node.toJSON === 'function' ? node.toJSON() : node;
    if (Array.isArray(j)) { for (const x of j) walk(x); return; }
    if (typeof j !== 'object') return;
    if (typeof j.content === 'string' && j.content.trim()) texts.push(j.content.trim());
    if (typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) {
      urls.push(j.label ? `${j.label}: ${j.url}` : j.url);
    }
    if (Array.isArray(j.components)) walk(j.components);
    if (Array.isArray(j.accessory)) walk(j.accessory);
    else if (j.accessory) walk(j.accessory);
  };
  if (typeof payload?.content === 'string' && payload.content.trim()) texts.push(payload.content.trim());
  if (Array.isArray(payload?.components)) walk(payload.components);
  const body = [...urls, ...texts].join('\n').trim() || 'Result ready (display card exceeded Discord limits).';
  const safeFiles = Array.isArray(payload?.files)
    ? payload.files.filter((f) => {
      const att = f?.attachment;
      return !Buffer.isBuffer(att) || att.length <= MAX_FALLBACK_FILE;
    })
    : [];
  return {
    content: body.length <= 1900 ? body : `${body.slice(0, 1899)}…`,
    files: safeFiles,
  };
}

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

  const userId = interaction?.user?.id || message?.author?.id || '0';

  return {
    isSlash,
    interaction,
    message,
    client,
    attachments,
    /** Link input (.deobf <url> / /deobf link:) — resolved by index.js for prefix. */
    url,
    userId,
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
        try {
          if (interaction.deferred || interaction.replied) {
            // Cannot add Ephemeral to an already-deferred public reply — strip Ephemeral bit if present.
            const clean = payload?.flags ? { ...payload, flags: payload.flags & ~64 } : payload;
            return await interaction.editReply(clean);
          }
          return await interaction.reply(payload);
        } catch (e) {
          logger.warn({ err: String(e?.message || e).slice(0, 200), phase: 'reply' }, 'discord: reply fallback');
          if (interaction.channel) {
            const pub = payload?.flags ? { ...payload, flags: payload.flags & ~64 } : payload;
            return interaction.channel.send(pub).catch(() => interaction.channel.send(extractFallbackTextAndLinks(pub)).catch(() => {}));
          }
          throw e;
        }
      }
      if (message) {
        try {
          return await message.reply(payload);
        } catch (e) {
          logger.warn({ err: String(e?.message || e).slice(0, 200), phase: 'message.reply' }, 'discord: reply fallback');
          return message.channel.send(payload).catch(() => message.channel.send(extractFallbackTextAndLinks(payload)).catch(() => {}));
        }
      }
    },

    /**
     * v2.7.1 — instant visible acknowledgement that mentions the user:
     *   "@user deobfuscating Your Code …"
     * Slash: defer + editReply (turns "Bot is thinking…" into the status line);
     * prefix: a real reply message. The heavy command then keeps working in the
     * background and delivers the result via send(). Returns a handle with
     * update(text) to refresh the status line (e.g. ✅ done / ❌ failed).
     */
    async statusReply(text) {
      const mentions = { allowedMentions: { users: [userId] } };
      if (interaction) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply().catch(() => {});
        }
        const payload = { content: text, ...mentions };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(payload)
          : interaction.reply(payload)).catch(() => {});
        return {
          async update(t) {
            // v2.10.0 delivery guarantee: interaction tokens expire after
            // 15 minutes — a heavy multi-layer job can outrun them. When the
            // edit fails, post the final status as a fresh channel message
            // instead of silently dropping it.
            try {
              await interaction.editReply({ content: t, ...mentions });
            } catch {
              await interaction.channel?.send({ content: t, ...mentions }).catch(() => {});
            }
          },
        };
      }
      if (message) {
        let sent = await message.reply({ content: text, ...mentions }).catch(() => null);
        if (!sent) sent = await message.channel.send({ content: text, ...mentions }).catch(() => null);
        return {
          async update(t) {
            if (sent) await sent.edit({ content: t, ...mentions }).catch(() => {});
          },
        };
      }
      return { async update() { /* no channel context */ } };
    },

    /**
     * v2.7.1 — deliver a NEW message (followUp for slash, reply for prefix).
     * Used to hand over the finished result WITHOUT replacing the status
     * placeholder created by statusReply().
     * v2.10.0 delivery guarantee: if the interaction token has expired
     * (jobs > 15 min), fall back to a plain channel send so the result card
     * ALWAYS lands.
     */
    async send(payload) {
      if (interaction) {
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply().catch(() => {});
          }
          return await (interaction.deferred || interaction.replied
            ? interaction.followUp(payload)
            : interaction.reply(payload));
        } catch (e) {
          logger.warn({ err: String(e?.message || e).slice(0, 200), phase: 'followUp' }, 'discord: delivery fallback');
          const chan = interaction.channel;
          if (chan) {
            try { return await chan.send(payload); } catch (e2) {
              logger.warn({ err: String(e2?.message || e2).slice(0, 200), phase: 'chan.send' }, 'discord: trying safe plain fallback');
              return chan.send(extractFallbackTextAndLinks(payload)).catch((e3) => {
                logger.error({ err: String(e3?.message || e3).slice(0, 200) }, 'discord: all send fallbacks failed');
              });
            }
          }
          const safe = extractFallbackTextAndLinks(payload);
          return interaction.followUp(safe).catch(() => {});
        }
      }
      if (message) {
        try {
          return await message.reply(payload);
        } catch (e) {
          logger.warn({ err: String(e?.message || e).slice(0, 200), phase: 'message.reply' }, 'discord: reply failed — falling back to channel.send');
          try { return await message.channel.send(payload); } catch (e2) {
            logger.warn({ err: String(e2?.message || e2).slice(0, 200), phase: 'channel.send' }, 'discord: trying safe plain fallback');
            return message.channel.send(extractFallbackTextAndLinks(payload)).catch((e3) => {
              logger.error({ err: String(e3?.message || e3).slice(0, 200) }, 'discord: all prefix fallbacks failed');
            });
          }
        }
      }
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
