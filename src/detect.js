/**
 * BypassX Deobf Bot — obfuscator / packer auto-detection with confidence %.
 *
 * Detection model: every service has weighted byte-level indicators. We scan
 * the first 256 KB (plus the last 64 KB — some obfuscators put their banner
 * at the end) and sum matched indicator weights per service. The winner is
 * the highest score; confidence blends absolute evidence strength with the
 * gap to the runner-up, so a version-header hit reads 90–99% while a single
 * weak heuristic reads 35–60%.
 *
 * Version extraction: indicators with `version: N` lift capture group N out
 * of the match (e.g. `Luraph Obfuscator v15.1` → version "v15.1").
 *
 * Sources calibrated against the public sample corpus
 * (terrorlua/obfuscator-samples: MoonVeil 1.x–2.0.26, 77fuscator 0.4.7–0.6.1,
 * Luraph v1–v15.1, MoonSec V2/V3, IronBrew 1/2/3, PSU, Boronide, Hercules,
 * Prometheus, SynapseXen, wYnFuscate) plus engine signature tables.
 */

export const TIER = {
  FULL: 'full',       // full devirtualization / unpacking
  PARTIAL: 'partial', // meaningful recovery, some constructs may remain
  DETECT: 'detect',   // detection only
};

export const SERVICES = [
  // ---- Lua VM obfuscators (engine-backed) ------------------------------------
  {
    id: 'luraph', name: 'Luraph', lang: 'lua', tier: TIER.FULL, engineFamily: 'luraph',
    versions: 'v11 → v15.1 (wire toolkit; older versions auto-detected too)',
    indicators: [
      { re: /protected using Luraph Obfuscator v?([\d.]+)/i, weight: 60, version: 1, label: 'Luraph version header' },
      { re: /\bLPH_(?:ENCSTR|ENCFUNC|CRASH|JIT|NOJIT|STR|VM)\b/, weight: 45, label: 'LPH_* VM macros' },
      { re: /lura\.ph/i, weight: 30, label: 'lura.ph domain reference' },
      { re: /--\s*Luraph/i, weight: 20, label: 'Luraph comment' },
    ],
  },
  {
    id: 'moonsec_v3', name: 'MoonSec V3', lang: 'lua', tier: TIER.FULL, engineFamily: 'moonsec-v3',
    versions: 'V3 (static-key builds fully; escrow/runtime-key builds report an honest wall)',
    indicators: [
      { re: /protected with MoonSec\s*V?3/i, weight: 60, label: 'MoonSec V3 header' },
      { re: /\bMoonSec\s*V3\b|\bMoonSecV3\b|\bMOSV3\b/i, weight: 40, label: 'MoonSec V3 token' },
      { re: /\bmoonsec_v3\b/i, weight: 45, label: 'moonsec_v3 token' },
      { re: /\bmoonsec\b/i, weight: 10, label: 'moonsec mention' },
    ],
  },
  {
    id: 'moonsec_v2', name: 'MoonSec V2', lang: 'lua', tier: TIER.FULL, engineFamily: 'moonsec-v2',
    versions: 'V2 (static-key builds fully; escrow/runtime-key builds report an honest wall)',
    indicators: [
      { re: /Protected_by_MoonSecV2|protected with MoonSec\s*V?2\b/i, weight: 60, label: 'MoonSec V2 header' },
      { re: /\bMoonSecV2\b|\bMOSV2\b/i, weight: 40, label: 'MoonSec V2 token' },
      { re: /\bmoonsec_v2\b/i, weight: 45, label: 'moonsec_v2 token' },
      { re: /--[[-]\s*MoonSec\b/i, weight: 25, label: 'MoonSec banner' },
    ],
  },
  {
    id: 'moonsec_v1', name: 'MoonSec V1', lang: 'lua', tier: TIER.FULL, engineFamily: 'moonsec-v1',
    versions: 'legacy V1 builds',
    indicators: [
      { re: /protected with MoonSec(?! V?[23])/i, weight: 55, label: 'MoonSec header (V1)' },
      { re: /--[[-]\s*MoonSec\b/i, weight: 25, label: 'MoonSec banner' },
    ],
  },
  {
    id: 'ironbrew2', name: 'IronBrew 2', lang: 'lua', tier: TIER.FULL, engineFamily: 'ironbrew2',
    versions: 'latest IronBrew2',
    indicators: [
      { re: /obfuscated by ironbrew/i, weight: 60, label: 'IronBrew2 header' },
      { re: /\bib2_[a-z]/, weight: 45, label: 'ib2_* tokens' },
      { re: /\bIronBrew\s*2\b|\bIronbrew2\b/i, weight: 40, label: 'IronBrew2 name' },
    ],
  },
  {
    id: 'ironbrew1', name: 'IronBrew 1 / Aztup Brew', lang: 'lua', tier: TIER.PARTIAL, engineFamily: 'aztup-brew',
    versions: 'classic IronBrew / Aztup Brew lineage',
    indicators: [
      { re: /\bAztup\s*Brew\b|\baztupbrew\b/i, weight: 55, label: 'Aztup Brew name' },
      { re: /\bIronBrew\b(?!2|3)/i, weight: 40, label: 'IronBrew (classic)' },
    ],
  },
  {
    id: 'ironbrew3', name: 'IronBrew 3', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'IronBrew3 (VM lineage continues)',
    indicators: [
      { re: /\bIronBrew\s*3\b|\bIronbrew3\b|\bib3_[a-z]/i, weight: 55, label: 'IronBrew3 markers' },
    ],
  },
  {
    id: 'prometheus', name: 'Prometheus', lang: 'lua', tier: TIER.FULL, engineFamily: 'prometheus',
    versions: 'latest (incl. VMify pipeline)',
    indicators: [
      { re: /--[[-]\s*Prometheus|obfuscated using Prometheus|by Prometheus obfuscator/i, weight: 55, label: 'Prometheus header' },
      { re: /return\(function\((?:\w,){8,}/, weight: 40, label: 'Prometheus VMify wrapper shape' },
      { re: /__len\s*=\s*function\(\)\s*return\s*-\d+/, weight: 35, label: 'VM antitamper sentinel' },
      { re: /\bPrometheus\b.{0,40}\bVMify\b|\bVMify\b/i, weight: 45, label: 'Prometheus VMify pipeline', version: null },
      { re: /\bPrometheus\b/i, weight: 20, label: 'Prometheus mention' },
    ],
  },
  {
    id: 'hercules', name: 'Hercules', lang: 'lua', tier: TIER.FULL, engineFamily: 'hercules',
    versions: 'V2.x (latest)',
    indicators: [
      { re: /--[[-]\s*Hercules|protected by Hercules|Hercules\s*V?\d\.\d/i, weight: 55, label: 'Hercules header' },
      { re: /\bHERCULES\b|\bHercules\b/i, weight: 20, label: 'Hercules mention' },
    ],
  },
  {
    id: 'psu', name: 'PSU (Play raw script Units)', lang: 'lua', tier: TIER.PARTIAL, engineFamily: 'psu',
    versions: 'PSU pipeline',
    indicators: [
      { re: /\bPSU[_A-Z]{2,}\b|--\s*PSU\b|\bpsu\.js\b/i, weight: 45, label: 'PSU markers' },
    ],
  },
  {
    id: 'boronide', name: 'Boronide', lang: 'lua', tier: TIER.PARTIAL, engineFamily: 'boronide',
    versions: 'latest',
    indicators: [
      { re: /\bBoronide\b/i, weight: 50, label: 'Boronide name' },
    ],
  },
  {
    id: 'darksec', name: 'DarkSec', lang: 'lua', tier: TIER.PARTIAL, engineFamily: 'dark-sec',
    versions: 'latest',
    indicators: [
      { re: /\bDarkSec\b/i, weight: 50, label: 'DarkSec name' },
    ],
  },
  {
    id: 'luaobfuscator_com', name: 'luaobfuscator.com', lang: 'lua', tier: TIER.PARTIAL, engineFamily: 'luaobfuscator-com',
    versions: 'latest online obfuscator',
    indicators: [
      { re: /luaobfuscator\.com/i, weight: 55, label: 'luaobfuscator.com domain' },
      { re: /--[[-]\s*LuaObfuscator\b/i, weight: 35, label: 'LuaObfuscator banner' },
    ],
  },
  {
    id: 'wearedevs', name: 'WeAreDevs', lang: 'lua', tier: TIER.PARTIAL, engineFamily: 'wearedevs',
    versions: 'latest LuaU wrapper',
    indicators: [
      { re: /\bWeAreDevs\b/i, weight: 50, label: 'WeAreDevs name' },
    ],
  },

  // ---- Lua obfuscators not yet engine-native (best-effort pipeline) ----------
  {
    id: 'moonveil', name: 'MoonVeil', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'v1.x → v2.0.26 (latest)',
    indicators: [
      { re: /generated using MoonVeil v?([\d.]+)/i, weight: 60, version: 1, label: 'MoonVeil version header' },
      { re: /--[[-]\s*MoonVeil|moonveil\.cc/i, weight: 40, label: 'MoonVeil banner / domain' },
      { re: /\bMoonVeil\b/i, weight: 20, label: 'MoonVeil mention' },
    ],
  },
  {
    id: '77fuscator', name: '77fuscator', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'v0.4.7 → v0.6.1 (latest)',
    indicators: [
      { re: /\[\[77fuscator v?([\d.]+)/i, weight: 60, version: 1, label: '77fuscator version header' },
      { re: /\b77fuscator\b/i, weight: 40, label: '77fuscator name' },
    ],
  },
  {
    id: 'xhider', name: 'Xhider', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'latest (MoonSec-style VM)',
    indicators: [
      { re: /protected with XH?ider|XH?ider\s*(?:obfuscator|v?\d)/i, weight: 55, label: 'Xhider header' },
      { re: /\bxhider\b|\bxhider_[a-z]/i, weight: 35, label: 'xhider tokens' },
    ],
  },
  {
    id: 'goofyscator', name: 'GoofyScator', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'current public build (polymorphic VM)',
    indicators: [
      { re: /\bGoofyScator\b|\bgoofyscator\b|\bgoofyscat(?:e|ion)\b/i, weight: 55, label: 'GoofyScator markers' },
    ],
  },
  {
    id: 'ironveil', name: 'Ironveil', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'latest',
    indicators: [
      { re: /\bIronVeil\b|\bironveil_[a-z]/i, weight: 55, label: 'Ironveil markers' },
    ],
  },
  {
    id: '25ms', name: '25ms', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: '25ms-branded builds (often Luraph/77f internals — routed to VM peelers)',
    indicators: [
      { re: /\b25ms\b|discord\.gg\/25ms/i, weight: 50, label: '25ms branding' },
    ],
  },
  {
    id: 'synapsexen', name: 'Synapse Xen', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'classic Xen builds',
    indicators: [
      { re: /\bSynapse\s*Xen\b|\bSynX_[A-Za-z]/i, weight: 55, label: 'Synapse Xen markers' },
    ],
  },
  {
    id: 'wynfuscate', name: 'wYnFuscate', lang: 'lua', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'latest',
    indicators: [
      { re: /\bwYnFuscate\b|\bwynfuscate\b/i, weight: 55, label: 'wYnFuscate markers' },
    ],
  },

  // ---- JavaScript ------------------------------------------------------------
  {
    id: 'obfuscator_io', name: 'obfuscator.io', lang: 'js', tier: TIER.FULL, engineFamily: null,
    versions: 'v4.x (latest, incl. string-array RC4 / self-defending)',
    indicators: [
      { re: /\b_0x[a-f0-9]{4,}\b/g, weight: 0, label: null }, // counted separately below
      { re: /parseInt\(_0x[0-9a-f]+\(/i, weight: 45, label: 'obfuscator.io string-array rotate' },
      { re: /\ba0_0x[0-9a-f]+\b/, weight: 40, label: 'a0_0x string-array prefix' },
      { re: /while\s*\(\s*!!\[\]\s*\)|while\s*\(\s*--\[\]\s*\)|while\s*\(\s*true\s*\)\s*\{?\s*(?:switch|const|var)/i, weight: 30, label: 'control-flow switcher' },
      { re: /(?:debugger|debuggerProtection|self.?protect)/i, weight: 15, label: 'self-defending markers' },
    ],
    extra: 'count_0x',
  },
  {
    id: 'js_generic', name: 'Generic JS obfuscation', lang: 'js', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'eval/packer/jsfuck-style chains',
    indicators: [
      { re: /\beval\s*\(\s*(?:function|atob|unescape|String)/, weight: 35, label: 'eval-wrapped payload' },
      { re: /\bATsx|p,a,c,k,e,d\b|eval\(function\(p,a,c,k,e/, weight: 45, label: 'packer (p,a,c,k,e,d)' },
      { re: /\bJSFuck\b|\[\]\[[\+"=\]\[(){}\s]{20,}\]\(/, weight: 40, label: 'JSFuck-style' },
    ],
  },

  // ---- Python ----------------------------------------------------------------
  {
    id: 'pyarmor', name: 'pyArmor', lang: 'python', tier: TIER.FULL, engineFamily: null,
    versions: 'v6 / v7 / v8 / v9-pro (static unpack)',
    indicators: [
      { re: /__pyarmor__\s*\(/, weight: 60, label: '__pyarmor__ call' },
      { re: /pyarmor(?:_runtime|\.bootstrap|__)|PyArmor/i, weight: 45, label: 'pyarmor runtime markers' },
      { re: /# PyArmor|\bpyarmor\b/i, weight: 25, label: 'pyarmor mention' },
    ],
  },

  // ---- Native binaries -------------------------------------------------------
  {
    id: 'upx', name: 'UPX', lang: 'binary', tier: TIER.FULL, engineFamily: null,
    versions: 'UPX 3.x/4.x/5.x (all classic sections)',
    indicators: [
      { re: /UPX!/, weight: 65, label: 'UPX! magic' },
      { re: /\bUPX\d?\b.*packed|Info:\s*This file is packed/i, weight: 40, label: 'UPX pack info' },
    ],
  },
  {
    id: 'native_generic', name: 'Packed native binary', lang: 'binary', tier: TIER.PARTIAL, engineFamily: null,
    versions: 'MPRESS / NSPack / FSG / kkrunchy / mew / custom PE-ELF packers',
    indicators: [
      { re: /MPRESS1|MPRESS2/, weight: 55, label: 'MPRESS section' },
      { re: /\.nsp0|NSPack/, weight: 45, label: 'NSPack section' },
      { re: /FSG!/, weight: 45, label: 'FSG magic' },
      { re: /kkrunchy/, weight: 45, label: 'kkrunchy marker' },
    ],
    extra: 'needs_magic_check',
  },
];

// Indicator that needs a count rather than a boolean match (obfuscator.io's
// `_0x` identifier flood is the single strongest JS signal).
const COUNT_0X_RE = /_0x[0-9a-f]{4,}\b/g;

/**
 * Detect the obfuscator/packer of a buffer.
 * Returns { top, candidates, lang, version } where each candidate is
 * { service, score, confidence, evidence[], version }.
 */
export function detectService(buf) {
  const head = buf.subarray(0, 256 * 1024).toString('latin1').replace(/\0/g, '');
  const tail = buf.length > 256 * 1024 ? buf.subarray(buf.length - 64 * 1024).toString('latin1').replace(/\0/g, '') : '';
  const text = head + '\n' + tail;

  // binary magic checks
  const isPE = buf.length > 2 && buf[0] === 0x4d && buf[1] === 0x5a;
  const isELF = buf.length > 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  const binaryMagic = isPE || isELF;

  const results = [];
  for (const service of SERVICES) {
    let score = 0;
    const evidence = [];
    let version = null;

    for (const ind of service.indicators) {
      if (ind.label === null) continue; // placeholder row
      const m = text.match(ind.re);
      if (m) {
        score += ind.weight;
        evidence.push(ind.label);
        if (ind.version && m[ind.version]) version = `v${m[ind.version].replace(/^v/, '')}`;
      }
    }

    if (service.extra === 'count_0x') {
      const count = (text.match(COUNT_0X_RE) || []).length;
      if (count >= 50) { score += 55; evidence.push(`_0x identifier flood (${count})`); }
      else if (count >= 10) { score += 25; evidence.push(`_0x identifiers (${count})`); }
    }
    if (service.extra === 'needs_magic_check') {
      if (!binaryMagic) score = Math.max(0, score - 30);
      else score += 25;
    }

    // Binary-services sanity: UPX/native need a PE/ELF/Mach-O container,
    // unless the UPX! magic appears inside a payload dump.
    if (service.lang === 'binary' && !binaryMagic && service.id === 'upx') score = Math.round(score * 0.6);

    results.push({ service, score, evidence, version });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results[0];
  const second = results[1] || { score: 0 };
  const best = top.score > 0
    ? { ...top, confidence: confidenceFor(top.score, second.score) }
    : null;

  return {
    best,
    candidates: results
      .filter((r) => r.score > 0)
      .slice(0, 4)
      .map((r) => ({
        id: r.service.id,
        name: r.service.name,
        version: r.version,
        score: r.score,
        confidence: confidenceFor(r.score, r.score === top.score ? (results[1]?.score ?? 0) : top.score),
        tier: r.service.tier,
        evidence: r.evidence.slice(0, 3),
      })),
  };
}

function confidenceFor(s1, s2) {
  if (s1 <= 0) return 0;
  const headerHit = s1 >= 55;
  const sep = s2 > 0 ? (s1 - s2) / s1 : 1;
  let c = headerHit ? 90 + 9 * sep : Math.min(88, 30 + s1 * 0.9 + 20 * sep);
  return Math.max(35, Math.min(99, Math.round(c)));
}

/** Quick language guess used for handler routing when detection is weak. */
export function guessLanguage(buf) {
  const head = buf.subarray(0, 8192);
  if (buf[0] === 0x4d && buf[1] === 0x5a) return 'binary';
  if (buf[0] === 0x7f && buf[1] === 0x45) return 'binary';
  const text = head.toString('utf8').replace(/\0/g, '');
  if (/__pyarmor__|pyarmor/i.test(text)) return 'python';
  // Lua signals — `then`/`until`/`repeat` are Lua keywords JS never uses; VM
  // wrappers often open with setmetatable(function returns.
  const luaKeys = (text.match(/\b(?:then|until|elseif)\b/g) || []).length;
  if (luaKeys >= 2 || (/\b(?:local|function|return)\b/.test(text) && /\bend\b/.test(text))) return 'lua';
  if (/\b(?:function|const|let|var|=>)\b/.test(text) && /[{};]/.test(text)) return 'js';
  if (/\bimport\s+\w+|def\s+\w+\(|print\s*\(/.test(text)) return 'python';
  return 'unknown';
}

export function serviceById(id) {
  return SERVICES.find((s) => s.id === id) || null;
}
