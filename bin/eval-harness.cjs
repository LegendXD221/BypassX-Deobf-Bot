#!/usr/bin/env node
/**
 * eval-harness.cjs — the jailed evaluator child for the owner `.eval` command.
 *
 *   node eval-harness.cjs <codeFile>
 *
 * Reads {"code": "..."} from the given file (written by the bot, 0600, in an
 * isolated tmpdir), runs it inside vm.runInNewContext with:
 *   - an EMPTY sandbox: no require/process/fetch/fs/network, and crucially no
 *     host objects (host functions are what make vm constructor-chain escapes
 *     possible, so there are none to climb);
 *   - a realm-native console that only appends to a realm array;
 *   - a hard 5 s vm instruction timeout (sync-only by construction).
 * Prints one JSON line: {ok, logs[], result|error, ms}. Any crash is caught;
 * the child itself is disposable (spawnHardened kills it at 12 s).
 */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const util = require('node:util');

function main() {
  const t0 = Date.now();
  const file = process.argv[2];
  const out = (obj) => process.stdout.write(JSON.stringify(obj));
  if (!file) return out({ ok: false, error: 'no code file given' });

  let code = '';
  try {
    code = String(JSON.parse(fs.readFileSync(file, 'utf8')).code || '');
  } catch (e) {
    return out({ ok: false, error: `bad code file: ${e.message}` });
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  if (code.length > 20_000) return out({ ok: false, error: 'code too long (20 KB max)' });

  const sandbox = {}; // intentionally empty — no host objects at all
  const context = vm.createContext(sandbox);
  try {
    // Realm-native console: functions close over realm objects only, so there
    // is no host Function/Process constructor reachable from user code.
    vm.runInContext(`
      var __logs = [];
      var console = {
        log:  (...a) => { __logs.push(a.map((x) => typeof x === 'string' ? x : String(x)).join(' ')); },
        warn: (...a) => { __logs.push('[warn] ' + a.map(String).join(' ')); },
        error:(...a) => { __logs.push('[err] '  + a.map(String).join(' ')); },
      };
    `, context, { timeout: 1000 });
    // Function-body mode via an IIFE inside runInContext: `return …` works,
    // and runInContext ENFORCES the 5 s instruction timeout (compileFunction's
    // timeout is not honored on invocation in current Node).
    const wrapped = `(function(){\n${code}\n})()`;
    const completion = vm.runInContext(wrapped, context, { timeout: 5000, displayErrors: true });
    const logs = (() => { try { return vm.runInContext('__logs', context, { timeout: 500 }); } catch { return []; } })();
    return out({
      ok: true,
      logs: logs.slice(0, 20).map((x) => String(x).slice(0, 400)),
      result: util.inspect(completion, { depth: 3, maxArrayLength: 30, breakLength: 120 }).slice(0, 2000),
      ms: Date.now() - t0,
    });
  } catch (e) {
    let logs = [];
    try { logs = vm.runInContext('__logs', context, { timeout: 500 }); } catch { /* realm gone */ }
    return out({ ok: false, logs: logs.slice(0, 20).map((x) => String(x)), error: String(e?.message || e).slice(0, 800), ms: Date.now() - t0 });
  }
}

main();
