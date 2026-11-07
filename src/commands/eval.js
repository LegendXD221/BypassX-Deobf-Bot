/**
 * .eval — OWNER ONLY. Run JS in a jailed node:vm sandbox.
 * The context has NO require/process/fetch/network/fs — pure computation,
 * sync-only (hard 5s instruction timeout), console output captured.
 */
import vm from 'node:vm';
import util from 'node:util';
import { CONFIG } from '../config.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'eval',
  description: '[owner] Evaluate JavaScript in a jailed sandbox',
  usage: '.eval <code>',
  owner: true,
  slash: {
    options: [
      { name: 'code', description: 'JavaScript to evaluate (sync, jailed sandbox)', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const code = ctx.isSlash
      ? ctx.interaction.options.getString('code', true)
      : (ctx.args || []).join(' ');
    if (!code.trim()) return ctx.reply(errorReply('Missing code', 'Give me something to evaluate.'));

    const logs = [];
    const fakeConsole = {
      log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 2, breakLength: 120 }))).join(' ')),
      error: (...a) => logs.push(`[err] ${a.map(String).join(' ')}`),
      warn: (...a) => logs.push(`[warn] ${a.map(String).join(' ')}`),
    };
    const sandbox = { console: fakeConsole, result: undefined };
    const context = vm.createContext(sandbox);

    const t0 = Date.now();
    let output = '';
    let ok = true;
    try {
      const completion = vm.runInContext(code, context, { timeout: 5_000, displayErrors: true });
      sandbox.result = completion;
      if (logs.length) output += `${logs.join('\n')}\n`;
      output += `=> ${util.inspect(completion, { depth: 3, maxArrayLength: 40, breakLength: 120 })}`;
    } catch (e) {
      ok = false;
      output = `${logs.length ? `${logs.join('\n')}\n` : ''}✗ ${String(e?.message || e).slice(0, 500)}`;
    }
    logger.info({ ms: Date.now() - t0, ok }, 'owner eval');
    return ctx.reply(ownerOutputReply({
      title: 'eval',
      ok,
      input: code,
      output,
      meta: [`${Date.now() - t0}ms`, 'jailed vm • no require/process/network', 'sync-only, 5s timeout'],
    }));
  },
};
