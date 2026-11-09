const { cloneNode } = require("../lua/ast");
const { evaluateNumeric } = require("../passes/constant-fold");

function isIdentifier(node, name) {
  return node && node.type === "Identifier" && node.name === name;
}

function isNumericLiteral(node) {
  return node && node.type === "NumericLiteral";
}

function isStringLiteral(node) {
  return node && node.type === "StringLiteral";
}

function evaluateStaticNumber(node) {
  const direct = evaluateNumeric(node);
  if (direct !== null) {
    return direct;
  }

  if (!node) {
    return null;
  }

  if (node.type === "StringLiteral") {
    const value = Number(node.value);
    return Number.isFinite(value) ? value : null;
  }

  if (node.type === "ParenthesisExpression") {
    return evaluateStaticNumber(node.expression);
  }

  if (node.type === "UnaryExpression") {
    const argument = evaluateStaticNumber(node.argument);
    if (argument === null) {
      return null;
    }
    if (node.operator === "-") {
      return -argument;
    }
    if (node.operator === "+") {
      return argument;
    }
    return null;
  }

  if (node.type !== "BinaryExpression") {
    return null;
  }

  const left = evaluateStaticNumber(node.left);
  const right = evaluateStaticNumber(node.right);
  if (left === null || right === null) {
    return null;
  }

  switch (node.operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right === 0 ? null : left / right;
    case "%":
      return right === 0 ? null : left % right;
    case "^":
      return left ** right;
    default:
      return null;
  }
}

function isExitExpression(node, envName) {
  return (
    node &&
    (
      node.type === "NilLiteral" ||
      (node.type === "IndexExpression" &&
        isIdentifier(node.base, envName) &&
        isStringLiteral(node.index))
    )
  );
}

function isDispatcherIf(statement, stateName) {
  if (!statement || statement.type !== "IfStatement" || statement.clauses.length !== 2) {
    return false;
  }

  const [ifClause, elseClause] = statement.clauses;
  if (ifClause.type !== "IfClause" || elseClause.type !== "ElseClause") {
    return false;
  }

  const bound = parseDispatcherCondition(ifClause.condition, stateName);
  return bound !== null;
}

function parseLinearExpression(node, stateName) {
  if (!node) {
    return null;
  }

  const numericValue = evaluateStaticNumber(node);
  if (numericValue !== null) {
    return {
      coeff: 0,
      constant: numericValue,
    };
  }

  if (isIdentifier(node, stateName)) {
    return {
      coeff: 1,
      constant: 0,
    };
  }

  if (node.type === "ParenthesisExpression") {
    return parseLinearExpression(node.expression, stateName);
  }

  if (node.type === "UnaryExpression" && node.operator === "-") {
    const argument = parseLinearExpression(node.argument, stateName);
    if (!argument) {
      return null;
    }
    return {
      coeff: -argument.coeff,
      constant: -argument.constant,
    };
  }

  if (node.type !== "BinaryExpression") {
    return null;
  }

  const left = parseLinearExpression(node.left, stateName);
  const right = parseLinearExpression(node.right, stateName);

  switch (node.operator) {
    case "+":
      if (!left || !right) {
        return null;
      }
      return {
        coeff: left.coeff + right.coeff,
        constant: left.constant + right.constant,
      };
    case "-":
      if (!left || !right) {
        return null;
      }
      return {
        coeff: left.coeff - right.coeff,
        constant: left.constant - right.constant,
      };
    case "*": {
      const leftNumeric = evaluateStaticNumber(node.left);
      if (leftNumeric !== null && right) {
        return {
          coeff: right.coeff * leftNumeric,
          constant: right.constant * leftNumeric,
        };
      }

      const rightNumeric = evaluateStaticNumber(node.right);
      if (rightNumeric !== null && left) {
        return {
          coeff: left.coeff * rightNumeric,
          constant: left.constant * rightNumeric,
        };
      }
      return null;
    }
    case "/": {
      const divisor = evaluateStaticNumber(node.right);
      if (divisor === null || divisor === 0 || !left) {
        return null;
      }
      return {
        coeff: left.coeff / divisor,
        constant: left.constant / divisor,
      };
    }
    default:
      return null;
  }
}

function parseLinearStateComparison(left, operator, right, stateName) {
  const leftLinear = parseLinearExpression(left, stateName);
  const rightLinear = parseLinearExpression(right, stateName);
  if (!leftLinear || !rightLinear) {
    return null;
  }

  let coeff = leftLinear.coeff - rightLinear.coeff;
  let constant = leftLinear.constant - rightLinear.constant;
  let normalizedOperator = operator;

  if (!Number.isFinite(coeff) || !Number.isFinite(constant) || coeff === 0) {
    return null;
  }

  if (coeff < 0) {
    coeff = -coeff;
    constant = -constant;
    normalizedOperator =
      operator === "<" ? ">" :
      operator === "<=" ? ">=" :
      operator === ">" ? "<" :
      operator === ">=" ? "<=" :
      operator;
    if (!normalizedOperator) {
      return null;
    }
  }

  const value = -constant / coeff;
  if (!Number.isFinite(value)) {
    return null;
  }

  return {
    kind: flipOperator(normalizedOperator, false),
    value,
  };
}

function parseDispatcherCondition(condition, stateName) {
  if (!condition || condition.type !== "BinaryExpression") {
    return null;
  }

  const { left, operator, right } = condition;

  const linear = parseLinearStateComparison(left, operator, right, stateName);
  if (linear) {
    return linear;
  }

  const direct = parseStateComparison(left, operator, right, stateName);
  if (direct) {
    return direct;
  }

  const inverted = parseStateComparison(right, operator, left, stateName, true);
  if (inverted) {
    return inverted;
  }

  const derived = parseStateMinusComparison(left, operator, right, stateName);
  if (derived) {
    return derived;
  }

  const derivedInverted = parseStateMinusComparison(right, operator, left, stateName, true);
  if (derivedInverted) {
    return derivedInverted;
  }

  return null;
}

function parseStateComparison(left, operator, right, stateName, flip = false) {
  if (!isIdentifier(left, stateName)) {
    return null;
  }

  const rightValue = evaluateStaticNumber(right);
  if (rightValue === null) {
    return null;
  }

  const normalized = flipOperator(operator, flip);
  if (!normalized) {
    return null;
  }

  return {
    kind: normalized,
    value: rightValue,
  };
}

function parseStateMinusComparison(left, operator, right, stateName, flip = false) {
  if (
    !left ||
    left.type !== "BinaryExpression" ||
    left.operator !== "-" ||
    !isIdentifier(left.left, stateName)
  ) {
    return null;
  }

  const offsetValue = evaluateStaticNumber(left.right);
  const rightValue = evaluateStaticNumber(right);
  if (offsetValue === null || rightValue === null) {
    return null;
  }

  if (rightValue !== 0) {
    return null;
  }

  const normalized = flipOperator(operator, flip);
  if (!normalized) {
    return null;
  }

  return {
    kind: normalized,
    value: offsetValue,
  };
}

function flipOperator(operator, flipped) {
  let next = operator;
  if (flipped) {
    if (operator === "<") next = ">";
    else if (operator === "<=") next = ">=";
    else if (operator === ">") next = "<";
    else if (operator === ">=") next = "<=";
  }

  if (next === "<") return "lt";
  if (next === "<=") return "lte";
  if (next === ">") return "gt";
  if (next === ">=") return "gte";
  if (next === "==") return "eq";
  if (next === "~=") return "neq";
  return null;
}

function extractBlockLeaves(statements, stateName, interval = { min: -Infinity, max: Infinity }, leaves = []) {

  if (statements.length === 1 && statements[0].type === "IfStatement") {
    const normalized = normalizeIfStatement(statements[0]);
    if (normalized.clauses.length === 2) {
      const [ifClause, elseClause] = normalized.clauses;
      const condition = parseDispatcherCondition(ifClause.condition, stateName);
      if (condition) {
        const splits = splitIntervalByCondition(interval, condition);
        splits.ifIntervals.forEach((branchInterval) => {
          extractBlockLeaves(ifClause.body, stateName, branchInterval, leaves);
        });
        splits.elseIntervals.forEach((branchInterval) => {
          extractBlockLeaves(elseClause.body, stateName, branchInterval, leaves);
        });
        return leaves;
      }
    }
  }

  leaves.push({
    id: `block_${leaves.length + 1}`,
    interval,
    statements,
  });
  return leaves;
}

function normalizeIfStatement(statement) {
  if (!statement || statement.type !== "IfStatement" || statement.clauses.length <= 2) {
    return statement;
  }

  const [first, ...rest] = statement.clauses;
  const normalizedRest = rest.map((clause) => {
    if (clause.type === "ElseifClause") {
      return {
        type: "IfClause",
        condition: clause.condition,
        body: clause.body,
      };
    }
    return clause;
  });

  const nested = {
    type: "IfStatement",
    clauses: normalizedRest,
  };

  return {
    type: "IfStatement",
    clauses: [
      first,
      {
        type: "ElseClause",
        body: [nested],
      },
    ],
  };
}

function splitIntervalByCondition(interval, condition) {
  const normalized = normalizeCondition(condition);
  if (!normalized) {
    return { ifIntervals: [interval], elseIntervals: [] };
  }

  const ifIntervals = [];
  const elseIntervals = [];

  const appendInterval = (target, next) => {
    if (next.max > next.min) {
      target.push(next);
    }
  };

  if (normalized.kind === "lt") {
    appendInterval(ifIntervals, { min: interval.min, max: Math.min(interval.max, normalized.value) });
    appendInterval(elseIntervals, { min: Math.max(interval.min, normalized.value), max: interval.max });
    return { ifIntervals, elseIntervals };
  }

  if (normalized.kind === "gte") {
    appendInterval(ifIntervals, { min: Math.max(interval.min, normalized.value), max: interval.max });
    appendInterval(elseIntervals, { min: interval.min, max: Math.min(interval.max, normalized.value) });
    return { ifIntervals, elseIntervals };
  }

  if (normalized.kind === "eq") {
    const upper = nextDiscreteValue(normalized.value);
    appendInterval(ifIntervals, { min: Math.max(interval.min, normalized.value), max: Math.min(interval.max, upper) });
    appendInterval(elseIntervals, { min: interval.min, max: Math.min(interval.max, normalized.value) });
    appendInterval(elseIntervals, { min: Math.max(interval.min, upper), max: interval.max });
    return { ifIntervals, elseIntervals };
  }

  if (normalized.kind === "neq") {
    const upper = nextDiscreteValue(normalized.value);
    appendInterval(elseIntervals, { min: Math.max(interval.min, normalized.value), max: Math.min(interval.max, upper) });
    appendInterval(ifIntervals, { min: interval.min, max: Math.min(interval.max, normalized.value) });
    appendInterval(ifIntervals, { min: Math.max(interval.min, upper), max: interval.max });
    return { ifIntervals, elseIntervals };
  }

  return { ifIntervals: [interval], elseIntervals: [] };
}

function normalizeCondition(condition) {
  if (!condition || typeof condition !== "object") {
    return null;
  }

  if (condition.kind === "lt") {
    return { kind: "lt", value: condition.value };
  }
  if (condition.kind === "lte") {
    return { kind: "lt", value: nextDiscreteValue(condition.value) };
  }
  if (condition.kind === "gt") {
    return { kind: "gte", value: nextDiscreteValue(condition.value) };
  }
  if (condition.kind === "gte") {
    return { kind: "gte", value: condition.value };
  }
  if (condition.kind === "eq") {
    return { kind: "eq", value: condition.value };
  }
  if (condition.kind === "neq") {
    return { kind: "neq", value: condition.value };
  }
  return null;
}

function nextDiscreteValue(value) {
  if (Number.isInteger(value)) {
    return value + 1;
  }
  return value;
}

function resolveLeafForState(leaves, value) {
  return leaves.find((leaf) => value >= leaf.interval.min && value < leaf.interval.max) || null;
}

function clone(value) {
  return cloneNode(value);
}

function createCacheKeyFactory() {
  const nodeIds = new WeakMap();
  let nextId = 1;

  const idForValue = (value) => {
    if (value && typeof value === "object") {
      if (!nodeIds.has(value)) {
        nodeIds.set(value, nextId);
        nextId += 1;
      }
      return `o${nodeIds.get(value)}`;
    }

    return `${typeof value}:${String(value)}`;
  };

  return (stateValue, wrapperName, depsValues) => {
    const depsKey = depsValues.map(idForValue).join(",");
    return `${wrapperName}:${stateValue}:${depsKey}`;
  };
}

function substitute(node, aliases, depth = 0) {
  if (depth > 8) {
    return node;
  }
  return transformNode(node, (current) => {
    if (current && current.type === "Identifier" && aliases.has(current.name)) {
      const replacement = aliases.get(current.name);
      if (statementReferencesIdentifier(replacement, current.name)) {
        return current;
      }
      return {
          _skipChildren: true,
          node: substitute(clone(replacement), aliases, depth + 1),
      };
    }
    return current;
  });
}

function isPureExpression(node) {
  if (!node) {
    return false;
  }

  switch (node.type) {
    case "Identifier":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return true;
    case "UnaryExpression":
      return isPureExpression(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isPureExpression(node.left) && isPureExpression(node.right);
    case "IndexExpression":
      return isPureExpression(node.base) && isPureExpression(node.index);
    case "MemberExpression":
      return isPureExpression(node.base);
    case "TableConstructorExpression":
      return node.fields.every((field) => {
        if (field.type === "TableValue") {
          return isPureExpression(field.value);
        }
        return isPureExpression(field.key) && isPureExpression(field.value);
      });
    default:
      return false;
  }
}

function statementReferencesIdentifier(statement, name) {
  if (!statement || typeof statement !== "object") {
    return false;
  }

  if (Array.isArray(statement)) {
    return statement.some((entry) => statementReferencesIdentifier(entry, name));
  }

  switch (statement.type) {
    case "Identifier":
      return statement.name === name;
    case "LocalStatement":
      return statement.init.some((expression) => statementReferencesIdentifier(expression, name));
    case "FunctionDeclaration":
      if (
        (statement.identifier && statement.identifier.name === name) ||
        (statement.parameters && statement.parameters.some((parameter) => parameter.type === "Identifier" && parameter.name === name))
      ) {
        return false;
      }
      return statement.body.some((entry) => statementReferencesIdentifier(entry, name));
    default:
      return Object.entries(statement).some(([key, value]) => {
        if (key === "variables" || key === "identifier" || key === "parameters") {
          return false;
        }
        return statementReferencesIdentifier(value, name);
      });
  }
}

function collectIdentifierUsage(node, usage) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((entry) => collectIdentifierUsage(entry, usage));
    return;
  }

  if (node.type === "Identifier") {
    usage.set(node.name, (usage.get(node.name) || 0) + 1);
    return;
  }

  for (const value of Object.values(node)) {
    collectIdentifierUsage(value, usage);
  }
}

function buildUsageMap(statements) {
  const usage = new Map();
  statements.forEach((statement) => {
    if (statement.type === "AssignmentStatement") {
      statement.init.forEach((expression) => collectIdentifierUsage(expression, usage));
      statement.variables.forEach((variable) => {
        if (variable.type !== "Identifier") {
          collectIdentifierUsage(variable, usage);
        }
      });
      return;
    }

    collectIdentifierUsage(statement, usage);
  });
  return usage;
}

function consumeStatementReads(statement, usage) {
  const decrement = (name) => {
    const current = usage.get(name) || 0;
    if (current <= 1) {
      usage.delete(name);
      return;
    }
    usage.set(name, current - 1);
  };

  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (node.type === "Identifier") {
      decrement(node.name);
      return;
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  };

  if (statement.type === "AssignmentStatement") {
    statement.init.forEach(visit);
    statement.variables.forEach((variable) => {
      if (variable.type !== "Identifier") {
        visit(variable);
      }
    });
    return;
  }

  visit(statement);
}

function createCallStatement(expression) {
  return {
    type: "CallStatement",
    expression,
  };
}

function createReturnStatement(argumentsList) {
  return {
    type: "ReturnStatement",
    arguments: argumentsList,
  };
}

function isEnvLookup(node, envName) {
  return (
    node &&
    node.type === "IndexExpression" &&
    isIdentifier(node.base, envName) &&
    isStringLiteral(node.index)
  );
}

function maybePromoteGlobalLookup(node, envName) {
  if (!isEnvLookup(node, envName)) {
    return node;
  }

  const name = node.index.value;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      type: "Identifier",
      name,
    };
  }

  return node;
}

function simplifyBlock(leaf, meta) {

  const statements = leaf.statements.map(clone);
  const usage = buildUsageMap(statements);
  const aliases = new Map();
  const emitted = [];
  let terminator = {
    kind: "exit",
    expression: null,
  };
  let returnExpression = null;

  for (const statement of statements) {

    consumeStatementReads(statement, usage);

    if (statement.type === "IfStatement") {
      const branchTerminator = extractStateIfTerminator(statement, meta);
      if (branchTerminator) {
        terminator = branchTerminator;
        continue;
      }
    }

    if (statement.type !== "AssignmentStatement" || statement.variables.length !== 1 || statement.init.length !== 1) {
      emitted.push(statement);
      continue;
    }

    const [target] = statement.variables;
    const [value] = statement.init;
    const simplifiedValue = maybePromoteGlobalLookup(substitute(value, aliases), meta.envName);

    if (target.type !== "Identifier") {
      emitted.push({
        type: "AssignmentStatement",
        variables: [target],
        init: [simplifiedValue],
      });
      continue;
    }

    if (target.name === meta.returnName && simplifiedValue.type === "TableConstructorExpression") {
      returnExpression = simplifiedValue;
      aliases.set(target.name, simplifiedValue);
      continue;
    }

    if (target.name === meta.stateName) {
      aliases.set(target.name, simplifiedValue);
      terminator = parseTerminator(simplifiedValue, meta, leaf.interval);
      continue;
    }

    if (simplifiedValue.type === "CallExpression") {
      if ((usage.get(target.name) || 0) === 0) {
        emitted.push(createCallStatement(simplifiedValue));
        continue;
      }
    }

    if (isPureExpression(simplifiedValue)) {
      aliases.set(target.name, simplifiedValue);
      continue;
    }

    emitted.push({
      type: "LocalStatement",
      variables: [clone(target)],
      init: [simplifiedValue],
    });
    aliases.set(target.name, clone(target));
  }

  return {
    id: leaf.id,
    emitted,
    returnExpression,
    terminator,
  };
}

function extractStateIfTerminator(statement, meta) {
  if (!statement || statement.type !== "IfStatement" || statement.clauses.length !== 2) {
    return null;
  }

  const [ifClause, elseClause] = statement.clauses;
  if (ifClause.type !== "IfClause" || elseClause.type !== "ElseClause") {
    return null;
  }

  const ifAssignment = ifClause.body.length === 1 ? ifClause.body[0] : null;
  const elseAssignment = elseClause.body.length === 1 ? elseClause.body[0] : null;
  if (
    !ifAssignment ||
    !elseAssignment ||
    ifAssignment.type !== "AssignmentStatement" ||
    elseAssignment.type !== "AssignmentStatement" ||
    ifAssignment.variables.length !== 1 ||
    elseAssignment.variables.length !== 1 ||
    ifAssignment.init.length !== 1 ||
    elseAssignment.init.length !== 1 ||
    ifAssignment.variables[0].type !== "Identifier" ||
    elseAssignment.variables[0].type !== "Identifier" ||
    ifAssignment.variables[0].name !== meta.stateName ||
    elseAssignment.variables[0].name !== meta.stateName
  ) {
    return null;
  }

  const trueState = evaluateStaticNumber(ifAssignment.init[0]);
  const falseState = evaluateStaticNumber(elseAssignment.init[0]);
  if (trueState === null || falseState === null) {
    return null;
  }

  return {
    kind: "branch",
    condition: ifClause.condition,
    trueState,
    falseState,
  };
}

function parseTerminator(expression, meta) {
  const numericValue = evaluateStaticNumber(expression);
  if (numericValue !== null) {
    return {
      kind: "jump",
      targetState: numericValue,
    };
  }

  if (expression.type === "LogicalExpression" && expression.operator === "or") {
    const falseBranch = expression.right;
    const trueBranchExpression = expression.left;
    const falseState = evaluateStaticNumber(falseBranch);
    if (
      trueBranchExpression.type === "LogicalExpression" &&
      trueBranchExpression.operator === "and" &&
      evaluateStaticNumber(trueBranchExpression.right) !== null &&
      falseState !== null
    ) {
      return {
        kind: "branch",
        condition: trueBranchExpression.left,
        trueState: evaluateStaticNumber(trueBranchExpression.right),
        falseState,
      };
    }
  }

  if (expression.type === "BooleanLiteral" && expression.value === false) {
    return {
      kind: "exit",
      expression,
    };
  }

  if (isExitExpression(expression, meta.envName)) {
    return {
      kind: "exit",
      expression,
    };
  }

  return {
    kind: "exit",
    expression,
  };
}

function firstSharedSuccessor(branchA, branchB, blocksById) {
  const pathA = traceLinearPath(branchA, blocksById);
  const pathB = new Set(traceLinearPath(branchB, blocksById));
  return pathA.find((blockId) => pathB.has(blockId)) || null;
}

function traceLinearPath(startId, blocksById) {

  const path = [];
  let currentId = startId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {

    visited.add(currentId);
    path.push(currentId);
    const block = blocksById.get(currentId);
    if (!block || block.terminator.kind !== "jump") {
      break;
    }
    currentId = block.terminator.target;
  }

  return path;
}

function appendStatements(target, statements) {
  statements.forEach((statement) => target.push(statement));
}

function buildLinearSegment(blockId, blocksById, stopId, visited) {

  const output = [];
  let currentId = blockId;

  while (currentId && currentId !== stopId && !visited.has(currentId)) {

    visited.add(currentId);
    const block = blocksById.get(currentId);
    if (!block) {
      break;
    }

    appendStatements(output, block.emitted);

    if (block.terminator.kind === "branch") {
      const trueTarget = block.terminator.trueTarget;
      const falseTarget = block.terminator.falseTarget;
      const mergeTarget = firstSharedSuccessor(trueTarget, falseTarget, blocksById);
      const branchVisited = new Set(visited);
      const thenBody = buildLinearSegment(trueTarget, blocksById, mergeTarget, branchVisited);
      const elseBody = buildLinearSegment(falseTarget, blocksById, mergeTarget, branchVisited);
      output.push(createIfStatement(block.terminator.condition, thenBody, elseBody));
      currentId = mergeTarget;
      continue;
    }

    if (block.terminator.kind === "jump") {
      currentId = block.terminator.target;
      continue;
    }

    if (block.returnExpression && block.returnExpression.type === "TableConstructorExpression") {
      const returnArgs = block.returnExpression.fields
        .filter((field) => field.type === "TableValue")
        .map((field) => field.value);
      output.push(createReturnStatement(returnArgs));
    } else if (block.returnExpression) {
      output.push(createReturnStatement([block.returnExpression]));
    }
    break;
  }

  return output;
}

function createIfStatement(condition, thenBody, elseBody) {
  const clauses = [
    {
      type: "IfClause",
      condition,
      body: thenBody,
    },
  ];

  if (elseBody.length > 0) {
    clauses.push({
      type: "ElseClause",
      body: elseBody,
    });
  }

  return {
    type: "IfStatement",
    clauses,
  };
}

function isLiteralInteger(node) {
  return node && node.type === "NumericLiteral" && Number.isInteger(node.value);
}

function extractTableValues(node) {
  if (!node || node.type !== "TableConstructorExpression") {
    return null;
  }

  const values = [];
  for (const field of node.fields) {
    if (field.type !== "TableValue") {
      return null;
    }
    values.push(field.value);
  }
  return values;
}

function extractWrapperFactories(helperAssignment) {
  const wrappers = new Map();

  for (let index = 0; index < helperAssignment.init.length; index += 1) {
    const initializer = helperAssignment.init[index];
    const variable = helperAssignment.variables[index];
    if (!initializer || initializer.type !== "FunctionDeclaration") {
      continue;
    }

    const fixedParameters = initializer.parameters.filter((parameter) => parameter.type === "Identifier");
    if (
      fixedParameters.length !== 2 ||
      initializer.parameters.length > 3 ||
      (initializer.parameters.length === 3 && initializer.parameters[2].type !== "VarargLiteral")
    ) {
      continue;
    }

    if (initializer.body.length !== 3) {
      continue;
    }

    const [retainStatement, closureStatement, returnStatement] = initializer.body;
    if (
      !retainStatement ||
      retainStatement.type !== "LocalStatement" ||
      retainStatement.variables.length !== 1 ||
      retainStatement.init.length !== 1 ||
      retainStatement.init[0].type !== "CallExpression" ||
      !closureStatement ||
      closureStatement.type !== "LocalStatement" ||
      closureStatement.variables.length !== 1 ||
      closureStatement.init.length !== 1 ||
      closureStatement.init[0].type !== "FunctionDeclaration" ||
      !returnStatement ||
      returnStatement.type !== "ReturnStatement" ||
      returnStatement.arguments.length !== 1 ||
      returnStatement.arguments[0].type !== "Identifier" ||
      returnStatement.arguments[0].name !== closureStatement.variables[0].name
    ) {
      continue;
    }

    const closure = closureStatement.init[0];
    if (
      closure.body.length !== 1 ||
      closure.body[0].type !== "ReturnStatement" ||
      closure.body[0].arguments.length !== 1 ||
      closure.body[0].arguments[0].type !== "CallExpression"
    ) {
      continue;
    }

    const callExpression = closure.body[0].arguments[0];
    if (callExpression.arguments.length !== 4 || callExpression.base.type !== "Identifier") {
      continue;
    }

    const [stateArgument, argsArgument, depsArgument, retainArgument] = callExpression.arguments;
    const argsValues = extractTableValues(argsArgument);
    const closureFixedParameters = closure.parameters.filter((parameter) => parameter.type === "Identifier");
    const closureHasVararg =
      closure.parameters.length > 0 &&
      closure.parameters[closure.parameters.length - 1].type === "VarargLiteral";
    if (
      !argsValues ||
      depsArgument.type !== "Identifier" ||
      depsArgument.name !== fixedParameters[1].name ||
      retainArgument.type !== "Identifier" ||
      retainArgument.name !== retainStatement.variables[0].name ||
      stateArgument.type !== "Identifier" ||
      stateArgument.name !== fixedParameters[0].name
    ) {
      continue;
    }

    const isVararg =
      argsValues.length === 1 &&
      argsValues[0].type === "VarargLiteral" &&
      closure.parameters.length === 1 &&
      closure.parameters[0].type === "VarargLiteral";

    const fixedArity =
      !isVararg &&
      argsValues.length === closureFixedParameters.length &&
      argsValues.every((value, paramIndex) => {
        return (
          value.type === "Identifier" &&
          closureFixedParameters[paramIndex] &&
          value.name === closureFixedParameters[paramIndex].name
        );
      });

    if (!isVararg && (!fixedArity || (!closureHasVararg && closure.parameters.length !== closureFixedParameters.length))) {
      continue;
    }

    wrappers.set(variable.name, {
      name: variable.name,
      dispatcherName: callExpression.base.name,
      arity: isVararg ? null : closureFixedParameters.length,
      isVararg,
    });
  }

  return wrappers;
}

function findMaxArrayIndex(node, arrayName) {
  let maxIndex = 0;

  const visit = (current) => {
    if (!current || typeof current !== "object") {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    if (
      current.type === "IndexExpression" &&
      current.base.type === "Identifier" &&
      current.base.name === arrayName &&
      isLiteralInteger(current.index) &&
      current.index.value > maxIndex
    ) {
      maxIndex = current.index.value;
    }

    for (const value of Object.values(current)) {
      visit(value);
    }
  };

  visit(node);
  return maxIndex;
}

function createFunctionExpression(parameters, body) {
  return {
    type: "FunctionDeclaration",
    identifier: null,
    isLocal: false,
    parameters,
    body,
  };
}

function transformNode(node, visitor) {

  if (!node || typeof node !== "object") {
    return node;
  }

  const applyVisitor = (value, parent) => {
    if (!value || typeof value !== "object") {
      return value;
    }
    const result = visitor(value, parent);
    if (result && result._skipChildren) {
        return result;
    }
    return result;
  };

  const rootResult = applyVisitor(node, null);
  const root = rootResult && rootResult._skipChildren ? rootResult.node : rootResult;

  if (!root || typeof root !== "object" || (rootResult && rootResult._skipChildren)) {
    return root;
  }

  const rootTarget = Array.isArray(root) ? new Array(root.length) : {};
  const stack = [{
    index: 0,
    source: root,
    target: rootTarget,
    parentNode: null,
    entries: Array.isArray(root) ? null : Object.entries(root),
  }];

  while (stack.length > 0) {

    const frame = stack[stack.length - 1];
    const parentNode = Array.isArray(frame.source) ? frame.parentNode : frame.source;

    if (Array.isArray(frame.source)) {
      if (frame.index >= frame.source.length) {
        stack.pop();
        continue;
      }

      const childIndex = frame.index;
      frame.index += 1;

      const childResult = applyVisitor(frame.source[childIndex], parentNode);
      const child = childResult && childResult._skipChildren ? childResult.node : childResult;

      if (!child || typeof child !== "object" || (childResult && childResult._skipChildren)) {
        frame.target[childIndex] = child;
        continue;
      }

      const childTarget = Array.isArray(child) ? new Array(child.length) : {};
      frame.target[childIndex] = childTarget;
      stack.push({
        index: 0,
        source: child,
        target: childTarget,
        parentNode: parentNode,
        entries: Array.isArray(child) ? null : Object.entries(child),
      });
      continue;
    }

    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }

    const [key, rawChild] = frame.entries[frame.index];
    frame.index += 1;

    const childResult = applyVisitor(rawChild, parentNode);
    const child = childResult && childResult._skipChildren ? childResult.node : childResult;

    if (!child || typeof child !== "object" || (childResult && childResult._skipChildren)) {
      frame.target[key] = child;
      continue;
    }

    const childTarget = Array.isArray(child) ? new Array(child.length) : {};
    frame.target[key] = childTarget;
    stack.push({
      index: 0,
      source: child,
      target: childTarget,
      parentNode: parentNode,
      entries: Array.isArray(child) ? null : Object.entries(child),
    });
  }

  return rootTarget;
}

function buildFunctionForState(stateValue, wrapper, depsValues, context, cache, stack) {

  const cacheKey = context.makeCacheKey(stateValue, wrapper.name, depsValues);
  const stackKey = `${wrapper.name}:${stateValue}`;

  if (cache.has(cacheKey)) {
    return clone(cache.get(cacheKey));
  }

  if (stack.has(stackKey)) {
    return null;
  }

  const startLeaf = resolveLeafForState(context.leaves, stateValue);
  if (!startLeaf) {
    return null;
  }

  stack.add(stackKey);

  const statements = buildLinearSegment(startLeaf.id, context.blocksById, null, new Set()).map(clone);
  const argArrayName = context.vm.container.parameters[1].name;
  const depsArrayName = context.vm.container.parameters[2].name;

  const maxArgIndex = findMaxArrayIndex(statements, argArrayName);
  const fixedParameters = wrapper.isVararg
    ? []
    : Array.from({ length: wrapper.arity }, (_, parameterIndex) => ({
        type: "Identifier",
        name: `arg_${parameterIndex + 1}`,
      }));
  const argLocals = wrapper.isVararg
    ? Array.from({ length: maxArgIndex }, (_, parameterIndex) => ({
        type: "Identifier",
        name: `arg_${parameterIndex + 1}`,
      }))
    : [];

  const transformedStatements = transformNode(statements, (current) => {
    if (
      current &&
      current.type === "IndexExpression" &&
      current.base.type === "Identifier" &&
      current.base.name === argArrayName &&
      isLiteralInteger(current.index)
    ) {
      const parameterIndex = current.index.value - 1;
      if (wrapper.isVararg) {
        if (parameterIndex >= 0 && parameterIndex < argLocals.length) {
          return clone(argLocals[parameterIndex]);
        }
        return {
          type: "NilLiteral",
          value: null,
          raw: "nil",
        };
      }

      if (parameterIndex >= 0 && parameterIndex < fixedParameters.length) {
        return clone(fixedParameters[parameterIndex]);
      }
    }

    if (
      current &&
      current.type === "IndexExpression" &&
      current.base.type === "Identifier" &&
      current.base.name === depsArrayName &&
      isLiteralInteger(current.index)
    ) {
      const dependencyIndex = current.index.value - 1;
      if (dependencyIndex >= 0 && dependencyIndex < depsValues.length) {
        return clone(depsValues[dependencyIndex]);
      }
    }

    if (
      current &&
      current.type === "CallExpression" &&
      current.base.type === "Identifier" &&
      context.wrappers.has(current.base.name) &&
      current.arguments.length === 2 &&
      isLiteralInteger(current.arguments[0])
    ) {
      const nestedWrapper = context.wrappers.get(current.base.name);
      const nestedDeps = extractTableValues(current.arguments[1]);
      if (nestedDeps) {
        const nestedFunction = buildFunctionForState(
          current.arguments[0].value,
          nestedWrapper,
          nestedDeps,
          context,
          cache,
          stack,
        );
        if (nestedFunction) {
          return nestedFunction;
        }
      }
    }

    return current;
  });

  const body = wrapper.isVararg && argLocals.length > 0
    ? [
        {
          type: "LocalStatement",
          variables: argLocals.map(clone),
          init: [{ type: "VarargLiteral", value: null, raw: "..." }],
        },
        ...transformedStatements,
      ]
    : transformedStatements;

  const functionExpression = createFunctionExpression(
    wrapper.isVararg ? [{ type: "VarargLiteral", value: null, raw: "..." }] : fixedParameters,
    body,
  );

  cache.set(cacheKey, functionExpression);
  stack.delete(stackKey);
  return clone(functionExpression);
}

function inlineWrapperFactories(statements, context) {
  const cache = new Map();

  return transformNode(statements, (current) => {
    if (
      current &&
      current.type === "CallExpression" &&
      current.base.type === "Identifier" &&
      context.wrappers.has(current.base.name) &&
      current.arguments.length === 2 &&
      isLiteralInteger(current.arguments[0])
    ) {
      const wrapper = context.wrappers.get(current.base.name);
      const depsValues = extractTableValues(current.arguments[1]);
      if (!depsValues) {
        return current;
      }

      const functionExpression = buildFunctionForState(
        current.arguments[0].value,
        wrapper,
        depsValues,
        context,
        cache,
        new Set(),
      );

      if (functionExpression) {
        return functionExpression;
      }
    }

    return current;
  });
}

function identifySlotHelpers(helperAssignment) {

  const result = {
    allocatorName: null,
    releaseManyName: null,
    releaseName: null,
    slotTableName: null,
  };

  for (let index = 0; index < helperAssignment.init.length; index += 1) {

    const initializer = helperAssignment.init[index];
    const variable = helperAssignment.variables[index];
    if (!initializer || initializer.type !== "FunctionDeclaration") {
      continue;
    }

    const fixedParameters = initializer.parameters.filter((parameter) => parameter.type === "Identifier");
    const hasTrailingVararg =
      initializer.parameters.length > 0 &&
      initializer.parameters[initializer.parameters.length - 1].type === "VarargLiteral";

    if (
      !result.allocatorName &&
      fixedParameters.length === 0 &&
      (initializer.parameters.length === 0 || (initializer.parameters.length === 1 && hasTrailingVararg)) &&
      initializer.body.length === 3 &&
      initializer.body[0].type === "AssignmentStatement" &&
      initializer.body[1].type === "AssignmentStatement" &&
      initializer.body[2].type === "ReturnStatement" &&
      initializer.body[2].arguments.length === 1 &&
      initializer.body[2].arguments[0].type === "Identifier"
    ) {
      const counterName = initializer.body[2].arguments[0].name;
      const incrementTarget = initializer.body[0].variables[0];
      const slotTarget = initializer.body[1].variables[0];
      if (
        incrementTarget.type === "Identifier" &&
        incrementTarget.name === counterName &&
        slotTarget.type === "IndexExpression" &&
        slotTarget.index.type === "Identifier" &&
        slotTarget.index.name === counterName
      ) {
        result.allocatorName = variable.name;
      }
    }

    if (
      !result.releaseName &&
      fixedParameters.length === 1 &&
      initializer.parameters.length <= 2 &&
      (initializer.parameters.length === 1 || hasTrailingVararg) &&
      initializer.body.length >= 2 &&
      initializer.body[0].type === "AssignmentStatement" &&
      initializer.body[1].type === "IfStatement"
    ) {
      const parameterName = fixedParameters[0].name;
      const firstTarget = initializer.body[0].variables[0];
      const ifStatement = initializer.body[1];
      if (
        firstTarget.type === "IndexExpression" &&
        firstTarget.index.type === "Identifier" &&
        firstTarget.index.name === parameterName &&
        ifStatement.clauses.length >= 1 &&
        ifStatement.clauses[0].type === "IfClause"
      ) {
        const nilAssignment = ifStatement.clauses[0].body.find((statement) => {
          return (
            statement.type === "AssignmentStatement" &&
            statement.variables.length === 2 &&
            statement.variables.every((entry) => {
              return (
                entry.type === "IndexExpression" &&
                entry.index.type === "Identifier" &&
                entry.index.name === parameterName &&
                entry.base.type === "Identifier"
              );
            })
          );
        });

        if (nilAssignment) {
          result.releaseName = variable.name;
          result.slotTableName = nilAssignment.variables[1].base.name;
        }
      }
    }

    if (
      !result.releaseManyName &&
      fixedParameters.length === 1 &&
      initializer.parameters.length <= 2 &&
      (initializer.parameters.length === 1 || hasTrailingVararg) &&
      initializer.body.some((statement) => statement.type === "WhileStatement")
    ) {
      result.releaseManyName = variable.name;
    }
  }

  return result;
}

function collapseSlotExpressions(node, state) {
  return transformNode(node, (current) => {
    if (
      current &&
      current.type === "IndexExpression" &&
      current.base.type === "Identifier" &&
      current.base.name === state.slotTableName &&
      current.index.type === "Identifier" &&
      state.slotBindings.has(current.index.name)
    ) {
      return clone(state.slotBindings.get(current.index.name));
    }

    if (current && current.type === "FunctionDeclaration") {
      const nestedBody = collapseVirtualSlots(current.body, {
        allocatorName: state.allocatorName,
        localCounter: 1,
        releaseManyName: state.releaseManyName,
        releaseName: state.releaseName,
        slotBindings: new Map(state.slotBindings),
        slotTableName: state.slotTableName,
      });
      return {
        ...current,
        body: nestedBody,
      };
    }

    return current;
  });
}

function collapseVirtualSlots(statements, options) {

  const state = {
    allocatorName: options.allocatorName,
    localCounter: options.localCounter || 1,
    pendingSlots: new Set(),
    releaseManyName: options.releaseManyName,
    releaseName: options.releaseName,
    slotBindings: options.slotBindings || new Map(),
    slotTableName: options.slotTableName,
  };

  const output = [];

  const nextLocalIdentifier = () => {
    const identifier = {
      type: "Identifier",
      name: `v_${state.localCounter}`,
    };
    state.localCounter += 1;
    return identifier;
  };

  for (const statement of statements) {

    const transformed = collapseSlotExpressions(statement, state);

    if (
      transformed.type === "CallStatement" &&
      transformed.expression.type === "CallExpression" &&
      transformed.expression.base.type === "Identifier" &&
      (
        transformed.expression.base.name === state.releaseName ||
        transformed.expression.base.name === state.releaseManyName
      )
    ) {
      continue;
    }

    if (
      transformed.type === "LocalStatement" &&
      transformed.variables.length === 1 &&
      transformed.init.length === 1 &&
      transformed.init[0].type === "CallExpression" &&
      transformed.init[0].base.type === "Identifier" &&
      transformed.init[0].base.name === state.allocatorName
    ) {
      state.pendingSlots.add(transformed.variables[0].name);
      continue;
    }

    if (
      transformed.type === "AssignmentStatement" &&
      transformed.variables.length === 1 &&
      transformed.variables[0].type === "Identifier" &&
      transformed.init.length === 1 &&
      transformed.init[0].type === "CallExpression" &&
      transformed.init[0].base.type === "Identifier" &&
      transformed.init[0].base.name === state.allocatorName
    ) {
      state.pendingSlots.add(transformed.variables[0].name);
      continue;
    }

    if (
      (transformed.type === "LocalStatement" || transformed.type === "AssignmentStatement") &&
      transformed.variables.length === 1 &&
      transformed.init.length === 1 &&
      transformed.variables[0].type === "Identifier" &&
      transformed.init[0].type === "CallExpression" &&
      transformed.init[0].base.type === "Identifier" &&
      transformed.init[0].base.name === state.releaseName &&
      transformed.init[0].arguments.length === 1 &&
      transformed.init[0].arguments[0].type === "Identifier"
    ) {
      continue;
    }

    if (
      transformed.type === "AssignmentStatement" &&
      transformed.variables.length === 1 &&
      transformed.variables[0].type === "IndexExpression" &&
      transformed.variables[0].base.type === "Identifier" &&
      transformed.variables[0].base.name === state.slotTableName &&
      transformed.variables[0].index.type === "Identifier"
    ) {
      const slotName = transformed.variables[0].index.name;
      const initializer = transformed.init.length === 1 ? transformed.init[0] : null;
      if (!initializer) {
        output.push(transformed);
        continue;
      }

      if (!state.slotBindings.has(slotName) && state.pendingSlots.has(slotName)) {
        state.pendingSlots.delete(slotName);
        const localIdentifier = nextLocalIdentifier();
        state.slotBindings.set(slotName, localIdentifier);
        output.push({
          type: "LocalStatement",
          variables: [clone(localIdentifier)],
          init: [initializer],
        });
        continue;
      }

      if (state.slotBindings.has(slotName)) {
        output.push({
          type: "AssignmentStatement",
          variables: [clone(state.slotBindings.get(slotName))],
          init: [initializer],
        });
        continue;
      }
    }

    if (transformed.type === "IfStatement") {
      output.push({
        ...transformed,
        clauses: transformed.clauses.map((clause) => ({
          ...clause,
          body: collapseVirtualSlots(clause.body, {
            allocatorName: state.allocatorName,
            localCounter: state.localCounter,
            releaseManyName: state.releaseManyName,
            releaseName: state.releaseName,
            slotBindings: new Map(state.slotBindings),
            slotTableName: state.slotTableName,
          }),
        })),
      });
      continue;
    }

    output.push(transformed);
  }

  return output;
}

function extractReturnTargetName(node) {
  if (!node || typeof node !== "object") {
    return null;
  }

  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "ParenthesisExpression") {
    return extractReturnTargetName(node.expression);
  }

  if (
    node.type === "BinaryExpression" &&
    ["+", "-", "*", "/", "%", "^", ".."].includes(node.operator)
  ) {
    if (node.left && node.left.type === "Identifier" && isStringLiteral(node.right)) {
      return node.left.name;
    }
    if (node.right && node.right.type === "Identifier" && isStringLiteral(node.left)) {
      return node.right.name;
    }
  }

  return null;
}

function findContainerIndexInAssignment(statement) {
  if (!statement || (statement.type !== "AssignmentStatement" && statement.type !== "LocalStatement")) {
    return -1;
  }

  return statement.init.findIndex((initializer) => {
    return (
      initializer.type === "FunctionDeclaration" &&
      initializer.parameters.length >= 4 &&
      initializer.body.some((entry) => entry.type === "WhileStatement")
    );
  });
}

function findContainerFunction(ast) {

  const returnStatement = [...ast.body].reverse().find((statement) => {
    return (
      statement.type === "ReturnStatement" &&
      statement.arguments.length === 1 &&
      statement.arguments[0].type === "CallExpression" &&
      statement.arguments[0].base.type === "FunctionDeclaration"
    );
  });

  if (!returnStatement) {
    return null;
  }

  const outerCall = returnStatement.arguments[0];
  let outerFunction = outerCall.base;
  if (!outerFunction || outerFunction.type !== "FunctionDeclaration") {
    return null;
  }

  let helperAssignment = null;
  let containerIndex = -1;

  for (let depth = 0; depth < 3; depth += 1) {

    if (outerFunction.body.length >= 1) {
      const candidate = outerFunction.body[0];
      containerIndex = findContainerIndexInAssignment(candidate);
      if (containerIndex >= 0) {
        helperAssignment = candidate;
        break;
      }
    }

    const nestedReturn = outerFunction.body[outerFunction.body.length - 1];
    if (
      !nestedReturn ||
      nestedReturn.type !== "ReturnStatement" ||
      nestedReturn.arguments.length !== 1 ||
      nestedReturn.arguments[0].type !== "CallExpression" ||
      nestedReturn.arguments[0].base.type !== "FunctionDeclaration"
    ) {
      return null;
    }

    outerFunction = nestedReturn.arguments[0].base;
  }

  if (!helperAssignment || containerIndex < 0) {
    return null;
  }

  const containerName = helperAssignment.variables[containerIndex].name;
  const container = helperAssignment.init[containerIndex];
  const outerReturn = outerFunction.body[outerFunction.body.length - 1];
  if (outerReturn.type !== "ReturnStatement" || outerReturn.arguments.length !== 1) {
    return null;
  }

  const [outerReturnExpression] = outerReturn.arguments;
  if (
    outerReturnExpression.type !== "CallExpression" ||
    (outerReturnExpression.base.type !== "CallExpression" && outerReturnExpression.base.type !== "FunctionDeclaration")
  ) {
    return null;
  }

  if (outerReturnExpression.base.type === "CallExpression") {
      if (
        outerReturnExpression.base.arguments.length < 1 ||
        evaluateStaticNumber(outerReturnExpression.base.arguments[0]) === null
      ) {
        return null;
      }
  }

  const finalReturnStatement = container.body[container.body.length - 1];
  const returnName =
    finalReturnStatement &&
    finalReturnStatement.type === "ReturnStatement" &&
    finalReturnStatement.arguments.length === 1 &&
    finalReturnStatement.arguments[0].type === "CallExpression" &&
    finalReturnStatement.arguments[0].arguments.length === 1
      ? extractReturnTargetName(finalReturnStatement.arguments[0].arguments[0])
      : null;
  if (
    finalReturnStatement.type !== "ReturnStatement" ||
    finalReturnStatement.arguments.length !== 1 ||
    finalReturnStatement.arguments[0].type !== "CallExpression"
  ) {
    return null;
  }

  return {
    ast,
    container,
    containerName,
    envName: outerFunction.parameters[0].name,
    helperAssignment,
    outerFunction,
    returnName,
    startState: evaluateStaticNumber(outerReturnExpression.base.arguments[0]),
    stateName: container.parameters[0].name,
    whileStatement: container.body.find((statement) => statement.type === "WhileStatement"),
  };
}

function devirtualizePrometheusVm(ast) {
  const vm = findContainerFunction(ast);
  if (!vm || !vm.whileStatement) {
    return {
      ast,
      changed: false,
    };
  }

  const leaves = extractBlockLeaves(vm.whileStatement.body, vm.stateName);
  const blocks = leaves.map((leaf) => simplifyBlock(leaf, vm));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));

  for (const block of blocks) {
    if (block.terminator.kind === "jump") {
      const targetLeaf = resolveLeafForState(leaves, block.terminator.targetState);
      block.terminator.target = targetLeaf ? targetLeaf.id : null;
      continue;
    }

    if (block.terminator.kind === "branch") {
      const trueLeaf = resolveLeafForState(leaves, block.terminator.trueState);
      const falseLeaf = resolveLeafForState(leaves, block.terminator.falseState);
      block.terminator.trueTarget = trueLeaf ? trueLeaf.id : null;
      block.terminator.falseTarget = falseLeaf ? falseLeaf.id : null;
    }
  }

  const startLeaf = resolveLeafForState(leaves, vm.startState);
  if (!startLeaf) {
    return {
      ast,
      changed: false,
    };
  }

  const wrapperContext = {
    blocksById,
    leaves,
    vm,
    wrappers: extractWrapperFactories(vm.helperAssignment),
    makeCacheKey: createCacheKeyFactory(),
  };

  let statements = buildLinearSegment(startLeaf.id, blocksById, null, new Set());
  try {
    statements = inlineWrapperFactories(statements, wrapperContext);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
  }
  const slotHelpers = identifySlotHelpers(vm.helperAssignment);
  if (slotHelpers.allocatorName && slotHelpers.slotTableName) {
    try {
      statements = collapseVirtualSlots(statements, {
        allocatorName: slotHelpers.allocatorName,
        releaseManyName: slotHelpers.releaseManyName,
        releaseName: slotHelpers.releaseName,
        slotTableName: slotHelpers.slotTableName,
      });
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
    }
  }
  if (!statements.length) {
    return {
      ast,
      changed: false,
    };
  }

  return {
    ast: {
      type: "Chunk",
      body: statements,
      comments: [],
    },
    changed: true,
  };
}

module.exports = {
  devirtualizePrometheusVm,
  _debug: {
    extractBlockLeaves,
    findContainerFunction,
    simplifyBlock,
    transformNode,
  },
};