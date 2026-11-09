const { transformNode } = require("../lua/transform");

const PURE_CALL_IDENTIFIERS = new Set([
  "tostring", "tonumber", "type", "typeof",
  "pcall", "xpcall",
  "unpack", "select",
  "pairs", "ipairs", "next",
  "rawget", "rawset", "rawequal", "rawlen",
]);

const PURE_CALL_MEMBERS = new Set([
  "math.abs", "math.ceil", "math.floor", "math.max", "math.min",
  "math.sqrt", "math.round", "math.log", "math.exp", "math.sin", "math.cos",
  "string.len", "string.lower", "string.upper", "string.reverse", "string.sub",
  "string.byte", "string.char", "string.rep", "string.match", "string.gmatch",
  "string.gsub", "string.find", "string.format",
  "table.concat", "table.insert", "table.remove", "table.sort",
  "table.pack", "table.unpack", "table.move",
]);

function clone(value) {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "scope") continue;
    next[key] = clone(child);
  }
  return next;
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function isIdentifier(node, name = null) {
  return Boolean(node) && node.type === "Identifier" && (name === null || node.name === name);
}

function isLiteralLike(node) {
  return Boolean(node) && (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NilLiteral"
  );
}

function getCallBaseKey(base) {
  const expression = unwrapParentheses(base);
  if (!expression) return null;

  if (expression.type === "Identifier") return expression.name;

  if (
    expression.type === "MemberExpression" &&
    expression.indexer === "." &&
    expression.base &&
    expression.base.type === "Identifier"
  ) {
    return `${expression.base.name}.${expression.identifier.name}`;
  }

  return null;
}

function isSingleValueExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression) return false;

  switch (expression.type) {
    case "Identifier":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
    case "FunctionDeclaration":
      return true;
    case "CallExpression":
    case "TableCallExpression":
    case "StringCallExpression":
      return false;
    case "ParenthesisExpression":
      return isSingleValueExpression(expression.expression);
    case "UnaryExpression":
      return isSingleValueExpression(expression.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isSingleValueExpression(expression.left) && isSingleValueExpression(expression.right);
    case "IndexExpression":
      return isSingleValueExpression(expression.base) && isSingleValueExpression(expression.index);
    case "MemberExpression":
      return isSingleValueExpression(expression.base);
    case "IfExpression":
      return (
        isSingleValueExpression(expression.condition) &&
        isSingleValueExpression(expression.trueExpression) &&
        isSingleValueExpression(expression.falseExpression)
      );
    case "TableConstructorExpression":
      return expression.fields.every((field) => {
        if (field.type === "TableValue") return isSingleValueExpression(field.value);
        return isSingleValueExpression(field.key) && isSingleValueExpression(field.value);
      });
    default:
      return false;
  }
}

function isPureBuiltinCall(node) {
  if (!node || node.type !== "CallExpression") return false;

  const key = getCallBaseKey(node.base);
  if (!key || (!PURE_CALL_IDENTIFIERS.has(key) && !PURE_CALL_MEMBERS.has(key))) return false;

  return node.arguments.every((argument) => isPureExpression(argument) && isSingleValueExpression(argument));
}

function isPureExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression || typeof expression !== "object") return false;

  switch (expression.type) {
    case "Identifier":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
    case "FunctionDeclaration":
      return true;
    case "ParenthesisExpression":
      return isPureExpression(expression.expression);
    case "UnaryExpression":
      return isPureExpression(expression.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isPureExpression(expression.left) && isPureExpression(expression.right);
    case "IndexExpression":
      return isPureExpression(expression.base) && isPureExpression(expression.index);
    case "MemberExpression":
      return isPureExpression(expression.base);
    case "TableConstructorExpression":
      return expression.fields.every((field) => {
        if (field.type === "TableValue") return isPureExpression(field.value);
        return isPureExpression(field.key) && isPureExpression(field.value);
      });
    case "IfExpression":
      return (
        isPureExpression(expression.condition) &&
        isPureExpression(expression.trueExpression) &&
        isPureExpression(expression.falseExpression)
      );
    case "CallExpression":
      return isPureBuiltinCall(expression);
    default:
      return false;
  }
}

function isTinyLiteralTable(node) {
  if (!node || node.type !== "TableConstructorExpression" || node.fields.length > 4) return false;
  return node.fields.every((field) => {
    if (field.type === "TableValue") return isPureExpression(field.value) && isSingleValueExpression(field.value);
    return (
      isPureExpression(field.key) && isSingleValueExpression(field.key) &&
      isPureExpression(field.value) && isSingleValueExpression(field.value)
    );
  });
}

function isInlineExpressionCandidate(node) {
  const expression = unwrapParentheses(node);
  if (!expression) return false;

  if (isLiteralLike(expression) || expression.type === "Identifier" || expression.type === "VarargLiteral") return true;
  if (expression.type === "TableConstructorExpression") return isTinyLiteralTable(expression);
  if (expression.type === "CallExpression") return isPureBuiltinCall(expression);
  if (expression.type === "FunctionDeclaration") return false;

  return isPureExpression(expression) && isSingleValueExpression(expression);
}

function describeNode(node) {
  const expression = unwrapParentheses(node);
  return expression ? expression.type : "Unknown";
}

function recordDecision(options, decision) {
  if (!Array.isArray(options && options.decisions)) return;
  options.decisions.push({ ...decision, index: options.decisions.length });
}

function buildUsageMap(statements, captured = new Set()) {
  const usage = new Map();
  const definitions = new Map();

  const walkNode = (node, inLValue = false, insideFunction = false) => {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach((child) => walkNode(child, inLValue, insideFunction));
      return;
    }

    if (node.type === "Identifier") {
      if (inLValue || insideFunction) {
        if (insideFunction) captured.add(node.name);
        definitions.set(node.name, (definitions.get(node.name) || 0) + 1);
      } else {
        usage.set(node.name, (usage.get(node.name) || 0) + 1);
      }
      return;
    }

    if (node.type === "LocalStatement") {
      node.init.forEach((child) => walkNode(child, false, insideFunction));
      node.variables.forEach((child) => walkNode(child, true, insideFunction));
      return;
    }

    if (node.type === "AssignmentStatement") {
      node.init.forEach((child) => walkNode(child, false, insideFunction));
      node.variables.forEach((child) => walkNode(child, true, insideFunction));
      return;
    }

    if (node.type === "FunctionDeclaration") {
      if (node.identifier) walkNode(node.identifier, true, insideFunction);
      node.parameters.forEach((param) => walkNode(param, true, true));
      if (Array.isArray(node.body)) node.body.forEach((stmt) => walkNode(stmt, false, true));
      return;
    }

    if (node.type === "CallStatement" && node.expression) {
      walkNode(node.expression, false, insideFunction);
      return;
    }

    if (node.type === "ReturnStatement") {
      if (Array.isArray(node.arguments)) node.arguments.forEach((arg) => walkNode(arg, false, insideFunction));
      return;
    }

    if (node.type === "IfStatement" && Array.isArray(node.clauses)) {
      node.clauses.forEach((clause) => {
        if (clause.condition) walkNode(clause.condition, false, insideFunction);
        if (Array.isArray(clause.body)) clause.body.forEach((stmt) => walkNode(stmt, false, insideFunction));
      });
      return;
    }

    if (node.type === "WhileStatement" || node.type === "RepeatStatement") {
      if (node.condition) walkNode(node.condition, false, insideFunction);
      if (Array.isArray(node.body)) node.body.forEach((stmt) => walkNode(stmt, false, insideFunction));
      return;
    }

    if (node.type === "DoStatement") {
      if (Array.isArray(node.body)) node.body.forEach((stmt) => walkNode(stmt, false, insideFunction));
      return;
    }

    if (node.type === "ForNumericStatement") {
      if (node.start) walkNode(node.start, false, insideFunction);
      if (node.end) walkNode(node.end, false, insideFunction);
      if (node.step) walkNode(node.step, false, insideFunction);
      if (node.variable) walkNode(node.variable, true, insideFunction);
      if (Array.isArray(node.body)) node.body.forEach((stmt) => walkNode(stmt, false, insideFunction));
      return;
    }

    if (node.type === "ForGenericStatement") {
      if (Array.isArray(node.iterators)) node.iterators.forEach((iter) => walkNode(iter, false, insideFunction));
      if (Array.isArray(node.variables)) node.variables.forEach((v) => walkNode(v, true, insideFunction));
      if (Array.isArray(node.body)) node.body.forEach((stmt) => walkNode(stmt, false, insideFunction));
      return;
    }

    Object.entries(node).forEach(([key, value]) => {
      if (key === "scope") return;
      walkNode(value, inLValue, insideFunction);
    });
  };

  statements.forEach((statement) => walkNode(statement));
  return { usage, definitions, captured };
}

function rewriteInlineExpression(node, candidates, options, context = { inLValue: false }) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => rewriteInlineExpression(child, candidates, options, context));

  if (node.type === "Identifier") {
    if (!context.inLValue && candidates.has(node.name)) {
      return clone(candidates.get(node.name).expression);
    }
    return node;
  }

  switch (node.type) {
    case "UnaryExpression":
      return { ...node, argument: rewriteInlineExpression(node.argument, candidates, options, { inLValue: false }) };
    case "BinaryExpression":
    case "LogicalExpression":
      return {
        ...node,
        left: rewriteInlineExpression(node.left, candidates, options, { inLValue: false }),
        right: rewriteInlineExpression(node.right, candidates, options, { inLValue: false }),
      };
    case "IfExpression":
      return {
        ...node,
        condition: rewriteInlineExpression(node.condition, candidates, options, { inLValue: false }),
        trueExpression: rewriteInlineExpression(node.trueExpression, candidates, options, { inLValue: false }),
        falseExpression: rewriteInlineExpression(node.falseExpression, candidates, options, { inLValue: false }),
      };
    case "ParenthesisExpression":
      return { ...node, expression: rewriteInlineExpression(node.expression, candidates, options, { inLValue: context.inLValue }) };
    case "IndexExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, candidates, options, { inLValue: context.inLValue }),
        index: rewriteInlineExpression(node.index, candidates, options, { inLValue: false }),
      };
    case "MemberExpression":
      return { ...node, base: rewriteInlineExpression(node.base, candidates, options, { inLValue: context.inLValue }) };
    case "CallExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, candidates, options, { inLValue: false }),
        arguments: node.arguments.map((arg) => rewriteInlineExpression(arg, candidates, options, { inLValue: false })),
      };
    case "TableCallExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, candidates, options, { inLValue: false }),
        arguments: rewriteInlineExpression(node.arguments, candidates, options, { inLValue: false }),
      };
    case "StringCallExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, candidates, options, { inLValue: false }),
        argument: rewriteInlineExpression(node.argument, candidates, options, { inLValue: false }),
      };
    case "TableConstructorExpression":
      return {
        ...node,
        fields: node.fields.map((field) => {
          if (field.type === "TableValue") return { ...field, value: rewriteInlineExpression(field.value, candidates, options, { inLValue: false }) };
          if (field.type === "TableKey") return { ...field, key: rewriteInlineExpression(field.key, candidates, options, { inLValue: false }), value: rewriteInlineExpression(field.value, candidates, options, { inLValue: false }) };
          if (field.type === "TableKeyString") return { ...field, value: rewriteInlineExpression(field.value, candidates, options, { inLValue: false }) };
          return field;
        }),
      };
    case "FunctionDeclaration":
      return { ...node, body: runPrometheusInlining(node.body, options) };
    default: {
      const next = { ...node };
      let changed = false;
      Object.entries(node).forEach(([key, value]) => {
        if (key === "scope" || key === "identifier" || key === "parameters" || key === "variables" || key === "variable") return;
        const nextValue = rewriteInlineExpression(value, candidates, options, { inLValue: false });
        if (nextValue !== value) {
          next[key] = nextValue;
          changed = true;
        }
      });
      return changed ? next : node;
    }
  }
}

function rewriteInlineStatement(statement, candidates, options) {
  if (!statement || typeof statement !== "object") return statement;

  switch (statement.type) {
    case "LocalStatement":
      return { ...statement, init: statement.init.map((expr) => rewriteInlineExpression(expr, candidates, options, { inLValue: false })) };
    case "AssignmentStatement":
      return {
        ...statement,
        variables: statement.variables.map((v) => rewriteInlineExpression(v, candidates, options, { inLValue: true })),
        init: statement.init.map((expr) => rewriteInlineExpression(expr, candidates, options, { inLValue: false })),
      };
    case "CallStatement":
      return { ...statement, expression: rewriteInlineExpression(statement.expression, candidates, options, { inLValue: false }) };
    case "ReturnStatement":
      return { ...statement, arguments: statement.arguments.map((arg) => rewriteInlineExpression(arg, candidates, options, { inLValue: false })) };
    case "IfStatement":
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? rewriteInlineExpression(clause.condition, candidates, options, { inLValue: false }) : clause.condition,
          body: runPrometheusInlining(clause.body || [], options),
        })),
      };
    case "WhileStatement":
      return { ...statement, condition: rewriteInlineExpression(statement.condition, candidates, options, { inLValue: false }), body: runPrometheusInlining(statement.body, options) };
    case "RepeatStatement":
      return { ...statement, condition: rewriteInlineExpression(statement.condition, candidates, options, { inLValue: false }), body: runPrometheusInlining(statement.body, options) };
    case "DoStatement":
      return { ...statement, body: runPrometheusInlining(statement.body, options) };
    case "ForNumericStatement":
      return {
        ...statement,
        start: rewriteInlineExpression(statement.start, candidates, options, { inLValue: false }),
        end: rewriteInlineExpression(statement.end, candidates, options, { inLValue: false }),
        step: statement.step ? rewriteInlineExpression(statement.step, candidates, options, { inLValue: false }) : statement.step,
        body: runPrometheusInlining(statement.body, options),
      };
    case "ForGenericStatement":
      return {
        ...statement,
        iterators: statement.iterators.map((iter) => rewriteInlineExpression(iter, candidates, options, { inLValue: false })),
        body: runPrometheusInlining(statement.body, options),
      };
    case "FunctionDeclaration":
      return {
        ...statement,
        identifier: statement.identifier && statement.identifier.type !== "Identifier"
          ? rewriteInlineExpression(statement.identifier, candidates, options, { inLValue: true })
          : statement.identifier,
        body: runPrometheusInlining(statement.body, options),
      };
    default:
      return rewriteInlineExpression(statement, candidates, options, { inLValue: false });
  }
}

function isCallbackLikeUse(node, name) {
  if (!node || node.type !== "CallExpression") return false;
  return node.arguments.some((arg) => {
    const expr = unwrapParentheses(arg);
    return expr && expr.type === "Identifier" && expr.name === name;
  });
}

function getLocalInlineCandidate(statement, usage, definitions, captured, options, iteration) {
  if (
    !statement ||
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    statement.variables[0].type !== "Identifier"
  ) {
    return null;
  }

  const name = statement.variables[0].name;
  const expression = statement.init[0];
  const nodeType = describeNode(expression);
  const useCount = usage.get(name) || 0;
  const definitionCount = definitions.get(name) || 0;

  if (useCount === 0) {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: "0 uses" });
    return null;
  }

  if (useCount !== 1) {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: `${useCount} uses` });
    return null;
  }

  if (definitionCount !== 1) {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: `${definitionCount} definitions` });
    return null;
  }

  if (captured.has(name)) {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: "captured by closure" });
    return null;
  }

  if (!isInlineExpressionCandidate(expression)) {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: "unsafe expression" });
    return null;
  }

  if (expression.type === "FunctionDeclaration") {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: "function literal preserved" });
    return null;
  }

  if (expression.type === "TableConstructorExpression" && expression.fields.length > 2) {
    recordDecision(options, { action: "skip", iteration, name, nodeType, pass: "locals", reason: "table literal preserved" });
    return null;
  }

  recordDecision(options, { action: "inline", iteration, name, nodeType, pass: "locals", reason: "single-use pure value" });

  return { expression, name };
}

function applyLocalInlining(statements, options) {
  let current = statements.map((statement) => rewriteInlineStatement(statement, new Map(), options));
  let changed = false;
  const maxIterations = options.localIterations || 6;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const captured = new Set();
    const { usage, definitions } = buildUsageMap(current, captured);
    const candidates = new Map();
    const survivors = [];

    for (const statement of current) {
      const candidate = getLocalInlineCandidate(statement, usage, definitions, captured, options, iteration);
      if (candidate) {
        candidates.set(candidate.name, candidate);
        changed = true;
        continue;
      }
      survivors.push(statement);
    }

    if (candidates.size === 0) break;

    current = survivors.map((statement) => rewriteInlineStatement(statement, candidates, options));
  }

  return { changed, statements: current };
}

function countParamUsage(node, paramSet, usage = new Map()) {
  const walk = (current) => {
    if (!current || typeof current !== "object") return usage;

    if (Array.isArray(current)) {
      current.forEach(walk);
      return usage;
    }

    if (current.type === "Identifier" && paramSet.has(current.name)) {
      usage.set(current.name, (usage.get(current.name) || 0) + 1);
      return usage;
    }

    if (current.type === "FunctionDeclaration") return usage;

    Object.values(current).forEach(walk);
    return usage;
  };

  return walk(node);
}

function containsUnknownIdentifiers(node, paramSet) {
  let unknown = false;

  const walk = (current) => {
    if (!current || typeof current !== "object" || unknown) return;
    if (Array.isArray(current)) { current.forEach(walk); return; }
    if (current.type === "Identifier" && !paramSet.has(current.name)) { unknown = true; return; }
    if (current.type === "FunctionDeclaration") return;
    Object.values(current).forEach(walk);
  };

  walk(node);
  return unknown;
}

function containsNestedFunction(node) {
  let found = false;
  const walk = (current) => {
    if (!current || typeof current !== "object" || found) return;
    if (Array.isArray(current)) { current.forEach(walk); return; }
    if (current.type === "FunctionDeclaration") { found = true; return; }
    Object.values(current).forEach(walk);
  };
  walk(node);
  return found;
}

function getWrapperInfoFromFunction(fn, name) {
  if (!fn || fn.type !== "FunctionDeclaration" || fn.body.length !== 1) return null;

  const returnStatement = fn.body[0];
  if (!returnStatement || returnStatement.type !== "ReturnStatement" || returnStatement.arguments.length !== 1) return null;

  const expression = unwrapParentheses(returnStatement.arguments[0]);
  if (!expression) return null;

  const params = [];
  let hasVararg = false;
  for (let index = 0; index < fn.parameters.length; index += 1) {
    const parameter = fn.parameters[index];
    if (parameter.type === "Identifier") { params.push(parameter.name); continue; }
    if (parameter.type === "VarargLiteral" && index === fn.parameters.length - 1) { hasVararg = true; continue; }
    return null;
  }

  const paramSet = new Set(params);

  if (!hasVararg && params.length === 1 && expression.type === "Identifier" && expression.name === params[0]) {
    return { expression, hasVararg, kind: "identity", name, paramUsage: new Map([[params[0], 1]]), params };
  }

  if (expression.type === "CallExpression") {
    if (expression.base.type === "Identifier" && expression.base.name === name) return null;
    if (containsNestedFunction(expression)) return null;

    for (let index = 0; index < expression.arguments.length; index += 1) {
      const argument = expression.arguments[index];
      if (argument.type === "VarargLiteral") {
        if (!hasVararg || index !== expression.arguments.length - 1) return null;
        continue;
      }
      if (!isPureExpression(argument) || !isSingleValueExpression(argument)) return null;
      if (containsUnknownIdentifiers(argument, paramSet)) return null;
    }

    return { expression, hasVararg, kind: "call", name, paramUsage: countParamUsage(expression, paramSet), params };
  }

  if (!hasVararg && isPureExpression(expression) && isSingleValueExpression(expression)) {
    if (containsNestedFunction(expression) || containsUnknownIdentifiers(expression, paramSet)) return null;
    return { expression, hasVararg, kind: "expr", name, paramUsage: countParamUsage(expression, paramSet), params };
  }

  return null;
}

function collectWrapperInfo(statement) {
  if (statement.type === "FunctionDeclaration" && statement.isLocal && statement.identifier && statement.identifier.type === "Identifier") {
    return getWrapperInfoFromFunction(statement, statement.identifier.name);
  }
  if (
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    statement.variables[0].type === "Identifier" &&
    statement.init[0].type === "FunctionDeclaration"
  ) {
    return getWrapperInfoFromFunction(statement.init[0], statement.variables[0].name);
  }
  return null;
}

function substituteExpression(node, replacements) {
  return transformNode(clone(node), (child) => {
    if (child && child.type === "Identifier" && replacements.has(child.name)) return clone(replacements.get(child.name));
    return child;
  });
}

function applyWrapperInline(wrapper, callArgs) {
  const paramCount = wrapper.params.length;
  if (callArgs.length < paramCount) return null;
  if (!wrapper.hasVararg && callArgs.length !== paramCount) return null;

  const replacements = new Map();
  for (let index = 0; index < paramCount; index += 1) {
    replacements.set(wrapper.params[index], callArgs[index]);
  }

  for (const param of wrapper.params) {
    const count = wrapper.paramUsage.get(param) || 0;
    if (count === 1) continue;
    const arg = replacements.get(param);
    if (!arg || !isPureExpression(arg) || !isSingleValueExpression(arg)) return null;
  }

  if (wrapper.kind === "identity") return clone(callArgs[0]);

  if (wrapper.kind === "expr") return substituteExpression(wrapper.expression, replacements);

  if (wrapper.kind === "call") {
    const callExpression = wrapper.expression;
    const base = substituteExpression(callExpression.base, replacements);
    const args = [];
    const restArgs = wrapper.hasVararg ? callArgs.slice(paramCount) : [];

    for (const argument of callExpression.arguments) {
      if (argument.type === "VarargLiteral") {
        if (!wrapper.hasVararg) return null;
        restArgs.forEach((rest) => args.push(clone(rest)));
        continue;
      }
      args.push(substituteExpression(argument, replacements));
    }

    return { ...callExpression, base, arguments: args };
  }

  return null;
}

function isWrapperDeclaration(statement, wrapperNames) {
  if (statement.type === "FunctionDeclaration" && statement.isLocal && statement.identifier && wrapperNames.has(statement.identifier.name)) {
    return statement.identifier.name;
  }
  if (
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    statement.variables[0].type === "Identifier" &&
    statement.init[0].type === "FunctionDeclaration" &&
    wrapperNames.has(statement.variables[0].name)
  ) {
    return statement.variables[0].name;
  }
  return null;
}

function applyWrapperInlining(statements, options) {
  const wrappers = new Map();
  for (const statement of statements) {
    const wrapper = collectWrapperInfo(statement);
    if (wrapper) wrappers.set(wrapper.name, wrapper);
  }

  if (wrappers.size === 0) return { changed: false, statements };

  let changed = false;
  const rewritten = statements.map((statement) => transformNode(statement, (node) => {
    if (node && node.type === "CallExpression" && node.base && node.base.type === "Identifier" && wrappers.has(node.base.name)) {
      const wrapper = wrappers.get(node.base.name);
      const replacement = applyWrapperInline(wrapper, node.arguments);
      if (replacement) {
        changed = true;
        recordDecision(options, { action: "inline", iteration: options.pipelineIteration || 0, name: wrapper.name, nodeType: wrapper.kind, pass: "wrappers", reason: "wrapper call expanded" });
        return replacement;
      }
      recordDecision(options, { action: "skip", iteration: options.pipelineIteration || 0, name: wrapper.name, nodeType: wrapper.kind, pass: "wrappers", reason: "wrapper call not safe" });
    }
    return node;
  }));

  const { usage } = buildUsageMap(rewritten);
  const wrapperNames = new Set(wrappers.keys());
  const survivors = rewritten.filter((statement) => {
    const name = isWrapperDeclaration(statement, wrapperNames);
    if (!name) return true;
    return (usage.get(name) || 0) > 0;
  });

  if (survivors.length !== rewritten.length) changed = true;

  return { changed, statements: survivors };
}

function runPrometheusInlining(statements, options = {}) {
  let current = statements;
  const maxIterations = options.pipelineIterations || 4;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const wrapperResult = applyWrapperInlining(current, { ...options, pipelineIteration: iteration });
    const localResult = applyLocalInlining(wrapperResult.statements, { ...options, pipelineIteration: iteration });

    current = localResult.statements;
    if (!wrapperResult.changed && !localResult.changed) break;
  }

  return current;
}

function formatInliningDecisions(decisions = []) {
  const groups = [];
  const groupsBySignature = new Map();

  for (const entry of decisions) {
    const signature = [entry.action || "", entry.pass || "", entry.name || "", entry.nodeType || "", entry.reason || ""].join("|");
    if (groupsBySignature.has(signature)) {
      const group = groupsBySignature.get(signature);
      group.count += 1;
      group.endIndex = entry.index;
      continue;
    }
    const group = { count: 1, endIndex: entry.index, entry, signature, startIndex: entry.index };
    groups.push(group);
    groupsBySignature.set(signature, group);
  }

  return groups.map((group) => {
    const action = group.entry.action === "inline" ? "inline" : "skip";
    const range = group.count > 1
      ? `${String(group.startIndex).padStart(3, "0")}-${String(group.endIndex).padStart(3, "0")}`
      : String(group.startIndex).padStart(3, "0");
    const parts = [range, action, group.entry.pass || "inliner", group.entry.name || "<anonymous>"];
    if (group.entry.nodeType) parts.push(`[${group.entry.nodeType}]`);
    if (group.entry.reason) parts.push(group.entry.reason);
    if (group.count > 1) parts.push(`x${group.count}`);
    return parts.join(" ");
  }).join("\n");
}

module.exports = {
  formatInliningDecisions,
  runPrometheusInlining,
};