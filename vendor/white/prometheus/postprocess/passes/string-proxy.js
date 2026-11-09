const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function createStringLiteral(value) {
  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
  };
}

function createGlobalIndexTarget(keyNode) {
  return {
    type: "IndexExpression",
    base: {
      type: "Identifier",
      name: "_ENV",
    },
    index: keyNode,
  };
}

function toIndexKeyFromNode(node) {
  const target = unwrapParentheses(node);
  if (!target) {
    return createStringLiteral("__invalid_lvalue");
  }

  if (target.type === "StringLiteral") {
    return createStringLiteral(String(target.value));
  }

  if (target.type === "NumericLiteral") {
    return createStringLiteral(String(target.value));
  }

  if (target.type === "BooleanLiteral") {
    return createStringLiteral(target.value ? "true" : "false");
  }

  if (target.type === "NilLiteral") {
    return createStringLiteral("nil");
  }

  if (target.type === "Identifier" && isValidIdentifierName(target.name)) {
    return createStringLiteral(target.name);
  }

  return createStringLiteral("__invalid_lvalue");
}

function normalizeAssignmentTarget(node) {
  const target = unwrapParentheses(node);
  if (!target) {
    return createGlobalIndexTarget(createStringLiteral("__invalid_lvalue"));
  }

  if (target.type === "Identifier" || target.type === "IndexExpression" || target.type === "MemberExpression") {
    return node;
  }

  if (target.type === "StringLiteral" && isValidIdentifierName(target.value)) {
    return {
      type: "Identifier",
      name: target.value,
    };
  }

  return createGlobalIndexTarget(toIndexKeyFromNode(target));
}

function rewriteStatement(statement) {
  if (!statement || typeof statement !== "object") {
    return statement;
  }

  if (statement.type === "AssignmentStatement" && Array.isArray(statement.variables)) {
    let changed = false;
    const nextVariables = statement.variables.map((variable) => {
      const normalized = normalizeAssignmentTarget(variable);
      if (normalized !== variable) {
        changed = true;
      }
      return normalized;
    });

    if (changed) {
      return {
        ...statement,
        variables: nextVariables,
      };
    }
    return statement;
  }

  if (statement.type === "IfStatement") {
    return {
      ...statement,
      clauses: statement.clauses.map((clause) => ({
        ...clause,
        body: rewriteBlock(clause.body || []),
      })),
    };
  }

  if (
    statement.type === "WhileStatement" ||
    statement.type === "RepeatStatement" ||
    statement.type === "DoStatement" ||
    statement.type === "ForNumericStatement" ||
    statement.type === "ForGenericStatement" ||
    statement.type === "FunctionDeclaration"
  ) {
    return {
      ...statement,
      body: rewriteBlock(statement.body || []),
    };
  }

  return statement;
}

function rewriteBlock(statements) {
  let changed = false;
  const next = statements.map((statement) => {
    const rewritten = rewriteStatement(statement);
    if (rewritten !== statement) {
      changed = true;
    }
    return rewritten;
  });
  return changed ? next : statements;
}

function sanitizeInvalidAssignmentTargets(ast) {
  if (!ast || !Array.isArray(ast.body)) {
    return {
      ast,
      changed: false,
    };
  }

  const body = rewriteBlock(ast.body);
  if (body === ast.body) {
    return {
      ast,
      changed: false,
    };
  }

  return {
    ast: {
      ...ast,
      body,
    },
    changed: true,
  };
}

module.exports = {
  sanitizeInvalidAssignmentTargets,
};