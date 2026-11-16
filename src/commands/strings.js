/**
 * .strings / /strings — extract the string table from a file (quick recon
 * before a full deobfuscation). Full list goes to Pastefy, preview inline.
 */
import { createPaste } from '../pastefy.js';
import { codeToolReply, errorReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { CONFIG } from '../config.js';
import { fmtBytes } from '../replies.js';

const MIN_LEN = 4;
const MAX_STRINGS = 5000;

export default {
  name: 'strings',
  description: 'Extract the string table from a file — quick recon of what it hides',
  usage: '.strings <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The file to scan', type: 'ATTACHMENT', required: false },
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

    const buf = att.buffer;
    if (buf.subarray(0, 4096).includes(0) && !/\blocal\b|\bfunction\b/.test(buf.subarray(0, 4096).toString('latin1'))) {
      return ctx.reply(errorReply('Binary file', 'String extraction works on text/code files. Run `.deobf` on packed binaries instead.'));
    }

    const text = buf.toString('utf8');
    const found = [];
    const seen = new Set();
    const push = (s) => {
      s = s.trim();
      if (s.length < MIN_LEN || s.length > 300) return;
      if (seen.has(s)) return;
      seen.add(s);
      found.push(s);
    };
    // Ordered, line-by-line so the table keeps rough source order.
    for (const line of text.split(/\r?\n/)) {
      for (const m of line.matchAll(/"((?:[^"\\\n]|\\.){4,300})"/g)) push(m[1]);
      for (const m of line.matchAll(/'((?:[^'\\\n]|\\.){4,300})'/g)) push(m[1]);
      for (const m of line.matchAll(/\[\[([^\]\n]{4,300})\]\]/g)) push(m[1]);
      if (found.length >= MAX_STRINGS) break;
    }

    if (!found.length) {
      return ctx.reply(errorReply('No strings found', 'No quoted strings of 4+ characters — the file may be packed, or its strings are encrypted (run `.deobf` for the full pipeline).'));
    }

    const table = found.map((s, i) => `${String(i + 1).padStart(4)} | ${s.replace(/\n/g, '\\n').slice(0, 200)}`).join('\n');
    let paste = null;
    try {
      paste = await createPaste({ title: `BypassX Deobf strings — ${att.filename || 'file'}`, text: table });
    } catch { /* deliver attachment only */ }

    return ctx.reply(codeToolReply({
      title: '🔤 String table',
      subtitle: `${found.length} unique strings`,
      factsRows: [
        { label: 'File', value: att.filename || 'file' },
        { label: 'Size', value: fmtBytes(buf.length) },
        { label: 'Strings', value: `${found.length} unique (≥${MIN_LEN} chars)` },
        ...(found.length >= MAX_STRINGS ? [{ label: 'Note', value: `capped at ${MAX_STRINGS}` }] : []),
      ],
      note: '**Sample**\n```\n' + found.slice(0, 12).map((s) => s.replace(/\n/g, '\\n').slice(0, 90)).join('\n') + '\n```',
      code: table,
      codeName: `strings-${att.filename || 'file'}.txt`,
      paste,
    }));
  },
};
