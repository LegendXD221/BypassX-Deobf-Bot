/**
 * BypassX Deobf Bot — Discord reply builders (embeds).
 */
import { EmbedBuilder } from 'discord.js';
import { TIER, SERVICES } from './detect.js';

export const BRAND = {
  color: 0x7c3aed,
  footer: { text: 'BypassX Deobf — auto-detect • multi-stage engine • pure code output' },
};

const TIER_LABEL = {
  [TIER.FULL]: '⬤ full recovery',
  [TIER.PARTIAL]: '◐ partial recovery',
  [TIER.DETECT]: '○ detect only',
};

function baseEmbed(title) {
  return new EmbedBuilder().setColor(BRAND.color).setTitle(title).setFooter({ text: BRAND.footer.text }).setTimestamp();
}

export function helpEmbed(prefix) {
  const e = baseEmbed('🧩 BypassX Deobf — help')
    .setDescription(
      'Upload an obfuscated file and I return **only the deobfuscated code** (via Pastefy). ' +
      'Auto-detects the obfuscator and shows a confidence percentage.',
    )
    .addFields(
      { name: `${prefix}deobf`, value: 'Deobfuscate an attached file (or reply to a message containing one). Slash: `/deobf file:`', inline: false },
      { name: `${prefix}detect`, value: 'Identify the obfuscator + confidence % without deobfuscating. Slash: `/detect file:`', inline: false },
      { name: `${prefix}families`, value: 'List every supported service, version range and recovery tier.', inline: false },
      { name: `${prefix}ping • ${prefix}help`, value: 'Latency / this message.', inline: false },
      {
        name: 'Supported (highlights)',
        value: SERVICES.slice(0, 12).map((s) => `• **${s.name}** (${s.versions.split('(')[0].trim()})`).join('\n') + `\n…and ${Math.max(0, SERVICES.length - 12)} more — see ${prefix}families`,
      },
      { name: 'How it works', value: 'Weighted signature detection → targeted engine peel → generic auto pipeline → family sweep → clean pure-code output. Samples are never executed (static analysis only, hardened spawn).', inline: false },
    );
  return e;
}

export function familiesEmbed(prefix) {
  const e = baseEmbed('🗂 Supported services');
  const groups = {
    '⬤ Full recovery (devirtualized / unpacked)': SERVICES.filter((s) => s.tier === TIER.FULL),
    '◐ Partial recovery (best-effort pipeline)': SERVICES.filter((s) => s.tier === TIER.PARTIAL),
  };
  for (const [label, list] of Object.entries(groups)) {
    if (!list.length) continue;
    e.addFields({
      name: label,
      value: list.map((s) => `**${s.name}** — ${s.versions}`).join('\n').slice(0, 1024),
    });
  }
  e.addFields({ name: 'Try it', value: `${prefix}deobf with your file attached — detection is automatic.`, inline: false });
  return e;
}

export function detectionEmbed(prefix, detected, meta) {
  const { sizeLabel, fileLabel } = meta || {};
  const e = baseEmbed('🔎 Detection report');
  if (detected.id === 'unknown' || !detected.confidence) {
    e.setDescription('**No known obfuscator signature found.**\nIt may be plain code, a custom/unknown obfuscator, or packed with an unsupported scheme. I can still try a generic pipeline:').addFields(
      { name: 'Next step', value: `Run \`${prefix}deobf\` on the same file — the engine auto pipeline handles unknown formats.`, inline: false },
    );
    return e;
  }
  const pct = detected.confidence;
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  e.setDescription(`**${detected.name}${detected.version ? ` ${detected.version}` : ''}** — \`${bar}\` **${pct}%** confidence`)
    .addFields(
      { name: 'Recovery tier', value: TIER_LABEL[detected.tier] || '◐ partial recovery', inline: true },
      { name: 'Language', value: detected.lang || '—', inline: true },
      { name: 'File', value: fileLabel || '—', inline: true },
    );
  if (detected.evidence.length) {
    e.addFields({ name: 'Evidence', value: detected.evidence.map((x) => `• ${x}`).join('\n').slice(0, 1024), inline: false });
  }
  if (detected.candidates?.length > 1) {
    const others = detected.candidates.slice(1, 4)
      .map((c) => `• ${c.name}${c.version ? ` ${c.version}` : ''} — ${c.confidence}%`).join('\n');
    if (others) e.addFields({ name: 'Also considered', value: others, inline: false });
  }
  if (sizeLabel) e.addFields({ name: 'Size', value: sizeLabel, inline: true });
  e.addFields({ name: 'Deobfuscate it', value: `\`${prefix}deobf\` on the same file → pure code via Pastefy`, inline: false });
  return e;
}

export function successEmbed(prefix, result, paste) {
  const d = result.detected;
  const e = baseEmbed('✅ Deobfuscation complete')
    .setDescription(
      `**Detected:** ${d.name}${d.version ? ` ${d.version}` : ''} — **${d.confidence}%** confidence\n` +
      `**Tier:** ${TIER_LABEL[d.tier] || '◐ partial recovery'}`,
    )
    .addFields(
      { name: 'Pipeline', value: result.stages.map((s) => s.name).join(' → ').slice(0, 1000) || 'engine', inline: false },
      { name: 'Size', value: `${fmtBytes(result.originalSize)} → ${fmtBytes(result.recoveredSize)}`, inline: true },
      { name: 'Time', value: `${(result.durationMs / 1000).toFixed(1)}s`, inline: true },
      { name: 'Engine', value: result.engine?.version || 'core', inline: true },
    );
  if (paste) {
    e.addFields(
      { name: '🧾 Deobfuscated code (pure, nothing else)', value: `[Open paste](${paste.url}) • [raw](${paste.rawUrl})`, inline: false },
    );
  } else if (result.binaryOutput) {
    e.addFields({ name: '📦 Unpacked binary', value: 'Attached below — text pastes cannot carry executables.', inline: false });
  } else {
    e.addFields({ name: 'Output', value: 'Recovered code could not be uploaded to Pastefy (service down?) — try again shortly.', inline: false });
  }
  if (!result.binaryOutput && result.code && result.code.length <= 1200) {
    e.addFields({ name: 'Preview', value: `\`\`\`\n${result.code.slice(0, 900)}\n\`\`\``, inline: false });
  }
  return e;
}

export function failureEmbed(prefix, result) {
  const d = result?.detected || { name: 'Unknown', confidence: 0 };
  const e = baseEmbed('⚠️ Could not deobfuscate')
    .setDescription(
      `**Detected:** ${d.name}${d.version ? ` ${d.version}` : ''}${d.confidence ? ` (${d.confidence}%)` : ''}\n\n` +
      (result?.note || 'The engine recovered no code from this sample.'),
    )
    .addFields(
      { name: 'What helps', value: [
        '• Make sure the file is the obfuscated output (not a screenshot/archive wrapper).',
        `• Check \`${prefix}detect\` on the same file for what I recognized.`,
        '• Very fresh obfuscator builds can ship new schemes — recovery tiers are listed in the family table.',
      ].join('\n'), inline: false },
    );
  if (result?.stages?.length) e.addFields({ name: 'Stages tried', value: result.stages.map((s) => `${s.name}${s.detail ? ` — ${s.detail}` : ''}`).join('\n').slice(0, 1024), inline: false });
  return e;
}

export function errorEmbed(title, message) {
  return baseEmbed(`❌ ${title}`).setDescription(message);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
