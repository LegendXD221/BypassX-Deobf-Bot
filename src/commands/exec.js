/**
 * .exec — OWNER ONLY. Run a shell command on the host (the Render container).
 * 20s timeout, 1MB output cap, output capped in the reply.
 */
import { exec as execCb } from 'node:child_process';
import { CONFIG } from '../config.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

function run(cmd, timeoutMs) {
  return new Promise((resolve) => {
    execCb(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd: process.cwd(), shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export default {
  name: 'exec',
  description: '[owner] Run a shell command on the host',
  usage: '.exec <command>',
  owner: true,
  slash: {
    options: [
      { name: 'command', description: 'Shell command to run (bash, 20s timeout)', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const cmd = ctx.isSlash
      ? ctx.interaction.options.getString('command', true)
      : (ctx.args || []).join(' ');
    if (!cmd.trim()) return ctx.reply(errorReply('Missing command', 'Give me a shell command.'));

    await ctx.defer();
    const t0 = Date.now();
    const { err, stdout, stderr } = await run(cmd, 20_000);
    const ms = Date.now() - t0;
    let output = stdout;
    if (stderr.trim()) output += (output ? '\n' : '') + `[stderr]\n${stderr}`;
    if (err) output += (output ? '\n' : '') + `[exit ${err.code ?? '?'}] ${String(err.message).split('\n')[0]}`;
    logger.info({ ms, cmd: cmd.slice(0, 80) }, 'owner exec');
    return ctx.reply(ownerOutputReply({
      title: 'exec',
      ok: !err,
      input: cmd,
      output: output.trim() || '(no output)',
      meta: [`${ms}ms`, 'bash • 20s timeout'],
    }));
  },
};
