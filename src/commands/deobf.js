/**
 * .deobf / /deobf — full pipeline: detect → deobfuscate → Pastefy (pure code).
 * Accepts a file attachment, a link (Pastefy/GitHub/Pastebin/gist/Discord
 * message/direct URL), or a reply to a message with a file.
 *
 * v2.8.0: the run body moved to src/commands/deobf-core.js so every
 * per-service command (.lph .ms3 .ms2 …) shares this exact flow. .deobf
 * itself stays pure auto-detect (no family pin).
 */
import { runDeobfJob } from './deobf-core.js';

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
    return runDeobfJob(ctx, { commandName: 'deobf', forced: null });
  },
};
