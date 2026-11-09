/**
 * BypassX Deobf Bot — per-service command catalog (single source of truth).
 *
 * Every supported obfuscator gets its own Discord command (.lph, .ms3, .ms2, …)
 * that FORCES the pipeline onto that family instead of trusting auto-detection.
 * This module is pure metadata + the forced-vs-detected resolution rule, so it
 * can be imported from the command defs, the reply builders and the tests
 * without pulling in the pipeline.
 *
 * Fields:
 *   cmd    — prefix command name (`.77` → cmd '77') and slash command name
 *   name   — display name shown on cards
 *   blurb  — exact description line shown by the supported-commands card
 *   slash  — slash command description (Discord limit: 100 chars)
 *   serviceId — detect.js SERVICES id the command forces (null for .l, which
 *               is the environment logger, not a family pin)
 *   accept — sibling family ids that a STRONG auto-detect may keep instead of
 *            the forced id (sub-family/version truthfulness), e.g. .ms3 keeps
 *            a positively-identified MoonSec V1 sample on the v1 engine.
 */

import { serviceById } from './detect.js';

export const SERVICE_COMMANDS = [
  {
    cmd: 'l', name: 'Environment Logger',
    blurb: 'Run Script In A Dumper Tool And See What It Records - Most Recommended',
    slash: 'Run the script in a dumper tool and see what it records (most recommended)',
    serviceId: null,
  },
  {
    cmd: 'prom', name: 'Prometheus / WeAreDevs',
    blurb: 'Prometheus-Deobfuscator',
    slash: 'Deobfuscate Prometheus / WeAreDevs files or URLs',
    serviceId: 'prometheus', accept: ['prometheus', 'wearedevs'],
  },
  {
    cmd: 'ms3', name: 'MoonSec V3',
    blurb: 'Deobfuscate Any Moonsec V3 File/URL',
    slash: 'Deobfuscate Any Moonsec V3 File/URL',
    serviceId: 'moonsec_v3', accept: ['moonsec_v3', 'moonsec_v1'],
  },
  {
    cmd: 'ms2', name: 'MoonSec V2',
    blurb: 'Deobfuscate Any Moonsec V2 File/URL',
    slash: 'Deobfuscate Any Moonsec V2 File/URL',
    serviceId: 'moonsec_v2', accept: ['moonsec_v2', 'moonsec_v1'],
  },
  {
    cmd: 'lph', name: 'Luraph',
    blurb: 'Deobfuscate Any Luraph V15, V14.7, V14.8, And V14.9 File/URL',
    slash: 'Deobfuscate Any Luraph V15, V14.7, V14.8 And V14.9 File/URL',
    serviceId: 'luraph', accept: ['luraph'],
  },
  {
    cmd: 'clyde', name: 'Clyde',
    blurb: 'Deobfuscate Clyde',
    slash: 'Deobfuscate Clyde files or URLs',
    serviceId: 'clyde',
  },
  {
    cmd: 'psu', name: 'PSU',
    blurb: 'PSU Deobfuscater',
    slash: 'PSU Deobfuscater — any PSU file/URL',
    serviceId: 'psu',
  },
  {
    cmd: 'ib2', name: 'IronBrew2',
    blurb: 'Deobfuscate Any IronBrew2 File/URL',
    slash: 'Deobfuscate Any IronBrew2 File/URL',
    serviceId: 'ironbrew2', accept: ['ironbrew2', 'ironbrew1', 'ironbrew3'],
  },
  {
    cmd: 'hcs', name: 'Hercules',
    blurb: 'Deobfuscate Any Hercules File/URL',
    slash: 'Deobfuscate Any Hercules File/URL',
    serviceId: 'hercules',
  },
  {
    cmd: 'lo', name: 'LuaObfuscator',
    blurb: 'Deobfuscate Any File/URL From LuaObfuscator.com',
    slash: 'Deobfuscate Any File/URL From LuaObfuscator.com',
    serviceId: 'luaobfuscator_com',
  },
  {
    cmd: 'mv', name: 'MoonVeil',
    blurb: 'MoonVeil v1.4.5 And V2 Deobfuscator',
    slash: 'MoonVeil v1.4.5 And V2 Deobfuscator',
    serviceId: 'moonveil',
  },
  {
    cmd: 'iv', name: 'Ironveil',
    blurb: 'Ironveil V1 Deobfuscator',
    slash: 'Ironveil V1 Deobfuscator',
    serviceId: 'ironveil',
  },
  {
    cmd: '77', name: '77fuscator',
    blurb: '77fuscator Deobfuscator',
    slash: '77fuscator Deobfuscator',
    serviceId: '77fuscator',
  },
  {
    cmd: 'goofy', name: 'Goofyscator',
    blurb: 'Goofyscator V10+ Deobfuscator',
    slash: 'Goofyscator V10+ Deobfuscator',
    serviceId: 'goofyscator',
  },
  {
    cmd: 'luast', name: 'LuaST',
    blurb: 'luast.clv.cloud Levels 1–3 static deobfuscator',
    slash: 'luast.clv.cloud Levels 1-3 static deobfuscator',
    serviceId: 'luast',
  },
];

/** Exact per-command lines rendered by the supported-commands card. */
export function serviceCommandLines(prefix = '.') {
  return SERVICE_COMMANDS.map((s) => `\`${prefix}${s.cmd}\` — **${s.name}** (${s.blurb})`);
}

/** The exact usage line rendered by the supported-commands card. */
export function serviceUsageLine(prefix = '.') {
  return `Usage: ${prefix}<cmd> [raw URL] or attach a .lua / .txt file.`;
}

/**
 * Forced-service resolution rule.
 *
 * @param best    detectService().best — { service, score, confidence, … } | null
 * @param forced  { id, accept?, tag? } — the command's pin request
 * @returns the SERVICES descriptor to force, or null to keep auto-detection
 *   (when the detector positively identified an accepted sibling family).
 *
 * Rules:
 *   - no forced request → null (pure auto)
 *   - detector hit (score ≥ 45) on an ACCEPTED family → null (auto wins; this
 *     keeps MoonSec V1 under .ms3 and WeAreDevs under .prom truthful)
 *   - anything else (unknown, weak or foreign detection) → the forced family.
 *     An explicit command choice always beats the detector.
 */
export function resolveForced(best, forced) {
  if (!forced || !forced.id) return null;
  const accept = Array.isArray(forced.accept) && forced.accept.length ? forced.accept : [forced.id];
  if (best && best.service && best.score >= 45 && accept.includes(best.service.id)) return null;
  return serviceById(forced.id);
}
