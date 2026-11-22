// -- made by jamie @_jmi. OR @jmialt_ (JOIN OMNI DBF (https://dsc.gg/luciddeobf))
const PATH_RE = /(?:\/app|\/usr|\/home|\/tmp|C:[\/\\]+Users|\\\\\.freebuff)[^\s"')\n]*/g;

const ENGINE_PATH_RE = /(?:deobfuscators|envlogger)[\/\\][\w.\/\\]+/g;

const REQUIRE_STACK_RE = /Require stack:\s*\n(?:\s*-\s+.+\n)+/g;

const STACK_FRAME_RE = /at\s+(?:.*?\s+\()?([^)]*?\.\w+:\d+:\d+)?/g;

function basename(p) {
    if (!p) return '[redacted]';
    const parts = p.split(/[\/\\]/);
    return parts[parts.length - 1] || '[redacted]';
}

function rp(msg) {
    let s = String(msg || '');

    s = s.replace(REQUIRE_STACK_RE, 'Require stack:\n  (redacted)');

    s = s.replace(STACK_FRAME_RE, (match, filePath) => {
        if (!filePath) return match;
        return match.replace(filePath, basename(filePath));
    });

    s = s.replace(PATH_RE, (m) => basename(m));

    s = s.replace(ENGINE_PATH_RE, (m) => basename(m));

    s = s.replace(/node_modules[\/\\][\w@.-]+/g, (m) => {
        return m.replace(/node_modules[\/\\]/, '');
    });

    return s;
}

module.exports = { rp };
