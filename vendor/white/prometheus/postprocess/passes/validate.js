const { emitChunk } = require("../../../lua/emit");
const { parseLua } = require("../../../lua/parse");

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LVALUE_TYPES = new Set(["Identifier", "IndexExpression", "MemberExpression"]);
const FUNCTION_TARGET_TYPES = new Set(["Identifier", "IndexExpression", "MemberExpression"]);

function isValidIdentifierName(name) {
  return typeof name === "string" && IDENTIFIER_REGEX.test(name);
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function createError(path, message) {
  return {
    message,
    path,
  };
}

function validateAstStructure(ast, options = {}) {
  const maxErrors = Number.isFinite(options.maxErrors) ? options.maxErrors : 32;
  const errors = [];
  const stack = [{ node: ast, path: "root" }];

  while (stack.length > 0 && errors.length < maxErrors) {
    const frame = stack.pop();
    const node = frame.node;
    const path = frame.path;

    if (!node || typeof node !== "object") {
      continue;
    }

    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node[index], path: `${path}[${index}]` });
      }
      continue;
    }

    switch (node.type) {
      case "Identifier":
        if (!isValidIdentifierName(node.name)) {
          errors.push(createError(path, `Invalid identifier name: ${JSON.stringify(node.name)}`));
        }
        break;
      case "LocalStatement":
        if (!Array.isArray(node.variables)) {
          errors.push(createError(path, "LocalStatement.variables must be an array"));
          break;
        }
        node.variables.forEach((variable, index) => {
          if (!variable || variable.type !== "Identifier" || !isValidIdentifierName(variable.name)) {
            errors.push(createError(`${path}.variables[${index}]`, "Local variable must be a valid Identifier"));
          }
        });
        break;
      case "AssignmentStatement":
        if (!Array.isArray(node.variables)) {
          errors.push(createError(path, "AssignmentStatement.variables must be an array"));
          break;
        }
        node.variables.forEach((variable, index) => {
          const target = unwrapParentheses(variable);
          if (!target || !LVALUE_TYPES.has(target.type)) {
            const targetType = target && target.type ? target.type : "unknown";
            errors.push(createError(`${path}.variables[${index}]`, `Invalid assignment target type: ${targetType}`));
          }
        });
        break;
      case "FunctionDeclaration": {
        const identifier = unwrapParentheses(node.identifier);
        if (node.isLocal === true) {
          if (!identifier || identifier.type !== "Identifier" || !isValidIdentifierName(identifier.name)) {
            errors.push(createError(`${path}.identifier`, "Local function identifier must be a valid Identifier"));
          }
        } else if (identifier && !FUNCTION_TARGET_TYPES.has(identifier.type)) {
          errors.push(createError(`${path}.identifier`, `Invalid function target type: ${identifier.type}`));
        }

        if (Array.isArray(node.parameters)) {
          node.parameters.forEach((parameter, index) => {
            if (parameter.type === "VarargLiteral" && index === node.parameters.length - 1) {
              return;
            }
            if (parameter.type !== "Identifier" || !isValidIdentifierName(parameter.name)) {
              errors.push(createError(`${path}.parameters[${index}]`, "Invalid function parameter"));
            }
          });
        }
        break;
      }
      case "ForNumericStatement":
        if (!node.variable || node.variable.type !== "Identifier" || !isValidIdentifierName(node.variable.name)) {
          errors.push(createError(`${path}.variable`, "ForNumericStatement.variable must be a valid Identifier"));
        }
        break;
      case "ForGenericStatement":
        if (!Array.isArray(node.variables)) {
          errors.push(createError(path, "ForGenericStatement.variables must be an array"));
          break;
        }
        node.variables.forEach((variable, index) => {
          if (!variable || variable.type !== "Identifier" || !isValidIdentifierName(variable.name)) {
            errors.push(createError(`${path}.variables[${index}]`, "ForGenericStatement variable must be a valid Identifier"));
          }
        });
        break;
      default:
        break;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") {
        continue;
      }
      stack.push({ node: value, path: `${path}.${key}` });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateAst(ast, options = {}) {
  const structure = validateAstStructure(ast, options);
  if (!structure.ok) {
    return structure;
  }

  if (options.parseCheck === false) {
    return structure;
  }

  try {
    parseLua(emitChunk(ast));
  } catch (error) {
    return {
      ok: false,
      errors: [
        createError("root", `Parse validation failed: ${error.message}`),
      ],
    };
  }

  return structure;
}

module.exports = {
  validateAst,
  validateAstStructure,
};