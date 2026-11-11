/**
 * BypassX Deobf Bot — AntiTamper V2 orchestrator.
 *
 * Single entry point for the whole engine:
 *
 *   import * as antitamper from './antitamper/index.js';
 *
 *   antitamper.matchCatalog(src)        → vector hits (intelligence scan)
 *   antitamper.isExecutorGated(src)     → should the run escalate?
 *   antitamper.neutralize(src)          → static defuse + report
 *   antitamper.harden(profile)          → Lua env layer + feature list
 *   antitamper.executorLadder(ids)      → pre-rendered escalation layers
 *   antitamper.audit()                  → behavioral sanity gate (all profiles)
 *   antitamper.defuseSummary(report)    → human-readable line for bot replies
 *
 * The pipeline calls neutralize() once per job (static tier) and the VM-lift
 * worker consumes executorLadder() on misses (dynamic tier).
 */

export {
  CATALOG, CATALOG_SIZE, FAMILIES,
  entryById, matchCatalog, isExecutorGated, EXECUTOR_IDENTITIES,
} from './catalog.js';

export {
  PRODUCTION_LUA, executorLua, harden, executorLadder,
} from './env-hardening.js';

export { neutralize } from './neutralize.js';
export { audit, executorLayerAlive, probeCount } from './sanity.js';

import { CATALOG, matchCatalog } from './catalog.js';

/**
 * Human-readable "antitamper defeated" summary from a neutralize() report —
 * the exact line the bot can show in its reply stages.
 * @param {object} report neutralize().report
 * @returns {string}
 */
export function defuseSummary(report) {
  if (!report || !Array.isArray(report.edits) || report.edits.length === 0) return '';
  const parts = report.edits.map((e) => `${e.count}× ${labelOf(e.id)}`);
  const bytes = report.bytesSaved > 0 ? ` — ${report.bytesSaved} bytes of kill logic removed` : '';
  return `${report.edits.reduce((a, e) => a + e.count, 0)} anti-tamper vectors defused (${parts.join(', ')})${bytes}`;
}

function labelOf(id) {
  switch (id) {
    case 'lph-precheck': return 'LPH_PRECHECK validator emptied';
    case 'lph-crash': return 'LPH_CRASH kill switch stripped';
    case 'ks-error-gate': return 'fingerprint kill gate removed';
    case 'ks-while-true': return 'spin bomb removed';
    case 'ks-pcall-suicide': return 'suicide thread defused';
    case 'ks-os-exit': return 'os.exit gate removed';
    case 'ks-crash-func': return 'crash helper call defused';
    default: return id;
  }
}

/**
 * Full pre-run intelligence brief for a sample — what the catalog sees,
 * what the static tier will do, whether escalation is expected.
 * @param {string} source
 * @returns {{hits: number, top: Array<{id,name,severity}> , gated: boolean, severity: number}}
 */
export function brief(source) {
  const hits = matchCatalog(source);
  const severity = hits.reduce((m, h) => Math.max(m, h.severity), 0);
  return {
    hits: hits.length,
    top: hits.slice(0, 5).map((h) => ({ id: h.id, name: h.name, severity: h.severity })),
    gated: hits.some((h) => h.counter === 'escalate'),
    severity,
  };
}

/** Version of the AntiTamper engine (mirrors the bot release). */
export const ANTITAMPER_VERSION = '2.0.0';
export const CATALOG_FAMILIES = [...new Set(CATALOG.map((e) => e.family))];
