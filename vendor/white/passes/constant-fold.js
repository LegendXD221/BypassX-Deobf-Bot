const { walkMut } = require("../lua/ast");

const BUILTIN_ROOTS = new Set(["string", "math"]);
const BUILTIN_CALLS = new Set(["tostring", "tonumber"]);

function collectShadowedIdentifiers(ast) {
  const shadowed = new Set();
  const stack = [ast];

  while (stack.length) {
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

    if (node.type === "LocalStatement") {
      for (const variable of node.variables) {
        if (variable && variable.type === "Identifier") {
          const name = variable.name;
          if (BUILTIN_ROOTS.has(name) || BUILTIN_CALLS.has(name)) {
            shadowed.add(name);
          }
        }
      }
    }

    if (node.type === "FunctionDeclaration" && node.isLocal && node.identifier && node.identifier.type === "Identifier") {
      const name = node.identifier.name;
      if (BUILTIN_ROOTS.has(name) || BUILTIN_CALLS.has(name)) {
        shadowed.add(name);
      }
    }

    if (node.type === "AssignmentStatement") {
      for (const variable of node.variables) {
        if (variable && variable.type === "Identifier") {
          const name = variable.name;
          if (BUILTIN_ROOTS.has(name) || BUILTIN_CALLS.has(name)) {
            shadowed.add(name);
          }
        }
      }
    }

    if (node.type === "ForNumericStatement" && node.variable && node.variable.type === "Identifier") {
      const name = node.variable.name;
      if (BUILTIN_ROOTS.has(name) || BUILTIN_CALLS.has(name)) {
        shadowed.add(name);
      }
    }

    if (node.type === "ForGenericStatement" && Array.isArray(node.variables)) {
      for (const variable of node.variables) {
        if (variable && variable.type === "Identifier") {
          const name = variable.name;
          if (BUILTIN_ROOTS.has(name) || BUILTIN_CALLS.has(name)) {
            shadowed.add(name);
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") {
        continue;
      }
      stack.push(value);
    }
  }

  return shadowed;
}

function isLuaTruthy(value) {
  return value !== false && value !== null;
}

function isLiteralValue(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isLiteralNode(node) {
  return (
    node &&
    (
      node.type === "StringLiteral" ||
      node.type === "NumericLiteral" ||
      node.type === "BooleanLiteral" ||
      node.type === "NilLiteral"
    )
  );
}

function literalToNode(value) {
  if (value === null) {
    return { type: "NilLiteral", value: null, raw: "nil" };
  }
  if (typeof value === "string") {
    return { type: "StringLiteral", value, raw: JSON.stringify(value) };
  }
  if (typeof value === "boolean") {
    return { type: "BooleanLiteral", value, raw: value ? "true" : "false" };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { type: "NumericLiteral", value, raw: String(value) };
  }
  return null;
}

function evaluateNumeric(node, shadowedIdentifiers) {
  const value = evaluateLiteral(node, shadowedIdentifiers);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function evaluateLiteral(node, shadowedIdentifiers) {
  if (!node) {
    return undefined;
  }

  switch (node.type) {
    case "NumericLiteral":
      return node.value;
    case "StringLiteral":
      return node.value;
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "ParenthesisExpression":
      return evaluateLiteral(node.expression, shadowedIdentifiers);
    case "UnaryExpression": {
      if (node.operator === "-") {
        const value = evaluateNumeric(node.argument, shadowedIdentifiers);
        return value === null ? undefined : -value;
      }
      if (node.operator === "not") {
        const value = evaluateLiteral(node.argument, shadowedIdentifiers);
        if (!isLiteralValue(value)) {
          return undefined;
        }
        return !isLuaTruthy(value);
      }
      if (node.operator === "#") {
        if (node.argument.type === "StringLiteral") {
          return node.argument.value.length;
        }
        if (node.argument.type === "TableConstructorExpression") {
          return getTableLength(node.argument);
        }
      }
      return undefined;
    }
    case "BinaryExpression":
      return evaluateBinaryExpression(node, shadowedIdentifiers);
    case "LogicalExpression":
      return evaluateLogicalExpression(node, shadowedIdentifiers);
    case "IndexExpression":
      return evaluateIndexExpression(node, shadowedIdentifiers);
    case "CallExpression":
      return evaluateCallExpression(node, shadowedIdentifiers);
    default:
      return undefined;
  }
}

function evaluateBinaryExpression(node, shadowedIdentifiers) {
  const left = evaluateLiteral(node.left, shadowedIdentifiers);
  const right = evaluateLiteral(node.right, shadowedIdentifiers);

  switch (node.operator) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "^":
    case "//":
      if (typeof left !== "number" || typeof right !== "number") {
        return undefined;
      }
      if (node.operator === "+") return left + right;
      if (node.operator === "-") return left - right;
      if (node.operator === "*") return left * right;
      if (node.operator === "/") return left / right;
      if (node.operator === "%") return left % right;
      if (node.operator === "^") return left ** right;
      if (node.operator === "//") return Math.floor(left / right);
      return undefined;
    case "..":
      if (
        (typeof left !== "string" && typeof left !== "number") ||
        (typeof right !== "string" && typeof right !== "number")
      ) {
        return undefined;
      }
      return String(left) + String(right);
    case "==":
      if (!isLiteralValue(left) || !isLiteralValue(right)) {
        return undefined;
      }
      return left === right;
    case "~=":
      if (!isLiteralValue(left) || !isLiteralValue(right)) {
        return undefined;
      }
      return left !== right;
    case "<":
    case "<=":
    case ">":
    case ">=":
      if (typeof left === "number" && typeof right === "number") {
        if (node.operator === "<") return left < right;
        if (node.operator === "<=") return left <= right;
        if (node.operator === ">") return left > right;
        if (node.operator === ">=") return left >= right;
      }
      if (typeof left === "string" && typeof right === "string") {
        if (node.operator === "<") return left < right;
        if (node.operator === "<=") return left <= right;
        if (node.operator === ">") return left > right;
        if (node.operator === ">=") return left >= right;
      }
      return undefined;
    default:
      return undefined;
  }
}

function evaluateLogicalExpression(node, shadowedIdentifiers) {
  const left = evaluateLiteral(node.left, shadowedIdentifiers);
  if (!isLiteralValue(left)) {
    return undefined;
  }

  if (node.operator === "and") {
    if (!isLuaTruthy(left)) {
      return left;
    }
    const right = evaluateLiteral(node.right, shadowedIdentifiers);
    if (!isLiteralValue(right)) {
      return undefined;
    }
    return right;
  }

  if (node.operator === "or") {
    if (isLuaTruthy(left)) {
      return left;
    }
    const right = evaluateLiteral(node.right, shadowedIdentifiers);
    if (!isLiteralValue(right)) {
      return undefined;
    }
    return right;
  }

  return undefined;
}

function getTableLength(node) {
  if (!node || node.type !== "TableConstructorExpression") {
    return undefined;
  }
  let length = 0;
  for (const field of node.fields) {
    if (field.type !== "TableValue") {
      break;
    }
    length += 1;
  }
  return length;
}

function evaluateIndexExpression(node, shadowedIdentifiers) {
  if (!node.base || node.base.type !== "TableConstructorExpression") {
    return undefined;
  }
  const index = evaluateLiteral(node.index, shadowedIdentifiers);
  if (typeof index === "number") {
    const field = node.base.fields[index - 1];
    if (field && field.type === "TableValue") {
      const value = evaluateLiteral(field.value, shadowedIdentifiers);
      return isLiteralValue(value) ? value : undefined;
    }
    return undefined;
  }
  if (typeof index === "string") {
    for (const field of node.base.fields) {
      if (field.type === "TableKeyString" && field.key.name === index) {
        const value = evaluateLiteral(field.value, shadowedIdentifiers);
        return isLiteralValue(value) ? value : undefined;
      }
      if (field.type === "TableKey" && field.key.type === "StringLiteral" && field.key.value === index) {
        const value = evaluateLiteral(field.value, shadowedIdentifiers);
        return isLiteralValue(value) ? value : undefined;
      }
    }
  }
  return undefined;
}

function evaluateCallExpression(node, shadowedIdentifiers) {
  const builtin = getBuiltinCall(node);
  if (!builtin) {
    return undefined;
  }

  if (shadowedIdentifiers) {
    if (builtin.object && shadowedIdentifiers.has(builtin.object)) {
      return undefined;
    }
    if (!builtin.object && shadowedIdentifiers.has(builtin.name)) {
      return undefined;
    }
  }

  const args = node.arguments.map((arg) => evaluateLiteral(arg, shadowedIdentifiers));
  if (args.some((arg) => !isLiteralValue(arg))) {
    return undefined;
  }

  if (builtin.object === "string") {
    return evaluateStringBuiltin(builtin.name, args);
  }
  if (builtin.object === "math") {
    return evaluateMathBuiltin(builtin.name, args);
  }
  if (builtin.object === null && builtin.name === "tostring") {
    return evaluateToString(args);
  }
  if (builtin.object === null && builtin.name === "tonumber") {
    return evaluateToNumber(args);
  }
  return undefined;
}

function getBuiltinCall(node) {
  if (!node || node.type !== "CallExpression") {
    return null;
  }

  if (node.base.type === "Identifier") {
    if (node.base.name === "tostring" || node.base.name === "tonumber") {
      return { object: null, name: node.base.name };
    }
    return null;
  }

  if (node.base.type === "MemberExpression" && node.base.indexer === ".") {
    if (node.base.base.type === "Identifier") {
      return { object: node.base.base.name, name: node.base.identifier.name };
    }
  }

  if (node.base.type === "IndexExpression" && node.base.base.type === "Identifier" && node.base.index.type === "StringLiteral") {
    return { object: node.base.base.name, name: node.base.index.value };
  }

  return null;
}

function evaluateStringBuiltin(name, args) {
  if (name === "len" && args.length === 1 && typeof args[0] === "string") {
    return args[0].length;
  }
  if (name === "byte" && args.length >= 1 && typeof args[0] === "string") {
    const index = args.length >= 2 && typeof args[1] === "number" ? args[1] : 1;
    if (!Number.isFinite(index)) {
      return undefined;
    }
    const position = index < 0 ? args[0].length + index + 1 : index;
    if (position < 1 || position > args[0].length) {
      return null;
    }
    return args[0].charCodeAt(position - 1);
  }
  if (name === "char" && args.length >= 1) {
    const chars = [];
    for (const arg of args) {
      if (typeof arg !== "number" || !Number.isFinite(arg) || arg < 0 || arg > 255) {
        return undefined;
      }
      chars.push(String.fromCharCode(arg));
    }
    return chars.join("");
  }
  if (name === "sub" && args.length >= 2 && typeof args[0] === "string") {
    const start = typeof args[1] === "number" ? args[1] : 1;
    const finish = args.length >= 3 && typeof args[2] === "number" ? args[2] : -1;
    if (!Number.isFinite(start) || !Number.isFinite(finish)) {
      return undefined;
    }
    return luaSub(args[0], start, finish);
  }
  return undefined;
}

function luaSub(value, start, finish) {
  const length = value.length;
  let i = start;
  let j = finish;
  if (i < 0) {
    i = length + i + 1;
  }
  if (j < 0) {
    j = length + j + 1;
  }
  if (i < 1) i = 1;
  if (j > length) j = length;
  if (i > j) {
    return "";
  }
  return value.slice(i - 1, j);
}

function evaluateMathBuiltin(name, args) {
  if (args.length !== 1 || typeof args[0] !== "number" || !Number.isFinite(args[0])) {
    return undefined;
  }
  if (name === "floor") return Math.floor(args[0]);
  if (name === "ceil") return Math.ceil(args[0]);
  if (name === "abs") return Math.abs(args[0]);
  return undefined;
}

function evaluateToString(args) {
  if (args.length < 1) {
    return undefined;
  }
  const value = args[0];
  if (value === null) {
    return "nil";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return undefined;
}

function evaluateToNumber(args) {
  if (args.length < 1) {
    return undefined;
  }
  const value = args[0];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    if (args.length >= 2 && typeof args[1] === "number" && Number.isFinite(args[1])) {
      const radix = args[1];
      if (radix >= 2 && radix <= 36) {
        const parsed = parseInt(value, radix);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function foldConstants(ast, options = {}) {
  let changed = false;
  const shadowedIdentifiers = options.shadowedIdentifiers || collectShadowedIdentifiers(ast);
  const nextAst = walkMut(ast, (node, parent) => {
    if (!parent) {
      return;
    }

    const value = evaluateLiteral(node, shadowedIdentifiers);
    if (!isLiteralValue(value)) {
      return;
    }

    if (isLiteralNode(node)) {
      return;
    }

    const replacement = literalToNode(value);
    if (!replacement) {
      return;
    }

    changed = true;
    return replacement;
  });

  return { ast: nextAst, changed };
}

module.exports = {
  collectShadowedIdentifiers,
  evaluateLiteral,
  evaluateNumeric,
  isLiteralValue,
  isLuaTruthy,
  foldConstants,
};