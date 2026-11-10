/**
 * BypassX Deobf Bot — AntiTamper orchestrator (v2.15.0).
 *
 * One entry point the pipeline calls BEFORE any engine sees the input:
 *
 *   prepareAntitamper(sourceText, familyId)
 *     → scan (catalog hits present in the source)
 *     → neutralize (safe rewrites: LPH traps, macro unwraps, tamper residue)
 *     → profile pick (env-hardening)
 *     → { code, changed, hits, scan, profile, summary, stages }
 *
 * The caller verify-gates `code` before shipping it (pipeline.js); a rewrite
 * that does not parse never leaves this module's hands as "changed" — but the
 * hits/scan report always survives, so visibility never depends on rewrites.
 */

import { CATALOG, CATALOG_BY_ID, catalogForFamily, PATTERNS, SUPPORTED_FAMILIES } from './catalog.js';
import { buildProfileExtension, profileSummary, hasProfile } from './env-hardening.js';
import { neutralizeSource, scanSource, hitsToStageLine } from './neutralize.js';
import { runSanity, sanityLine, CHECKS } from './sanity.js';

export { CATALOG, CATALOG_BY_ID, catalogForFamily, PATTERNS, SUPPORTED_FAMILIES };
export { buildProfileExtension, profileSummary, hasProfile };
export { neutralizeSource, scanSource, hitsToStageLine };
export { runSanity, sanityLine, CHECKS };

const SCAN_PATTERNS = [
  // each: [id, regex source] — matched against raw source for the SCAN report
  ['lph-crash', /LPH_CR(A|A)SH\s*\(/],
  ['lph-precheck', /LPH_PRECHECK\s*\(/],
  ['lph-macros', /LPH_(ENCSTR|ENCNUM|ENCFUNC|JIT_MAX|JIT|NO_VIRTUALIZE|NO_UPVALUES)\s*\(/],
  ['residue-antitamper-leftovers', /setmetatable\s*\(\s*(game|workspace|script)\s*,/],
  ['unc-identifyexecutor', /\b(identifyexecutor|getexecutorname)\s*\(/],
  ['unc-getgenv-tell', /\b(getgenv|getrenv|getgc)\s*\(/],
  ['unc-namecall-integrity', /__namecall/],
  ['dump-stringdump', /string\s*\.\s*dump/],
  ['telemetry-http', /Http(Get|Post)\b/],
  ['telemetry-request', /\b(request|http_request)\s*\(/],
  ['ms-skid-setfenv', /\bsetfenv\s*\(/],
  ['luraph-tostring-fingerprint', /45195195/],
  ['dump-bytecode-guard', /RSB1/],
];

/**
 * Prepare an input for every engine: scan + neutralize + profile.
 * Pure string work — no I/O, no throw. On any internal error the ORIGINAL
 * text is returned unchanged with the error recorded (never fails a job).
 */
export function prepareAntitamper(sourceText, familyId = 'unknown') {
  const out = {
    code: sourceText,
    changed: false,
    hits: [],
    scan: [],
    profile: profileSummary(familyId),
    summary: null,
    stages: [],
    error: null,
  };
  try {
    if (typeof sourceText !== 'string' || !sourceText) return out;

    // 1. Catalog scan (cheap, regex-only) — what the source carries.
    const seen = new Set();
    for (const [id, re] of SCAN_PATTERNS) {
      const m = sourceText.match(new RegExp(re.source, 'g'));
      if (m && m.length) {
        out.scan.push({ id, count: m.length });
        seen.add(id);
      }
    }

    // 2. Neutralize (safe rewrites).
    const n = neutralizeSource(sourceText, familyId);
    out.code = n.code;
    out.changed = n.changed;
    out.hits = n.hits;

    // 3. Stage lines (user-visible in replies via pipeline stages).
    const line = hitsToStageLine(out.hits);
    if (line) {
      out.stages.push({ name: 'antitamper', detail: line });
      out.summary = line;
    } else if (out.scan.length) {
      out.summary = `${out.scan.reduce((a, s) => a + s.count, 0)} anti-tamper signature(s) present — handled by the hardened jail (${out.profile.label})`;
      out.stages.push({ name: 'antitamper', detail: out.summary });
    }
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 200);
    out.code = sourceText; // original text, always
    out.changed = false;
  }
  return out;
}

/** Catalog entries for a family, formatted for a reply block. */
export function catalogLinesForFamily(familyId, { max = 8 } = {}) {
  const entries = catalogForFamily(familyId);
  const specific = entries.filter((e) => !e.services.includes('*'));
  const generic = entries.filter((e) => e.services.includes('*'));
  const ordered = [...specific, ...generic].slice(0, max);
  return ordered.map((e) => `• **${e.name}** (${e.kind}, ${e.severity}) — ${e.counter}`);
}

/** Full human report (owner/debug surface). */
export function fullReport(familyId) {
  const p = profileSummary(familyId);
  const lines = [
    `AntiTamper report — ${p.label}`,
    ...p.notes.map((n) => `  • ${n}`),
    `Catalog: ${CATALOG.length} mechanisms (${catalogForFamily(familyId).length} relevant to ${familyId})`,
  ];
  return lines.join('\n');
}
