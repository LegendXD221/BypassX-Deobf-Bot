function normalizePassResult(ast, result) {
  if (result === undefined || result === null) {
    return {
      ast,
      changed: false,
      metadata: null,
    };
  }

  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "ast")) {
    return {
      ast: result.ast || ast,
      changed: result.changed === true,
      metadata: result.metadata || null,
    };
  }

  return {
    ast: result,
    changed: result !== ast,
    metadata: null,
  };
}

function runPass(ast, context, pass) {
  const start = Date.now();
  const result = normalizePassResult(ast, pass.run(ast, context));
  if (context && Array.isArray(context.stages)) {
    context.stages.push({
      changed: result.changed,
      durationMs: Date.now() - start,
      metadata: result.metadata,
      name: pass.name,
    });
  }
  return result;
}

function runPassSequence(ast, context, passes = [], options = {}) {
  const maxIterations = options.maxIterations || 1;
  let currentAst = ast;
  let changed = false;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let iterationChanged = false;

    for (const pass of passes) {
      const result = runPass(currentAst, context, pass);
      currentAst = result.ast;
      iterationChanged = iterationChanged || result.changed;
      changed = changed || result.changed;
    }

    if (!iterationChanged) {
      break;
    }
  }

  return {
    ast: currentAst,
    changed,
  };
}

module.exports = {
  runPass,
  runPassSequence,
};