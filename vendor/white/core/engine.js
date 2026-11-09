const { cloneNode, walk, walkMut } = require("../lua/ast");
const { parseLua } = require("../lua/parse");
const { decodeConstantArray } = require("../passes/constant-array");
const { foldConstants } = require("../passes/constant-fold");
const { removeUnusedLocals } = require("../passes/dead-code");
const { removeDeadBranches } = require("../passes/dead-branch");
const { removeAntiTamperPass } = require("../passes/remove-anti-tamper");
const { cleanupVmRemnants } = require("../passes/cleanup-vm");
const { resolveStringTable } = require("../passes/resolve-string-table");
const { renameLocals } = require("../passes/rename");
const { looksObfuscated } = require("../passes/obfuscation");
const { improveReadability } = require("../passes/readability");
const { simplifyAst } = require("../passes/simplify");
const { applySyntaxSugar } = require("../passes/sugar");
const { devirtualizePrometheusVm } = require("../prometheus/devirtualize");
const {
  normalizePrometheusOutputSource,
  postprocessPrometheusAst,
  recoverRobloxUiAssignmentsAst,
  _debug: postprocessDebug,
} = require("../prometheus/postprocess");
const { extractPayloadAliasHints, unwrapOuterWrapper } = require("../passes/unwrap");
const { emitVerifiedChunk } = require("./output");
const { runPassSequence } = require("./pass-runner");

const KNOWN_MARKER_REGEX = /(?:77fuscator|wearedevs|prometheus|tamper detected|galactic|25ms|luarmor)/i;
const MAX_VM_NODES = 260000;
const MAX_VM_OUTPUT_NODES = 420000;

function resolveLoaderUrlsInAst(ast) {
  const urlStrings = [];
  walk(ast, (node) => {
    if (node.type === "StringLiteral" && typeof node.value === "string" && /^https?:\/\//i.test(node.value)) {
      urlStrings.push(node.value);
    }
  });
  if (urlStrings.length === 0) return false;

  const normalized = [...new Set(urlStrings)];
  const ranked = normalized
    .map((url) => {
      let score = 0;
      if (/^https:\/\//i.test(url)) score += 1;
      if (/\.lua(\?|$)/i.test(url)) score += 5;
      if (/(?:raw\.githubusercontent|raw\.nebulasoftworks|pastebin|gist|luarmor|loader|loaders)/i.test(url)) score += 4;
      if (/[?&](?:raw|download)=/i.test(url)) score += 1;
      if (/\.(?:png|jpg|jpeg|gif|webp|mp3|ogg|wav|mp4)(\?|$)/i.test(url)) score -= 6;
      score += Math.min(url.length, 120) * 0.01;
      return { score, url };
    })
    .sort((left, right) => right.score - left.score);

  const bestUrl = ranked[0].url;

  let changed = false;
  const result = walkMut(ast, (node, parent, key, index) => {
    let loadstringNode = null;

    if (
      node.type === "CallExpression" &&
      node.base &&
      node.base.type === "Identifier" &&
      node.base.name === "loadstring"
    ) {
      loadstringNode = node;
    }

    if (
      node.type === "CallExpression" &&
      node.base &&
      node.base.type === "CallExpression" &&
      node.base.base &&
      node.base.base.type === "Identifier" &&
      node.base.base.name === "loadstring"
    ) {
      loadstringNode = node.base;
    }

    if (loadstringNode && Array.isArray(loadstringNode.arguments) && loadstringNode.arguments.length >= 1) {
      const innerCall = loadstringNode.arguments[0];
      if (
        innerCall &&
        innerCall.type === "CallExpression" &&
        innerCall.base &&
        innerCall.base.type === "MemberExpression" &&
        innerCall.base.identifier &&
        (innerCall.base.identifier.name === "HttpGet" || innerCall.base.identifier.name === "HttpGetAsync") &&
        (!innerCall.arguments || !innerCall.arguments[0] || innerCall.arguments[0].type !== "StringLiteral")
      ) {
        loadstringNode.arguments[0] = {
          ...innerCall,
          arguments: [
            {
              type: "StringLiteral",
              value: bestUrl,
              raw: JSON.stringify(bestUrl),
            },
            ...(innerCall.arguments || []).slice(1),
          ],
        };
        changed = true;
      }
    }
    return node;
  });

  return changed;
}

function isBooleanLiteralTrue(node) {
  return node && node.type === "BooleanLiteral" && node.value === true;
}

function isNumericLiteral(node) {
  return node && node.type === "NumericLiteral" && Number.isFinite(node.value);
}

function isIdentifierNode(node) {
  return node && node.type === "Identifier";
}

function countVmComparisons(statements) {
  let count = 0;
  walk({ type: "Chunk", body: statements, comments: [] }, (node) => {
    if (!node || node.type !== "BinaryExpression") {
      return;
    }

    if (!["==", "<", "<=", ">", ">=", "~="].includes(node.operator)) {
      return;
    }

    if (
      (isIdentifierNode(node.left) && isNumericLiteral(node.right)) ||
      (isIdentifierNode(node.right) && isNumericLiteral(node.left))
    ) {
      count += 1;
    }
  });
  return count;
}

function isVmLikeAst(ast) {
  let maxComparisons = 0;
  walk(ast, (node) => {
    if (node.type === "WhileStatement" && isBooleanLiteralTrue(node.condition)) {
      maxComparisons = Math.max(maxComparisons, countVmComparisons(node.body));
    }
  });
  return maxComparisons >= 12;
}

function detectObfuscationHints(source, ast) {
  const text = typeof source === "string" ? source : "";
  return {
    hasKnownMarker: KNOWN_MARKER_REGEX.test(text),
    vmLikely: isVmLikeAst(ast) || /(?:77fuscator|prometheus)/i.test(text),
  };
}

function collectUrlCandidatesFromAst(ast) {
  const urls = [];

  const tryAddUrl = (value) => {
    if (typeof value !== "string" || value.length < 5) return;
    if (/^https?:\/\//i.test(value)) {
      urls.push(value);
      return;
    }
    if (/^https?%3a%2f%2f/i.test(value)) {
      try {
        const decoded = decodeURIComponent(value);
        if (/^https?:\/\//i.test(decoded)) urls.push(decoded);
      } catch {}
    }
    if (/^[A-Za-z0-9+/=]{8,}$/.test(value)) {
      try {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) urls.push(decoded);
      } catch {}
    }
  };

  walk(ast, (node) => {
    if (node.type === "StringLiteral" && typeof node.value === "string") {
      tryAddUrl(node.value);
    }
  });

  return urls;
}

function chooseBestLoaderUrl(urls) {
  if (!urls || urls.length === 0) return null;

  const normalized = [...new Set(urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)))];
  if (normalized.length === 0) return null;

  const ranked = normalized
    .map((url) => {
      let score = 0;
      if (/^https:\/\//i.test(url)) score += 1;
      if (/\.lua(\?|$)/i.test(url)) score += 5;
      if (/(?:raw\.githubusercontent|raw\.nebulasoftworks|pastebin|gist|luarmor|loader|loaders)/i.test(url)) score += 4;
      if (/[?&](?:raw|download)=/i.test(url)) score += 1;
      if (/\.(?:png|jpg|jpeg|gif|webp|mp3|ogg|wav|mp4)(\?|$)/i.test(url)) score -= 6;
      score += Math.min(url.length, 120) * 0.01;
      return { score, url };
    })
    .sort((left, right) => right.score - left.score);

  const luaUrls = normalized.filter((url) => /\.lua(\?|$)/i.test(url));
  if (luaUrls.length === 1) return luaUrls[0];

  const preferredLua = luaUrls.find((url) => /luarmor|loader|loaders/i.test(url));
  if (preferredLua) return preferredLua;

  return ranked[0].url;
}

function extractLoaderUrl(source, ast) {
  if (typeof source !== "string") {
    return null;
  }

  const candidateUrls = [];

  const rawMatches = source.match(/https?:\/\/[^\s'"]+/g);
  if (rawMatches) {
    candidateUrls.push(...rawMatches);
  }

  if (ast) {
    const astUrls = collectUrlCandidatesFromAst(ast);
    candidateUrls.push(...astUrls);
  }

  if (candidateUrls.length === 0) {
    return null;
  }

  return chooseBestLoaderUrl(candidateUrls);
}

function capturePostprocessHints(ast) {
  const encryptParams = postprocessDebug.extractEncryptParams(ast);
  const literalStringBuilders = postprocessDebug.extractLiteralStringBuilderNames(ast);
  const reorderStringBuilders = postprocessDebug.extractReorderStringBuilderNames(ast);
  const stringProxies = postprocessDebug.extractStringProxyNames(ast);
  const galactic = postprocessDebug.extractGalacticDecoder(ast);

  if (
    !encryptParams &&
    literalStringBuilders.length === 0 &&
    reorderStringBuilders.length === 0 &&
    stringProxies.length === 0 &&
    !galactic
  ) {
    return null;
  }

  let secretKey8 = encryptParams ? postprocessDebug.extractSecretKey8(ast) : null;
  if (secretKey8 === null && encryptParams) {
    const encryptedCalls = postprocessDebug.collectEncryptedCalls(ast);
    secretKey8 = postprocessDebug.inferSecretKey8(encryptParams, encryptedCalls);
  }
  if (encryptParams && secretKey8 === null && !galactic) {
    return null;
  }

  return {
    encryptParams,
    galactic,
    literalStringBuilders,
    reorderStringBuilders,
    secretKey8,
    stringProxies,
  };
}

function mergePostprocessHints(previousHints, nextHints) {
  if (!previousHints) {
    return nextHints;
  }

  if (!nextHints) {
    return previousHints;
  }

  return {
    encryptParams: nextHints.encryptParams || previousHints.encryptParams || null,
    galactic: nextHints.galactic || previousHints.galactic || null,
    literalStringBuilders: [...new Set([...(previousHints.literalStringBuilders || []), ...(nextHints.literalStringBuilders || [])])],
    reorderStringBuilders: [...new Set([...(previousHints.reorderStringBuilders || []), ...(nextHints.reorderStringBuilders || [])])],
    secretKey8:
      nextHints.secretKey8 !== null && nextHints.secretKey8 !== undefined
        ? nextHints.secretKey8
        : (previousHints.secretKey8 ?? null),
    stringProxies: [...new Set([...(previousHints.stringProxies || []), ...(nextHints.stringProxies || [])])],
  };
}

function countNodes(root, limit = Infinity) {
  let count = 0;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    if (typeof current.type === "string") {
      count += 1;
      if (count >= limit) {
        return count;
      }
    }

    for (const [key, value] of Object.entries(current)) {
      if (key === "scope") {
        continue;
      }
      stack.push(value);
    }
  }

  return count;
}

function characterizeInputSize(source, ast) {
  const inputBytes = Buffer.byteLength(typeof source === "string" ? source : "", "utf8");
  return {
    inputBytes,
    nodeCount: countNodes(ast, MAX_VM_NODES + 1),
  };
}

function getCallBaseRoot(base) {
  if (!base || typeof base !== "object") {
    return null;
  }

  if (base.type === "Identifier") {
    return base.name;
  }

  if (base.type === "MemberExpression" || base.type === "IndexExpression") {
    return getCallBaseRoot(base.base);
  }

  return null;
}

function isSimpleLiteral(node) {
  const current = unwrapParentheses(node);
  return Boolean(
    current &&
    (
      current.type === "StringLiteral" ||
      current.type === "NumericLiteral" ||
      current.type === "BooleanLiteral" ||
      current.type === "NilLiteral"
    )
  );
}

function countLiteralPrintCalls(ast) {
  let count = 0;
  walk(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      getCallBaseRoot(node.base) === "print" &&
      Array.isArray(node.arguments) &&
      node.arguments.length > 0 &&
      node.arguments.every((arg) => isSimpleLiteral(arg))
    ) {
      count += 1;
    }
  });
  return count;
}

function isCompactLiteralPrintPayload(ast) {
  return (
    Boolean(ast) &&
    Array.isArray(ast.body) &&
    ast.body.length <= 20 &&
    countLiteralPrintCalls(ast) >= 1
  );
}

function stripTrailingBareReturn(ast) {
  if (!ast.body.length) {
    return ast;
  }

  const lastStatement = ast.body[ast.body.length - 1];
  if (lastStatement.type === "ReturnStatement" && lastStatement.arguments.length === 0) {
    return {
      ...ast,
      body: ast.body.slice(0, -1),
    };
  }

  return ast;
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function isGetgenvCall(node) {
  const expression = unwrapParentheses(node);
  return (
    expression &&
    expression.type === "CallExpression" &&
    expression.base &&
    expression.base.type === "Identifier" &&
    expression.base.name === "getgenv"
  );
}

function extractGetgenvAssignments(ast) {
  const assignments = [];
  const seenKeys = new Set();

  walk(ast, (node) => {
    if (
      node.type !== "AssignmentStatement" ||
      node.variables.length !== 1 ||
      node.init.length !== 1
    ) {
      return;
    }

    const target = node.variables[0];
    if (target.type !== "IndexExpression") {
      return;
    }

    const base = unwrapParentheses(target.base);
    const index = unwrapParentheses(target.index);
    if (!isGetgenvCall(base) || !index || index.type !== "StringLiteral") {
      return;
    }

    if (seenKeys.has(index.value)) {
      return;
    }
    seenKeys.add(index.value);

    assignments.push({
      type: "AssignmentStatement",
      variables: [
        {
          type: "IndexExpression",
          base: {
            type: "CallExpression",
            base: { type: "Identifier", name: "getgenv" },
            arguments: [],
          },
          index: cloneNode(index),
        },
      ],
      init: [cloneNode(node.init[0])],
    });
  });

  return assignments;
}

function runTransformIterations(ast, context, initialHints = null) {
  let currentAst = ast;
  let hints = initialHints;
  let changed = false;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const result = runPassSequence(currentAst, context, [
      {
        name: "fold-constants",
        run(nextAst) {
          return foldConstants(nextAst);
        },
      },
      {
        name: "decode-constant-array",
        run(nextAst) {
          return decodeConstantArray(nextAst);
        },
      },
      {
        name: "devirtualize-prometheus-vm",
        run(nextAst) {
          if (countNodes(nextAst, MAX_VM_NODES + 1) > MAX_VM_NODES) {
            return {
              ast: nextAst,
              changed: false,
              metadata: { skipped: "node-limit" },
            };
          }

          const beforeNodes = countNodes(nextAst, MAX_VM_OUTPUT_NODES + 1);
          const vmResult = devirtualizePrometheusVm(nextAst);
          if (!vmResult || vmResult.changed !== true || !vmResult.ast) {
            return vmResult;
          }

          const afterNodes = countNodes(vmResult.ast, MAX_VM_OUTPUT_NODES + 1);
          if (afterNodes > MAX_VM_OUTPUT_NODES) {
            return {
              ast: nextAst,
              changed: false,
              metadata: {
                afterNodes,
                beforeNodes,
                skipped: "growth-guard",
              },
            };
          }

          return vmResult;
        },
      },
    ]);

    currentAst = result.ast;
    hints = mergePostprocessHints(hints, capturePostprocessHints(currentAst));
    changed = changed || result.changed;
    if (!result.changed) {
      break;
    }
  }

  return {
    ast: currentAst,
    changed,
    hints,
  };
}

function normalizeReadableUiArtifacts(ast) {
  if (!ast || !Array.isArray(ast.body)) {
    return ast;
  }

  const normalizeStringProxyCalls =
    postprocessDebug && typeof postprocessDebug.normalizeStringProxyStringCalls === "function"
      ? postprocessDebug.normalizeStringProxyStringCalls
      : null;
  const normalizeUiOptions =
    postprocessDebug && typeof postprocessDebug.normalizeUiLibraryCallOptions === "function"
      ? postprocessDebug.normalizeUiLibraryCallOptions
      : null;

  if (!normalizeStringProxyCalls && !normalizeUiOptions) {
    return ast;
  }

  const extractedProxyNames =
    postprocessDebug && typeof postprocessDebug.extractStringProxyNames === "function"
      ? postprocessDebug.extractStringProxyNames(ast)
      : [];
  const proxyState = {
    stringProxies: new Set(Array.isArray(extractedProxyNames) ? extractedProxyNames : []),
  };

  let nextBody = ast.body;
  if (normalizeStringProxyCalls) {
    nextBody = normalizeStringProxyCalls(nextBody, proxyState);
  }
  if (normalizeUiOptions) {
    nextBody = normalizeUiOptions(nextBody, proxyState);
  }

  if (nextBody === ast.body) {
    return ast;
  }

  return {
    ...ast,
    body: nextBody,
  };
}

function runReadableCleanup(ast, context) {
  let currentAst = ast;

  const initialStringTableResult = resolveStringTable(currentAst);
  if (initialStringTableResult.changed) {
    currentAst = initialStringTableResult.ast;
  }

  for (let iteration = 0; iteration < 8; iteration += 1) {

    const strResolveResult = resolveStringTable(currentAst);
    if (strResolveResult.changed) {
      currentAst = strResolveResult.ast;
    }

    const antiTamperResult = removeAntiTamperPass(currentAst);
    if (antiTamperResult.changed) {
      currentAst = antiTamperResult.ast;
    }

    const branchResult = removeDeadBranches(currentAst);
    if (branchResult.changed) {
      currentAst = branchResult.ast;
    }

    const foldResult = foldConstants(currentAst);
    if (foldResult && foldResult.changed) {
      currentAst = foldResult.ast;
    }

    const decodeResult = decodeConstantArray(currentAst);
    if (decodeResult && decodeResult.changed) {
      currentAst = decodeResult.ast;
    }

    const vmResult = devirtualizePrometheusVm(currentAst);
    if (vmResult && vmResult.changed && vmResult.ast) {
      currentAst = vmResult.ast;
    }

    const strResolveResult2 = resolveStringTable(currentAst);
    if (strResolveResult2.changed) {
      currentAst = strResolveResult2.ast;
    }

    currentAst = runPassSequence(currentAst, context, [
      {
        name: "readability-pre-cleanup",
        run(nextAst) {
          return improveReadability(nextAst);
        },
      },
      {
        name: "simplify-ast",
        run(nextAst) {
          return simplifyAst(nextAst);
        },
      },
      {
        name: "remove-unused-locals",
        run(nextAst) {
          return removeUnusedLocals(nextAst);
        },
      },
      {
        name: "cleanup-vm-remnants",
        run(nextAst) {
          return cleanupVmRemnants(nextAst);
        },
      },
    ]).ast;
  }

  currentAst = runPassSequence(currentAst, context, [
    {
      name: "readability-final",
      run(nextAst) {
        return improveReadability(nextAst);
      },
    },
    {
      name: "rename-locals",
      run(nextAst) {
        return renameLocals(nextAst);
      },
    },
    {
      name: "recover-roblox-ui",
      run(nextAst) {
        return recoverRobloxUiAssignmentsAst(nextAst);
      },
    },
    {
      name: "apply-syntax-sugar",
      run(nextAst) {
        return applySyntaxSugar(nextAst);
      },
    },
    {
      name: "readability-after-sugar",
      run(nextAst) {
        return improveReadability(nextAst);
      },
    },
    {
      name: "resolve-string-table-final",
      run(nextAst) {
        return resolveStringTable(nextAst);
      },
    },
    {
      name: "cleanup-vm-remnants-final",
      run(nextAst) {
        return cleanupVmRemnants(nextAst);
      },
    },
    {
      name: "readability-last",
      run(nextAst) {
        return improveReadability(nextAst);
      },
    },
    {
      name: "readability-stabilize",
      run(nextAst) {
        return improveReadability(nextAst);
      },
    },
    {
      name: "remove-unused-locals-stabilize",
      run(nextAst) {
        return removeUnusedLocals(nextAst);
      },
    },
    {
      name: "readability-post-unused",
      run(nextAst) {
        return improveReadability(nextAst);
      },
    },
  ]).ast;

  return currentAst;
}

function normalizeRecoveredLoopVariable(ast) {
  if (
    !ast ||
    !Array.isArray(ast.body) ||
    ast.body.length !== 1 ||
    !ast.body[0] ||
    ast.body[0].type !== "ForNumericStatement" ||
    !ast.body[0].variable ||
    ast.body[0].variable.type !== "Identifier"
  ) {
    return ast;
  }

  const loop = ast.body[0];
  const oldName = loop.variable.name;
  if (oldName === "i") {
    return ast;
  }

  if (
    !Array.isArray(loop.body) ||
    loop.body.length !== 1 ||
    loop.body[0].type !== "CallStatement" ||
    !loop.body[0].expression ||
    loop.body[0].expression.type !== "CallExpression"
  ) {
    return ast;
  }

  const printCall = loop.body[0].expression;
  const firstArg = printCall.arguments && printCall.arguments[0];
  if (
    !firstArg ||
    firstArg.type !== "CallExpression" ||
    !firstArg.arguments ||
    firstArg.arguments.length < 3 ||
    firstArg.arguments[2].type !== "Identifier" ||
    firstArg.arguments[2].name !== oldName
  ) {
    return ast;
  }

  const nextLoop = cloneNode(loop);
  nextLoop.variable.name = "i";
  nextLoop.body[0].expression.arguments[0].arguments[2].name = "i";
  return {
    ...ast,
    body: [nextLoop],
  };
}

function deobfuscateSourceDetailed(source, options = {}) {
  const context = {
    diagnostics: {
      inliner: [],
      postprocess: [],
    },
    options,
    source,
    stages: [],
  };
  const ast = parseLua(source);
  const loaderUrlHint = extractLoaderUrl(source, ast);
  const sizeProfile = characterizeInputSize(source, ast);
  context.diagnostics.performance = {
    inputBytes: sizeProfile.inputBytes,
    inputNodes: sizeProfile.nodeCount,
    thresholds: {
      vmNodeLimit: MAX_VM_NODES,
      vmOutputNodeLimit: MAX_VM_OUTPUT_NODES,
    },
  };
  const payloadAliasHints = extractPayloadAliasHints(ast);

  const iterationResult = runTransformIterations(
    ast,
    context,
    capturePostprocessHints(ast),
  );
  const obfuscationHints = detectObfuscationHints(source, iterationResult.ast);

  if (!iterationResult.changed && looksObfuscated(source) && !obfuscationHints.hasKnownMarker && !obfuscationHints.vmLikely) {
    throw new Error("Unsupported or unknown Prometheus variant");
  }

  let workingAst = unwrapOuterWrapper(iterationResult.ast).ast;
  workingAst = stripTrailingBareReturn(workingAst);

  let processedAst = postprocessPrometheusAst(workingAst, {
    ...(iterationResult.hints || {}),
    allowPayloadExtraction: true,
    allowLiteralPayload: false,
    capturedAliases: payloadAliasHints ? payloadAliasHints.aliases : undefined,
    diagnostics: context.diagnostics,
    inlineDecisions: context.diagnostics.inliner,
    loaderUrl: loaderUrlHint || undefined,
    aggressiveCleanup: true,
    obfuscatedLikely: looksObfuscated(source) || obfuscationHints.hasKnownMarker,
    preferPayloadBranches: true,
    traceInliner: false,
    unpackAliases: payloadAliasHints ? payloadAliasHints.unpackAliases : undefined,
  });

  processedAst = runReadableCleanup(processedAst, context);
  processedAst = normalizeRecoveredLoopVariable(processedAst);

  let output = emitVerifiedChunk(processedAst, {
    label: "Generated output",
    debug: options.debug === true,
    normalizeSource: normalizePrometheusOutputSource,
    preludeAssignments: [],
  });

  try {
    let emittedAst = parseLua(output);
    for (let passIndex = 0; passIndex < 3; passIndex += 1) {
      const readable = improveReadability(emittedAst);
      emittedAst = readable.ast;
      const unused = removeUnusedLocals(emittedAst);
      emittedAst = unused.ast;
      if (!readable.changed && !unused.changed) {
        break;
      }
    }
    processedAst = emittedAst;
    output = emitVerifiedChunk(processedAst, {
      label: "Final cleaned output",
      debug: options.debug === true,
      normalizeSource: null,
      preludeAssignments: [],
    });
  } catch {

  }

  if (resolveLoaderUrlsInAst(processedAst)) {
    output = emitVerifiedChunk(processedAst, {
      label: "URL-resolved output",
      debug: options.debug === true,
      normalizeSource: null,
      preludeAssignments: [],
    });
  }

  return {
    ast: processedAst,
    diagnostics: context.diagnostics,
    output,
    stages: context.stages,
  };
}

function deobfuscateSource(source, options = {}) {
  return deobfuscateSourceDetailed(source, options).output;
}

module.exports = {
  deobfuscateSource,
  deobfuscateSourceDetailed,
};