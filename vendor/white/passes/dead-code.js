function createScope(parent) {
  return {
    parent,
    bindings: new Map(),
  };
}

function resolveBinding(scope, name) {
  let current = scope;
  while (current) {
    const binding = current.bindings.get(name);
    if (binding) {
      return binding;
    }
    current = current.parent;
  }
  return null;
}

function isPureCallExpression(node) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }

  if (
    node.base &&
    node.base.type === "Identifier" &&
    ["tostring", "tonumber", "type", "typeof"].includes(node.base.name)
  ) {
    return node.arguments.every(isPureExpression);
  }

  if (
    node.base &&
    node.base.type === "MemberExpression" &&
    node.base.base &&
    node.base.base.type === "Identifier"
  ) {
    const baseName = node.base.base.name;
    const memberName = node.base.identifier && node.base.identifier.name;

    if (
      baseName === "game" &&
      node.base.indexer === ":" &&
      memberName === "GetService" &&
      node.arguments.every(isPureExpression)
    ) {
      return true;
    }

    if (
      ["Color3", "UDim", "UDim2", "Vector2", "Vector3", "CFrame", "TweenInfo"].includes(baseName) &&
      ["new", "fromRGB", "fromHSV"].includes(memberName) &&
      node.arguments.every(isPureExpression)
    ) {
      return true;
    }
  }

  return false;
}

function isAlwaysErrorBinaryExpression(node) {
  if (!node || node.type !== "BinaryExpression") {
    return false;
  }

  const numericOps = new Set(["+", "-", "*", "/", "%", "^", "//", "<", "<=", ">", ">="]);
  if (!numericOps.has(node.operator)) {
    return false;
  }

  const leftType = getPureLiteralType(node.left);
  const rightType = getPureLiteralType(node.right);
  if (!leftType || !rightType) {
    return false;
  }

  if ((leftType === "string" && rightType === "number") ||
      (leftType === "number" && rightType === "string")) {
    return true;
  }

  if (leftType === "boolean" || rightType === "boolean" ||
      leftType === "table" || rightType === "table") {
    return true;
  }

  return false;
}

function getPureLiteralType(node) {
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

function isAlwaysErrorReturnStatement(stmt) {
  if (!stmt || stmt.type !== "ReturnStatement") {
    return false;
  }
  for (const arg of stmt.arguments) {
    if (isAlwaysErrorBinaryExpression(arg)) {
      return true;
    }
  }
  return false;
}

function isTrashOrErrorFunction(node) {
  if (!node || node.type !== "FunctionDeclaration") {
    return false;
  }

  const body = node.body;
  if (!body || body.length === 0) {
    return true;
  }

  let hasErrorExpr = false;
  for (const stmt of body) {
    if (isAlwaysErrorReturnStatement(stmt)) {
      hasErrorExpr = true;
      break;
    }
    if (stmt.type === "AssignmentStatement") {
      for (const init of stmt.init) {
        if (isAlwaysErrorBinaryExpression(init)) {
          hasErrorExpr = true;
          break;
        }
      }
    }
    if (hasErrorExpr) break;
  }

  if (hasErrorExpr) return true;

  if (body.length <= 2) {
    let hasTrashAssign = false;
    let hasBareReturn = false;

    for (const stmt of body) {
      if (stmt.type === "AssignmentStatement" && stmt.variables.length === 1) {
        const target = stmt.variables[0];
        if (target.type === "IndexExpression" && target.base && target.base.type === "Identifier") {
          const baseName = target.base.name;

          if (/^[A-Z]$/.test(baseName)) {
            hasTrashAssign = true;
            continue;
          }
        }
      }
      if (stmt.type === "ReturnStatement" && stmt.arguments.length === 0) {
        hasBareReturn = true;
      }
    }

    if (hasTrashAssign && hasBareReturn) {
      return true;
    }
  }

  return false;
}

function isPureExpression(node) {
  if (!node) {
    return true;
  }

  switch (node.type) {
    case "Identifier":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
      return true;
    case "ParenthesisExpression":
      return isPureExpression(node.expression);
    case "FunctionDeclaration":
      return true;
    case "CallExpression":
      return isPureCallExpression(node);
    case "TableConstructorExpression":
      return node.fields.every((field) => {
        if (field.type === "TableValue") {
          return isPureExpression(field.value);
        }
        if (field.type === "TableKey") {
          return isPureExpression(field.key) && isPureExpression(field.value);
        }
        if (field.type === "TableKeyString") {
          return isPureExpression(field.value);
        }
        return false;
      });
    default:
      return false;
  }
}

function collectUnusedInfo(ast) {
  const rootUses = new Set();
  const localStatementInfo = new WeakMap();
  const bindingByFunctionStatement = new WeakMap();

  function recordUse(binding, owner) {
    if (!binding) {
      return;
    }
    if (owner) {
      owner.deps.add(binding);
      return;
    }
    rootUses.add(binding);
  }

  function collectExpression(node, scope, owner) {
    if (!node || typeof node !== "object") {
      return;
    }

    switch (node.type) {
      case "Identifier": {
        const binding = resolveBinding(scope, node.name);
        recordUse(binding, owner);
        return;
      }
      case "ParenthesisExpression":
        collectExpression(node.expression, scope, owner);
        return;
      case "UnaryExpression":
        collectExpression(node.argument, scope, owner);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        collectExpression(node.left, scope, owner);
        collectExpression(node.right, scope, owner);
        return;
      case "IfExpression":
        collectExpression(node.condition, scope, owner);
        collectExpression(node.trueExpression, scope, owner);
        collectExpression(node.falseExpression, scope, owner);
        return;
      case "IndexExpression":
        collectExpression(node.base, scope, owner);
        collectExpression(node.index, scope, owner);
        return;
      case "MemberExpression":
        collectExpression(node.base, scope, owner);
        return;
      case "CallExpression":
        collectExpression(node.base, scope, owner);
        node.arguments.forEach((arg) => collectExpression(arg, scope, owner));
        return;
      case "TableCallExpression":
        collectExpression(node.base, scope, owner);
        collectExpression(node.arguments, scope, owner);
        return;
      case "StringCallExpression":
        collectExpression(node.base, scope, owner);
        collectExpression(node.argument, scope, owner);
        return;
      case "TableConstructorExpression":
        node.fields.forEach((field) => {
          if (field.type === "TableValue") {
            collectExpression(field.value, scope, owner);
            return;
          }
          if (field.type === "TableKey") {
            collectExpression(field.key, scope, owner);
            collectExpression(field.value, scope, owner);
            return;
          }
          if (field.type === "TableKeyString") {
            collectExpression(field.value, scope, owner);
          }
        });
        return;
      case "FunctionDeclaration": {
        const fnScope = createScope(scope);
        node.parameters.forEach((param) => {
          if (param.type !== "Identifier") {
            return;
          }
          fnScope.bindings.set(param.name, {
            name: param.name,
            deps: new Set(),
            statementInfo: null,
            statement: null,
          });
        });
        collectStatements(node.body, fnScope, owner);
        return;
      }
      default:
        return;
    }
  }

  function collectStatements(statements, scope, owner) {
    for (const statement of statements) {
      collectStatement(statement, scope, owner);
    }
  }

  function collectStatement(statement, scope, owner) {
    if (!statement || typeof statement !== "object") {
      return;
    }

    switch (statement.type) {
      case "LocalStatement": {
        const info = {
          bindings: [],
          deps: new Set(),
          pure: statement.init.every(isPureExpression),
        };
        localStatementInfo.set(statement, info);

        const initOwner = info.pure ? info : null;
        statement.init.forEach((expr) => collectExpression(expr, scope, initOwner));

        statement.variables.forEach((variable) => {
          const binding = {
            name: variable.name,
            deps: new Set(),
            statementInfo: info,
            statement,
          };
          scope.bindings.set(variable.name, binding);
          info.bindings.push(binding);
        });
        return;
      }
      case "FunctionDeclaration": {
        if (statement.isLocal) {
          const binding = {
            name: statement.identifier.name,
            deps: new Set(),
            statementInfo: null,
            statement,
          };
          scope.bindings.set(statement.identifier.name, binding);
          bindingByFunctionStatement.set(statement, binding);
          const fnScope = createScope(scope);
          statement.parameters.forEach((param) => {
            if (param.type !== "Identifier") {
              return;
            }
            fnScope.bindings.set(param.name, {
              name: param.name,
              deps: new Set(),
              statementInfo: null,
              statement: null,
            });
          });
          collectStatements(statement.body, fnScope, binding);
          return;
        }
        const fnScope = createScope(scope);
        statement.parameters.forEach((param) => {
          if (param.type !== "Identifier") {
            return;
          }
          fnScope.bindings.set(param.name, {
            name: param.name,
            deps: new Set(),
            statementInfo: null,
            statement: null,
          });
        });
        collectStatements(statement.body, fnScope, null);
        return;
      }
      case "AssignmentStatement":
        statement.variables.forEach((expr) => collectExpression(expr, scope, null));
        statement.init.forEach((expr) => collectExpression(expr, scope, null));
        return;
      case "CallStatement":
        collectExpression(statement.expression, scope, null);
        return;
      case "ReturnStatement":
        statement.arguments.forEach((expr) => collectExpression(expr, scope, null));
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.condition) {
            collectExpression(clause.condition, scope, null);
          }
          const clauseScope = createScope(scope);
          collectStatements(clause.body, clauseScope, null);
        });
        return;
      case "WhileStatement": {
        collectExpression(statement.condition, scope, null);
        const bodyScope = createScope(scope);
        collectStatements(statement.body, bodyScope, null);
        return;
      }
      case "RepeatStatement": {
        const repeatScope = createScope(scope);
        collectStatements(statement.body, repeatScope, null);
        collectExpression(statement.condition, repeatScope, null);
        return;
      }
      case "DoStatement": {
        const bodyScope = createScope(scope);
        collectStatements(statement.body, bodyScope, null);
        return;
      }
      case "ForNumericStatement": {
        collectExpression(statement.start, scope, null);
        collectExpression(statement.end, scope, null);
        if (statement.step) {
          collectExpression(statement.step, scope, null);
        }
        const loopScope = createScope(scope);
        loopScope.bindings.set(statement.variable.name, {
          name: statement.variable.name,
          deps: new Set(),
          statementInfo: null,
          statement: null,
        });
        collectStatements(statement.body, loopScope, null);
        return;
      }
      case "ForGenericStatement": {
        statement.iterators.forEach((expr) => collectExpression(expr, scope, null));
        const loopScope = createScope(scope);
        statement.variables.forEach((variable) => {
          loopScope.bindings.set(variable.name, {
            name: variable.name,
            deps: new Set(),
            statementInfo: null,
            statement: null,
          });
        });
        collectStatements(statement.body, loopScope, null);
        return;
      }
      default:
        return;
    }
  }

  const rootScope = createScope(null);
  collectStatements(ast.body, rootScope, null);

  return {
    rootUses,
    localStatementInfo,
    bindingByFunctionStatement,
  };
}

function computeLiveBindings(rootUses) {
  const live = new Set(rootUses);
  const queue = [...rootUses];
  const activatedStatements = new Set();

  while (queue.length) {
    const binding = queue.pop();
    if (!binding) {
      continue;
    }
    if (binding.deps && binding.deps.size) {
      for (const dep of binding.deps) {
        if (!live.has(dep)) {
          live.add(dep);
          queue.push(dep);
        }
      }
    }

    const statementInfo = binding.statementInfo;
    if (statementInfo && statementInfo.pure && !activatedStatements.has(statementInfo)) {
      activatedStatements.add(statementInfo);
      for (const dep of statementInfo.deps) {
        if (!live.has(dep)) {
          live.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  return live;
}

function pruneUnusedLocals(ast, live, localStatementInfo, bindingByFunctionStatement) {
  let changed = false;

  function pruneExpression(node) {
    if (!node || typeof node !== "object") {
      return;
    }

    switch (node.type) {
      case "ParenthesisExpression":
        pruneExpression(node.expression);
        return;
      case "UnaryExpression":
        pruneExpression(node.argument);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        pruneExpression(node.left);
        pruneExpression(node.right);
        return;
      case "IfExpression":
        pruneExpression(node.condition);
        pruneExpression(node.trueExpression);
        pruneExpression(node.falseExpression);
        return;
      case "IndexExpression":
        pruneExpression(node.base);
        pruneExpression(node.index);
        return;
      case "MemberExpression":
        pruneExpression(node.base);
        return;
      case "CallExpression":
        pruneExpression(node.base);
        node.arguments.forEach(pruneExpression);
        return;
      case "TableCallExpression":
        pruneExpression(node.base);
        pruneExpression(node.arguments);
        return;
      case "StringCallExpression":
        pruneExpression(node.base);
        pruneExpression(node.argument);
        return;
      case "TableConstructorExpression":
        node.fields.forEach((field) => {
          if (field.type === "TableValue") {
            pruneExpression(field.value);
            return;
          }
          if (field.type === "TableKey") {
            pruneExpression(field.key);
            pruneExpression(field.value);
            return;
          }
          if (field.type === "TableKeyString") {
            pruneExpression(field.value);
          }
        });
        return;
      case "FunctionDeclaration": {
        const result = pruneBlock(node.body);
        if (result) {
          changed = true;
        }
        return;
      }
      default:
        return;
    }
  }

  function pruneBlock(statements) {
    let blockChanged = false;
    const next = [];

    for (const statement of statements) {
      if (statement.type === "LocalStatement") {
        const info = localStatementInfo.get(statement);
        if (info && info.pure && info.bindings.every((binding) => !live.has(binding))) {
          blockChanged = true;
          continue;
        }
        statement.init.forEach(pruneExpression);
        next.push(statement);
        continue;
      }

      if (statement.type === "FunctionDeclaration" && statement.isLocal) {
        const binding = bindingByFunctionStatement.get(statement);
        if (binding && !live.has(binding)) {
          blockChanged = true;
          continue;
        }
        const result = pruneBlock(statement.body);
        if (result) {
          blockChanged = true;
        }
        next.push(statement);
        continue;
      }

      switch (statement.type) {
        case "AssignmentStatement":
          statement.variables.forEach(pruneExpression);
          statement.init.forEach(pruneExpression);
          break;
        case "CallStatement":
          if (isPureExpression(statement.expression)) {
            blockChanged = true;
            continue;
          }
          pruneExpression(statement.expression);
          break;
        case "ReturnStatement":
          statement.arguments.forEach(pruneExpression);
          break;
        case "IfStatement":
          statement.clauses.forEach((clause) => {
            if (clause.condition) {
              pruneExpression(clause.condition);
            }
            const result = pruneBlock(clause.body);
            if (result) {
              blockChanged = true;
            }
          });
          break;
        case "WhileStatement": {
          pruneExpression(statement.condition);
          const result = pruneBlock(statement.body);
          if (result) {
            blockChanged = true;
          }
          break;
        }
        case "RepeatStatement": {
          const result = pruneBlock(statement.body);
          if (result) {
            blockChanged = true;
          }
          pruneExpression(statement.condition);
          break;
        }
        case "DoStatement": {
          const result = pruneBlock(statement.body);
          if (result) {
            blockChanged = true;
          }
          break;
        }
        case "ForNumericStatement": {
          pruneExpression(statement.start);
          pruneExpression(statement.end);
          if (statement.step) {
            pruneExpression(statement.step);
          }
          const result = pruneBlock(statement.body);
          if (result) {
            blockChanged = true;
          }
          break;
        }
        case "ForGenericStatement": {
          statement.iterators.forEach(pruneExpression);
          const result = pruneBlock(statement.body);
          if (result) {
            blockChanged = true;
          }
          break;
        }
        default:
          break;
      }

      next.push(statement);
    }

    if (blockChanged) {
      statements.length = 0;
      statements.push(...next);
    }

    return blockChanged;
  }

  const rootChanged = pruneBlock(ast.body);
  changed = changed || rootChanged;

  return { ast, changed };
}

function removeUnusedLocals(ast) {
  const { rootUses, localStatementInfo, bindingByFunctionStatement } = collectUnusedInfo(ast);
  const live = computeLiveBindings(rootUses);
  return pruneUnusedLocals(ast, live, localStatementInfo, bindingByFunctionStatement);
}

module.exports = {
  analyzeUnused(ast) {
    const { rootUses, localStatementInfo, bindingByFunctionStatement } = collectUnusedInfo(ast);
    const live = computeLiveBindings(rootUses);
    return { live, localStatementInfo, bindingByFunctionStatement };
  },
  isPureExpression,
  removeUnusedLocals,
};