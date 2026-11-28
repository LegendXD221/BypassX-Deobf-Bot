/**
 * .scan / /scan — static security & malware threat scanner for scripts.
 * Flags webhooks, IP loggers, .ROBLOSECURITY/token stealers, OS/FFI escapes,
 * and remote second-stage loaders without executing untrusted code.
 */
import { CONFIG } from '../config.js';
import { getInputBuffer } from '../ctx.js';
import { classifyString, kindLabel } from '../notable.js';
import { redactSecrets } from '../redact.js';
import { codeToolReply, errorReply, fmtBytes } from '../replies.js';

const SCAN_RULES = [
  { kind: 'webhook', severity: 'HIGH', re: /(?:(?:canary\.|ptb\.)?discord(?:app)?\.com|discord\.gg)\/api\/(?:v\d+\/)?webhooks\/[^\s"'`<>\\]{6,}|(?:webhook\.lewisakura\.moe|hooks\.hyra\.io|hooks\.slack\.com|api\.telegram\.org\/bot|webhook\.site|requestbin\.\w+|ngrok(?:-free)?\.app|ngrok\.io|pipedream\.net)[^\s"'`<>\\]*/gi },
  { kind: 'iplogger', severity: 'HIGH', re: /\bhttps?:\/\/[^\s"'`<>\\]*(?:api\.ipify\.org|grabify\.link|iplogger\.org|ip-api\.com|icanhazip\.com|ifconfig\.me|checkip\.amazonaws\.com|ipinfo\.io)[^\s"'`<>\\]*/gi },
  { kind: 'stealer', severity: 'CRITICAL', re: /\.ROBLOSECURITY|Local Storage[\\/]leveldb|discord[\\/]Local Storage|io\.popen\s*\(|os\.execute\s*\(|require\s*\(\s*["'](?:ffi|lfs)["']\s*\)|debug\.getregistry\s*\(/gi },
  { kind: 'loader', severity: 'MED', re: /\b(?:loadstring|load|queue_on_teleport)\s*\([^\n]{0,120}(?:game:HttpGet(?:Async)?|HttpGet(?:Async)?|GetAsync|syn\.request|http_request|http\.request|request)\b[^\n]*/gi },
  { kind: 'token', severity: 'CRITICAL', re: /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{27,}/g },
  { kind: 'url', severity: 'LOW', re: /\bhttps?:\/\/[^\s"'`<>\\]{6,}/gi },
];

export function scanScriptBuffer(buf) {
  const text = buf.toString('utf8');
  const findings = [];
  const seen = new Set();

  for (const rule of SCAN_RULES) {
    rule.re.lastIndex = 0;
    let m;
    let hits = 0;
    while ((m = rule.re.exec(text)) !== null && hits < 12) {
      const raw = m[0].trim();
      const key = `${rule.kind}:${raw}`;
      if (!seen.has(key)) {
        seen.add(key);
        const kind = classifyString(raw) || rule.kind;
        findings.push({
          kind,
          label: kindLabel(kind),
          severity: rule.severity,
          sample: redactSecrets(raw).slice(0, 140),
        });
        hits++;
      }
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }

  const crit = findings.filter((f) => f.severity === 'CRITICAL').length;
  const high = findings.filter((f) => f.severity === 'HIGH').length;
  const med = findings.filter((f) => f.severity === 'MED').length;
  const verdict = crit > 0 || high > 0
    ? '🚨 MALICIOUS / HIGH RISK'
    : med > 0
      ? '⚠️ SUSPICIOUS (REMOTE LOADER)'
      : findings.length > 0
        ? '🟡 LOW RISK (URLS FOUND)'
        : '✅ CLEAN (NO THREAT SIGNATURES)';

  return { verdict, findings, crit, high, med };
}

export default {
  name: 'scan',
  description: 'Scan a script or link for webhooks, IP loggers, stealers, OS escapes, and remote loaders',
  usage: '.scan <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The script file to scan', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a link', type: 'STRING', required: false },
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
    if (att.buffer.subarray(0, 1024).includes(0)) {
      return ctx.reply(errorReply('Binary file', 'Static threat scan works on text scripts only.'));
    }

    const report = scanScriptBuffer(att.buffer);
    const lines = report.findings.length
      ? report.findings.map((f, i) => `${i + 1}. [${f.severity}] (${f.label}) ${f.sample}`)
      : ['No webhooks, IP loggers, stealers, dangerous OS/FFI calls, or remote loaders detected.'];

    return ctx.reply(codeToolReply({
      title: `🛡️ Threat Scan — ${report.verdict}`,
      subtitle: `${report.findings.length} indicator(s) found`,
      factsRows: [
        { label: 'File', value: att.filename || 'script' },
        { label: 'Size', value: fmtBytes(att.buffer.length) },
        { label: 'Severity', value: `${report.crit} critical • ${report.high} high • ${report.med} med` },
      ],
      code: lines.join('\n'),
      codeName: `${(att.filename || 'script').replace(/\.[^.]+$/, '')}-scan.txt`,
    }));
  },
};
