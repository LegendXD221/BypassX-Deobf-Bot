'use strict';

const { execFile } = require('child_process');

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

const KILL_GRACE_MS = 5000;

const SETTLE_GRACE_MS = 3000;

function asText(value) {
    if (value == null) return '';
    return typeof value === 'string' ? value : value.toString('utf8');
}

function runProcess(file, args, opts) {
    const options = opts || {};
    const timeout = Number(options.timeout) || 0;
    const settings = {
        encoding: 'utf8',
        maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
        windowsHide: true,

        timeout: 0,
    };
    if (options.cwd) settings.cwd = options.cwd;
    if (options.env) settings.env = options.env;

    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        const timers = [];

        const later = (ms, fn) => {
            const timer = setTimeout(fn, ms);

            if (typeof timer.unref === 'function') timer.unref();
            timers.push(timer);
        };

        const finish = (err, stdout, stderr) => {
            if (settled) return;
            settled = true;
            for (const timer of timers) clearTimeout(timer);
            timers.length = 0;

            const out = asText(stdout);
            const errOut = asText(stderr);
            if (!err) {
                resolve({ stdout: out, stderr: errOut });
                return;
            }
            err.stdout = out;
            err.stderr = errOut;
            if (timedOut) {

                err.code = 'ETIMEDOUT';
                err.killed = true;
                if (!err.signal) err.signal = 'SIGTERM';
            }
            reject(err);
        };

        let child;
        try {
            child = execFile(file, args, settings, (err, stdout, stderr) => finish(err, stdout, stderr));
        } catch (spawnErr) {

            finish(spawnErr, '', '');
            return;
        }

        if (timeout > 0) {
            later(timeout, () => {
                if (settled) return;
                timedOut = true;
                try { child.kill('SIGTERM'); } catch (_) {}
            });
            later(timeout + KILL_GRACE_MS, () => {
                if (settled) return;
                try { child.kill('SIGKILL'); } catch (_) {}
            });
            later(timeout + KILL_GRACE_MS + SETTLE_GRACE_MS, () => {
                if (settled) return;
                timedOut = true;
                finish(Object.assign(
                    new Error(`${file} did not exit after being killed`),
                    { signal: 'SIGKILL' },
                ), '', '');
            });
        }
    });
}

async function probeCommand(file, args, expect, timeoutMs) {
    try {
        const { stdout, stderr } = await runProcess(file, args, {
            timeout: timeoutMs || 5000,
            maxBuffer: 1024 * 1024,
        });
        const text = `${stdout}\n${stderr}`;
        return expect ? expect.test(text) : true;
    } catch (_) {
        return false;
    }
}

module.exports = { runProcess, probeCommand, DEFAULT_MAX_BUFFER, KILL_GRACE_MS };
