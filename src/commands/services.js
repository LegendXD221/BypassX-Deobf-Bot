/**
 * Per-service deobfuscation commands — every supported obfuscator gets its
 * own prefix + slash command that FORCES the pipeline onto that family:
 *
 *   .prom .ms3 .ms2 .lph .clyde .psu .ib2 .hcs .lo .mv .iv .77 .goofy .luast
 *
 * (.l — Environment Logger — is a separate dumper command, src/commands/logger.js)
 *
 * All of them run the exact same v2.7.1 flow as .deobf (instant "@user
 * deobfuscating …" ack → background pipeline → ✅ + result card) through
 * src/commands/deobf-core.js, with the family pin resolved by
 * src/service-catalog.js: a strong auto-hit on an accepted sibling family
 * stays (sub-family truthfulness), everything else is overridden by the
 * command's explicit choice.
 */
import { SERVICE_COMMANDS } from '../service-catalog.js';
import { runDeobfJob } from './deobf-core.js';

function makeServiceCommand(spec) {
  return {
    name: spec.cmd,
    description: spec.slash,
    usage: `.${spec.cmd} <attach file | link>`,
    slash: {
      options: [
        { name: 'file', description: `The ${spec.name}-obfuscated file (.lua/.txt)`, type: 'ATTACHMENT', required: false },
        { name: 'link', description: 'Or fetch it from a raw URL (Pastefy, GitHub, Pastebin, gist, direct)', type: 'STRING', required: false },
      ],
    },
    heavy: true,
    serviceCmd: true, // per-guild deobf gate + dispatch stats

    async run(ctx) {
      return runDeobfJob(ctx, {
        commandName: spec.cmd,
        forced: { id: spec.serviceId, accept: spec.accept, tag: spec.cmd, label: spec.name },
      });
    },
  };
}

export default SERVICE_COMMANDS.filter((s) => s.serviceId).map(makeServiceCommand);
