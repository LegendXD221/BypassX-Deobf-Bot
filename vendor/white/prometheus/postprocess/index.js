const { cloneNode } = require("../../lua/ast");
const { emitChunk } = require("../../lua/emit");

const legacy = require("./legacy");
const { deriveDecodeOptions } = require("./passes/decode");
const { derivePayloadOptions } = require("./passes/payload");
const { deriveCleanupOptions } = require("./passes/cleanup");
const { sanitizeInvalidAssignmentTargets } = require("./passes/string-proxy");
const { runRobloxRecoveryAst } = require("./passes/roblox");
const { validateAst } = require("./passes/validate");

function getDiagnosticsBucket(options) {
  if (!options || !options.diagnostics || typeof options.diagnostics !== "object") {
    return null;
  }

  if (!Array.isArray(options.diagnostics.postprocess)) {
    options.diagnostics.postprocess = [];
  }

  return options.diagnostics.postprocess;
}

function recordDiagnostic(options, entry) {
  const bucket = getDiagnosticsBucket(options);
  if (!bucket) {
    return;
  }
  bucket.push({
    ...entry,
    index: bucket.length,
    timestamp: Date.now(),
  });
}

function normalizePassOutput(currentAst, result) {
  if (!result || typeof result !== "object") {
    return currentAst;
  }

  if (Array.isArray(result.body)) {
    return result;
  }

  if (Object.prototype.hasOwnProperty.call(result, "ast")) {
    return result.ast || currentAst;
  }

  return currentAst;
}

function runSafePostprocessPass(passName, currentAst, options, run, validationOptions = {}) {
  const parseCheck = validationOptions.parseCheck !== false;
  const previousAst = cloneNode(currentAst);
  const startedAt = Date.now();

  let candidateAst = previousAst;
  try {
    candidateAst = normalizePassOutput(previousAst, run(previousAst));
  } catch (error) {
    recordDiagnostic(options, {
      changed: false,
      durationMs: Date.now() - startedAt,
      name: passName,
      rolledBack: true,
      reason: `pass-threw: ${error.message}`,
    });
    return previousAst;
  }

  const validation = validateAst(candidateAst, {
    maxErrors: 24,
    parseCheck,
  });

  if (!validation.ok) {
    recordDiagnostic(options, {
      changed: false,
      durationMs: Date.now() - startedAt,
      errors: validation.errors,
      name: passName,
      rolledBack: true,
      reason: "validation-failed",
    });
    return previousAst;
  }

  recordDiagnostic(options, {
    changed: candidateAst !== previousAst,
    durationMs: Date.now() - startedAt,
    name: passName,
    rolledBack: false,
  });
  return candidateAst;
}

function buildPostprocessOptions(ast, options = {}) {
  const decodeOptions = deriveDecodeOptions();
  const payloadOptions = derivePayloadOptions(ast, options);
  const cleanupOptions = deriveCleanupOptions();

  return {
    ...options,
    ...decodeOptions,
    ...payloadOptions,
    ...cleanupOptions,
  };
}

function runFallbackPostprocess(ast, options = {}) {
  const fallbackOptions = {
    ...options,
    aggressiveCleanup: false,
    allowPayloadExtraction: false,
    preferPayloadBranches: false,
  };

  const fallbackAst = legacy.postprocessPrometheusAst(cloneNode(ast), fallbackOptions);
  const sanitized = sanitizeInvalidAssignmentTargets(fallbackAst).ast;
  const validated = validateAst(sanitized, { parseCheck: true, maxErrors: 24 });
  if (validated.ok) {
    recordDiagnostic(options, {
      changed: true,
      name: "fallback-postprocess",
      rolledBack: false,
    });
    return sanitized;
  }

  recordDiagnostic(options, {
    changed: false,
    errors: validated.errors,
    name: "fallback-postprocess",
    rolledBack: true,
    reason: "fallback-validation-failed",
  });
  return cloneNode(ast);
}

function postprocessPrometheusAst(ast, options = {}) {
  const mergedOptions = buildPostprocessOptions(ast, options);
  let workingAst = cloneNode(ast);

  workingAst = runSafePostprocessPass(
    "legacy-postprocess",
    workingAst,
    mergedOptions,
    (candidateAst) => legacy.postprocessPrometheusAst(candidateAst, mergedOptions),
    { parseCheck: true },
  );

  workingAst = runSafePostprocessPass(
    "sanitize-invalid-lvalues",
    workingAst,
    mergedOptions,
    (candidateAst) => sanitizeInvalidAssignmentTargets(candidateAst),
    { parseCheck: false },
  );

  const finalValidation = validateAst(workingAst, { parseCheck: true, maxErrors: 24 });
  if (!finalValidation.ok) {
    recordDiagnostic(mergedOptions, {
      changed: false,
      errors: finalValidation.errors,
      name: "final-validation",
      rolledBack: true,
      reason: "invalid-final-ast",
    });
    return runFallbackPostprocess(ast, mergedOptions);
  }

  return workingAst;
}

function postprocessPrometheusOutput(ast, options = {}) {
  const processedAst = postprocessPrometheusAst(ast, options);
  return emitChunk(processedAst);
}

function recoverRobloxUiAssignmentsAst(ast, options = {}) {
  const originalAst = cloneNode(ast);
  const recovered = runRobloxRecoveryAst(cloneNode(ast), legacy);
  const candidateAst = normalizePassOutput(ast, recovered);

  const validation = validateAst(candidateAst, {
    maxErrors: 24,
    parseCheck: false,
  });

  if (!validation.ok) {
    recordDiagnostic(options, {
      changed: false,
      errors: validation.errors,
      name: "recover-roblox-ui",
      rolledBack: true,
      reason: "validation-failed",
    });
    return {
      ast: originalAst,
      changed: false,
    };
  }

  return {
    ast: candidateAst,
    changed: Boolean(recovered && recovered.changed),
  };
}

module.exports = {
  inlineSingleUsageLocalsAst: legacy.inlineSingleUsageLocalsAst,
  normalizePrometheusOutputSource: legacy.normalizePrometheusOutputSource,
  postprocessPrometheusAst,
  postprocessPrometheusOutput,
  recoverRobloxUiAssignmentsAst,
  _debug: {
    ...(legacy._debug || {}),
    validateAst,
  },
};