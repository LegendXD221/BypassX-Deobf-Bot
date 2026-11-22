// -- made by jamie @_jmi. OR @jmialt_ (JOIN OMNI DBF (https://dsc.gg/luciddeobf))
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { rp } = require('./sanitize');

const ENGINE_DIR = path.join(__dirname, 'IronveilV1', 'deobfuscator');
const ENGINE_INDEX = path.join(ENGINE_DIR, 'index.js');

function detectIronveil(content) {
    let score = 0;

    if (/ironveil/i.test(content)) score += 10;

    if (/W\[8\]=\{/.test(content)) score += 5;
    if (/W\[9\]=\{/.test(content)) score += 5;
    if (/W\[8\]=\{\w+\[\{/.test(content)) score += 5;

    if (/W\[10\]=/.test(content)) score += 3;
    if (/W\[11\]=/.test(content)) score += 3;

    if (/function\(\)return\s+\d+\s+end\)\(\)/.test(content)) score += 3;

    if (/string\.pack|I4|I2/.test(content)) score += 2;

    if (/\w+\[\{"[^"]+"\.\.\."[^"]+"\.\.\."[^"]*",\s*\d+\}\]/.test(content)) score += 4;

    if (/~=.*\d{5,12}/.test(content)) score += 3;

    return { isIronveil: score >= 8, score };
}

function deobfuscateIronveil(content) {
    if (!fs.existsSync(ENGINE_INDEX)) {
        return {
            success: false,
            error: 'The Ironveil V1 engine is not installed on this host (index.js missing). '
                 + 'This is a deployment problem, not a problem with your file.',
        };
    }

    let engine;
    try {
        engine = require(ENGINE_INDEX);
    } catch (err) {
        return {
            success: false,
            error: rp('Failed to load the Ironveil V1 engine: ' + (err.message || err)),
        };
    }

    if (typeof engine.deobfuscate !== 'function') {
        return {
            success: false,
            error: 'The Ironveil V1 engine does not export a deobfuscate() function.',
        };
    }

    let raw;
    try {
        raw = engine.deobfuscate(content);
    } catch (err) {
        const msg = String(err && err.message || err);
        if (/ENOENT|Cannot find module|MODULE_NOT_FOUND/.test(msg)) {
            return {
                success: false,
                error: 'The Ironveil V1 engine is missing a dependency. This is a deployment problem, not a problem with your file.',
            };
        }
        if (/out of memory|heap|allocation failed/i.test(msg)) {
            return {
                success: false,
                error: 'The Ironveil V1 engine ran out of memory on this script. It may be too large.',
            };
        }
        return { success: false, error: rp('Ironveil deobfuscation failed: ' + msg.slice(0, 300)) };
    }

    if (!raw || typeof raw !== 'string') {
        return { success: false, error: 'The Ironveil V1 engine returned no output.' };
    }

    let output = cleanupOutput(raw);

    if (output.length === 0) {
        return { success: false, error: 'Deobfuscation produced empty output after cleanup.' };
    }

    const decodedStrings = extractStrings(output);

    return {
        success: true,
        output,
        stats: {
            type: 'Ironveil',
            version: 'V1',
            inputSize: content.length,
            outputSize: output.length,
            decodedStrings,
        },
    };
}

function cleanupOutput(raw) {
    let out = raw;

    out = out.replace(/^--\s*(?:deobfuscated\s+by\s+LeakD|deobfuscated|generated\s+by)[^\n]*/gi, '');

    out = out.split('\n').filter(line => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('--')) return true;

        if (/^--\s*(?:deobfuscated|generated|original|source|extracted|recovered|engine)/i.test(trimmed)) return false;
        return true;
    }).join('\n');

    out = out.replace(/\n{3,}/g, '\n\n');

    out = out.trim();

    const MAX_OUTPUT = 7 * 1024 * 1024;
    if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT);
    }

    return out;
}

function extractStrings(output) {
    const seen = new Set();
    const result = [];
    const pattern = /"([^\n"]{3,80})"/g;
    let m;

    while ((m = pattern.exec(output)) !== null) {
        const s = m[1];

        if (!/[a-zA-Z]/.test(s)) continue;

        if (/^[A-Za-z0-9_]{1,3}$/.test(s)) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        result.push(s);
        if (result.length >= 20) break;
    }

    return result;
}

module.exports = { detectIronveil, deobfuscateIronveil };
