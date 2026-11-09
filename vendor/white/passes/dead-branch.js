const { walkMut } = require("../lua/ast");
const { evaluateLiteral, evaluateNumeric, collectShadowedIdentifiers } = require("./constant-fold");

function isAlwaysErrorBinaryExpression(node) {
  if (!node || node.type !== "BinaryExpression") {
    return false;
  }

  const { left, right, operator } = node;

  const numericOps = new Set(["+", "-", "*", "/", "%", "^", "//"]);
  if (numericOps.has(operator)) {
    const leftType = getLiteralType(left);
    const rightType = getLiteralType(right);
    if (leftType && rightType && leftType !== rightType) {
      if ((leftType === "string" && rightType === "number") ||
          (leftType === "number" && rightType === "string")) {
        return true;
      }
    }
  }

  return false;
}

function getLiteralType(node) {
  if (!node) return null;
  switch (node.type) {
    case "StringLiteral": return "string";
    case "NumericLiteral": return "number";
    case "BooleanLiteral": return "boolean";
    case "NilLiteral": return "nil";
    case "TableConstructorExpression": return "table";
    case "FunctionDeclaration": return "function";
    default: return null;
  }
}

function isAlwaysErrorFunction(node) {
  if (!node || node.type !== "FunctionDeclaration") {
    return false;
  }
  return hasAlwaysErrorExpression(node.body);
}

function hasAlwaysErrorExpression(statements) {
  for (const stmt of statements) {
    if (!stmt || typeof stmt !== "object") continue;
    switch (stmt.type) {
      case "ReturnStatement":
        for (const arg of stmt.arguments) {
          if (isAlwaysErrorBinaryExpression(arg)) return true;
        }
        break;
      case "AssignmentStatement":
        for (const init of stmt.init) {
          if (isAlwaysErrorBinaryExpression(init)) return true;
        }
        break;
      case "LocalStatement":
        for (const init of stmt.init) {
          if (isAlwaysErrorBinaryExpression(init)) return true;
        }
        break;
    }
  }
  return false;
}

function isTrashFunction(node) {
  if (!node || node.type !== "FunctionDeclaration") return false;
  const body = node.body;
  if (!body || body.length === 0) return true;
  if (body.length <= 2) {
    let hasTrashAssign = false;
    let hasBareReturn = false;
    for (const stmt of body) {
      if (stmt.type === "AssignmentStatement" && stmt.variables.length === 1) {
        const target = stmt.variables[0];
        if (target.type === "IndexExpression" && target.base && target.base.type === "Identifier" &&
            target.base.name.length === 1 && target.base.name >= "A" && target.base.name <= "Z") {
          hasTrashAssign = true;
        }
      }
      if (stmt.type === "ReturnStatement" && stmt.arguments.length === 0) hasBareReturn = true;
    }
    if (hasTrashAssign && body.length <= 2) return true;
  }
  return false;
}

function removeDeadBranches(ast) {
  let changed = false;

  function walkAndRemove(node, parent, key) {
    if (!node || typeof node !== "object") return false;
    let localChanged = false;

    if (node.type === "IfStatement") {
      const newClauses = [];
      let droppedAny = false;

      for (const clause of node.clauses) {
        if (clause.type !== "IfClause" || !clause.condition) {
          newClauses.push(clause);
          continue;
        }

        const constantValue = evaluateIfConstant(clause.condition);
        if (constantValue === true) {
          newClauses.push({ type: "ElseClause", body: clause.body });
          droppedAny = true;
          localChanged = true;
          break;
        } else if (constantValue === false) {
          droppedAny = true;
          localChanged = true;
          continue;
        }
        newClauses.push(clause);
      }

      if (newClauses.length === 0 && parent && key !== undefined) {
        parent[key] = { type: "DoStatement", body: [] };
        return true;
      }

      if (droppedAny) {
        node.clauses = newClauses;
      }

      for (const clause of node.clauses) {
        if (clause.body) {
          for (let j = 0; j < clause.body.length; j++) {
            if (walkAndRemove(clause.body[j], clause.body, j)) localChanged = true;
          }
        }
      }
      return localChanged;
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === "scope") continue;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (typeof v[i] === "object" && v[i] !== null) {
            if (walkAndRemove(v[i], v, i)) localChanged = true;
          }
        }
      } else if (v && typeof v === "object") {
        if (walkAndRemove(v, node, k)) localChanged = true;
      }
    }
    return localChanged;
  }

  for (let i = 0; i < 4; i++) {
    const result = walkAndRemove(ast, null, null);
    if (result) {
      changed = true;
    } else {
      break;
    }
  }

  return { ast, changed };
}

function evaluateIfConstant(node) {
  if (!node) return null;

  const matchedPattern = matchAntiTamperPattern(node);
  if (matchedPattern) return false;

  if (hasLikelyUndeclaredReference(node)) {
    const evaluated = tryEvaluateWithDefaults(node);
    if (evaluated === true || evaluated === false) return evaluated;
  }

  return null;
}

function isLogicalOp(node, op) {
  if (!node) return false;
  return (node.type === "LogicalExpression" && node.operator === op) ||
         (node.type === "BinaryExpression" && node.operator === op);
}

function matchAntiTamperPattern(node) {
  if (!node) return false;
  let cond = node;
  while (cond && cond.type === "ParenthesisExpression") cond = cond.expression;
  if (!cond || !isLogicalOp(cond, "or")) return false;

  let left = cond.left;
  let right = cond.right;
  while (left && left.type === "ParenthesisExpression") left = left.expression;
  while (right && right.type === "ParenthesisExpression") right = right.expression;
  if (!left || !right) return false;
  if (!isLogicalOp(left, "and")) return false;
  if (!isLogicalOp(right, "and")) return false;

  let leftCond = left.left;
  let rightCond = right.left;
  while (leftCond && leftCond.type === "ParenthesisExpression") leftCond = leftCond.expression;
  while (rightCond && rightCond.type === "ParenthesisExpression") rightCond = rightCond.expression;
  if (!leftCond || !rightCond) return false;

  if (leftCond.type !== "Identifier" || !/^[A-Z]$/.test(leftCond.name)) return false;

  if (rightCond.type !== "UnaryExpression" || rightCond.operator !== "not") return false;
  let notArg = rightCond.argument;
  while (notArg && notArg.type === "ParenthesisExpression") notArg = notArg.expression;
  if (!notArg || notArg.type !== "Identifier" || notArg.name !== leftCond.name) return false;

  return true;
}

function collectNamedIdentifierReferences(node) {
  const names = new Set();
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (current.type === "Identifier") names.add(current.name);
    for (const [key, value] of Object.entries(current)) {
      if (key === "scope") continue;
      stack.push(value);
    }
  }
  return names;
}

function hasLikelyUndeclaredReference(node) {
  const names = collectNamedIdentifierReferences(node);
  let undeclaredCount = 0;
  for (const name of names) {
    if (/^[A-Z]$/.test(name)) undeclaredCount += 1;
  }
  return undeclaredCount >= 2 && undeclaredCount >= names.size * 0.5;
}

const KNOWN_GLOBALS = new Set([
  "print", "warn", "error", "type", "typeof", "tostring", "tonumber",
  "pairs", "ipairs", "next", "select", "unpack", "pack",
  "pcall", "xpcall", "rawequal", "rawget", "rawset", "rawlen",
  "setmetatable", "getmetatable", "require", "load", "loadstring",
  "dofile", "loadfile", "collectgarbage", "gcinfo", "newproxy",
  "delay", "spawn", "tick", "time", "Version", "_G", "_ENV",
  "game", "workspace", "script", "shared", "plugin",
  "Instance", "Color3", "UDim", "UDim2", "Vector2", "Vector3",
  "CFrame", "TweenInfo", "BrickColor", "NumberSequence",
  "NumberSequenceKeypoint", "ColorSequence", "ColorSequenceKeypoint",
  "Ray", "Rect", "Region3", "Region3int16", "Faces", "Axes",
  "Enum", "getgenv", "getfenv", "getrenv", "getreg", "setfenv",
  "gethui", "identifyexecutor", "http_request", "syn", "request",
  "hookfunction", "hookmetamethod", "newcclosure", "checkcaller",
  "cloneref", "compareinstances", "is_sirhurt_closure",
  "is_protosmasher_closure", "is_synapse_closure",
  "isfile", "readfile", "writefile", "appendfile", "listfiles",
  "makefolder", "delfolder", "delfile",
]);

function tryEvaluateWithDefaults(node) {
  return evaluateInContext(node, new Map());
}

function evaluateInContext(node, bindings) {
  if (!node) return undefined;
  switch (node.type) {
    case "NilLiteral": return null;
    case "BooleanLiteral": return node.value;
    case "NumericLiteral": return node.value;
    case "StringLiteral": return node.value;
    case "ParenthesisExpression": return evaluateInContext(node.expression, bindings);
    case "Identifier": {
      if (bindings.has(node.name)) return bindings.get(node.name);
      if (KNOWN_GLOBALS.has(node.name)) return undefined;
      if (/^_[a-z]/.test(node.name)) return undefined;
      if (/^[A-Z]$/.test(node.name)) return null;
      if (/^[a-z]{1,3}$/.test(node.name)) return undefined;
      return undefined;
    }
    case "UnaryExpression": {
      const arg = evaluateInContext(node.argument, bindings);
      if (arg === undefined) return undefined;
      if (node.operator === "not") return !isTruthy(arg);
      if (node.operator === "-") return typeof arg === "number" ? -arg : undefined;
      if (node.operator === "#") {
        if (typeof arg === "string") return arg.length;
        if (arg === null) return 0;
        return undefined;
      }
      return undefined;
    }
    case "BinaryExpression": {
      const left = evaluateInContext(node.left, bindings);
      const right = evaluateInContext(node.right, bindings);
      if (left === undefined || right === undefined) return undefined;
      if (left === null || right === null) {
        if (["==", "~=", "<", "<=", ">", ">="].includes(node.operator)) {
          if (node.operator === "==") return left === right;
          if (node.operator === "~=") return left !== right;
          return false;
        }
        return undefined;
      }
      switch (node.operator) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
        case "^": return left ** right;
        case "//": return Math.floor(left / right);
        case "..": return String(left) + String(right);
        case "==": return left === right;
        case "~=": return left !== right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
        case "and": return isTruthy(left) ? right : left;
        case "or": return isTruthy(left) ? left : right;
      }
      return undefined;
    }
    case "LogicalExpression": {
      const left = evaluateInContext(node.left, bindings);
      if (left === undefined) return undefined;
      if (node.operator === "and") return isTruthy(left) ? evaluateInContext(node.right, bindings) : left;
      if (node.operator === "or") return isTruthy(left) ? left : evaluateInContext(node.right, bindings);
      return undefined;
    }
    default:
      return undefined;
  }
}

function isTruthy(value) {
  return value !== false && value !== null;
}

module.exports = {
  isAlwaysErrorFunction,
  isTrashFunction,
  isAlwaysErrorBinaryExpression,
  removeDeadBranches,
  tryEvaluateWithDefaults,
};