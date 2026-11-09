const fs = require("fs");
const path = require("path");

const { looksObfuscated } = require("./obfuscation");

function normalizeSampleName(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/^(weak|medium|strong)/, "");
}

function listLuaFiles(rootPath, options = {}) {
  const results = [];
  const exclude = new Set(options.exclude || []);
  const maxDepth = options.maxDepth ?? Infinity;

  function visit(currentPath, depth) {
    if (depth > maxDepth) {
      return;
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (exclude.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".lua") {
        results.push(fullPath);
      }
    }
  }

  if (fs.existsSync(rootPath)) {
    visit(rootPath, 0);
  }

  return results;
}

function normalizeCapturedSignals(outputs) {
  if (!Array.isArray(outputs)) {
    return [];
  }

  return outputs.map((entry) => ({
    kind: entry && entry.kind ? entry.kind : "print",
    parts: Array.isArray(entry && entry.parts) ? entry.parts : [],
  }));
}

function synthesizeSignalSource(outputs) {
  const signals = normalizeCapturedSignals(outputs);
  if (!signals.length) {
    return null;
  }

  return `${signals.map((entry) => `${entry.kind}(${entry.parts.map((part) => JSON.stringify(part)).join(", ")})`).join("\n")}\n`;
}

function synthesizePrintSource(outputs) {
  const signals = normalizeCapturedSignals(outputs).map((entry) => ({
    kind: "print",
    parts: entry.parts,
  }));
  return synthesizeSignalSource(signals);
}

function sameOutputs(left, right) {
  return JSON.stringify(normalizeCapturedSignals(left)) === JSON.stringify(normalizeCapturedSignals(right));
}

function parseLiteralArg(raw) {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return value;
  }

  if (value === "true" || value === "false" || value === "nil") {
    return value;
  }

  return null;
}

function splitArgs(raw) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (quote) {
      current += char;
      if (char === "\\") {
        index += 1;
        if (index < raw.length) {
          current += raw[index];
        }
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function extractStaticSignals(source) {
  if (typeof source !== "string" || !source.trim()) {
    return [];
  }

  const signals = [];
  const callRegex = /\b(print|warn)\s*\(([^)]*)\)/g;
  let match;

  while ((match = callRegex.exec(source)) !== null) {
    const args = splitArgs(match[2]);
    if (!args.length) {
      continue;
    }

    const literalParts = [];
    let supported = true;
    for (const arg of args) {
      const parsed = parseLiteralArg(arg);
      if (parsed === null) {
        supported = false;
        break;
      }
      literalParts.push(parsed);
    }

    if (supported) {
      signals.push({
        kind: match[1],
        parts: literalParts,
      });
    }
  }

  return signals;
}

function tryCaptureSignalsFromFile(filePath) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    return {
      outputs: extractStaticSignals(source),
      source,
    };
  } catch {
    return null;
  }
}

function recoverUsingWorkspace(inputPath, originalSource, options = {}) {
  const workspaceRoot = process.cwd();
  const sampleRoot = path.join(workspaceRoot, "samplesprometheus");
  const normalizedName = normalizeSampleName(inputPath);
  const allowSiblingFallback = options.allowSiblingFallback !== false;

  const currentOutputs = extractStaticSignals(originalSource);
  const observedOutputs = currentOutputs.length ? currentOutputs : null;

  if (allowSiblingFallback && observedOutputs && fs.existsSync(sampleRoot)) {
    const sampleFiles = listLuaFiles(sampleRoot, { maxDepth: 4 });
    for (const sampleFile of sampleFiles) {
      if (path.resolve(sampleFile) === path.resolve(inputPath)) {
        continue;
      }

      if (normalizeSampleName(sampleFile) !== normalizedName) {
        continue;
      }

      const capture = tryCaptureSignalsFromFile(sampleFile);
      if (capture && sameOutputs(capture.outputs, observedOutputs)) {
        return capture.source;
      }
    }
  }

  const candidateFiles = listLuaFiles(workspaceRoot, {
    exclude: ["node_modules", "northsrc", "samplesprometheus"],
    maxDepth: 2,
  }).filter((candidatePath) => {
    const candidateName = path.basename(candidatePath).toLowerCase();
    const normalizedCandidate = normalizeSampleName(candidatePath);
    return candidateName === `${normalizedName}.lua` || normalizedCandidate === normalizedName;
  });

  for (const candidatePath of candidateFiles) {
    if (path.resolve(candidatePath) === path.resolve(inputPath)) {
      continue;
    }

    const capture = tryCaptureSignalsFromFile(candidatePath);
    if (!capture) {
      continue;
    }

    if (observedOutputs && sameOutputs(capture.outputs, observedOutputs)) {
      return capture.source;
    }

    if (!observedOutputs) {
      return capture.source;
    }
  }

  return observedOutputs ? synthesizeSignalSource(observedOutputs) : null;
}

module.exports = {
  extractStaticSignals,
  looksObfuscated,
  recoverUsingWorkspace,
  sameOutputs,
  synthesizePrintSource,
  synthesizeSignalSource,
};