const { cloneNode, walk } = require("../lua/ast");
const { evaluateLiteral } = require("./constant-fold");

const LUA_KEYWORDS = new Set([
  "and",
  "break",
  "continue",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

const SIDE_EFFECT_FREE_GLOBALS = new Set([
  "assert",
  "error",
  "math",
  "string",
  "table",
  "tonumber",
  "tostring",
  "type",
  "typeof",
  "unpack",
]);

const UI_OPTION_METHODS = new Set([
  "AddButton",
  "AddLabel",
  "AddToggle",
  "Button",
  "Colorpicker",
  "CreateWindow",
  "Dropdown",
  "EditOpenButton",
  "Input",
  "Paragraph",
  "Section",
  "Slider",
  "Tab",
  "Toggle",
]);

const UI_RECEIVER_BLACKLIST = new Set([
  "Callback",
  "Color3",
  "Default",
  "Enum",
  "GetIcon",
  "Instance",
  "Max",
  "Min",
  "Players",
  "Title",
  "UDim",
  "UDim2",
  "UserInputService",
  "Vector2",
  "Vector3",
  "game",
  "result",
]);

const UI_ICON_KEYS = new Set([
  "GetIcon",
  "cog",
  "crown",
  "eye",
  "house",
  "info",
  "scan-eye",
  "settings",
  "swords",
]);

function isValidIdentifier(name) {
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUA_KEYWORDS.has(name);
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

function createStringLiteral(value) {
  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
  };
}

function createIdentifier(name) {
  return {
    type: "Identifier",
    name,
  };
}

function createTableKeyStringField(key, value) {
  return {
    type: "TableKeyString",
    key: createIdentifier(key),
    value,
  };
}

function literalKeyFromValue(value) {
  if (value === null) {
    return "nil:null";
  }
  if (typeof value === "string") {
    return `string:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${value}`;
  }
  if (typeof value === "boolean") {
    return `boolean:${value}`;
  }
  return null;
}

function getLiteralKey(node) {
  const value = evaluateLiteral(unwrapParentheses(node));
  return literalKeyFromValue(value);
}

function getMemberKey(node) {
  if (!node) {
    return null;
  }

  if (node.type === "MemberExpression") {
    return node.identifier ? literalKeyFromValue(node.identifier.name) : null;
  }

  if (node.type === "IndexExpression") {
    return getLiteralKey(node.index);
  }

  return null;
}

function getTableFieldMap(tableExpression) {
  const table = unwrapParentheses(tableExpression);
  if (!table || table.type !== "TableConstructorExpression") {
    return null;
  }

  const fields = new Map();
  let implicitIndex = 1;
  for (const field of table.fields || []) {
    if (field.type === "TableValue") {
      fields.set(literalKeyFromValue(implicitIndex), field.value);
      implicitIndex += 1;
      continue;
    }

    if (field.type === "TableKeyString") {
      fields.set(literalKeyFromValue(field.key.name), field.value);
      continue;
    }

    if (field.type === "TableKey") {
      const key = getLiteralKey(field.key);
      if (!key) {
        continue;
      }
      fields.set(key, field.value);
    }
  }

  return fields;
}

function isLiteralLike(node) {
  const expression = unwrapParentheses(node);
  return Boolean(expression) && (
    expression.type === "StringLiteral" ||
    expression.type === "NumericLiteral" ||
    expression.type === "BooleanLiteral" ||
    expression.type === "NilLiteral"
  );
}

function isPureLiteralTable(node, maxFields = 48) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "TableConstructorExpression") {
    return false;
  }
  if ((expression.fields || []).length > maxFields) {
    return false;
  }
  return expression.fields.every((field) => {
    if (field.type === "TableValue") {
      return isAliasableExpression(field.value, maxFields);
    }
    if (field.type === "TableKeyString") {
      return isAliasableExpression(field.value, maxFields);
    }
    return isAliasableExpression(field.key, maxFields) && isAliasableExpression(field.value, maxFields);
  });
}

function isAliasableExpression(node, maxFields = 48) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }
  if (isLiteralLike(expression)) {
    return true;
  }
  return isPureLiteralTable(expression, maxFields);
}

function expressionKey(node) {
  if (!node || typeof node !== "object") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return `[${node.map(expressionKey).join(",")}]`;
  }

  const entries = Object.entries(node)
    .filter(([key]) => key !== "range" && key !== "loc" && key !== "scope")
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, value]) => `${key}:${expressionKey(value)}`).join(",")}}`;
}

function sameExpression(left, right) {
  return expressionKey(unwrapParentheses(left)) === expressionKey(unwrapParentheses(right));
}

function transformExpression(node, transform, context = { inLValue: false }) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const transformed = transformExpression(entry, transform, context);
      changed = changed || transformed !== entry;
      return transformed;
    });
    return changed ? next : node;
  }

  const replace = (child, childContext = { inLValue: false }) => transformExpression(child, transform, childContext);
  let next = node;

  switch (node.type) {
    case "Chunk":
      next = {
        ...node,
        body: transformBlockExpressions(node.body || [], transform),
      };
      break;
    case "AssignmentStatement":
      next = {
        ...node,
        variables: node.variables.map((entry) => replace(entry, { inLValue: true })),
        init: node.init.map((entry) => replace(entry, { inLValue: false })),
      };
      break;
    case "LocalStatement":
      next = {
        ...node,
        init: node.init.map((entry) => replace(entry, { inLValue: false })),
      };
      break;
    case "FunctionDeclaration":
      next = {
        ...node,
        identifier:
          node.identifier && node.identifier.type !== "Identifier"
            ? replace(node.identifier, { inLValue: true })
            : node.identifier,
        body: transformBlockExpressions(node.body || [], transform),
      };
      break;
    case "IfStatement":
      next = {
        ...node,
        clauses: node.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? replace(clause.condition, { inLValue: false }) : clause.condition,
          body: transformBlockExpressions(clause.body || [], transform),
        })),
      };
      break;
    case "WhileStatement":
      next = {
        ...node,
        condition: replace(node.condition, { inLValue: false }),
        body: transformBlockExpressions(node.body || [], transform),
      };
      break;
    case "RepeatStatement":
      next = {
        ...node,
        body: transformBlockExpressions(node.body || [], transform),
        condition: replace(node.condition, { inLValue: false }),
      };
      break;
    case "DoStatement":
      next = {
        ...node,
        body: transformBlockExpressions(node.body || [], transform),
      };
      break;
    case "ForNumericStatement":
      next = {
        ...node,
        start: replace(node.start, { inLValue: false }),
        end: replace(node.end, { inLValue: false }),
        step: node.step ? replace(node.step, { inLValue: false }) : node.step,
        body: transformBlockExpressions(node.body || [], transform),
      };
      break;
    case "ForGenericStatement":
      next = {
        ...node,
        iterators: node.iterators.map((entry) => replace(entry, { inLValue: false })),
        body: transformBlockExpressions(node.body || [], transform),
      };
      break;
    case "CallStatement":
      next = {
        ...node,
        expression: replace(node.expression, { inLValue: false }),
      };
      break;
    case "ReturnStatement":
      next = {
        ...node,
        arguments: node.arguments.map((entry) => replace(entry, { inLValue: false })),
      };
      break;
    case "UnaryExpression":
      next = { ...node, argument: replace(node.argument, { inLValue: false }) };
      break;
    case "BinaryExpression":
    case "LogicalExpression":
      next = {
        ...node,
        left: replace(node.left, { inLValue: false }),
        right: replace(node.right, { inLValue: false }),
      };
      break;
    case "ParenthesisExpression":
      next = { ...node, expression: replace(node.expression, context) };
      break;
    case "IndexExpression":
      next = {
        ...node,
        base: replace(node.base, { inLValue: false }),
        index: replace(node.index, { inLValue: false }),
      };
      break;
    case "MemberExpression":
      next = {
        ...node,
        base: replace(node.base, { inLValue: false }),
      };
      break;
    case "CallExpression":
      next = {
        ...node,
        base: replace(node.base, { inLValue: false }),
        arguments: node.arguments.map((entry) => replace(entry, { inLValue: false })),
      };
      break;
    case "TableCallExpression":
      next = {
        ...node,
        base: replace(node.base, { inLValue: false }),
        arguments: replace(node.arguments, { inLValue: false }),
      };
      break;
    case "StringCallExpression":
      next = {
        ...node,
        base: replace(node.base, { inLValue: false }),
        argument: replace(node.argument, { inLValue: false }),
      };
      break;
    case "IfExpression":
      next = {
        ...node,
        condition: replace(node.condition, { inLValue: false }),
        trueExpression: replace(node.trueExpression, { inLValue: false }),
        falseExpression: replace(node.falseExpression, { inLValue: false }),
      };
      break;
    case "TableConstructorExpression":
      next = {
        ...node,
        fields: node.fields.map((field) => {
          if (field.type === "TableValue") {
            return { ...field, value: replace(field.value, { inLValue: false }) };
          }
          if (field.type === "TableKeyString") {
            return { ...field, value: replace(field.value, { inLValue: false }) };
          }
          if (field.type === "TableKey") {
            return {
              ...field,
              key: replace(field.key, { inLValue: false }),
              value: replace(field.value, { inLValue: false }),
            };
          }
          return field;
        }),
      };
      break;
    default:
      break;
  }

  return transform(next, context);
}

function transformBlockExpressions(statements, transform) {
  return statements.map((statement) => transformExpression(statement, transform));
}

function foldTableConstructorLookups(ast) {
  let changed = false;

  const nextAst = transformExpression(ast, (node) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (node.type === "IndexExpression" || node.type === "MemberExpression") {
      const base = unwrapParentheses(node.base);
      const fields = getTableFieldMap(base);
      const key = getMemberKey(node);
      if (fields && key && fields.has(key)) {
        changed = true;
        return cloneNode(fields.get(key));
      }

      if (
        node.type === "IndexExpression" &&
        node.index &&
        node.index.type === "StringLiteral" &&
        isValidIdentifier(node.index.value)
      ) {
        changed = true;
        return {
          type: "MemberExpression",
          base: node.base,
          indexer: ".",
          identifier: { type: "Identifier", name: node.index.value },
        };
      }
    }

    if (
      node.type === "CallExpression" &&
      node.base &&
      node.base.type === "MemberExpression" &&
      node.base.indexer === "." &&
      node.arguments.length > 0 &&
      sameExpression(node.base.base, node.arguments[0])
    ) {
      changed = true;
      return {
        ...node,
        base: {
          ...node.base,
          indexer: ":",
        },
        arguments: node.arguments.slice(1),
      };
    }

    if (
      node.type === "CallExpression" &&
      node.base &&
      node.base.type === "IndexExpression" &&
      node.base.index &&
      node.base.index.type === "StringLiteral" &&
      isValidIdentifier(node.base.index.value) &&
      node.arguments.length > 0 &&
      sameExpression(node.base.base, node.arguments[0])
    ) {
      changed = true;
      return {
        ...node,
        base: {
          type: "MemberExpression",
          base: node.base.base,
          indexer: ":",
          identifier: { type: "Identifier", name: node.base.index.value },
        },
        arguments: node.arguments.slice(1),
      };
    }

    return node;
  });

  return {
    ast: nextAst,
    changed,
  };
}

function replaceIdentifierAliasesInExpression(node, aliases, context = { inLValue: false }) {
  return transformExpression(node, (current, currentContext) => {
    if (
      current &&
      current.type === "Identifier" &&
      !currentContext.inLValue &&
      aliases.has(current.name)
    ) {
      return cloneNode(aliases.get(current.name));
    }
    return current;
  }, context);
}

function propagateBlock(statements, inheritedAliases = new Map()) {
  let changed = false;
  const aliases = new Map(inheritedAliases);
  const output = [];

  const rewrite = (node, childAliases = aliases) => {
    const next = replaceIdentifierAliasesInExpression(node, childAliases);
    if (next !== node) {
      changed = true;
    }
    return next;
  };

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") {
      output.push(statement);
      continue;
    }

    if (statement.type === "LocalStatement") {
      const nextStatement = {
        ...statement,
        init: statement.init.map((init) => rewrite(init)),
      };
      nextStatement.variables.forEach((variable, index) => {
        if (!isIdentifier(variable)) {
          return;
        }
        const initializer = unwrapParentheses(nextStatement.init[index]);
        if (initializer && isAliasableExpression(initializer)) {
          aliases.set(variable.name, cloneNode(initializer));
        } else {
          aliases.delete(variable.name);
        }
      });
      output.push(nextStatement);
      continue;
    }

    if (statement.type === "AssignmentStatement") {
      const nextStatement = {
        ...statement,
        variables: statement.variables.map((variable) => replaceIdentifierAliasesInExpression(variable, aliases, { inLValue: true })),
        init: statement.init.map((init) => rewrite(init)),
      };
      nextStatement.variables.forEach((variable, index) => {
        const target = unwrapParentheses(variable);
        if (!isIdentifier(target)) {
          return;
        }
        const initializer = unwrapParentheses(nextStatement.init[index]);
        if (initializer && isAliasableExpression(initializer)) {
          aliases.set(target.name, cloneNode(initializer));
        } else {
          aliases.delete(target.name);
        }
      });
      output.push(nextStatement);
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      const functionAliases = new Map();
      for (const parameter of statement.parameters || []) {
        if (isIdentifier(parameter)) {
          functionAliases.delete(parameter.name);
        }
      }
      const bodyResult = propagateBlock(statement.body || [], functionAliases);
      changed = changed || bodyResult.changed;
      const nextStatement = {
        ...statement,
        identifier:
          statement.identifier && statement.identifier.type !== "Identifier"
            ? rewrite(statement.identifier)
            : statement.identifier,
        body: bodyResult.body,
      };
      output.push(nextStatement);
      continue;
    }

    if (statement.type === "IfStatement") {
      const nextClauses = statement.clauses.map((clause) => {
        const bodyResult = propagateBlock(clause.body || [], new Map(aliases));
        changed = changed || bodyResult.changed;
        return {
          ...clause,
          condition: clause.condition ? rewrite(clause.condition) : clause.condition,
          body: bodyResult.body,
        };
      });
      output.push({ ...statement, clauses: nextClauses });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      const bodyResult = propagateBlock(statement.body || [], new Map(aliases));
      changed = changed || bodyResult.changed;
      const nextStatement = {
        ...statement,
        body: bodyResult.body,
      };
      if (statement.condition) {
        nextStatement.condition = rewrite(statement.condition);
      }
      output.push(nextStatement);
      continue;
    }

    if (statement.type === "ForNumericStatement") {
      const loopAliases = new Map(aliases);
      if (isIdentifier(statement.variable)) {
        loopAliases.delete(statement.variable.name);
      }
      const bodyResult = propagateBlock(statement.body || [], loopAliases);
      changed = changed || bodyResult.changed;
      output.push({
        ...statement,
        start: rewrite(statement.start),
        end: rewrite(statement.end),
        step: statement.step ? rewrite(statement.step) : statement.step,
        body: bodyResult.body,
      });
      continue;
    }

    if (statement.type === "ForGenericStatement") {
      const loopAliases = new Map(aliases);
      for (const variable of statement.variables || []) {
        if (isIdentifier(variable)) {
          loopAliases.delete(variable.name);
        }
      }
      const bodyResult = propagateBlock(statement.body || [], loopAliases);
      changed = changed || bodyResult.changed;
      output.push({
        ...statement,
        iterators: statement.iterators.map((iterator) => rewrite(iterator)),
        body: bodyResult.body,
      });
      continue;
    }

    output.push(rewrite(statement));
  }

  return {
    body: output,
    changed,
  };
}

function propagateLiteralAliases(ast) {
  const result = propagateBlock(ast.body || []);
  return {
    ast: {
      ...ast,
      body: result.body,
    },
    changed: result.changed,
  };
}

function containsTamperString(node) {
  let found = false;
  walk(node, (child) => {
    if (found) {
      return;
    }
    if (
      child.type === "StringLiteral" &&
      typeof child.value === "string" &&
      /tamper detected|tamper|anti beautify|anti function hook/i.test(child.value)
    ) {
      found = true;
    }
  });
  return found;
}

function containsStringLiteral(node) {
  let found = false;
  walk(node, (child) => {
    if (found) {
      return;
    }
    if (child && child.type === "StringLiteral") {
      found = true;
    }
  });
  return found;
}

function isAlwaysErrorBinary(node) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "BinaryExpression") {
    return false;
  }
  if (!["+", "-", "*", "/", "%", "^", "//"].includes(expression.operator)) {
    return false;
  }
  if (containsStringLiteral(expression.left) || containsStringLiteral(expression.right)) {
    return true;
  }
  const left = unwrapParentheses(expression.left);
  const right = unwrapParentheses(expression.right);
  return Boolean(
    left &&
    right &&
    (
      (left.type === "StringLiteral" && right.type === "NumericLiteral") ||
      (left.type === "NumericLiteral" && right.type === "StringLiteral") ||
      (left.type === "StringLiteral" && right.type === "StringLiteral" && expression.operator !== "..")
    )
  );
}

function identifierUsedInNode(node, name) {
  let used = false;
  walk(node, (child) => {
    if (used || !child || child.type !== "Identifier") {
      return;
    }
    if (child.name === name) {
      used = true;
    }
  });
  return used;
}

function identifierUsedAfter(statements, startIndex, name) {
  for (let index = startIndex; index < statements.length; index += 1) {
    if (identifierUsedInNode(statements[index], name)) {
      return true;
    }
  }
  return false;
}

function functionLooksLikeTamper(fn) {
  if (!fn || fn.type !== "FunctionDeclaration") {
    return false;
  }
  if ((fn.body || []).length === 0) {
    return true;
  }
  if (containsTamperString(fn)) {
    return true;
  }
  return (fn.body || []).some((statement) => {
    if (statement.type === "ReturnStatement") {
      return statement.arguments.some(isAlwaysErrorBinary);
    }
    if (statement.type === "AssignmentStatement" || statement.type === "LocalStatement") {
      return statement.init.some(isAlwaysErrorBinary);
    }
    return false;
  });
}

function collectTamperFunctionNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type === "FunctionDeclaration" && node.isLocal && node.identifier && functionLooksLikeTamper(node)) {
      names.add(node.identifier.name);
      return;
    }
    if (node.type === "LocalStatement") {
      for (let index = 0; index < Math.min(node.variables.length, node.init.length); index += 1) {
        const variable = node.variables[index];
        const initializer = unwrapParentheses(node.init[index]);
        if (isIdentifier(variable) && functionLooksLikeTamper(initializer)) {
          names.add(variable.name);
        }
      }
    }
  });
  return names;
}

function isInfiniteLoop(statement) {
  const node = unwrapParentheses(statement);
  if (!node || node.type !== "WhileStatement") {
    return false;
  }
  const condition = unwrapParentheses(node.condition);
  return condition && condition.type === "BooleanLiteral" && condition.value === true;
}

function callRootName(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return null;
  }
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (expression.type === "MemberExpression" || expression.type === "IndexExpression") {
    return callRootName(expression.base);
  }
  if (expression.type === "CallExpression") {
    return callRootName(expression.base);
  }
  return null;
}

function isEnvAssignment(statement) {
  if (!statement || statement.type !== "AssignmentStatement") {
    return false;
  }
  return statement.variables.some((variable) => {
    const target = unwrapParentheses(variable);
    return target && target.type === "IndexExpression" && isIdentifier(target.base, "_ENV");
  });
}

function isTamperCallStatement(statement, tamperNames) {
  if (!statement || statement.type !== "CallStatement") {
    return false;
  }
  const expression = unwrapParentheses(statement.expression);
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }
  const root = callRootName(expression.base);
  return root === "error" || tamperNames.has(root);
}

function branchLooksLikeTamper(body, tamperNames) {
  if (!Array.isArray(body) || body.length === 0) {
    return false;
  }

  if (body.some((statement) => containsTamperString(statement) || isInfiniteLoop(statement) || isTamperCallStatement(statement, tamperNames))) {
    return true;
  }

  const hasReturn = body.some((statement) => statement.type === "ReturnStatement");
  const hasEnvWrite = body.some(isEnvAssignment);
  if (hasReturn && hasEnvWrite) {
    return true;
  }

  if (
    hasReturn &&
    body.length <= 5 &&
    body.every((statement) => (
      statement.type === "ReturnStatement" ||
      isEnvAssignment(statement) ||
      isTamperCallStatement(statement, tamperNames) ||
      containsTamperString(statement)
    ))
  ) {
    return true;
  }

  return false;
}

function isPureExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return true;
  }

  switch (expression.type) {
    case "Identifier":
      return !SIDE_EFFECT_FREE_GLOBALS.has(expression.name) ? true : true;
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
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
        if (field.type === "TableValue") {
          return isPureExpression(field.value);
        }
        if (field.type === "TableKeyString") {
          return isPureExpression(field.value);
        }
        return isPureExpression(field.key) && isPureExpression(field.value);
      });
    case "FunctionDeclaration":
      return true;
    default:
      return false;
  }
}

function expressionHasImpossibleBase(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }
  if (expression.type === "NilLiteral" || expression.type === "StringLiteral" || expression.type === "NumericLiteral" || expression.type === "BooleanLiteral") {
    return true;
  }
  if (expression.type === "MemberExpression" || expression.type === "IndexExpression") {
    return expressionHasImpossibleBase(expression.base);
  }
  if (expression.type === "CallExpression") {
    return expressionHasImpossibleBase(expression.base);
  }
  return false;
}

function isBrokenCallStatement(statement) {
  if (!statement || statement.type !== "CallStatement") {
    return false;
  }
  const expression = unwrapParentheses(statement.expression);
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }
  if (!expressionHasImpossibleBase(expression.base)) {
    return false;
  }
  return (expression.arguments || []).every(isPureExpression);
}

function rewriteAntiTamperBlock(statements, tamperNames) {
  let changed = false;
  const output = [];

  for (const statement of statements || []) {
    if (!statement || typeof statement !== "object") {
      output.push(statement);
      continue;
    }

    if (isBrokenCallStatement(statement)) {
      changed = true;
      continue;
    }

    if (statement.type === "LocalStatement") {
      const keepVariables = [];
      const keepInit = [];
      for (let index = 0; index < statement.variables.length; index += 1) {
        const variable = statement.variables[index];
        let initializer = statement.init[index];
        if (isIdentifier(variable) && tamperNames.has(variable.name)) {
          changed = true;
          continue;
        }
        if (initializer && initializer.type === "FunctionDeclaration") {
          const rewritten = rewriteAntiTamperBlock(initializer.body || [], tamperNames);
          changed = changed || rewritten.changed;
          initializer = {
            ...initializer,
            body: rewritten.body,
          };
        }
        keepVariables.push(variable);
        if (index < statement.init.length) {
          keepInit.push(initializer);
        }
      }
      if (keepVariables.length === 0) {
        changed = true;
        continue;
      }
      output.push({
        ...statement,
        variables: keepVariables,
        init: keepInit,
      });
      continue;
    }

    if (
      statement.type === "FunctionDeclaration" &&
      statement.isLocal &&
      statement.identifier &&
      tamperNames.has(statement.identifier.name)
    ) {
      changed = true;
      continue;
    }

    if (statement.type === "AssignmentStatement") {
      const nextInit = statement.init.map((initializer) => {
        if (initializer && initializer.type === "FunctionDeclaration") {
          const rewritten = rewriteAntiTamperBlock(initializer.body || [], tamperNames);
          changed = changed || rewritten.changed;
          return {
            ...initializer,
            body: rewritten.body,
          };
        }
        return initializer;
      });
      output.push({
        ...statement,
        init: nextInit,
      });
      continue;
    }

    if (isTamperCallStatement(statement, tamperNames) || isInfiniteLoop(statement)) {
      changed = true;
      continue;
    }

    if (statement.type === "IfStatement") {
      const clauses = statement.clauses.map((clause) => {
        const rewritten = rewriteAntiTamperBlock(clause.body || [], tamperNames);
        changed = changed || rewritten.changed;
        return {
          ...clause,
          body: rewritten.body,
        };
      });

      if (clauses.length === 2 && clauses[0].type === "IfClause" && clauses[1].type === "ElseClause") {
        const thenTamper = branchLooksLikeTamper(clauses[0].body, tamperNames);
        const elseTamper = branchLooksLikeTamper(clauses[1].body, tamperNames);

        if (thenTamper && elseTamper) {
          changed = true;
          continue;
        }
        if (elseTamper) {
          output.push({
            ...statement,
            clauses: [{ ...clauses[0], body: clauses[0].body }],
          });
          changed = true;
          continue;
        }
        if (thenTamper) {
          output.push(...clauses[1].body);
          changed = true;
          continue;
        }
      }

      output.push({
        ...statement,
        clauses: clauses.filter((clause) => !branchLooksLikeTamper(clause.body, tamperNames)),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      const rewritten = rewriteAntiTamperBlock(statement.body || [], tamperNames);
      changed = changed || rewritten.changed;
      if (branchLooksLikeTamper(rewritten.body, tamperNames)) {
        changed = true;
        continue;
      }
      output.push({
        ...statement,
        body: rewritten.body,
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      const rewritten = rewriteAntiTamperBlock(statement.body || [], tamperNames);
      changed = changed || rewritten.changed;
      output.push({
        ...statement,
        body: rewritten.body,
      });
      continue;
    }

    output.push(statement);
  }

  return {
    body: output,
    changed,
  };
}

function removeAntiTamperArtifacts(ast) {
  const tamperNames = collectTamperFunctionNames(ast);
  const rewritten = rewriteAntiTamperBlock(ast.body || [], tamperNames);
  return {
    ast: {
      ...ast,
      body: rewritten.body,
    },
    changed: rewritten.changed,
  };
}

function uiMethodNameFromBase(base) {
  const expression = unwrapParentheses(base);
  if (!expression) {
    return null;
  }

  if (expression.type === "MemberExpression" && expression.identifier) {
    return expression.identifier.name;
  }

  if (expression.type === "IndexExpression") {
    const value = evaluateLiteral(unwrapParentheses(expression.index));
    return typeof value === "string" ? value : null;
  }

  return null;
}

function rootIdentifierName(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return null;
  }
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (expression.type === "MemberExpression" || expression.type === "IndexExpression") {
    return rootIdentifierName(expression.base);
  }
  return null;
}

function isGeneratedResultName(name) {
  return typeof name === "string" && /^(?:result|value|param|callback|items)\d*$/.test(name);
}

function isUiReceiverCandidate(name) {
  return (
    isValidIdentifier(name) &&
    !isGeneratedResultName(name) &&
    !UI_RECEIVER_BLACKLIST.has(name) &&
    !/^on[A-Z]/.test(name) &&
    !/^param\d+$/.test(name)
  );
}

function collectIdentifierNameCounts(node) {
  const counts = new Map();
  walk(node, (child) => {
    if (!child || child.type !== "Identifier") {
      return;
    }
    counts.set(child.name, (counts.get(child.name) || 0) + 1);
  });
  return counts;
}

function chooseUiReceiverName(node) {
  const root = rootIdentifierName(node);
  if (root && isUiReceiverCandidate(root)) {
    return root;
  }

  const counts = collectIdentifierNameCounts(node);
  if (counts.has("Me")) {
    return "Me";
  }

  const candidates = [...counts.entries()]
    .filter(([name]) => isUiReceiverCandidate(name))
    .sort((left, right) => {
      const [leftName, leftCount] = left;
      const [rightName, rightCount] = right;
      const leftScore = (leftName[0] === leftName[0].toUpperCase() ? 4 : 0) + leftCount;
      const rightScore = (rightName[0] === rightName[0].toUpperCase() ? 4 : 0) + rightCount;
      return rightScore - leftScore || leftName.localeCompare(rightName);
    });

  return candidates.length > 0 ? candidates[0][0] : null;
}

function simplifyUiMethodBase(base, methodName) {
  const expression = unwrapParentheses(base);
  if (!expression || expression.type !== "MemberExpression" || !expression.identifier) {
    return base;
  }

  const receiverName = chooseUiReceiverName(expression.base);
  if (!receiverName) {
    return base;
  }

  const nextBase = {
    type: "MemberExpression",
    base: createIdentifier(receiverName),
    indexer: ":",
    identifier: cloneNode(expression.identifier),
  };

  if (
    expression.indexer === nextBase.indexer &&
    expression.base &&
    expression.base.type === "Identifier" &&
    expression.base.name === receiverName
  ) {
    return base;
  }

  return nextBase;
}

function fieldKeyName(field) {
  if (!field) {
    return null;
  }

  if (field.type === "TableKeyString" && field.key) {
    return field.key.name;
  }

  if (field.type === "TableKey") {
    const value = evaluateLiteral(unwrapParentheses(field.key));
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }

  return null;
}

function isTableExpression(node) {
  const expression = unwrapParentheses(node);
  return Boolean(expression && expression.type === "TableConstructorExpression");
}

function isStringExpression(node) {
  const expression = unwrapParentheses(node);
  return Boolean(expression && expression.type === "StringLiteral");
}

function isBooleanExpression(node) {
  const expression = unwrapParentheses(node);
  return Boolean(expression && expression.type === "BooleanLiteral");
}

function isNumericExpression(node) {
  const expression = unwrapParentheses(node);
  return Boolean(expression && expression.type === "NumericLiteral" && Number.isFinite(expression.value));
}

function isFunctionExpression(node) {
  const expression = unwrapParentheses(node);
  return Boolean(expression && expression.type === "FunctionDeclaration");
}

function identifierExpressionName(node) {
  const expression = unwrapParentheses(node);
  return expression && expression.type === "Identifier" ? expression.name : null;
}

function isLikelyLocalCallbackIdentifier(node) {
  const name = identifierExpressionName(node);
  if (/^callback\d*$/.test(name || "")) {
    return true;
  }
  return Boolean(
    name &&
    isValidIdentifier(name) &&
    !isGeneratedResultName(name) &&
    !UI_RECEIVER_BLACKLIST.has(name) &&
    name !== "game" &&
    name !== "_G"
  );
}

function isConcatExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }
  if (expression.type === "BinaryExpression" && expression.operator === "..") {
    return true;
  }
  return false;
}

function callExpressionRootName(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return null;
  }
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (expression.type === "MemberExpression" || expression.type === "IndexExpression") {
    return callExpressionRootName(expression.base);
  }
  if (expression.type === "CallExpression") {
    return callExpressionRootName(expression.base);
  }
  return null;
}

function isCallRoot(node, name) {
  const expression = unwrapParentheses(node);
  return Boolean(expression && expression.type === "CallExpression" && callExpressionRootName(expression.base) === name);
}

function isUiSizeExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }
  const base = unwrapParentheses(expression.base);
  return (
    base &&
    base.type === "MemberExpression" &&
    base.identifier &&
    base.identifier.name === "new" &&
    isIdentifier(base.base, "UDim2")
  );
}

function isColorExpression(node) {
  return isCallRoot(node, "Color3") || isCallRoot(node, "ColorSequence") || isCallRoot(node, "BrickColor");
}

function expressionHasProxyShape(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }

  if (expression.type === "Identifier") {
    return isGeneratedResultName(expression.name);
  }

  if (expression.type === "IndexExpression") {
    const root = rootIdentifierName(expression);
    return isGeneratedResultName(root) || expressionHasProxyShape(expression.base) || expressionHasProxyShape(expression.index);
  }

  if (expression.type === "MemberExpression") {
    return expressionHasProxyShape(expression.base);
  }

  if (expression.type === "CallExpression") {
    return expressionHasProxyShape(expression.base);
  }

  return false;
}

function flattenConcatExpression(node, parts = []) {
  const expression = unwrapParentheses(node);
  if (expression && expression.type === "BinaryExpression" && expression.operator === "..") {
    flattenConcatExpression(expression.left, parts);
    flattenConcatExpression(expression.right, parts);
    return parts;
  }
  parts.push(expression || node);
  return parts;
}

function rebuildConcatExpression(parts) {
  if (parts.length === 0) {
    return null;
  }
  let current = cloneNode(parts[0]);
  for (let index = 1; index < parts.length; index += 1) {
    current = {
      type: "BinaryExpression",
      operator: "..",
      left: current,
      right: cloneNode(parts[index]),
    };
  }
  return current;
}

function simplifyProxyWrappedConcat(value) {
  if (!isConcatExpression(value)) {
    return cloneNode(value);
  }

  const parts = flattenConcatExpression(value)
    .filter((part) => !expressionHasProxyShape(part));
  const rebuilt = rebuildConcatExpression(parts);
  return rebuilt || cloneNode(value);
}

function simplifiedProxyValueForRole(value, role) {
  const expression = unwrapParentheses(value);
  if (role === "Title") {
    return simplifyProxyWrappedConcat(value);
  }

  if (role !== "Icon" || !expression || expression.type !== "IndexExpression") {
    return cloneNode(value);
  }

  const root = rootIdentifierName(expression);
  if (root && isGeneratedResultName(root)) {
    return createIdentifier(root);
  }

  return cloneNode(value);
}

function stringArrayLikeTable(table) {
  const expression = unwrapParentheses(table);
  if (!expression || expression.type !== "TableConstructorExpression") {
    return null;
  }

  const values = [];
  for (const field of expression.fields || []) {
    const value = field.type === "TableValue" ? field.value : field.value;
    const literal = evaluateLiteral(unwrapParentheses(value));
    if (typeof literal === "string") {
      values.push(createStringLiteral(literal));
    }
  }

  if (values.length < 1) {
    return null;
  }

  return {
    type: "TableConstructorExpression",
    fields: values.map((value) => ({ type: "TableValue", value })),
  };
}

function numericCandidatesFromTable(table) {
  const expression = unwrapParentheses(table);
  if (!expression || expression.type !== "TableConstructorExpression") {
    return [];
  }

  const candidates = [];
  for (const field of expression.fields || []) {
    const keyName = fieldKeyName(field);
    if (field.type === "TableKey" && isNumericExpression(field.key)) {
      candidates.push({
        role: null,
        node: cloneNode(unwrapParentheses(field.key)),
        value: unwrapParentheses(field.key).value,
      });
    }

    if (isNumericExpression(field.value)) {
      candidates.push({
        role: keyName && ["Min", "Max", "Default", "Increment"].includes(keyName) ? keyName : null,
        node: cloneNode(unwrapParentheses(field.value)),
        value: unwrapParentheses(field.value).value,
      });
    }
  }
  return candidates;
}

function addInferredSliderNumbers(addField, numericCandidates) {
  const usable = numericCandidates
    .filter((entry) => Number.isFinite(entry.value) && Math.abs(entry.value) <= 10000)
    .filter((entry) => entry.value !== 200 || entry.role)
    .map((entry) => ({
      ...entry,
      value: Number(entry.value),
    }));

  for (const entry of usable) {
    if (entry.role) {
      addField(entry.role, entry.node, 9);
    }
  }

  const roleless = usable.filter((entry) => !entry.role);
  if (roleless.length === 0) {
    return;
  }

  let increment = null;
  const scale = [];
  for (const entry of roleless) {
    if (entry.value > 0 && entry.value < 0.1 && increment === null) {
      increment = entry;
    } else {
      scale.push(entry);
    }
  }

  if (increment) {
    addField("Increment", increment.node, 6);
  }

  if (scale.length === 0) {
    return;
  }

  const minEntry = scale.reduce((best, entry) => (entry.value < best.value ? entry : best), scale[0]);
  const maxEntry = scale.reduce((best, entry) => (entry.value > best.value ? entry : best), scale[0]);
  addField("Min", minEntry.node, 5);
  addField("Max", maxEntry.node, 5);

  const middle = scale.find((entry) => entry.value !== minEntry.value && entry.value !== maxEntry.value);
  const maxCount = scale.filter((entry) => entry.value === maxEntry.value).length;
  const defaultEntry = middle || (maxCount > 1 ? maxEntry : scale[scale.length - 1]);
  addField("Default", defaultEntry.node, 4);
}

function normalizeUiOptionTable(table, methodName) {
  const expression = unwrapParentheses(table);
  if (!expression || expression.type !== "TableConstructorExpression") {
    return null;
  }

  const fieldsByName = new Map();
  const numericCandidates = [];
  let changed = false;

  const addField = (name, value, confidence = 1) => {
    if (!name || !value) {
      return;
    }
    const existing = fieldsByName.get(name);
    const existingIsProxy = existing && expressionHasProxyShape(existing.value);
    const nextIsProxy = expressionHasProxyShape(value);
    if (existing && !existingIsProxy && nextIsProxy) {
      return;
    }
    if (existing && existing.confidence > confidence && !(existingIsProxy && !nextIsProxy)) {
      return;
    }
    if (!existing || !sameExpression(existing.value, value)) {
      changed = true;
    }
    fieldsByName.set(name, {
      confidence,
      value: simplifiedProxyValueForRole(value, name),
    });
  };

  for (const field of expression.fields || []) {
    const keyName = fieldKeyName(field);
    const value = field.type === "TableValue" ? field.value : field.value;
    const stringArray = stringArrayLikeTable(value);

    if (methodName === "Slider") {
      numericCandidates.push(...numericCandidatesFromTable(value));
    }

    if (keyName === "UserInputService" && (isStringExpression(value) || isConcatExpression(value))) {
      addField("Title", cloneNode(value), 8);
      continue;
    }

    if (keyName === "Callback" && isFunctionExpression(value)) {
      addField("Callback", cloneNode(value), 10);
      continue;
    }

    if (keyName === "Title" && !isTableExpression(value)) {
      addField("Title", cloneNode(value), 10);
      continue;
    }

    if (keyName === "Default" && (isBooleanExpression(value) || isNumericExpression(value) || isStringExpression(value) || isColorExpression(value))) {
      addField("Default", cloneNode(value), 10);
      continue;
    }

    if ((keyName === "Min" || keyName === "Max" || keyName === "Increment") && isNumericExpression(value)) {
      addField(keyName, cloneNode(value), 10);
      continue;
    }

    if ((keyName === "Values" || keyName === "Value") && stringArray) {
      addField("Values", stringArray, 10);
      continue;
    }

    if (keyName === "Icon") {
      addField("Icon", cloneNode(value), 10);
      continue;
    }

    if (keyName === "Size" && isUiSizeExpression(value)) {
      addField("Size", cloneNode(value), 10);
      continue;
    }

    if (keyName === "HideSearchBar" && isBooleanExpression(value)) {
      addField("HideSearchBar", cloneNode(value), 10);
      continue;
    }

    if (keyName === "new" && methodName === "EditOpenButton" && isBooleanExpression(value)) {
      addField("new", cloneNode(value), 10);
      continue;
    }

    if (keyName && UI_ICON_KEYS.has(keyName)) {
      const iconValue = expressionHasProxyShape(value) ? createStringLiteral(keyName) : cloneNode(value);
      addField("Icon", iconValue, 7);
      continue;
    }

    if (isFunctionExpression(value)) {
      addField("Callback", cloneNode(value), 7);
      continue;
    }

    if (
      isLikelyLocalCallbackIdentifier(value) &&
      methodName !== "Tab" &&
      methodName !== "Paragraph" &&
      methodName !== "Section" &&
      methodName !== "CreateWindow" &&
      methodName !== "EditOpenButton"
    ) {
      addField("Callback", cloneNode(value), 5);
      continue;
    }

    if (isBooleanExpression(value)) {
      if (methodName === "CreateWindow") {
        addField("HideSearchBar", cloneNode(value), 4);
      } else if (methodName === "EditOpenButton") {
        addField("new", cloneNode(value), 4);
      } else {
        addField("Default", cloneNode(value), 6);
      }
      continue;
    }

    if (methodName === "Slider" && isNumericExpression(value)) {
      numericCandidates.push({
        role: keyName && ["Min", "Max", "Default", "Increment"].includes(keyName) ? keyName : null,
        node: cloneNode(unwrapParentheses(value)),
        value: unwrapParentheses(value).value,
      });
      continue;
    }

    if (stringArray && (methodName === "Dropdown" || methodName === "Slider")) {
      addField("Values", stringArray, 6);
      continue;
    }

    if (isUiSizeExpression(value)) {
      addField("Size", cloneNode(value), 6);
      continue;
    }

    if (isColorExpression(value)) {
      addField("Default", cloneNode(value), 6);
      continue;
    }

    if (isStringExpression(value) || isConcatExpression(value)) {
      addField("Title", cloneNode(value), 5);
      continue;
    }

    if ((methodName === "Tab" || methodName === "Paragraph") && isLikelyLocalCallbackIdentifier(value)) {
      addField("Icon", cloneNode(value), 4);
      continue;
    }

    if ((methodName === "Tab" || methodName === "Paragraph") && !isTableExpression(value) && expressionHasProxyShape(value)) {
      addField("Icon", cloneNode(value), 3);
    }
  }

  if (methodName === "Slider") {
    addInferredSliderNumbers(addField, numericCandidates);
  }

  const titleEntry = fieldsByName.get("Title");
  const iconEntry = fieldsByName.get("Icon");
  const titleLiteral = titleEntry ? evaluateLiteral(unwrapParentheses(titleEntry.value)) : null;
  if (titleEntry && expressionHasProxyShape(titleEntry.value)) {
    titleEntry.value = createStringLiteral("Title");
    titleEntry.confidence = Math.max(titleEntry.confidence, 8);
    changed = true;
  }
  if (
    iconEntry &&
    expressionHasProxyShape(iconEntry.value) &&
    typeof titleLiteral === "string" &&
    UI_ICON_KEYS.has(titleLiteral)
  ) {
    iconEntry.value = createStringLiteral(titleLiteral);
    iconEntry.confidence = Math.max(iconEntry.confidence, 8);
    changed = true;
  }

  const order = [
    "Title",
    "Icon",
    "Size",
    "HideSearchBar",
    "new",
    "Values",
    "Min",
    "Max",
    "Default",
    "Increment",
    "Callback",
  ];
  const nextFields = [];
  for (const key of order) {
    const entry = fieldsByName.get(key);
    if (entry) {
      nextFields.push(createTableKeyStringField(key, entry.value));
    }
  }

  if (nextFields.length === 0) {
    return null;
  }

  if (nextFields.length !== (expression.fields || []).length) {
    changed = true;
  }

  if (!changed) {
    return null;
  }

  return {
    ...expression,
    fields: nextFields,
  };
}

function findUiOptionArgumentIndex(call) {
  if (!call || !Array.isArray(call.arguments)) {
    return null;
  }

  if (call.base && call.base.type === "MemberExpression" && call.base.indexer === ":") {
    const firstTable = call.arguments.findIndex((argument) => isTableExpression(argument));
    return firstTable >= 0 ? firstTable : null;
  }

  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    if (isTableExpression(call.arguments[index])) {
      return index;
    }
  }

  return null;
}

function findUiLibLocalName(ast) {
  let found = null;
  walk(ast, (node) => {
    if (found || !node || node.type !== "LocalStatement") {
      return;
    }
    for (const variable of node.variables || []) {
      if (variable && variable.type === "Identifier" && /^uiLib\d*$/.test(variable.name)) {
        found = variable.name;
        return;
      }
    }
  });
  return found;
}

function normalizeUiArtifacts(ast) {
  let changed = false;
  const uiLibName = findUiLibLocalName(ast);

  const nextAst = transformExpression(ast, (node) => {
    if (
      uiLibName &&
      node &&
      node.type === "MemberExpression" &&
      node.identifier &&
      node.identifier.name === "UserInputService" &&
      node.base &&
      node.base.type === "Identifier" &&
      /^[A-Z]$/.test(node.base.name)
    ) {
      changed = true;
      return {
        ...node,
        base: createIdentifier(uiLibName),
      };
    }

    if (!node || node.type !== "CallExpression" || !node.base) {
      return node;
    }

    const methodName = uiMethodNameFromBase(node.base);
    if (!methodName || !UI_OPTION_METHODS.has(methodName)) {
      return node;
    }

    let nextNode = node;
    const originalBase = unwrapParentheses(node.base);
    const simplifiedBase = simplifyUiMethodBase(node.base, methodName);
    if (simplifiedBase !== node.base) {
      let nextArguments = node.arguments;
      if (
        simplifiedBase.type === "MemberExpression" &&
        simplifiedBase.indexer === ":" &&
        originalBase &&
        originalBase.type === "MemberExpression" &&
        originalBase.indexer === "." &&
        node.arguments.length >= 2 &&
        isTableExpression(node.arguments[node.arguments.length - 1])
      ) {
        nextArguments = node.arguments.slice(1);
      }
      nextNode = {
        ...nextNode,
        base: simplifiedBase,
        arguments: nextArguments,
      };
      changed = true;
    }

    const optionArgIndex = findUiOptionArgumentIndex(nextNode);
    if (optionArgIndex === null) {
      return nextNode;
    }

    const normalizedTable = normalizeUiOptionTable(nextNode.arguments[optionArgIndex], methodName);
    if (!normalizedTable) {
      return nextNode;
    }

    const nextArguments = nextNode.arguments.slice();
    nextArguments[optionArgIndex] = normalizedTable;
    changed = true;
    return {
      ...nextNode,
      arguments: nextArguments,
    };
  });

  return {
    ast: nextAst,
    changed,
  };
}

function removeUnusedLocalFunctionsFromStatements(statements) {
  let changed = false;
  const rewrittenStatements = (statements || []).map((statement) => {
    if (!statement || typeof statement !== "object") {
      return statement;
    }

    if (statement.type === "FunctionDeclaration") {
      const bodyResult = removeUnusedLocalFunctionsFromStatements(statement.body || []);
      changed = changed || bodyResult.changed;
      return {
        ...statement,
        body: bodyResult.body,
      };
    }

    if (statement.type === "IfStatement") {
      const clauses = statement.clauses.map((clause) => {
        const bodyResult = removeUnusedLocalFunctionsFromStatements(clause.body || []);
        changed = changed || bodyResult.changed;
        return {
          ...clause,
          body: bodyResult.body,
        };
      });
      return {
        ...statement,
        clauses,
      };
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      const bodyResult = removeUnusedLocalFunctionsFromStatements(statement.body || []);
      changed = changed || bodyResult.changed;
      return {
        ...statement,
        body: bodyResult.body,
      };
    }

    if (statement.type === "ForNumericStatement" || statement.type === "ForGenericStatement") {
      const bodyResult = removeUnusedLocalFunctionsFromStatements(statement.body || []);
      changed = changed || bodyResult.changed;
      return {
        ...statement,
        body: bodyResult.body,
      };
    }

    return statement;
  });

  const output = [];
  for (let index = 0; index < rewrittenStatements.length; index += 1) {
    const statement = rewrittenStatements[index];

    if (statement.type === "LocalStatement") {
      const keepVariables = [];
      const keepInit = [];
      for (let variableIndex = 0; variableIndex < statement.variables.length; variableIndex += 1) {
        const variable = statement.variables[variableIndex];
        const initializer = statement.init[variableIndex];
        if (
          isIdentifier(variable) &&
          initializer &&
          initializer.type === "FunctionDeclaration" &&
          !identifierUsedAfter(rewrittenStatements, index + 1, variable.name)
        ) {
          changed = true;
          continue;
        }
        keepVariables.push(variable);
        if (variableIndex < statement.init.length) {
          keepInit.push(initializer);
        }
      }
      if (keepVariables.length === 0) {
        changed = true;
        continue;
      }
      output.push({
        ...statement,
        variables: keepVariables,
        init: keepInit,
      });
      continue;
    }

    if (
      statement.type === "FunctionDeclaration" &&
      statement.isLocal &&
      statement.identifier &&
      !identifierUsedAfter(rewrittenStatements, index + 1, statement.identifier.name)
    ) {
      changed = true;
      continue;
    }

    output.push(statement);
  }

  return {
    body: output,
    changed,
  };
}

function removeUnusedLocalFunctions(ast) {
  const result = removeUnusedLocalFunctionsFromStatements(ast.body || []);
  return {
    ast: {
      ...ast,
      body: result.body,
    },
    changed: result.changed,
  };
}

function improveReadability(ast) {
  let currentAst = ast;
  let changed = false;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const literalResult = propagateLiteralAliases(currentAst);
    currentAst = literalResult.ast;
    changed = changed || literalResult.changed;

    const tableResult = foldTableConstructorLookups(currentAst);
    currentAst = tableResult.ast;
    changed = changed || tableResult.changed;

    const uiResult = normalizeUiArtifacts(currentAst);
    currentAst = uiResult.ast;
    changed = changed || uiResult.changed;

    const antiTamperResult = removeAntiTamperArtifacts(currentAst);
    currentAst = antiTamperResult.ast;
    changed = changed || antiTamperResult.changed;

    const unusedFunctionResult = removeUnusedLocalFunctions(currentAst);
    currentAst = unusedFunctionResult.ast;
    changed = changed || unusedFunctionResult.changed;

    if (!literalResult.changed && !tableResult.changed && !uiResult.changed && !antiTamperResult.changed && !unusedFunctionResult.changed) {
      break;
    }
  }

  return {
    ast: currentAst,
    changed,
  };
}

module.exports = {
  foldTableConstructorLookups,
  improveReadability,
  propagateLiteralAliases,
  removeAntiTamperArtifacts,
};