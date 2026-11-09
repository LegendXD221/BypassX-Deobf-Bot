const { cloneNode } = require("../lua/ast");

function isVarargOnlyFunction(node) {
  return (
    node &&
    node.type === "FunctionDeclaration" &&
    node.parameters.length === 1 &&
    node.parameters[0].type === "VarargLiteral"
  );
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function isIdentifier(node, name = null) {
  return node && node.type === "Identifier" && (name === null || node.name === name);
}

function findNestedPayloadReturnIndex(statements) {
  return statements.findIndex((statement) => {
    if (!statement || statement.type !== "ReturnStatement" || statement.arguments.length !== 1) {
      return false;
    }

    const candidate = unwrapParentheses(statement.arguments[0]);
    if (!candidate || candidate.type !== "CallExpression") {
      return false;
    }

    const base = unwrapParentheses(candidate.base);
    return base && base.type === "FunctionDeclaration";
  });
}

function getPayloadWrapperContext(ast) {
  if (!ast || !Array.isArray(ast.body) || ast.body.length === 0) {
    return null;
  }

  const statement = ast.body[ast.body.length - 1];
  if (statement.type !== "ReturnStatement" || statement.arguments.length !== 1) {
    return null;
  }

  const outerCall = unwrapParentheses(statement.arguments[0]);
  if (!outerCall || outerCall.type !== "CallExpression") {
    return null;
  }

  const wrapperBase = unwrapParentheses(outerCall.base);
  if (!wrapperBase || wrapperBase.type !== "FunctionDeclaration") {
    return null;
  }

  const returnIndex = findNestedPayloadReturnIndex(wrapperBase.body);
  if (returnIndex === -1) {
    return null;
  }

  const payloadCall = unwrapParentheses(wrapperBase.body[returnIndex].arguments[0]);
  const payloadFunction = unwrapParentheses(payloadCall.base);
  if (!payloadFunction || payloadFunction.type !== "FunctionDeclaration") {
    return null;
  }

  return {
    outerCall,
    wrapperFunction: wrapperBase,
    payloadCall,
    payloadFunction,
    returnIndex,
  };
}

function containsNode(node, predicate) {
  const stack = [node];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (predicate(current)) {
      return true;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    for (const value of Object.values(current)) {
      stack.push(value);
    }
  }

  return false;
}

function looksLikeEnvAlias(node) {
  return containsNode(node, (current) => {
    const expression = unwrapParentheses(current);
    return (
      isIdentifier(expression, "_ENV") ||
      (
        expression &&
        expression.type === "CallExpression" &&
        isIdentifier(unwrapParentheses(expression.base), "getfenv")
      )
    );
  });
}

function looksLikeUnpackAlias(node) {
  return containsNode(node, (current) => {
    const expression = unwrapParentheses(current);
    return (
      isIdentifier(expression, "unpack") ||
      (
        expression &&
        expression.type === "MemberExpression" &&
        expression.indexer === "." &&
        isIdentifier(expression.base, "table") &&
        isIdentifier(expression.identifier, "unpack")
      ) ||
      (
        expression &&
        expression.type === "IndexExpression" &&
        isIdentifier(expression.base, "table") &&
        expression.index &&
        expression.index.type === "StringLiteral" &&
        expression.index.value === "unpack"
      )
    );
  });
}

function extractPayloadAliasHints(ast) {
  const context = getPayloadWrapperContext(ast);
  if (!context) {
    return null;
  }

  const aliases = [];
  const { payloadFunction, payloadCall } = context;
  const replacements = [
    ["_ENV", looksLikeEnvAlias],
    ["unpack", looksLikeUnpackAlias],
    ["newproxy", (node) => isIdentifier(unwrapParentheses(node), "newproxy")],
    ["setmetatable", (node) => isIdentifier(unwrapParentheses(node), "setmetatable")],
    ["getmetatable", (node) => isIdentifier(unwrapParentheses(node), "getmetatable")],
    ["select", (node) => isIdentifier(unwrapParentheses(node), "select")],
  ];

  for (let index = 0; index < payloadFunction.parameters.length; index += 1) {
    const parameter = payloadFunction.parameters[index];
    const argument = payloadCall.arguments[index];
    if (!parameter || parameter.type !== "Identifier" || !argument) {
      continue;
    }

    const replacement = replacements.find(([, matcher]) => matcher(argument));
    if (!replacement) {
      continue;
    }

    aliases.push({
      name: parameter.name,
      replacement: replacement[0],
    });
  }

  if (aliases.length === 0) {
    return null;
  }

  return {
    aliases,
    unpackAliases: aliases
      .filter((alias) => alias.replacement === "unpack")
      .map((alias) => alias.name),
  };
}

function unwrapOuterWrapper(ast) {
  const nextAst = cloneNode(ast);
  if (nextAst.body.length === 0) {
    return { ast: nextAst, changed: false };
  }

  const statement = nextAst.body[nextAst.body.length - 1];
  if (statement.type !== "ReturnStatement" || statement.arguments.length !== 1) {
    return { ast: nextAst, changed: false };
  }

  const [expression] = statement.arguments;
  const outerCall = unwrapParentheses(expression);
  if (!outerCall || outerCall.type !== "CallExpression") {
    return { ast: nextAst, changed: false };
  }

  const wrapperBase = unwrapParentheses(outerCall.base);
  if (!wrapperBase || wrapperBase.type !== "FunctionDeclaration") {
    return { ast: nextAst, changed: false };
  }

  const wrapperFunction = wrapperBase;
  const innerBody = wrapperFunction.body;

  const parameterLocals = [];
  wrapperFunction.parameters.forEach((param, i) => {
    if (param.type === "Identifier" && outerCall.arguments[i]) {
      parameterLocals.push({
        type: "LocalStatement",
        variables: [cloneNode(param)],
        init: [cloneNode(outerCall.arguments[i])],
      });
    }
  });

  const returnIndex = findNestedPayloadReturnIndex(innerBody);

  if (returnIndex !== -1) {
      const payloadCall = unwrapParentheses(innerBody[returnIndex].arguments[0]);
      const payloadFunction = unwrapParentheses(payloadCall.base);
      const isHelperStatement = (statement) => {
        if (!statement || typeof statement !== "object") {
          return false;
        }
        if (
          statement.type === "LocalStatement" ||
          statement.type === "AssignmentStatement" ||
          statement.type === "FunctionDeclaration"
        ) {
          return true;
        }
        if (statement.type === "DoStatement") {
          return statement.body.every(isHelperStatement);
        }
        return false;
      };

      const leadingStatements = innerBody.slice(0, returnIndex).filter(isHelperStatement);

      payloadFunction.parameters.forEach((param, i) => {
          if (param.type === "Identifier" && payloadCall.arguments[i]) {
              parameterLocals.push({
                  type: "LocalStatement",
                  variables: [cloneNode(param)],
                  init: [cloneNode(payloadCall.arguments[i])],
              });
          }
      });

      nextAst.body.splice(nextAst.body.length - 1, 1, ...leadingStatements, ...parameterLocals, ...payloadFunction.body);
      return { ast: nextAst, changed: true };
  }

  nextAst.body.splice(nextAst.body.length - 1, 1, ...parameterLocals, ...innerBody);
  return { ast: nextAst, changed: true };
}

module.exports = {
  extractPayloadAliasHints,
  unwrapOuterWrapper,
};