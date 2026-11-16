/**
 * .obf / /obf — Xfuscator: BypassX's own obfuscator.
 *
 * Packs a Lua file into a self-decoding Xfuscator build (v1 / v2 / v2.1).
 * Same input UX as .deobf: attachment, link, or reply-to. The output runs on
 * anything that exposes loadstring/load (Lua 5.1-5.4, Luau executors).
 *
 * Guards: input must be text Lua (Luau superset accepted via the shim),
 * never a binary, never already-Xfuscated (refuse double-obf), 1 MB cap.
 */
import { xfuscate, isXfuscated, XFUSCATOR_DEFAULT } from '../xfuscator.js';
import { obfReply, errorReply, cooldownReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { checkCooldown } from '../rate-limit.js';
import { createPaste } from '../pastefy.js';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';
import { looksLikeUrl } from '../fetchurl.js';

const MAX_OBF_BYTES = 1 * 1024 * 1024;

/** Normalize a user version token ('1', 'v1', '2', 'v2', '2.1', 'v2.1', '21'). */
function normalizeVersion(tok) {
  const t = String(tok || '').toLowerCase().replace(/^v/, '').replace(/\./g, '');
  if (t === '1') return 'v1';
  if (t === '2') return 'v2';
  if (t === '21') return 'v2.1';
  return null;
}

/**
 * Text sanity for blob packing (syntax-agnostic, so this stays heuristic):
 * reject binaries and text that shows no Lua markers at all.
 * @returns {string|null} error message, or null when OK
 */
function luaInputCheck(text) {
  if (!text || !text.trim()) return 'The file is empty — nothing to obfuscate.';
  if (/\u0000|\u0001|\u0002/.test(text.slice(0, 4096))) return 'This looks like a binary file. Xfuscator obfuscates Lua source text.';
  if (!/\b(?:local|function|end|then|return|print|repeat|while|elseif)\b/.test(text)) {
    return 'This does not look like Lua source. Xfuscator packs Lua scripts (Luau syntax accepted).';
  }
  return null;
}

export default {
  name: 'obf',
  description: 'Obfuscate a Lua file with Xfuscator — our own obfuscator (v1 / v2 / v2.1)',
  usage: '.obf [v1|v2|v2.1] <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The Lua file to obfuscate (.lua/.txt)', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a link (Pastefy, GitHub, Pastebin, gist, direct)', type: 'STRING', required: false },
      {
        name: 'version', description: 'Xfuscator build (default v2.1)', type: 'STRING', required: false,
        choices: [
          { name: 'v1 — XOR stream packer', value: 'v1' },
          { name: 'v2 — + position keys + integrity MAC', value: 'v2' },
          { name: 'v2.1 — + junk-byte interleave', value: 'v2.1' },
        ],
      },
    ],
  },

  async run(ctx) {
    const cd = checkCooldown(ctx.userId);
    if (!cd.ok) return ctx.reply(cooldownReply(cd.remainingMs));

    // Version: slash choice, or first non-URL prefix arg.
    let version = XFUSCATOR_DEFAULT;
    if (ctx.isSlash) {
      version = normalizeVersion(ctx.interaction.options.getString('version')) || XFUSCATOR_DEFAULT;
    } else {
      const tok = (ctx.args || []).find((a) => !looksLikeUrl(a));
      const norm = normalizeVersion(tok);
      if (norm) version = norm;
      else if (tok && /^(v?\d)/i.test(tok.trim())) {
        return ctx.reply(errorReply('Unknown version', `Use v1, v2 or v2.1 — e.g. \`${CONFIG.prefix}obf v2.1\` (default v2.1).`));
      }
    }

    const known = ctx.attachments.find(Boolean)?.name
      || (ctx.url ? 'link' : (ctx.attachments.referencedId ? 'replied message' : null));
    const t0 = Date.now();
    const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    const status = await ctx.statusReply(
      `<@${ctx.userId}> obfuscating Your Code${known ? ` (\`${known}\`)` : ''} with Xfuscator (${version}) …`,
    );

    let att;
    try {
      att = await getInputBuffer(ctx, { maxBytes: Math.min(CONFIG.maxUploadBytes, MAX_OBF_BYTES) });
    } catch (e) {
      await status.update(`❌ <@${ctx.userId}> couldn't download the input (${secs()}) — details below.`);
      return ctx.send(errorReply('Download failed', String(e.message || e).slice(0, 300)));
    }
    if (att.error) {
      await status.update(`❌ <@${ctx.userId}> no valid input — details below.`);
      return ctx.send(errorReply('No input', att.error));
    }

    const text = att.buffer.toString('utf8');
    const bad = luaInputCheck(text);
    if (bad) {
      await status.update(`❌ <@${ctx.userId}> input rejected (${secs()}).`);
      return ctx.send(errorReply('Not Lua source', bad));
    }
    if (isXfuscated(text)) {
      await status.update(`❌ <@${ctx.userId}> already Xfuscated (${secs()}).`);
      return ctx.send(errorReply('Already obfuscated', 'This file was already obfuscated by Xfuscator — double-obfuscation is refused to keep the loader honest.'));
    }

    const r = xfuscate(text, { version });
    if (!r.ok) {
      await status.update(`❌ <@${ctx.userId}> Xfuscator failed (${secs()}) — details below.`);
      return ctx.send(errorReply('Xfuscator failed', r.error));
    }

    let paste = null;
    try {
      paste = await createPaste({
        title: `Xfuscator (${version}) — ${att.filename || 'input.lua'}`,
        text: r.code,
      });
    } catch (e) {
      logger.warn({ err: String(e.message || e) }, 'obf: pastefy upload failed — delivering file attachment instead');
    }

    logger.info({ name: att.filename, version, in: r.stats.originalBytes, out: r.stats.outputBytes, cmd: 'obf' }, 'obf: success');
    await status.update(`✅ <@${ctx.userId}> obfuscated in ${secs()} — your Xfuscator build is below 👇`);
    return ctx.send(obfReply({
      version,
      code: r.code,
      filename: att.filename,
      sizeIn: r.stats.originalBytes,
      sizeOut: r.stats.outputBytes,
      paste,
      sourceUrl: att.sourceUrl || null,
    }));
  },
};
