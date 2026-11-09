function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
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

function countSignalCalls(ast) {
  let literalPrintCalls = 0;
  let robloxAccessCalls = 0;
  let loadstringCalls = 0;
  const stack = [ast];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") {
      continue;
    }

    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push(node[index]);
      }
      continue;
    }

    if (node.type === "CallExpression") {
      const root = getCallBaseRoot(node.base);
      if (root === "print" || root === "warn") {
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const literalOnly = args.length > 0 && args.every((arg) => {
          const unwrapped = unwrapParentheses(arg);
          return unwrapped && (
            unwrapped.type === "StringLiteral" ||
            unwrapped.type === "NumericLiteral" ||
            unwrapped.type === "BooleanLiteral" ||
            unwrapped.type === "NilLiteral"
          );
        });
        if (literalOnly) {
          literalPrintCalls += 1;
        }
      }

      if (root === "loadstring") {
        loadstringCalls += 1;
      }

      if (root === "game" || root === "workspace" || root === "Instance") {
        robloxAccessCalls += 1;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") {
        continue;
      }
      stack.push(value);
    }
  }

  return {
    literalPrintCalls,
    loadstringCalls,
    robloxAccessCalls,
  };
}

function estimatePayloadConfidence(ast, options = {}) {
  if (typeof options.payloadConfidence === "number") {
    return Math.max(0, Math.min(1, options.payloadConfidence));
  }

  const bodyLength = ast && Array.isArray(ast.body) ? ast.body.length : 0;
  const signals = countSignalCalls(ast);
  let confidence = 0.25;

  if (bodyLength > 0 && bodyLength <= 24) {
    confidence += 0.2;
  }

  if (signals.literalPrintCalls >= 1) {
    confidence += 0.35;
  }

  if (signals.robloxAccessCalls >= 6) {
    confidence += 0.15;
  }

  if (signals.loadstringCalls >= 1) {
    confidence -= 0.2;
  }

  return Math.max(0, Math.min(1, confidence));
}

function derivePayloadRetentionRatio(confidence) {
  if (confidence >= 0.8) {
    return 0.15;
  }

  if (confidence >= 0.6) {
    return 0.35;
  }

  return 0.68;
}

function derivePayloadOptions(ast, options = {}) {
  if (typeof options.payloadRetentionRatio === "number") {
    return {
      payloadConfidence: estimatePayloadConfidence(ast, options),
      payloadRetentionRatio: Math.max(0, Math.min(1, options.payloadRetentionRatio)),
    };
  }

  const payloadConfidence = estimatePayloadConfidence(ast, options);
  return {
    payloadConfidence,
    payloadRetentionRatio: derivePayloadRetentionRatio(payloadConfidence),
  };
}

module.exports = {
  derivePayloadOptions,
  estimatePayloadConfidence,
};