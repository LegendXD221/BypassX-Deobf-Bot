/**
 * BypassX Deobf Bot — Discord reply builders (Components V2).
 *
 * Every reply is a Components V2 payload (MessageFlags.IsComponentsV2):
 *   • ContainerBuilder  — accent-colored card that hosts everything below
 *   • TextDisplayBuilder — markdown text
 *   • SectionBuilder    — text + thumbnail/button accessory
 *   • SeparatorBuilder  — divider
 *   • ActionRowBuilder  — link buttons (paste / raw / invite / repo)
 *   • FileBuilder       — inline attachment card (recovered code / binary)
 *
 * V2 budget: max 4000 text characters per message across all TextDisplays —
 * every text goes through clamp() to guarantee we never exceed it.
 */
import {
  MessageFlags, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
  SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, FileBuilder,
} from 'discord.js';
import { TIER, SERVICES } from './detect.js';

export const BRAND = {
  color: 0x7c3aed,
  ok: 0x22c55e,
  warn: 0xf59e0b,
  err: 0xef4444,
  name: 'BypassX Deobf',
};

const REPO_URL = 'https://github.com/LegendXD221/BypassX-Deobf-Bot';

// ---- low-level helpers ------------------------------------------------------

const T = (md) => new TextDisplayBuilder().setContent(clamp(md, 3900));
const SEP = () => new SeparatorBuilder().setSpacing(1).setDivider(true);

function clamp(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

function container(accent, build) {
  const c = new ContainerBuilder().setAccentColor(accent);
  build(c);
  return c;
}

function linkRow(defs) {
  const row = new ActionRowBuilder();
  for (const d of defs) {
    row.addComponents(
      new ButtonBuilder().setLabel(d.label).setStyle(ButtonStyle.Link).setURL(d.url),
    );
  }
  return row;
}

/** Wrap containers into a Components V2 message payload. */
export function v2(containers, { files = [], ephemeral = false } = {}) {
  const flags = MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0);
  return { components: containers, flags, files };
}

const TIER_LABEL = {
  [TIER.FULL]: '⬤ full recovery',
  [TIER.PARTIAL]: '◐ partial recovery',
  [TIER.DETECT]: '○ detect only',
};

export function confidenceBar(pct) {
  const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Brand header section (with bot avatar thumbnail when available). */
function brandHeader(c, title, subtitle, client) {
  const avatar = client?.user?.displayAvatarURL?.({ size: 128 });
  const text = `## ${title}\n-# ${subtitle}`;
  if (avatar) {
    c.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(T(text))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)),
    );
  } else {
    c.addTextDisplayComponents(T(text));
  }
}

function footerButtons(c, extra = []) {
  const defs = [
    ...extra,
    { label: 'GitHub', url: REPO_URL },
  ];
  c.addActionRowComponents(linkRow(defs));
}

// ---- help -------------------------------------------------------------------

export function helpReply(prefix, client) {
  const highlights = SERVICES.slice(0, 10).map((s) => s.name).join(' • ');
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🧩 BypassX Deobf — help',
      'Upload an obfuscated file — I return only the deobfuscated code. Auto-detects the obfuscator with a confidence %.', client);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      `**\`${prefix}deobf\`** — attach a file (or reply to a message with one) → pure deobfuscated code via Pastefy + attachment. Slash: \`/deobf file:\``,
      `**\`${prefix}detect\`** — identify the obfuscator + confidence %, no deobfuscation. Slash: \`/detect file:\``,
      `**\`${prefix}families\`** — every supported service, version range and recovery tier`,
      `**\`${prefix}ping\`** • **\`${prefix}invite\`** • **\`${prefix}help\`** — latency / invite / this panel`,
    ].join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      '**Supported (highlights)**',
      `${highlights} • …and ${Math.max(0, SERVICES.length - 10)} more — see \`${prefix}families\``,
    ].join('\n')));
    c.addTextDisplayComponents(T([
      '**How it works**',
      'Weighted signature detection → targeted family peel → generic auto pipeline → full family sweep → clean pure-code output. Samples are never executed (static analysis only, hardened spawn, RCE-protected).',
    ].join('\n')));
    footerButtons(c);
  });
  return v2([card]);
}

// ---- families ---------------------------------------------------------------

export function familiesReply(prefix) {
  const full = SERVICES.filter((s) => s.tier === TIER.FULL)
    .map((s) => `• **${s.name}** — ${clamp(s.versions, 90)}`);
  const partial = SERVICES.filter((s) => s.tier === TIER.PARTIAL)
    .map((s) => `• **${s.name}** — ${clamp(s.versions, 90)}`);
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🗂 Supported services',
      `${SERVICES.length} services • ⬤ full = devirtualized/unpacked • ◐ partial = best-effort pipeline`, null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(['**⬤ Full recovery**', ...full].join('\n')));
    if (partial.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T(['**◐ Partial recovery / best-effort**', ...partial].join('\n')));
    }
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Try it:** \`${prefix}deobf\` with your file attached — detection is automatic.`));
    footerButtons(c);
  });
  return v2([card]);
}

// ---- detection report -------------------------------------------------------

export function detectionReply(detected, meta, prefix) {
  const { sizeLabel, fileLabel } = meta || {};
  if (detected.id === 'unknown' || !detected.confidence) {
    const card = container(BRAND.warn, (c) => {
      c.addTextDisplayComponents(T('## 🔎 Detection report'));
      c.addTextDisplayComponents(T([
        '**No known obfuscator signature found.**',
        'It may be plain code, a custom/unknown obfuscator, or packed with an unsupported scheme.',
      ].join('\n')));
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        `**File:** ${clamp(fileLabel || '—', 60)}${sizeLabel ? ` • ${sizeLabel}` : ''} • language: ${detected.lang || '—'}`,
        `**Next step:** run \`${prefix}deobf\` on the same file — the auto pipeline handles unknown formats.`,
      ].join('\n')));
      footerButtons(c);
    });
    return v2([card]);
  }

  const pct = detected.confidence;
  const card = container(BRAND.color, (c) => {
    c.addTextDisplayComponents(T('## 🔎 Detection report'));
    c.addTextDisplayComponents(T([
      `**${detected.name}${detected.version ? ` ${detected.version}` : ''}**`,
      `\`${confidenceBar(pct)}\` **${pct}%** confidence`,
    ].join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      `**Recovery tier:** ${TIER_LABEL[detected.tier] || '◐ partial recovery'}`,
      `**Language:** ${detected.lang || '—'} • **File:** ${clamp(fileLabel || '—', 40)}${sizeLabel ? ` • ${sizeLabel}` : ''}`,
    ].join('\n')));
    if (detected.evidence?.length) {
      c.addTextDisplayComponents(T([
        '**Evidence**',
        ...detected.evidence.map((x) => `• ${x}`),
      ].join('\n')));
    }
    const others = (detected.candidates || []).slice(1, 4)
      .map((cc) => `• ${cc.name}${cc.version ? ` ${cc.version}` : ''} — ${cc.confidence}%`);
    if (others.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T(['**Also considered**', ...others].join('\n')));
    }
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Deobfuscate it:** \`${prefix}deobf\` on the same file → pure code via Pastefy.`));
    footerButtons(c);
  });
  return v2([card]);
}

// ---- success ----------------------------------------------------------------

export function successReply(result, paste, filename) {
  const d = result.detected || {};
  const files = [];
  const card = container(BRAND.ok, (c) => {
    c.addTextDisplayComponents(T('## ✅ Deobfuscation complete'));
    c.addTextDisplayComponents(T([
      `**Detected:** ${d.name || 'Unknown'}${d.version ? ` ${d.version}` : ''} — **${d.confidence ?? 0}%** confidence`,
      `**Tier:** ${TIER_LABEL[d.tier] || '◐ partial recovery'}`,
      result.partialNote ? `\n-# ${clamp(result.partialNote, 380)}` : '',
    ].filter(Boolean).join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      `**Pipeline:** ${clamp((result.stages || []).map((s) => s.name).join(' → ') || 'engine', 400)}`,
      `**Size:** ${fmtBytes(result.originalSize)} → ${fmtBytes(result.recoveredSize)} • **Time:** ${((result.durationMs || 0) / 1000).toFixed(1)}s • **Engine:** ${result.engine?.version || 'core'}`,
      `**Input:** ${clamp(filename || result.codeName || 'file', 60)}`,
    ].join('\n')));

    if (result.binaryOutput) {
      files.push(new AttachmentBuilder(result.outputBuffer, { name: result.codeName || 'unpacked.bin' }));
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T('**📦 Unpacked binary** attached below — text pastes cannot carry executables.'));
      c.addFileComponents(new FileBuilder().setURL(`attachment://${result.codeName || 'unpacked.bin'}`));
    } else if (result.code) {
      if (paste) {
        c.addActionRowComponents(linkRow([
          { label: '🧾 Open paste', url: paste.url },
          { label: 'Raw', url: paste.rawUrl },
        ]));
      }
      const preview = result.code.length <= 1000
        ? result.code
        : `${result.code.slice(0, 800)}\n… (${result.code.length - 800} more chars in the paste)`;
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T(`**Preview**${result.code.length > 1000 ? ' (truncated)' : ''}\n\`\`\`\n${clamp(preview, 1600)}\n\`\`\``));
      const outName = result.codeName || 'deobfuscated.lua';
      files.push(new AttachmentBuilder(Buffer.from(result.code, 'utf8'), { name: outName }));
      c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
      if (!paste) {
        c.addTextDisplayComponents(T('-# ⚠️ Pastefy upload failed — the full code is delivered as the attached file instead.'));
      }
    }
  });
  return v2([card], { files });
}

// ---- failure ----------------------------------------------------------------

export function failureReply(result, prefix) {
  const d = result?.detected || {};
  const card = container(BRAND.warn, (c) => {
    c.addTextDisplayComponents(T('## ⚠️ Could not deobfuscate'));
    c.addTextDisplayComponents(T([
      `**Detected:** ${d.name || 'Unknown'}${d.version ? ` ${d.version}` : ''}${d.confidence ? ` (${d.confidence}%)` : ''}`,
      '',
      result?.note || 'The engine recovered no code from this sample.',
    ].join('\n')));
    if (result?.stages?.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        '**Stages tried**',
        ...result.stages.map((s) => `• ${s.name}${s.detail ? ` — ${clamp(s.detail, 100)}` : ''}`),
      ].join('\n')));
    }
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      '**What helps**',
      `• Make sure the file is the obfuscated output (not a screenshot or archive wrapper).`,
      `• Check \`${prefix}detect\` on the same file for what I recognized.`,
      `• Very fresh obfuscator builds can ship new schemes — recovery tiers are listed in \`${prefix}families\`.`,
    ].join('\n')));
    footerButtons(c);
  });
  return v2([card]);
}

// ---- errors / small replies -------------------------------------------------

export function errorReply(title, message, { ephemeral = false } = {}) {
  const card = container(BRAND.err, (c) => {
    c.addTextDisplayComponents(T(`## ❌ ${clamp(title, 100)}`));
    c.addTextDisplayComponents(T(clamp(message, 1500)));
  });
  return v2([card], { ephemeral });
}

export function cooldownReply(remainingMs) {
  const card = container(BRAND.warn, (c) => {
    c.addTextDisplayComponents(T(`## 🕐 Slow down\nTry again in **${Math.ceil(remainingMs / 1000)}s**.`));
  });
  return v2([card], { ephemeral: true });
}

export function pongReply({ wsPing, uptimeS, engine, version, guilds }) {
  const card = container(BRAND.ok, (c) => {
    c.addTextDisplayComponents(T('## 🏓 Pong'));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      `**Gateway:** ${Math.round(wsPing || 0)}ms • **Uptime:** ${fmtUptime(uptimeS || 0)}`,
      `**Engine:** ${engine?.available ? engine.version : 'preparing…'} • **Bot:** v${version || '1.0.0'}`,
      guilds != null ? `**Servers:** ${guilds}` : null,
    ].filter(Boolean).join('\n')));
  });
  return v2([card]);
}

export function inviteReply(url) {
  const card = container(BRAND.color, (c) => {
    c.addTextDisplayComponents(T([
      '## ➕ Add BypassX Deobf to your server',
      'Press the button below — the bot needs Send Messages, Attach Files and Read Message History permissions.',
    ].join('\n')));
    c.addActionRowComponents(linkRow([{ label: 'Invite BypassX Deobf', url }]));
  });
  return v2([card]);
}

export { fmtBytes };
