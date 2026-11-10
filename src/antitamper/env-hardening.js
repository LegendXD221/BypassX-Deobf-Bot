/**
 * BypassX Deobf Bot — AntiTamper Environment Hardening (v2.15.0).
 *
 * Per-service PROFILES that extend the shared jail prelude. The shared
 * PRELUDE (src/jail-prelude.js) is the byte-identical base every worker
 * installs; extensions are APPENDED after it per-run — the shared string is
 * never edited, so the regression floor in test/env-sanity.js keeps holding.
 *
 * A profile is what makes a specific obfuscator's anti-tamper take the CLEAN
 * path inside our jail:
 *   • identity: what executor-shaped surface the family expects (most
 *     whitelists only run their payload under known executors — we masquerade
 *     or stay nil depending on which path decrypts the payload)
 *   • lua: extra prelude lines (must be plain, pcall-safe Lua)
 *   • notes: human-readable summary surfaced in bot stages
 *
 * Default policy: NO extension for unknown families — the base prelude is
 * already the A/B-verified shape; extensions are opt-in per family only when
 * a verified exploit demands it.
 */

const IDENTIFY_NIL = ''; // default: keep executor identity reads nil (production shape)

/**
 * Per-family profiles. `lua` strings are appended verbatim after PRELUDE.
 * Keep every line defensive: the jail must NEVER throw because an extension
 * assumed something the base prelude does not provide.
 */
export const PROFILES = {
  luraph: {
    label: 'Luraph v11→v15.1',
    identity: IDENTIFY_NIL,
    notes: [
      'LPH_* macros stripped pre-run by the neutralizer (LPH_CRASH/LPH_PRECHECK traps never fire).',
      'bit32 float-tolerance + buffer lib + string.char/rep float floor are load-bearing for v15 loaders.',
      'setfenv stays real-for-functions / erroring-for-C (skid detector parity).',
    ],
    lua: '',
  },
  tokrascript: {
    label: 'TokraScript (Luraph v14 numeric preset)',
    identity: IDENTIFY_NIL,
    notes: ['Same hardening surface as Luraph; numeric preset changes only the dispatch shape.'],
    lua: '',
  },
  moonsec_v1: {
    label: 'MoonSec V1',
    identity: IDENTIFY_NIL,
    notes: [
      'getfenv() returns the SAME table the sinks spy on — constant-pool reads stay coherent.',
      'setfenv(C-fn, {}) errors with the exact 5.1 message — the skid detector takes the clean path.',
    ],
    lua: '',
  },
  moonsec_v2: {
    label: 'MoonSec V2 (escrow)',
    identity: IDENTIFY_NIL,
    notes: [
      'math.ldexp/frexp bound (dispatcher init requirement).',
      'wait() returns advancing numbers; game.Loaded true — escrow yield-gates resolve instantly.',
      'Anti-dump probe surface (islclosure/getconstants/hookfunction/…) reads nil — no garbage keys.',
    ],
    lua: '',
  },
  moonsec_v3: {
    label: 'MoonSec V3 (escrow)',
    identity: IDENTIFY_NIL,
    notes: [
      'os.clock() ADVANCES ~10ms/call — the frozen-clock init deadlock (while os.clock()-t<X do end) cannot stall the pool.',
      'Escrow dispatcher runs with production-shaped env; 43-string class harvests stay reproducible.',
    ],
    lua: '',
  },
  ironbrew1: {
    label: 'IronBrew 1 / Aztup Brew',
    identity: IDENTIFY_NIL,
    notes: ['rawset/pcall real semantics; numeric setfenv(1, fenv) stays inert to protect probe slot indices.'],
    lua: '',
  },
  ironbrew2: {
    label: 'IronBrew 2',
    identity: IDENTIFY_NIL,
    notes: ['Same surface as IronBrew 1; env setup via setfenv(1, …) intentionally no-ops (Biggest-Scan A/B verified).'],
    lua: '',
  },
  ironbrew3: {
    label: 'IronBrew 3',
    identity: IDENTIFY_NIL,
    notes: ['Base production-shaped surface; VM walkers depend on real pcall shapes only.'],
    lua: '',
  },
  prometheus: {
    label: 'Prometheus',
    identity: IDENTIFY_NIL,
    notes: [
      'pc-flattened dispatch is undone by branch-comment devirtualization, not env tricks.',
      'Deep static pass inlines base64-pool literals at call sites (v2.13.0).',
    ],
    lua: '',
  },
  hercules: {
    label: 'Hercules',
    identity: IDENTIFY_NIL,
    notes: ['Static-first family; jail surface stays production-shaped.'],
    lua: '',
  },
  psu: {
    label: 'PSU / Play raw script Units',
    identity: IDENTIFY_NIL,
    notes: ['Decrypt-then-load staging: full source lands in _BX_CHUNKS at init (complete recovery path).'],
    lua: '',
  },
  boronide: { label: 'Boronide', identity: IDENTIFY_NIL, notes: ['Base surface; load()-stage capture applies.'], lua: '' },
  darksec: { label: 'DarkSec', identity: IDENTIFY_NIL, notes: ['Base surface; load()-stage capture applies.'], lua: '' },
  luaobfuscator_com: { label: 'luaobfuscator.com', identity: IDENTIFY_NIL, notes: ['Base surface.'], lua: '' },
  wearedevs: {
    label: 'WeAreDevs',
    identity: IDENTIFY_NIL,
    notes: [
      'Garbage globals (package/inf/…) are genuinely ABSENT keys — nil-ing paths behave.',
      'Arithmetic on inert objects returns neutral values instead of erroring.',
    ],
    lua: '',
  },
  moonveil: { label: 'MoonVeil', identity: IDENTIFY_NIL, notes: ['Base surface; full-VM builds fall back to pool + chunk capture.'], lua: '' },
  '77fuscator': { label: '77fuscator', identity: IDENTIFY_NIL, notes: ['Base surface; static peel + readability floor covers 0.6.x shapes.'], lua: '' },
  xhider: { label: 'Xhider', identity: IDENTIFY_NIL, notes: ['Base surface.'], lua: '' },
  goofyscator: { label: 'GoofyScator', identity: IDENTIFY_NIL, notes: ['Base surface.'], lua: '' },
  ironveil: { label: 'Ironveil', identity: IDENTIFY_NIL, notes: ['Base surface.'], lua: '' },
  '25ms': {
    label: '25ms',
    identity: IDENTIFY_NIL,
    notes: [
      'Anti-tamper inspects game/workspace/CFrame + task — the production-shaped inert DataModel forces the clean path.',
      'Concat-injection tier captures pool-table strings raw ".." misses (v2.10.0).',
    ],
    lua: '',
  },
  synapsexen: { label: 'Synapse Xen', identity: IDENTIFY_NIL, notes: ['Base surface.'], lua: '' },
  wynfuscate: { label: 'wYnFuscate', identity: IDENTIFY_NIL, notes: ['Same CFrame/task probe family as 25ms.'], lua: '' },
  clyde: { label: 'Clyde', identity: IDENTIFY_NIL, notes: ['Base surface; load()-stage capture applies.'], lua: '' },
  luast: { label: 'LuaST', identity: IDENTIFY_NIL, notes: ['Base surface.'], lua: '' },
  unknown: { label: 'Unknown / generic', identity: IDENTIFY_NIL, notes: ['No profile — base prelude only, extensions never guessed.'], lua: '' },
};

/** Build the Lua extension string for a family (never throws). */
export function buildProfileExtension(familyId) {
  try {
    const p = PROFILES[familyId];
    if (!p || typeof p.lua !== 'string' || !p.lua.trim()) return '';
    return p.lua;
  } catch {
    return '';
  }
}

/** Human summary for reports/replies. */
export function profileSummary(familyId) {
  const p = PROFILES[familyId];
  if (!p) {
    return { family: familyId, label: 'Unknown / generic', notes: ['No profile — base prelude only, extensions never guessed.'], identity: 'nil (production shape)' };
  }
  return {
    family: familyId,
    label: p.label,
    notes: p.notes,
    identity: p.identity === '' ? 'nil (production shape)' : p.identity,
  };
}

/** True when the family has a dedicated profile (vs the base-only default). */
export function hasProfile(familyId) {
  return Object.prototype.hasOwnProperty.call(PROFILES, familyId);
}
