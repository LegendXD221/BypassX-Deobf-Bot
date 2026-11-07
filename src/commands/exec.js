/**
 * .exec — OWNER, DANGEROUS (L1-L5). Run a shell command on the host (the
 * Render container). This is the owner's own maintenance shell on their own
 * box: 90 s timeout, 16 MB output capture, long output auto-uploaded to
 * Pastefy and attached as a file. Protected by the 5 owner layers at dispatch.
 */
import { exec as execCb } from 'node:child_process';
import { CONFIG } from '../config.js';
import { createPaste } from '../pastefy.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

const MAX_TIMEOUT = 300_000;

function run(cmd, timeoutMs) {
  return new Promise((resolve) => {
    execCb(cmd, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd: process.cwd(), shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export default {
  name: 'exec',
  description: '[owner] Run a shell command on the host (dangerous — confirmation required)',
  usage: '.exec <command>',
  owner: true,
  danger: true,
  slash: {
    options: [
      { name: 'command', description: 'Shell command to run (bash, 90s timeout)', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const cmd = ctx.isSlash
      ? ctx.interaction.options.getString('command', true)
      : (ctx.args || []).join(' ');
    if (!cmd.trim()) return ctx.reply(errorReply('Missing command', 'Give me a shell command.'));

    // Optional ".exec <cmd> %% <seconds>" tail to raise the timeout per call.
    let timeoutMs = 90_000;
    const m = cmd.match(/\s%%\s*(\d{1,3})\s*$/);
    if (m) timeoutMs = Math.min(MAX_TIMEOUT, Number(m[1]) * 1000);

    await ctx.defer();
    const t0 = Date.now();
    const { err, stdout, stderr } = await run(cmd.replace(/\s%%\s*\d{1,3}\s*$/, ''), timeoutMs);
    const ms = Date.now() - t0;
    let output = stdout;
    if (stderr.trim()) output += (output ? '\n' : '') + `[stderr]\n${stderr}`;
    if (err && err.killed) output += (output ? '\n' : '') + `[killed at ${timeoutMs / 1000}s timeout]`;
    else if (err) output += (output ? '\n' : '') + `[exit ${err.code ?? '?'}] ${String(err.message).split('\n')[0]}`;
    output = output.trim() || '(no output)';

    logger.info({ ms, cmd: cmd.slice(0, 80) }, 'owner exec');

    const meta = [`${ms}ms`, `exit ${err ? (err.code ?? 'sig') : 0}`, `${timeoutMs / 1000}s cap`];
    if (output.length > 1500) {
      let paste = null;
      try {
        paste = await createPaste({ title: `BypassX Deobf — exec output (${ms}ms)`, text: output });
      } catch { /* file attachment still carries it */ }
      return ctx.reply(ownerOutputReply({
        title: 'exec', ok: !err, input: cmd,
        output: `${output.slice(0, 1500)}\n… (${output.length - 1500} more chars)`,
        meta: [...meta, paste ? `full output: ${paste.url}` : 'full output attached'],
      }));
    }
    return ctx.reply(ownerOutputReply({ title: 'exec', ok: !err, input: cmd, output, meta }));
  },
};
