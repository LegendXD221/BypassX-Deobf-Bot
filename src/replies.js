/**
 * Lucid Deobf Bot — Discord reply builders (Components V2).
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
import { kindLabel } from './notable.js';
import { SERVICE_COMMANDS, serviceCommandLines, serviceUsageLine } from './service-catalog.js';
import { CONFIG } from './config.js';
import { prettyEngine } from './pretty.js';

export const BRAND = {
  color: 0x8b5cf6,
  info: 0x3b82f6,
  ok: 0x10b981,
  warn: 0xf59e0b,
  err: 0xf43f5e,
  name: 'Lucid Deobf',
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
  [TIER.FULL]: '🟢 Full Recovery',
  [TIER.PARTIAL]: '🟡 Partial Recovery',
  [TIER.DETECT]: '⚪ Detect Only',
};

export function confidenceBar(pct) {
  const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
}

function codeLangFromName(name) {
  const ext = String(name || '').toLowerCase();
  if (/\.(?:js|mjs|cjs|ts|jsx|tsx)$/.test(ext)) return 'js';
  if (/\.(?:py|pyw)$/.test(ext)) return 'py';
  if (/\.(?:lua|luau|glua|txt)$/.test(ext)) return 'lua';
  return '';
}

function attachOutputFile(c, files, buf, outName, paste, {
  noPasteNote = '-# Pastefy upload failed — full output is attached below.',
  overLimitPasteNote = '-# Output exceeds Discord 8 MB attachment limit — full output is in the Pastefy link above.',
  overLimitTruncNote = '-# Pastefy failed and output exceeded 8 MB — attached first 7.9 MB.',
} = {}) {
  const safeName = safeAttachmentName(outName, 'output.lua');
  if (buf.length <= MAX_DISCORD_ATTACHMENT) {
    files.push(new AttachmentBuilder(buf, { name: safeName }));
    c.addFileComponents(new FileBuilder().setURL(`attachment://${safeName}`));
    if (!paste && noPasteNote) c.addTextDisplayComponents(T(noPasteNote));
  } else if (paste) {
    if (overLimitPasteNote) c.addTextDisplayComponents(T(overLimitPasteNote));
  } else {
    files.push(new AttachmentBuilder(buf.subarray(0, SAFE_TRUNC_SLICE), { name: safeName }));
    c.addFileComponents(new FileBuilder().setURL(`attachment://${safeName}`));
    if (overLimitTruncNote) c.addTextDisplayComponents(T(overLimitTruncNote));
  }
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

/** Uniform facts block — crisp `▸ **Label** · value` rows. */
function facts(c, rows) {
  const body = rows.filter(Boolean).map((r) => {
    const { label, value } = r;
    return `▸ **${label}** · ${value}`;
  }).join('\n');
  if (!body) return;
  c.addTextDisplayComponents(T(body));
}

// ---- help -------------------------------------------------------------------

export function helpReply(prefix, client) {
  const highlights = SERVICES.slice(0, 10).map((s) => s.name).join(' • ');
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '⚡ Lucid Deobf — Command Center',
      'Send an obfuscated file or paste link — get clean, verified source code back.', client);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      '**🔓 Deobfuscation**',
      `▸ **\`${prefix}deobf\`** \`<file | link>\` — full multi-stage pipeline → pure code + Pastefy`,
      `▸ **\`${prefix}lph\` \`${prefix}ms3\` \`${prefix}ms2\` \`${prefix}l\` +${Math.max(0, SERVICE_COMMANDS.length - 4)} more** — targeted lifters (\`${prefix}families\`)`,
      `▸ **\`${prefix}detect\`** \`<file | link>\` — identify obfuscator + confidence score`,
      '',
      '**🛡️ Security & Recon**',
      `▸ **\`${prefix}scan\`** \`<file | link>\` — scan for webhooks, IP loggers, stealers & loaders`,
      `▸ **\`${prefix}strings\`** \`<file | link>\` — extract & classify notable string constants`,
      `▸ **\`${prefix}fetch\`** \`<link>\` — fetch raw script from any paste/repo URL`,
      '',
      '**🧰 Code Tools & Obfuscator**',
      `▸ **\`${prefix}beautify\`** / **\`${prefix}minify\`** \`<file | link>\` — reformat or compact Lua/JS`,
      `▸ **\`${prefix}obf\`** \`<file | link>\` — Xfuscator Lua packer (v1 / v2 / v2.1)`,
      `▸ **\`${prefix}paste\`** \`<file | text>\` — upload directly to Pastefy`,
      '',
      '**📊 Bot & Account**',
      `▸ **\`${prefix}stats\`** • **\`${prefix}history\`** • **\`${prefix}ping\`** • **\`${prefix}invite\`**`,
    ].join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**Supported Obfuscators** (${SERVICES.length} total)\n${highlights} • *see \`${prefix}families\`*`));
  });
  return v2([card]);
}

// ---- families / supported ---------------------------------------------------

/**
 * The supported-commands card — EXACT user-specified format: one line per
 * dedicated service command, then the usage line. Single source of truth is
 * src/service-catalog.js (the same table drives the command definitions).
 */
export function familiesReply(prefix) {
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🗂 Supported services',
      `${SERVICE_COMMANDS.length} dedicated commands — every service has its own`, null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(serviceCommandLines(prefix).join('\n')));
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**${serviceUsageLine(prefix)}**`));
    c.addTextDisplayComponents(T(`-# Auto-detect still works everywhere: \`${prefix}deobf\` / \`${prefix}detect\` with any file or link.`));
  });
  return v2([card]);
}

// ---- environment logger (.l) --------------------------------------------------

const LOGGER_VERDICTS = {
  source: {
    title: 'decrypted source captured at load()',
    detail: 'The script decrypted its REAL code and handed it to load()/loadstring() inside the dumper sandbox — the recording contains the complete original source. Run `.deobf` on the original file for the polished pipeline delivery.',
  },
  bytecode: {
    title: 'decrypted bytecode captured at load()',
    detail: 'The obfuscator compiled its payload and handed raw bytecode to load() — that chunk is in the recording. Run `.deobf` on the original to engage the full VM devirtualization chain.',
  },
  pool: {
    title: 'decrypted string pool recorded',
    detail: 'The VM decrypted its constant pool inside the sandbox — every recovered string is in the recording. The code itself stays behind the VM; `.deobf` engages behavioral lifting for that.',
  },
  clean: {
    title: 'script ran clean — nothing sensitive recorded',
    detail: 'The script executed in the dumper sandbox but recorded no chunks, pool or URLs — it may be plain code, or its payload needs an environment the offline jail does not fake. Run `.deobf` for the full pipeline, or run it in a live dumper environment and send the recorded output back here.',
  },
  norecord: {
    title: 'VM did not reach its payload',
    detail: 'The jailed run halted before the payload decrypted (anti-tamper or time-gate). This is exactly what the Environment Logger workflow is for: run the script in a live dumper tool, then send the recorded output back with `.deobf`.',
  },
};

/** .l card — the dumper recording summary + paste buttons + guidance. */
export function loggerReply(report, paste, filename, prefix, fileBuffer = null) {
  const files = [];
  const v = LOGGER_VERDICTS[report.verdict] || LOGGER_VERDICTS.norecord;
  const accent = report.verdict === 'source' || report.verdict === 'bytecode'
    ? BRAND.ok
    : report.verdict === 'pool' ? BRAND.color : BRAND.warn;
  const card = container(accent, (c) => {
    brandHeader(c, '🎚 Environment Logger — recording', v.title, null);
    c.addSeparatorComponents(SEP());
    facts(c, [
      { label: 'File', value: `${clamp(filename || 'input.lua', 60)}` },
      { label: 'Signature', value: report.signature || 'no known signature' },
      { label: 'VM run', value: report.ran ? 'completed inside the jailed dumper sandbox' : `halted early${report.runError ? ` — ${clamp(report.runError, 120)}` : ''}` },
      { label: 'load() chunks', value: `${report.counts.total} captured — ${report.counts.sources} source, ${report.counts.bytecode} bytecode, ${report.counts.data} data` },
      { label: 'Pool strings', value: `${report.strings.kept.length} decrypted${report.strings.dropped ? ` (${report.strings.dropped} noise fragments filtered)` : ''}` },
      { label: 'URLs seen', value: String(report.urls.length) },
      // v2.25.0 env logger V2: global-env access record + notable strings
      { label: 'Globals touched', value: `${report.env?.reads?.length || 0} read${report.env?.writes?.length ? ` · ${report.env.writes.length} written` : ''}${report.env?.readTotal ? ` (${report.env.readTotal} hits)` : ''}` },
      { label: 'Notable strings', value: report.notable?.length ? `${report.notable.length} flagged${report.notable.some((x) => x.kind === 'webhook' || x.kind === 'token') ? ' — ⚠️ credential/exfil markers' : ''}` : 'none flagged' },
    ]);
    if (report.notable?.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        '**Notable strings** (safety-relevant first)',
        ...report.notable.slice(0, 6).map((x) => `• \`${kindLabel(x.kind)}\` — ${clamp(x.s.replace(/\s+/g, ' '), 110)}`),
      ].join('\n')));
    }
    if (report.env?.reads?.length || report.env?.writes?.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        '**Global-env access**',
        report.env.reads.length ? `• reads: ${report.env.reads.slice(0, 8).map((r) => `\`${r.n}\``).join(', ')}` : null,
        report.env.writes.length ? `• writes: ${report.env.writes.slice(0, 8).map((w) => `\`${w.n}\``).join(', ')}` : null,
      ].filter(Boolean).join('\n')));
    }
    if (report.urls.length) {
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        '**URLs recorded**',
        ...report.urls.slice(0, 6).map((u) => `• ${clamp(u, 120)}`),
      ].join('\n')));
    }
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T(`**What this means** ${v.detail}`));
    if (paste) {
      c.addActionRowComponents(linkRow([
        { label: '🧾 Open recording', url: paste.url },
        { label: 'Raw', url: paste.rawUrl },
      ]));
    }
    if (fileBuffer) {
      const outName = 'environment-recording.lua';
      if (fileBuffer.length <= MAX_DISCORD_ATTACHMENT) {
        files.push(new AttachmentBuilder(fileBuffer, { name: outName }));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
        if (!paste) c.addTextDisplayComponents(T('-# Pastefy upload failed — the recording is delivered as the attached file instead.'));
      } else if (paste) {
        c.addTextDisplayComponents(T('-# Recording exceeds Discord 8 MB attachment limit — full dump is in the Pastefy link above.'));
      } else {
        files.push(new AttachmentBuilder(fileBuffer.subarray(0, SAFE_TRUNC_SLICE), { name: outName }));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
        c.addTextDisplayComponents(T('-# Pastefy failed and recording exceeded 8 MB — attached first 7.9 MB.'));
      }
    }
  });
  return v2([card], { files });
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

const MAX_DISCORD_ATTACHMENT = 8 * 1024 * 1024;
const SAFE_TRUNC_SLICE = 7_900_000;

/** Sanitize filename for Discord AttachmentBuilder + FileBuilder attachment:// URL validator. */
function safeAttachmentName(raw, fallback = 'output.lua') {
  const cleaned = String(raw || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** Total text characters across a ContainerBuilder's TextDisplayBuilder children. */
function v2TextBudgetLeft(c, maxTotal = 3700) {
  try {
    const j = c.toJSON();
    let used = 0;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      if (typeof n.content === 'string') used += n.content.length;
      if (Array.isArray(n.components)) walk(n.components);
    };
    walk(j.components);
    return Math.max(0, maxTotal - used);
  } catch {
    return 1400;
  }
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
      const binBuf = result.outputBuffer || Buffer.alloc(0);
      const outName = safeAttachmentName(result.codeName, 'unpacked.bin');
      if (binBuf.length <= MAX_DISCORD_ATTACHMENT) {
        files.push(new AttachmentBuilder(binBuf, { name: outName }));
        c.addSeparatorComponents(SEP());
        c.addTextDisplayComponents(T('**Unpacked binary** attached below — text pastes cannot carry executables.'));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
      } else {
        files.push(new AttachmentBuilder(binBuf.subarray(0, SAFE_TRUNC_SLICE), { name: outName }));
        c.addSeparatorComponents(SEP());
        c.addTextDisplayComponents(T(`**Unpacked binary** (${fmtBytes(binBuf.length)}) exceeded Discord's 8 MB upload limit — attached first 7.9 MB.`));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
      }
    } else if (result.code) {
      c.addSeparatorComponents(SEP());
      // Actions: paste buttons first (multi-part supported), then preview + file.
      if (paste) {
        const parts = paste.parts || [];
        if (parts.length > 1) {
          const shown = parts.slice(0, 4).map((p) => ({ label: `Part ${p.index}/${p.of}`, url: p.url }));
          c.addActionRowComponents(linkRow([...shown, { label: 'Raw', url: paste.rawUrl }]));
          const rest = parts.slice(4).map((p) => `[Part ${p.index}](${p.url})`).join(' • ');
          if (rest) c.addTextDisplayComponents(T(`-# More parts: ${clamp(rest, 350)}`));
        } else {
          c.addActionRowComponents(linkRow([
            { label: '🧾 Open paste', url: paste.url },
            { label: 'Raw', url: paste.rawUrl },
          ]));
        }
      }
      const budget = Math.max(220, Math.min(1600, v2TextBudgetLeft(c) - 180));
      const sliceLen = Math.max(160, budget - 80);
      const preview = result.code.length <= sliceLen
        ? result.code
        : `${result.code.slice(0, sliceLen)}\n… (${result.code.length - sliceLen} more chars${paste ? ' in the paste' : ''})`;
      const lang = codeLangFromName(result.codeName || filename);
      c.addTextDisplayComponents(T(`**Preview**${result.code.length > sliceLen ? ' *(truncated)*' : ''}\n\`\`\`${lang}\n${clamp(preview, budget)}\n\`\`\``));
      attachOutputFile(c, files, Buffer.from(result.code, 'utf8'), result.codeName || 'deobfuscated.lua', paste);
      c.addTextDisplayComponents(T('-# Tip: run `.scan` on recovered scripts to check for webhooks, IP loggers, or stealers.'));
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
    c.addTextDisplayComponents(T(clamp(result?.note || 'The engine recovered no code from this sample.', 700)));
    if (result?.stages?.length) {
      const recent = result.stages.slice(-8);
      const omitted = result.stages.length - recent.length;
      c.addSeparatorComponents(SEP());
      c.addTextDisplayComponents(T([
        `**Stages tried**${omitted > 0 ? ` (last ${recent.length} of ${result.stages.length})` : ''}`,
        ...recent.map((s) => `• ${s.name}${s.detail ? ` — ${clamp(s.detail, 80)}` : ''}`),
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
    brandHeader(c, '➕ Add Lucid Deobf', 'One click — works everywhere', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T('**Permissions needed** Send Messages • Attach Files • Read Message History.'));
    c.addActionRowComponents(linkRow([{ label: 'Invite Lucid Deobf', url }]));
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
    `• **\`${prefix}setprefix\`** \`<prefix | reset>\` — per-server command prefix (default \`.\`)`,
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

/** .setprefix success card — old → new, live on the next message. */
export function setPrefixReply(oldPrefix, newPrefix, isReset) {
  const card = container(BRAND.ok, (c) => {
    brandHeader(c, isReset ? '✅ Prefix reset' : '✅ Prefix updated', 'this server — live immediately', null);
    c.addSeparatorComponents(SEP());
    c.addTextDisplayComponents(T([
      `**Was** \`${oldPrefix}\``,
      `**Now** \`${newPrefix}\`${isReset ? ' (global default)' : ''}`,
      '',
      `-# Example: \`${newPrefix}deobf\` — slash commands (/deobf) are unaffected.`,
    ].join('\n')));
  });
  return v2([card], { ephemeral: true });
}

// ---- obf (Xfuscator) ------------------------------------------------------------

const XF_LAYERS = {
  v1: 'per-byte XOR stream packer',
  v2: '+ position-mixed keys • integrity MAC (silent tamper refusal)',
  'v2.1': '+ junk-byte interleave (ciphertext stride 2)',
};

/** .obf success card — Xfuscator build delivered as paste + file. */
export function obfReply({ version, code, filename, sizeIn, sizeOut, paste, sourceUrl }) {
  const files = [];
  const card = container(BRAND.color, (c) => {
    brandHeader(c, '🔒 Xfuscator complete', `build ${version} — our own obfuscator, shipped with the bot`, null);
    c.addSeparatorComponents(SEP());
    facts(c, [
      { label: 'Build', value: `**${version}** — ${XF_LAYERS[version] || 'packer'}` },
      { label: 'Input', value: `${clamp(filename || 'file', 60)} — ${fmtBytes(sizeIn)}${sourceUrl ? ' (link)' : ''}` },
      { label: 'Output', value: `${fmtBytes(sizeOut)} Lua, self-decoding at runtime` },
      { label: 'Runs on', value: 'anything with `loadstring`/`load` — Lua 5.1-5.4, Luau executors' },
      { label: 'Tamper', value: version === 'v1' ? 'wrong key → load fails loud' : 'integrity MAC → silently refuses to run' },
    ]);
    c.addSeparatorComponents(SEP());
    if (paste) {
      const parts = paste.parts || [];
      if (parts.length > 1) {
        const shown = parts.slice(0, 4).map((p) => ({ label: `Part ${p.index}/${p.of}`, url: p.url }));
        c.addActionRowComponents(linkRow([...shown, { label: 'Raw', url: paste.rawUrl }]));
      } else {
        c.addActionRowComponents(linkRow([
          { label: '🧾 Open paste', url: paste.url },
          { label: 'Raw', url: paste.rawUrl },
        ]));
      }
    }
    const preview = code.length <= 800 ? code : `${code.slice(0, 600)}\n… (${code.length - 600} more chars in the paste)`;
    c.addTextDisplayComponents(T(`**Preview**${code.length > 800 ? ' (truncated)' : ''}\n\`\`\`lua\n${clamp(preview, 1400)}\n\`\`\``));
    const outName = safeAttachmentName(`${String(filename || 'output.lua').replace(/\.[^.]*$/, '')}.xfuscator.${version}.lua`, `xfuscator.${version}.lua`);
    const codeBuf = Buffer.from(code, 'utf8');
    if (codeBuf.length <= MAX_DISCORD_ATTACHMENT) {
      files.push(new AttachmentBuilder(codeBuf, { name: outName }));
      c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
      if (!paste) c.addTextDisplayComponents(T('-# Pastefy upload failed — the full obfuscated file is attached instead.'));
    } else if (paste) {
      c.addTextDisplayComponents(T('-# Output exceeds Discord 8 MB attachment limit — full code is in the Pastefy link above.'));
    } else {
      files.push(new AttachmentBuilder(codeBuf.subarray(0, SAFE_TRUNC_SLICE), { name: outName }));
      c.addFileComponents(new FileBuilder().setURL(`attachment://${outName}`));
      c.addTextDisplayComponents(T('-# Pastefy failed and output exceeded 8 MB — attached first 7.9 MB.'));
    }
  });
  return v2([card], { files });
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
    if (paste || code != null || fileBuffer) {
      c.addSeparatorComponents(SEP());
      if (paste) {
        const parts = paste.parts || [];
        if (parts.length > 1) {
          const shown = parts.slice(0, 4).map((p) => ({ label: `Part ${p.index}/${p.of}`, url: p.url }));
          c.addActionRowComponents(linkRow([...shown, { label: 'Raw', url: paste.rawUrl }]));
          const rest = parts.slice(4).map((p) => `[Part ${p.index}](${p.url})`).join(' • ');
          if (rest) c.addTextDisplayComponents(T(`-# More parts: ${clamp(rest, 350)}`));
        } else {
          const defs = [{ label: '🧾 Open paste', url: paste.url }, { label: 'Raw', url: paste.rawUrl }];
          c.addActionRowComponents(linkRow(defs));
        }
      }
      if (code != null) {
        const budget = Math.max(220, Math.min(1500, v2TextBudgetLeft(c) - 180));
        const sliceLen = Math.max(150, budget - 80);
        const preview = code.length <= sliceLen ? code : `${code.slice(0, sliceLen)}\n… (${code.length - sliceLen} more chars)`;
        const lang = codeLangFromName(codeName);
        c.addTextDisplayComponents(T(`**Preview**${code.length > sliceLen ? ' *(truncated)*' : ''}\n\`\`\`${lang}\n${clamp(preview, budget)}\n\`\`\``));
        attachOutputFile(c, files, Buffer.from(code, 'utf8'), codeName || 'output.txt', paste || true, { noPasteNote: null });
      } else if (fileBuffer) {
        const name = safeAttachmentName(codeName, 'output.bin');
        const buf = fileBuffer.length <= MAX_DISCORD_ATTACHMENT ? fileBuffer : fileBuffer.subarray(0, SAFE_TRUNC_SLICE);
        files.push(new AttachmentBuilder(buf, { name }));
        c.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
      }
      if (paste && paste.parts?.length > 1) {
        c.addTextDisplayComponents(T(`-# Large output delivered as ${paste.parts.length} paste parts.`));
      }
    }
  });
  return v2([card], { files });
}

export { fmtBytes };
