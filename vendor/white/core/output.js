const { emitChunk } = require("../lua/emit");
const { parseLua } = require("../lua/parse");

function prependPreludeSource(output, preludeAssignments = []) {
  if (!Array.isArray(preludeAssignments) || preludeAssignments.length === 0) {
    return output;
  }

  if (/\bgetgenv\b/.test(output)) {
    return output;
  }

  const preludeSource = emitChunk({
    type: "Chunk",
    body: preludeAssignments,
    comments: [],
  });

  return `${preludeSource}${output}`;
}

function extractParseLocation(message) {
  const match = String(message || "").match(/\[(\d+):(\d+)\]/);
  if (!match) {
    return null;
  }

  return {
    line: Number.parseInt(match[1], 10),
    column: Number.parseInt(match[2], 10),
  };
}

function annotateParseError(source, error, label = "Generated output") {
  const message = error && error.message ? error.message : String(error);
  const location = extractParseLocation(message);
  const lines = source.split("\n");

  if (!location || !Number.isFinite(location.line) || !Number.isFinite(location.column)) {
    return `-- DEBUG PARSE ERROR: ${label} is not parseable: ${message}\n${source}`;
  }

  const lineIndex = Math.max(0, Math.min(lines.length - 1, location.line - 1));
  const pointerPadding = " ".repeat(Math.max(0, location.column - 1));
  const commentHeader = `-- debug error hehe >w<: ${label} is not parseable: ${message}`;
  const commentPointer = `-- debug: ${pointerPadding}^ here UwU`;

  lines.splice(lineIndex, 0, commentHeader, commentPointer);
  return lines.join("\n");
}

function tryAutoRepairMissingEndBeforeElse(source, error) {
  const message = error && error.message ? error.message : String(error);
  if (!/'end' expected near 'else'/.test(message) && !/'end' expected near 'elseif'/.test(message)) {
    return null;
  }

  const location = extractParseLocation(message);
  if (!location || !Number.isFinite(location.line)) {
    return null;
  }

  const lines = source.split("\n");
  const lineIndex = Math.max(0, Math.min(lines.length - 1, location.line - 1));
  const failingLine = lines[lineIndex] || "";
  if (!/^\s*else(?:if)?\b/.test(failingLine)) {
    return null;
  }

  const indent = failingLine.match(/^\s*/)[0];
  const repairedLines = [...lines];
  repairedLines.splice(lineIndex, 0, `${indent}end`);
  return repairedLines.join("\n");
}

function assertParseableLua(source, label = "Generated output", options = {}) {
  try {
    parseLua(source);
  } catch (error) {
    const repaired = tryAutoRepairMissingEndBeforeElse(source, error);
    if (repaired !== null) {
      try {
        parseLua(repaired);
        return repaired;
      } catch {
      }
    }

    if (options.debug === true) {
      return annotateParseError(source, error, label);
    }
    throw new Error(`${label} is not parseable: ${error.message}`);
  }

  return source;
}

function emitVerifiedChunk(ast, options = {}) {
  const label = options.label || "Generated output";
  let output = emitChunk(ast);
  output = prependPreludeSource(output, options.preludeAssignments || []);
  if (typeof options.normalizeSource === "function") {
    output = options.normalizeSource(output);
  }
  return assertParseableLua(output, label, options);
}

module.exports = {
  annotateParseError,
  assertParseableLua,
  extractParseLocation,
  emitVerifiedChunk,
  prependPreludeSource,
};