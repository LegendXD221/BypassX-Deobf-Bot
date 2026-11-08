/**
 * BypassX Deobf Bot — Discord reply builders (Components V2).
 *
 * Design system (v1.3.0 "clean & professional"):
 *   Every card follows the same disciplined structure:
 *     1. HEADER   — `## Title` + one `-#` subtitle line (brand section w/ avatar)
 *     2. FACTS    — uniform `**Label** value` rows, nothing else mixed in
 *     3. CONTENT  — preview / steps / lists (only where they belong)
 *     4. ACTIONS  — functional buttons only (paste / raw / invite)
 *   Separators divide every zone; no scattered fragments, no GitHub links,
 *   one accent color per intent (violet brand / green ok / amber warn / red err).
 *
 * V2 budget: max 4000 text characters per message across all TextDisplays —
 * every text goes through clamp() to guarantee we never exceed it.
 */
import {
  MessageFlags, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
  SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, FileBuilder,
} from 'discord.js';
import { TIER, SERVICES } from './detect.js';
import { CONFIG } from './config.js';
import { prettyEngine } from './pretty.js';

export const BRAND = {
  color: 0x7c3aed,
  ok: 0x22c55e,
  warn: 0xf59e0b,
  err: 0xef4444,
  name: 'BypassX Deobf',
};

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

/** Uniform facts block — every row is `**Label** value`. */
function facts(c, rows) {
  const body = rows.filter(Boolean).map((r) => {
    const { label, value } = r;
    return `**${label}** ${value}`;
  }).join('\n');
  if (!body) return;
  c.addTextDisplayComponents(T(body));
}

// ---- help -------------------------------------------------------------------

export function helpReply(prefix, client) {
  const highlights = SERVICES.slice(0, 10).map((s) => s.name).join(' • ');
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🧩 BypassX Deobf — help',
      'Send an obfuscated file or a link — get back only the deobfuscated code, verified for syntax.', client);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      '**Deobfuscate**',
      `• **\`${prefix}deobf\`** \`<file | link>\` — full pipeline → pure code via Pastefy`,
      `• **\`${prefix}detect\`** \`<file | link>\` — obfuscator ID + confidence %, no deobfuscation`,
      `• **\`${prefix}families\`** — every supported service, versions and recovery tiers`,
      '',
      '**Utilities**',
      `• **\`${prefix}beautify\`** \`<file | link>\` — reformat messy/minified code, no deobfuscation`,
      `• **\`${prefix}strings\`** \`<file | link>\` — extract the string table for quick recon`,
      `• **\`${prefix}paste\`** \`<file | text>\` — upload any text/file to Pastefy`,
      `• **\`${prefix}stats\`** — success rate, jobs served, uptime and engine build`,
      `• **\`${prefix}history\`** — your last deobfuscation jobs`,
      '',
      '**Info**',
      `• **\`${prefix}ping\`** • **\`${prefix}invite\`** • **\`${prefix}help\`**`,
    ].join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Supported (highlights)**\n${highlights} • …and ${Math.max(0, SERVICES.length - 10)} more — see \`${prefix}families\``));
  });
  return v2([card]);
}

// ---- families ---------------------------------------------------------------

export function familiesReply(prefix) {
  const full = SERVICES.filter((s) => s.tier === TIER.FULL);
  const partial = SERVICES.filter((s) => s.tier === TIER.PARTIAL);
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🗂 Supported services',
      `${full.length} full-recovery • ${partial.length} best-effort • ${SERVICES.length} total`, null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      `**⬤ Full recovery (${full.length})**`,
      ...full.map((s) => `• **${s.name}** — ${clamp(s.versions, 90)}`),
    ].join('\n')));
    if (partial.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        `**◐ Partial recovery / best-effort (${partial.length})**`,
        ...partial.map((s) => `• **${s.name}** — ${clamp(s.versions, 90)}`),
      ].join('\n')));
    }
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Try it** \`${prefix}deobf\` with your file attached or a link — detection is automatic.`));
  });
  return v2([card]);
}

// ---- detection report -------------------------------------------------------

export function detectionReply(detected, meta, prefix) {
  const { sizeLabel, fileLabel } = meta || {};
  const sourceRow = meta?.sourceUrl
    ? `**Source** ${clamp(meta.sourceUrl, 120)}`
    : null;

  if (detected.id === 'unknown' || !detected.confidence) {
    const card = container(BRAND.warn, (c) => {
      brandHeader(c, '🔎 Detection report', 'No known obfuscator signature', null);
      c.addSeparatorComponents(SEP());
      facts(c, [
        { label: 'File', value: clamp(fileLabel || '—', 60) },
        { label: 'Size', value: sizeLabel || '—' },
        { label: 'Language', value: detected.lang || '—' },
        sourceRow,
      ]);
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        '**What this means**',
        'It may be plain code, a custom/unknown obfuscator, or packed with an unsupported scheme.',
        '',
        '**Next step**',
        `Run \`${prefix}deobf\` on the same file — the auto pipeline handles unknown formats.`,
      ].join('\n')));
    });
    return v2([card]);
  }

  const pct = detected.confidence;
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🔎 Detection report',
      `${detected.name}${detected.version ? ` ${detected.version}` : ''} — ${pct}% confidence`, null);
    c.addSeparatorComponents(SEP());
    facts(c, [
      { label: 'Confidence', value: `\`${confidenceBar(pct)}\` ${pct}%` },
      { label: 'Recovery tier', value: TIER_LABEL[detected.tier] || '◐ partial recovery' },
      { label: 'Language', value: detected.lang || '—' },
      { label: 'File', value: `${clamp(fileLabel || '—', 40)}${sizeLabel ? ` • ${sizeLabel}` : ''}` },
      sourceRow,
    ]);
    if (meta?.layers?.multi) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        '**🧅 Multi-layer obfuscation detected**',
        `${clamp(meta.layers.summary, 300)}`,
        '',
        `The deobf pipeline peels these one at a time — run \`${prefix}deobf\` and each layer is stripped until plain code remains.`,
      ].join('\n')));
    }
    if (detected.evidence?.length) {
      c.addSeparatorComponents(SEP());
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
    c.addTextDisplayComponents(T(`**Deobfuscate it** \`${prefix}deobf\` on the same file or link → pure code via Pastefy.`));
  });
  return v2([card]);
}

// ---- success ----------------------------------------------------------------

/** One verification badge line for the facts block. */
function verifiedFact(verification) {
  if (!verification) return null;
  if (verification.status === 'verified') {
    return { label: 'Verified', value: `✓ ${clamp(verification.detail, 120)}` };
  }
  if (verification.status === 'failed') {
    return { label: 'Verified', value: `⚠ syntax check failed — ${clamp(verification.detail, 120)}` };
  }
  return { label: 'Verified', value: `○ ${clamp(verification.detail || 'not verifiable', 120)}` };
}

export function successReply(result, paste, filename, sourceUrl, sourceNote) {
  const d = result.detected || {};
  const files = [];
  const card = container(BRAND.ok, (c) => {
    brandHeader(c, '✅ Deobfuscation complete',
      `${d.name || 'Unknown'}${d.version ? ` ${d.version}` : ''} — ${(result.stages || []).length} pipeline stages`, null);
    c.addSeparatorComponents(SEP());
    facts(c, [
      { label: 'Detected', value: `${d.name || 'Unknown'}${d.version ? ` ${d.version}` : ''} — **${d.confidence ?? 0}%** confidence` },
      { label: 'Recovery tier', value: TIER_LABEL[d.tier] || '◐ partial recovery' },
      result.layerSummary ? { label: (result.layers || []).length > 1 ? 'Layers peeled' : 'Layer stack', value: clamp(result.layerSummary, 180) } : null,
      result.readability ? { label: 'Readability', value: `**${result.readability.score}/100** — ${result.readability.grade}` } : null,
      verifiedFact(result.verification),
      { label: 'Size', value: `${fmtBytes(result.originalSize)} → ${fmtBytes(result.recoveredSize)} in ${((result.durationMs || 0) / 1000).toFixed(1)}s` },
      { label: 'Engine', value: result.engine?.version ? prettyEngine(result.engine.version) : 'core' },
      { label: 'Input', value: `${clamp(filename || result.codeName || 'file', 60)}${sourceUrl ? ' (link)' : ''}` },
      sourceUrl ? { label: 'Source', value: clamp(sourceUrl, 120) } : null,
    ]);
    if (result.partialNote) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T(`**Note** ${clamp(result.partialNote, 600)}`));
    }

    if (result.binaryOutput) {
      files.push(new AttachmentBuilder(result.outputBuffer, { name: result.codeName || 'unpacked.bin' }));
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T('**Unpacked binary** attached below — text pastes cannot carry executables.'));
      c.addFileComponents(new FileBuilder().setURL(`attachment://${result.codeName || 'unpacked.bin'}`));
    } else if (result.code) {
      c.addSeparatorComponents(SEP());
      // Actions: paste buttons first (multi-part supported), then preview + file.
      if (paste) {
        const parts = paste.parts || [];
        if (parts.length > 1) {
          const shown = parts.slice(0, 4).map((p) => ({ label: `Part ${p.index}/${p.of}`, url: p.url }));
          c.addActionRowComponents(linkRow([...shown, { label: 'Raw', url: paste.rawUrl }]));
          const rest = parts.slice(4).map((p) => `[Part ${p.index}](${p.url})`).join(' • ');
          if (rest) c.addTextDisplayComponents(T(`-# More parts: ${rest}`));
        } else {
          c.addActionRowComponents(linkRow([
            { label: '🧾 Open paste', url: paste.url },
            { label: 'Raw', url: paste.rawUrl },
          ]));
        }
      }
      const preview = result.code.length <= 1000
        ? result.code
        : `${result.code.slice(0, 800)}\n… (${result.code.length - 800} more chars in the paste)`;
      c.addTextDisplayComponents(T(`**Preview**${result.code.length > 1000 ? ' (truncated)' : ''}\n\`\`\`\n${clamp(preview, 1600)}\n\`\`\``));
      const outName = result.codeName || 'deobfuscated.lua';
      files.push(new AttachmentBuilder(Buffer.from(result.code, 'utf8'), { name: outName }));
      c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
      if (!paste) {
        c.addTextDisplayComponents(T('-# Pastefy upload failed — the full code is delivered as the attached file instead.'));
      }
    }
  });
  return v2([card], { files });
}

// ---- failure ----------------------------------------------------------------

export function failureReply(result, prefix) {
  const d = result?.detected || {};
  const card = container(BRAND.warn, (c) => {
    brandHeader(c, '⚠️ Could not deobfuscate',
      `${d.name || 'Unknown'}${d.version ? ` ${d.version}` : ''}${d.confidence ? ` — ${d.confidence}% confidence` : ''}`, null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(clamp(result?.note || 'The engine recovered no code from this sample.', 900)));
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
      `1. Make sure the file is the obfuscated output itself (not a screenshot or an archive wrapper).`,
      `2. Run \`${prefix}detect\` on the same file to see what I recognized.`,
      `3. Fresh obfuscator builds can ship new schemes — recovery tiers are in \`${prefix}families\`.`,
    ].join('\n')));
  });
  return v2([card]);
}

// ---- errors / small replies -------------------------------------------------

export function errorReply(title, message, { ephemeral = false } = {}) {
  const card = container(BRAND.err, (c) => {
    brandHeader(c, `❌ ${clamp(title, 100)}`, 'Action failed', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(clamp(message, 1500)));
  });
  return v2([card], { ephemeral });
}

export function cooldownReply(remainingMs) {
  const card = container(BRAND.warn, (c) => {
    brandHeader(c, '🕐 Slow down', 'Rate limit', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Try again** in **${Math.ceil(remainingMs / 1000)}s**.`));
  });
  return v2([card], { ephemeral: true });
}

export function pongReply({ wsPing, uptimeS, engine, version, guilds }) {
  const card = container(BRAND.ok, (c) => {
    brandHeader(c, '🏓 Pong', 'All systems nominal', null);
    c.addSeparatorComponents(SEP());
    facts(c, [
      { label: 'Gateway', value: `${Math.round(wsPing || 0)}ms` },
      { label: 'Uptime', value: fmtUptime(uptimeS || 0) },
      { label: 'Engine', value: engine?.available ? prettyEngine(engine.version) : 'preparing…' },
      { label: 'Bot', value: `v${version || '1.0.0'}` },
      guilds != null ? { label: 'Servers', value: String(guilds) } : null,
    ]);
  });
  return v2([card]);
}

export function inviteReply(url) {
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '➕ Add BypassX Deobf', 'One click — works everywhere', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T('**Permissions needed** Send Messages • Attach Files • Read Message History.'));
    c.addActionRowComponents(linkRow([{ label: 'Invite BypassX Deobf', url }]));
  });
  return v2([card]);
}

// ---- stats ------------------------------------------------------------------

export function statsReply({ version, uptimeS, engine, jobs, guilds, memoryMb, discordReady, pingMs, owner, dbInfo = null, allTime = null }) {
  const rate = jobs.total > 0 ? Math.round((jobs.ok / jobs.total) * 100) : null;
  const dbLine = dbInfo?.enabled
    ? `Neon • ${dbInfo.connected ? 'connected' : 'connecting…'}${allTime ? ` • ${allTime.ok}/${allTime.total} all-time` : ''}`
    : 'not configured';
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '📊 Bot statistics', `v${version} • ${discordReady ? 'gateway connected' : 'gateway connecting'}`, null);
    c.addSeparatorComponents(SEP());
    facts(c, [
      { label: 'Deobfuscations', value: `**${jobs.ok}** succeeded • ${jobs.fail} failed • ${jobs.total} total` },
      { label: 'Success rate', value: rate == null ? '— (no jobs yet)' : `${rate}%` },
      { label: 'Database', value: dbLine },
      { label: 'Uptime', value: fmtUptime(uptimeS) },
      { label: 'Engine', value: engine?.available ? prettyEngine(engine.version) : 'preparing…' },
      { label: 'Gateway ping', value: `${Math.round(pingMs || 0)}ms` },
      guilds != null ? { label: 'Servers', value: String(guilds) } : null,
      { label: 'Memory', value: `${(memoryMb || 0).toFixed(0)} MB` },
      owner ? { label: 'Owner', value: `<@${owner}>` } : null,
    ]);
  });
  return v2([card]);
}

// ---- owner ------------------------------------------------------------------

export function ownerOnlyReply(cmdName) {
  const card = container(BRAND.err, (c) => {
    brandHeader(c, '🔒 Owner only', 'Restricted command — attempt logged', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`\`${cmdName}\` is reserved for the bot owner.`));
    c.addTextDisplayComponents(T('-# This attempt has been recorded and reported.'));
  });
  return v2([card], { ephemeral: true });
}

/** Blacklist enforcement block. */
export function blockedReply(kind) {
  const card = container(BRAND.err, (c) => {
    brandHeader(c, '⛔ Access blocked', 'blacklisted', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`This ${kind} has been blocked from using the bot.`));
  });
  return v2([card], { ephemeral: true });
}

/** Per-guild controls set from the owner dashboard. */
export function guildOffReply(title, detail) {
  const card = container(BRAND.warn, (c) => {
    brandHeader(c, `🔇 ${clamp(title, 80)}`, 'disabled by the server owner', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(clamp(String(detail), 500)));
  });
  return v2([card], { ephemeral: true });
}

/** L2 pin rejections. */
export function pinReply({ locked, retryMs = 0, remaining = 0 }) {
  const card = container(BRAND.err, (c) => {
    brandHeader(c, locked ? '🔐 Locked out' : '🔐 PIN required', 'protection layer 2', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(locked
      ? `Too many wrong PIN attempts — locked for **${Math.ceil(retryMs / 60_000)} min**.`
      : `A valid **PIN** is required for dangerous commands (set \`OWNER_PIN\` in the dashboard).\n-# ${remaining} attempt(s) left before a 15-minute lockout.`));
  });
  return v2([card], { ephemeral: true });
}

/** L4 danger rate limit. */
export function dangerLimitedReply(reason) {
  const card = container(BRAND.warn, (c) => {
    brandHeader(c, '⏳ Dangerous command limited', 'protection layer 4', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(clamp(String(reason), 400)));
  });
  return v2([card], { ephemeral: true });
}

/** L3 confirm cancelled/timeout. */
export function cancelledReply() {
  const card = container(BRAND.warn, (c) => {
    brandHeader(c, '🚫 Cancelled', 'nothing was executed', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T('The dangerous action was **not** confirmed, so nothing happened.'));
  });
  return v2([card], { ephemeral: false });
}

/** .history — the user's recent deobf jobs from the Neon DB. */
export async function historyReply(userId) {
  const { describe, historyFor } = await import('./db.js');
  const d = describe();
  if (!d.enabled) {
    const card = container(BRAND.warn, (c) => {
      brandHeader(c, '🕘 History unavailable', 'database not configured', null);
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T('The owner has not connected a database yet, so job history is not stored.'));
    });
    return v2([card], { ephemeral: true });
  }
  const rows = await historyFor(userId, 10);
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🕘 Your last jobs', rows.length ? `${rows.length} deobfuscation(s)` : 'nothing yet', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(rows.length
      ? rows.map((r) => {
        const at = r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16) : '?';
        const fam = r.family || 'unknown';
        const pct = Number.isFinite(r.confidence) ? ` ${r.confidence}%` : '';
        const link = r.paste_url ? ` — [result](${r.paste_url})` : '';
        return `${r.success ? '✅' : '⚠️'} **${fam}**${pct} • ${at} UTC${link}`;
      }).join('\n')
      : `No jobs yet — run \`.deobf\` with an obfuscated file and it will show up here.`));
  });
  return v2([card], { ephemeral: true });
}

/** .owner panel — command list + live layer status. */
export function ownerPanelReply(prefix, { pinSet, db: dbInfo, danger }) {
  const rows = [
    '**Control**',
    `• **\`${prefix}eval\`** \`<code>\` — jailed JS sandbox (secret-free child)`,
    `• **\`${prefix}exec\`** \`<cmd>\` — host shell (90 s, auto-paste for long output)`,
    `• **\`${prefix}restart\`** / **\`${prefix}shutdown\`** — restart / stop the service`,
    '',
    '**Server + data**',
    `• **\`${prefix}db\`** \`<sql | status>\` — raw SQL on the Neon database`,
    `• **\`${prefix}blacklist\`** \`add|remove|list <id>\` — block abusive users/servers`,
    `• **\`${prefix}broadcast\`** \`<text>\` — message every server`,
    `• **\`${prefix}dm\`** \`<userId> <text>\` — direct-message a user`,
    '',
    '**Presence + ops**',
    `• **\`${prefix}activity\`** \`<type> <text>\` — change presence`,
    `• **\`${prefix}env\`** — environment variables (masked)`,
    `• **\`${prefix}owner audit\`** — recent audit trail`,
    `• **\`${prefix}servers\`** / **\`${prefix}leave\`** / **\`${prefix}logs\`** / **\`${prefix}setstatus\`**`,
  ];
  const layers = [
    `**L1 identity** — only <@${CONFIG.ownerId}>, exact id match`,
    `**L2 pin** — ${pinSet ? '🟢 armed (OWNER_PIN set — 3 fails = 15 min lock)' : '⚪ inactive (set OWNER_PIN to arm)'}`,
    '**L3 confirm** — danger commands need a single-use button (30 s)',
    `**L4 rate limit** — ${danger ? `${danger.capPerHour}/h • ${Math.round(danger.cooldownMs / 1000)} s cooldown • 1 at a time (used ${danger.usedThisHour})` : '—'}`,
    `**L5 audit** — ${dbInfo?.enabled ? `🟢 Neon DB (${dbInfo.connected ? 'connected' : 'connecting…'}) + DM alerts` : '🟡 console + DM alerts only (no DATABASE_URL)'}`,
  ];
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🛡 Owner control panel', 'dangerous commands — 5 protection layers', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(rows.join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(layers.join('\n')));
  });
  return v2([card], { ephemeral: true });
}

/** Owner tool output (eval / exec) — fenced, capped. */
export function ownerOutputReply({ title, ok = true, input, output, meta }) {
  const card = container(ok ? BRAND.color : BRAND.err, (c) => {
    brandHeader(c, `🛠 ${clamp(title, 80)}`, ok ? 'executed' : 'failed', null);
    if (input) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T(`**Input**\n\`\`\`\n${clamp(input, 900)}\n\`\`\``));
    }
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Output**\n\`\`\`\n${clamp(output || '(no output)', 1800)}\n\`\`\``));
    if (meta?.length) {
      c.addTextDisplayComponents(T(`-# ${meta.map(clamp).join(' • ')}`));
    }
  });
  return v2([card], { ephemeral: true });
}

export function logsReply(lines) {
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🧾 Recent logs', `${lines.length} lines (newest last)`, null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`\`\`\`\n${clamp(lines.join('\n') || '(no logs yet)', 3400)}\n\`\`\``));
  });
  return v2([card], { ephemeral: true });
}

export function serversReply(guilds) {
  const rows = guilds.map((g) => `• **${clamp(g.name, 40)}** — ${g.memberCount ?? '?'} members • \`${g.id}\``);
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🏠 Servers', `${guilds.length} guild(s)`, null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(clamp(rows.join('\n') || 'Not in any guild yet.', 3400)));
  });
  return v2([card], { ephemeral: true });
}

export function statusSetReply(text) {
  const card = container(BRAND.ok, (c) => {
    brandHeader(c, '✅ Presence updated', 'visible now', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Watching** ${clamp(text, 120)}`));
  });
  return v2([card], { ephemeral: true });
}

// ---- code tools (paste / beautify / strings) ---------------------------------

/**
 * Generic result card for the code utilities.
 * opts: { title, subtitle, accent, facts[], code, codeName, paste, note, files[] }
 */
export function codeToolReply({
  title, subtitle = 'done', accent = BRAND.color, factsRows = [],
  code = null, codeName = 'output.txt', paste = null, note = null, fileBuffer = null,
}) {
  const files = [];
  const card = container(accent, (c) => {
    brandHeader(c, title, subtitle, null);
    c.addSeparatorComponents(SEP());
    if (factsRows.length) facts(c, factsRows);
    if (note) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T(clamp(note, 700)));
    }
    if (code != null || fileBuffer) {
      c.addSeparatorComponents(SEP());
      if (paste) {
        const defs = [{ label: '🧾 Open paste', url: paste.url }, { label: 'Raw', url: paste.rawUrl }];
        c.addActionRowComponents(linkRow(defs));
      }
      if (code != null) {
        const preview = code.length <= 900 ? code : `${code.slice(0, 750)}\n… (${code.length - 750} more chars)`;
        c.addTextDisplayComponents(T(`**Preview**${code.length > 900 ? ' (truncated)' : ''}\n\`\`\`\n${clamp(preview, 1500)}\n\`\`\``));
        const name = codeName || 'output.txt';
        files.push(new AttachmentBuilder(Buffer.from(code, 'utf8'), { name }));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
      } else if (fileBuffer) {
        const name = codeName || 'output.bin';
        files.push(new AttachmentBuilder(fileBuffer, { name }));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
      }
      if (paste && code != null && paste.parts?.length > 1) {
        c.addTextDisplayComponents(T(`-# Large output delivered as ${paste.parts.length} paste parts.`));
      }
    }
  });
  return v2([card], { files });
}

export { fmtBytes };
