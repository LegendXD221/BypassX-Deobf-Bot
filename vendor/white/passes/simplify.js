const { analyzeUnused } = require("./dead-code");

const CALL_TYPES = new Set(["CallExpression", "TableCallExpression", "StringCallExpression"]);

function isCallLike(node) {
  return Boolean(node) && CALL_TYPES.has(node.type);
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function normalizeIndexExpression(node) {
  if (node.type !== "IndexExpression") {
    return;
  }
  const index = unwrapParentheses(node.index);
  if (index && index.type === "StringLiteral") {
    const value = index.value;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      node.type = "MemberExpression";
      node.indexer = ".";
      node.identifier = {
        type: "Identifier",
        name: value,
      };
      delete node.index;
      return true;
    }
  }
  return false;
}

function invertCondition(condition) {
  const unwrapped = unwrapParentheses(condition);
  if (unwrapped && unwrapped.type === "UnaryExpression" && unwrapped.operator === "not") {
    return unwrapped.argument;
  }
  return {
    type: "UnaryExpression",
    operator: "not",
    argument: condition,
  };
}

function endsWithReturn(statements) {
  if (!statements.length) {
    return false;
  }
  const last = statements[statements.length - 1];
  return last.type === "ReturnStatement";
}

function containsTopLevelLocals(statements) {
  for (const statement of statements) {
    if (statement.type === "LocalStatement") {
      return true;
    }
    if (statement.type === "FunctionDeclaration" && statement.isLocal) {
      return true;
    }
  }
  return false;
}

function isIdentifier(node, name) {
  return Boolean(node) && node.type === "Identifier" && (name === undefined || node.name === name);
}

function cloneAst(node) {
  return node === undefined ? node : JSON.parse(JSON.stringify(node));
}

function getStaticTruthiness(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return null;
  }

  switch (expression.type) {
    case "BooleanLiteral":
      return expression.value;
    case "NilLiteral":
      return false;
    case "StringLiteral":
    case "NumericLiteral":
    case "FunctionDeclaration":
    case "TableConstructorExpression":
      return true;
    case "UnaryExpression":
      if (expression.operator === "not") {
        const inner = getStaticTruthiness(expression.argument);
        if (inner === null) {
          return null;
        }
        return !inner;
      }
      return null;
    default:
      return null;
  }
}

function isUnpackLikeBase(node) {
  const base = unwrapParentheses(node);
  if (!base) {
    return false;
  }

  if (isIdentifier(base, "unpack")) {
    return true;
  }

  if (
    base.type === "MemberExpression" &&
    base.indexer === "." &&
    isIdentifier(base.base, "table") &&
    isIdentifier(base.identifier, "unpack")
  ) {
    return true;
  }

  if (
    base.type === "IndexExpression" &&
    isIdentifier(base.base, "table") &&
    base.index &&
    base.index.type === "StringLiteral" &&
    base.index.value === "unpack"
  ) {
    return true;
  }

  return false;
}

function getSingleValuePackLocal(statement) {
  if (
    !statement ||
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    !isIdentifier(statement.variables[0])
  ) {
    return null;
  }

  const initializer = unwrapParentheses(statement.init[0]);
  if (
    !initializer ||
    initializer.type !== "TableConstructorExpression" ||
    initializer.fields.length !== 1 ||
    initializer.fields[0].type !== "TableValue"
  ) {
    return null;
  }

  return {
    name: statement.variables[0].name,
    value: initializer.fields[0].value,
  };
}

function simplifySingleValueUnpackReturn(statement, localName, value) {
  if (!statement || statement.type !== "ReturnStatement" || statement.arguments.length !== 1) {
    return null;
  }

  const expression = unwrapParentheses(statement.arguments[0]);
  if (
    !expression ||
    expression.type !== "CallExpression" ||
    expression.arguments.length !== 1 ||
    !isUnpackLikeBase(expression.base) ||
    !isIdentifier(unwrapParentheses(expression.arguments[0]), localName)
  ) {
    return null;
  }

  return {
    type: "ReturnStatement",
    arguments: [cloneAst(value)],
  };
}

function simplifyExpression(node) {
  if (!node || typeof node !== "object") {
    return;
  }

  switch (node.type) {
    case "ParenthesisExpression":
      simplifyExpression(node.expression);
      return;
    case "UnaryExpression":
      simplifyExpression(node.argument);
      if (node.operator === "not") {
        const inner = unwrapParentheses(node.argument);
        if (inner && inner.type === "UnaryExpression" && inner.operator === "not") {
          const target = inner.argument;
          Object.keys(node).forEach((key) => delete node[key]);
          Object.assign(node, target);
        }
      }
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      simplifyExpression(node.left);
      simplifyExpression(node.right);
      return;
    case "IfExpression":
      simplifyExpression(node.condition);
      simplifyExpression(node.trueExpression);
      simplifyExpression(node.falseExpression);
      return;
    case "IndexExpression":
      simplifyExpression(node.base);
      simplifyExpression(node.index);
      normalizeIndexExpression(node);
      return;
    case "MemberExpression":
      simplifyExpression(node.base);
      return;
    case "CallExpression":
      simplifyExpression(node.base);
      node.arguments.forEach(simplifyExpression);
      return;
    case "TableCallExpression":
      simplifyExpression(node.base);
      simplifyExpression(node.arguments);
      return;
    case "StringCallExpression":
      simplifyExpression(node.base);
      simplifyExpression(node.argument);
      return;
    case "TableConstructorExpression":
      node.fields.forEach((field) => {
        if (field.type === "TableValue") {
          simplifyExpression(field.value);
          return;
        }
        if (field.type === "TableKey") {
          simplifyExpression(field.key);
          simplifyExpression(field.value);
          return;
        }
        if (field.type === "TableKeyString") {
          simplifyExpression(field.value);
        }
      });
      return;
    case "FunctionDeclaration":
      simplifyBlock(node.body, true);
      return;
    default:
      return;
  }
}

function simplifyIfStatement(statement, isLast) {
  let changed = false;
  let clauses = statement.clauses.slice();

  for (const clause of clauses) {
    if (clause.condition) {
      simplifyExpression(clause.condition);
    }
    if (simplifyBlock(clause.body, false)) {
      changed = true;
    }
  }

  if (clauses.length > 0) {
    const last = clauses[clauses.length - 1];
    if (last.type === "ElseClause" && last.body.length === 0) {
      clauses = clauses.slice(0, -1);
      changed = true;
    }
  }

  if (clauses.length === 0) {
    return null;
  }

  if (clauses.length >= 1 && clauses[0].type === "IfClause") {
    const firstTruthiness = getStaticTruthiness(clauses[0].condition);
    if (firstTruthiness === true) {
      return {
        statement: {
          type: "DoStatement",
          body: clauses[0].body,
        },
        changed: true,
      };
    }

    if (firstTruthiness === false) {
      if (clauses.length === 1) {
        return null;
      }

      if (clauses.length === 2 && clauses[1].type === "ElseClause") {
        return {
          statement: {
            type: "DoStatement",
            body: clauses[1].body,
          },
          changed: true,
        };
      }
    }
  }

  if (clauses.length === 1) {
    if (clauses[0].body.length === 0) {
      return null;
    }
    if (changed || clauses !== statement.clauses) {
      return { statement: { ...statement, clauses }, changed: true };
    }
    return { statement, changed };
  }

  if (
    clauses.length === 2 &&
    clauses[0].type === "IfClause" &&
    clauses[1].type === "ElseClause"
  ) {
    const ifBody = clauses[0].body;
    const elseBody = clauses[1].body;

    if (ifBody.length === 0 && elseBody.length === 0) {
      return null;
    }

    if (ifBody.length === 0) {
      const inverted = invertCondition(clauses[0].condition);
      return {
        statement: {
          ...statement,
          clauses: [{ type: "IfClause", condition: inverted, body: elseBody }],
        },
        changed: true,
      };
    }

    if (elseBody.length === 0) {
      return {
        statement: {
          ...statement,
          clauses: [clauses[0]],
        },
        changed: true,
      };
    }

    if (endsWithReturn(ifBody) && (isLast || !containsTopLevelLocals(elseBody))) {
      return {
        statement: {
          ...statement,
          clauses: [clauses[0]],
        },
        inlineBody: elseBody,
        changed: true,
      };
    }
  }

  if (changed || clauses !== statement.clauses) {
    return { statement: { ...statement, clauses }, changed: true };
  }

  return { statement, changed };
}

function simplifyBlock(statements, allowStripReturn) {
  let changed = false;
  const output = [];

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const isLast = index === statements.length - 1;
    let shouldStop = false;

    const packLocal = getSingleValuePackLocal(statement);
    if (packLocal) {
      const next = statements[index + 1];
      const simplifiedReturn = simplifySingleValueUnpackReturn(next, packLocal.name, packLocal.value);
      if (simplifiedReturn) {
        simplifyExpression(simplifiedReturn.arguments[0]);
        output.push(simplifiedReturn);
        index += 1;
        changed = true;
        shouldStop = true;
        break;
      }
    }

    switch (statement.type) {
      case "LocalStatement":
        statement.init.forEach(simplifyExpression);
        output.push(statement);
        break;
      case "AssignmentStatement":
        statement.variables.forEach(simplifyExpression);
        statement.init.forEach(simplifyExpression);
        output.push(statement);
        break;
      case "CallStatement":
        simplifyExpression(statement.expression);
        output.push(statement);
        break;
      case "ReturnStatement":
        statement.arguments.forEach(simplifyExpression);
        output.push(statement);
        shouldStop = true;
        break;
      case "BreakStatement":
      case "ContinueStatement":
        output.push(statement);
        shouldStop = true;
        break;
      case "IfStatement": {
        const result = simplifyIfStatement(statement, isLast);
        if (!result) {
          changed = true;
          break;
        }
        output.push(result.statement);
        if (result.inlineBody) {
          output.push(...result.inlineBody);
          changed = true;
        }
        if (result.changed) {
          changed = true;
        }
        break;
      }
      case "WhileStatement":
        simplifyExpression(statement.condition);
        if (simplifyBlock(statement.body, false)) {
          changed = true;
        }
        output.push(statement);
        break;
      case "RepeatStatement":
        if (simplifyBlock(statement.body, false)) {
          changed = true;
        }
        simplifyExpression(statement.condition);
        output.push(statement);
        break;
      case "DoStatement":
        if (simplifyBlock(statement.body, false)) {
          changed = true;
        }
        output.push(statement);
        break;
      case "ForNumericStatement":
        simplifyExpression(statement.start);
        simplifyExpression(statement.end);
        if (statement.step) {
          simplifyExpression(statement.step);
        }
        if (simplifyBlock(statement.body, false)) {
          changed = true;
        }
        output.push(statement);
        break;
      case "ForGenericStatement":
        statement.iterators.forEach(simplifyExpression);
        if (simplifyBlock(statement.body, false)) {
          changed = true;
        }
        output.push(statement);
        break;
      case "FunctionDeclaration":
        if (simplifyBlock(statement.body, true)) {
          changed = true;
        }
        output.push(statement);
        break;
      default:
        output.push(statement);
        break;
    }

    if (shouldStop) {
      if (!isLast) {
        changed = true;
      }
      break;
    }
  }

  if (allowStripReturn && output.length > 0) {
    const last = output[output.length - 1];
    if (last.type === "ReturnStatement" && last.arguments.length === 0) {
      output.pop();
      changed = true;
    }
  }

  if (changed || output.length !== statements.length) {
    statements.length = 0;
    statements.push(...output);
  }

  return changed;
}

function extractSideEffectStatements(expression) {
  if (isCallLike(expression)) {
    return [{ type: "CallStatement", expression }];
  }

  if (expression.type === "TableConstructorExpression") {
    const calls = [];
    for (const field of expression.fields) {
      if (field.type !== "TableValue") {
        return null;
      }
      if (!isCallLike(field.value)) {
        return null;
      }
      calls.push({ type: "CallStatement", expression: field.value });
    }
    if (calls.length > 0) {
      return calls;
    }
  }

  return null;
}

function cleanupExpressions(node, rewriteBlock) {
  if (!node || typeof node !== "object") {
    return;
  }

  switch (node.type) {
    case "ParenthesisExpression":
      cleanupExpressions(node.expression, rewriteBlock);
      return;
    case "UnaryExpression":
      cleanupExpressions(node.argument, rewriteBlock);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      cleanupExpressions(node.left, rewriteBlock);
      cleanupExpressions(node.right, rewriteBlock);
      return;
    case "IfExpression":
      cleanupExpressions(node.condition, rewriteBlock);
      cleanupExpressions(node.trueExpression, rewriteBlock);
      cleanupExpressions(node.falseExpression, rewriteBlock);
      return;
    case "IndexExpression":
      cleanupExpressions(node.base, rewriteBlock);
      cleanupExpressions(node.index, rewriteBlock);
      return;
    case "MemberExpression":
      cleanupExpressions(node.base, rewriteBlock);
      return;
    case "CallExpression":
      cleanupExpressions(node.base, rewriteBlock);
      node.arguments.forEach((arg) => cleanupExpressions(arg, rewriteBlock));
      return;
    case "TableCallExpression":
      cleanupExpressions(node.base, rewriteBlock);
      cleanupExpressions(node.arguments, rewriteBlock);
      return;
    case "StringCallExpression":
      cleanupExpressions(node.base, rewriteBlock);
      cleanupExpressions(node.argument, rewriteBlock);
      return;
    case "TableConstructorExpression":
      node.fields.forEach((field) => {
        if (field.type === "TableValue") {
          cleanupExpressions(field.value, rewriteBlock);
          return;
        }
        if (field.type === "TableKey") {
          cleanupExpressions(field.key, rewriteBlock);
          cleanupExpressions(field.value, rewriteBlock);
          return;
        }
        if (field.type === "TableKeyString") {
          cleanupExpressions(field.value, rewriteBlock);
        }
      });
      return;
    case "FunctionDeclaration":
      rewriteBlock(node.body);
      return;
    default:
      return;
  }
}

function cleanupUnusedLocals(ast) {
  const { live, localStatementInfo } = analyzeUnused(ast);
  let changed = false;

  function rewriteBlock(statements) {
    const next = [];
    let blockChanged = false;

    for (const statement of statements) {
      if (statement.type === "LocalStatement") {
        const info = localStatementInfo.get(statement);
        if (
          info &&
          info.bindings.length === 1 &&
          statement.variables.length === 1 &&
          statement.init.length === 1 &&
          !live.has(info.bindings[0])
        ) {
          const sideEffects = extractSideEffectStatements(statement.init[0]);
          if (sideEffects) {
            next.push(...sideEffects);
            blockChanged = true;
            continue;
          }
        }

        statement.init.forEach((expr) => cleanupExpressions(expr, rewriteBlock));
        next.push(statement);
        continue;
      }

      if (statement.type === "FunctionDeclaration" && statement.isLocal) {
        rewriteBlock(statement.body);
        next.push(statement);
        continue;
      }

      switch (statement.type) {
        case "AssignmentStatement":
          statement.variables.forEach((expr) => cleanupExpressions(expr, rewriteBlock));
          statement.init.forEach((expr) => cleanupExpressions(expr, rewriteBlock));
          break;
        case "CallStatement":
          cleanupExpressions(statement.expression, rewriteBlock);
          break;
        case "ReturnStatement":
          statement.arguments.forEach((expr) => cleanupExpressions(expr, rewriteBlock));
          break;
        case "IfStatement":
          statement.clauses.forEach((clause) => {
            if (clause.condition) {
              cleanupExpressions(clause.condition, rewriteBlock);
            }
            rewriteBlock(clause.body);
          });
          break;
        case "WhileStatement":
          cleanupExpressions(statement.condition, rewriteBlock);
          rewriteBlock(statement.body);
          break;
        case "RepeatStatement":
          rewriteBlock(statement.body);
          cleanupExpressions(statement.condition, rewriteBlock);
          break;
        case "DoStatement":
          rewriteBlock(statement.body);
          break;
        case "ForNumericStatement":
          cleanupExpressions(statement.start, rewriteBlock);
          cleanupExpressions(statement.end, rewriteBlock);
          if (statement.step) {
            cleanupExpressions(statement.step, rewriteBlock);
          }
          rewriteBlock(statement.body);
          break;
        case "ForGenericStatement":
          statement.iterators.forEach((expr) => cleanupExpressions(expr, rewriteBlock));
          rewriteBlock(statement.body);
          break;
        default:
          break;
      }

      next.push(statement);
    }

    if (blockChanged || next.length !== statements.length) {
      statements.length = 0;
      statements.push(...next);
      changed = true;
    }
  }

  rewriteBlock(ast.body);
  return changed;
}

function simplifyAst(ast) {
  const changed = simplifyBlock(ast.body, false);
  const cleaned = cleanupUnusedLocals(ast);
  return { ast, changed: changed || cleaned };
}

module.exports = {
  simplifyAst,
};