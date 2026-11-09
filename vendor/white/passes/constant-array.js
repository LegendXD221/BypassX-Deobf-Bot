const { cloneNode } = require("../lua/ast");
const { evaluateLiteral, evaluateNumeric, isLiteralValue } = require("./constant-fold");

function findTopLevelArrayDeclaration(ast) {
  for (const statement of ast.body) {
    if (statement.type !== "LocalStatement" && statement.type !== "AssignmentStatement") {
      continue;
    }

    const variables = statement.variables || [];
    const initializers = statement.init || [];

    for (let index = 0; index < variables.length; index += 1) {
      const variable = variables[index];
      const initializer = initializers[index];
      if (!initializer || initializer.type !== "TableConstructorExpression") {
        continue;
      }
      if (!variable || variable.type !== "Identifier") {
        continue;
      }

      const values = extractArrayValues(initializer);
      if (!values) {
        continue;
      }

      const canRemove =
        statement.type === "LocalStatement" && variables.length === 1 && initializers.length === 1;

      return {
        statement,
        arrayName: variable.name,
        values,
        canRemove,
      };
    }
  }

  return null;
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

function createStringLiteral(value) {
  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
  };
}

function createNumericLiteral(value) {
  return {
    type: "NumericLiteral",
    value,
    raw: String(value),
  };
}

function createBooleanLiteral(value) {
  return {
    type: "BooleanLiteral",
    value,
    raw: value ? "true" : "false",
  };
}

function createNilLiteral() {
  return {
    type: "NilLiteral",
    value: null,
    raw: "nil",
  };
}

function literalFromValue(value) {
  if (value === null) {
    return createNilLiteral();
  }
  if (typeof value === "string") {
    return createStringLiteral(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return createNumericLiteral(value);
  }
  if (typeof value === "boolean") {
    return createBooleanLiteral(value);
  }
  return null;
}

function extractLiteralNode(node) {
  const unwrapped = unwrapParentheses(node);
  if (!unwrapped) {
    return null;
  }
  if (isLiteralNode(unwrapped)) {
    return cloneNode(unwrapped);
  }
  const evaluated = evaluateLiteral(unwrapped);
  return literalFromValue(evaluated);
}

function extractNumericKey(node) {
  const value = evaluateNumeric(node);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const literal = evaluateLiteral(node);
  if (typeof literal === "string" && /^[0-9]+$/.test(literal)) {
    return Number(literal);
  }

  return null;
}

function extractArrayValues(tableExpression) {
  if (!tableExpression || tableExpression.type !== "TableConstructorExpression") {
    return null;
  }

  const values = [];
  let implicitIndex = 1;

  for (const field of tableExpression.fields) {
    if (field.type === "TableValue") {
      const literal = extractLiteralNode(field.value);
      if (!literal) {
        return null;
      }
      values[implicitIndex - 1] = literal;
      implicitIndex += 1;
      continue;
    }

    if (field.type === "TableKey") {
      const keyValue = extractNumericKey(field.key);
      if (!Number.isFinite(keyValue) || keyValue < 1 || !Number.isInteger(keyValue)) {
        return null;
      }
      const literal = extractLiteralNode(field.value);
      if (!literal) {
        return null;
      }
      while (values.length < keyValue) {
        values.push(createNilLiteral());
      }
      values[keyValue - 1] = literal;
      continue;
    }

    return null;
  }

  if (values.length === 0) {
    return null;
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!values[index]) {
      values[index] = createNilLiteral();
    }
  }

  return values;
}

function reverseRange(values, left, right) {
  let start = left - 1;
  let end = right - 1;
  while (start < end) {
    const temp = values[start];
    values[start] = values[end];
    values[end] = temp;
    start += 1;
    end -= 1;
  }
}

function rotateArray(values, shift) {
  const copy = values.slice();
  reverseRange(copy, 1, copy.length);
  reverseRange(copy, 1, shift);
  reverseRange(copy, shift + 1, copy.length);
  return copy;
}

function detectRotationStatement(statement, arrayName) {
  if (statement.type !== "ForGenericStatement") {
    return null;
  }

  if (
    statement.iterators.length !== 1 ||
    !(
      (
        statement.iterators[0].type === "CallExpression" &&
        statement.iterators[0].base.type === "Identifier" &&
        statement.iterators[0].base.name === "ipairs"
      ) ||
      (
        statement.iterators[0].type === "TableCallExpression" &&
        statement.iterators[0].base.type === "Identifier" &&
        statement.iterators[0].base.name === "ipairs"
      )
    )
  ) {
    return null;
  }

  const argument =
    statement.iterators[0].type === "CallExpression"
      ? statement.iterators[0].arguments[0]
      : statement.iterators[0].arguments;
  if (!argument || argument.type !== "TableConstructorExpression") {
    return null;
  }

  const ranges = [];
  for (const field of argument.fields) {
    if (field.type !== "TableValue" || field.value.type !== "TableConstructorExpression") {
      return null;
    }
    const [leftField, rightField] = field.value.fields;
    if (!leftField || !rightField) {
      return null;
    }
    const left = leftField.type === "TableValue" ? evaluateNumeric(leftField.value) : null;
    const right = rightField.type === "TableValue" ? evaluateNumeric(rightField.value) : null;
    if (left === null || right === null) {
      return null;
    }
    ranges.push([left, right]);
  }

  if (ranges.length !== 3) {
    return null;
  }

  const whileStatement = statement.body.find((node) => node.type === "WhileStatement");
  if (!whileStatement) {
    return null;
  }

  const assignment = whileStatement.body.find((node) => node.type === "AssignmentStatement");
  if (!assignment) {
    return null;
  }

  const arrayTargets = assignment.variables.filter((variable) => {
    return variable.type === "IndexExpression" && variable.base.type === "Identifier" && variable.base.name === arrayName;
  });

  if (arrayTargets.length !== 2) {
    return null;
  }

  return ranges;
}

function decodeBase64String(value, alphabetMap) {
  let buffer = 0;
  let bits = 0;
  const bytes = [];

  for (const char of value) {
    if (char === "=") {
      break;
    }

    const code = alphabetMap.get(char);
    if (code === undefined) {
      continue;
    }

    buffer = (buffer << 6) | code;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Buffer.from(bytes).toString("latin1");
}

function extractDecodeAlphabet(statement) {
  if (statement.type !== "DoStatement") {
    return null;
  }

  for (const nested of statement.body) {
    if (nested.type !== "LocalStatement") {
      continue;
    }

    for (const initializer of nested.init) {
      if (!initializer || initializer.type !== "TableConstructorExpression") {
        continue;
      }

      const entries = [];
      for (const field of initializer.fields) {
        if (field.value.type !== "NumericLiteral") {
          entries.length = 0;
          break;
        }

        if (field.type === "TableKeyString") {
          entries.push([field.key.name, field.value.value]);
          continue;
        }

        if (field.type === "TableKey" && field.key.type === "StringLiteral" && typeof field.key.value === "string") {
          entries.push([field.key.value, field.value.value]);
          continue;
        }

        entries.length = 0;
        break;
      }

      if (entries.length >= 64) {
        return new Map(entries);
      }
    }
  }

  return null;
}

function extractChunkDecodeMap(statement) {
  if (statement.type !== "DoStatement") {
    return null;
  }

  for (const nested of statement.body) {
    if (nested.type !== "LocalStatement") {
      continue;
    }

    for (const initializer of nested.init) {
      if (!initializer || initializer.type !== "TableConstructorExpression") {
        continue;
      }

      const entries = [];
      let keyLength = null;

      for (const field of initializer.fields) {
        const value = evaluateNumeric(field.value);
        if (value === null || !Number.isFinite(value) || value < 0 || value > 255) {
          entries.length = 0;
          break;
        }

        let key = null;
        if (field.type === "TableKeyString") {
          key = field.key.name;
        } else if (field.type === "TableKey" && field.key.type === "StringLiteral" && typeof field.key.value === "string") {
          key = field.key.value;
        }

        if (!key) {
          entries.length = 0;
          break;
        }

        if (keyLength === null) {
          keyLength = key.length;
        } else if (key.length !== keyLength) {
          entries.length = 0;
          break;
        }

        entries.push([key, value]);
      }

      if (entries.length >= 32 && keyLength !== null && keyLength >= 2) {
        return {
          map: new Map(entries),
          keyLength,
          statement,
        };
      }
    }
  }

  return null;
}

function resolveArrayIndexExpression(indexExpression, parameterNames) {
  const resolveParamIndex = (node) => {
    if (!node || node.type !== "Identifier") {
      return null;
    }
    const index = parameterNames.indexOf(node.name);
    return index >= 0 ? index + 1 : null;
  };

  const extractLinear = (node) => {
    const current = unwrapParentheses(node);
    if (!current) {
      return null;
    }

    if (current.type === "Identifier") {
      const argIndex = resolveParamIndex(current);
      if (!argIndex) {
        return null;
      }
      return { argIndex, offset: 0 };
    }

    const constantValue = evaluateNumeric(current);
    if (constantValue !== null) {
      return { argIndex: null, offset: constantValue };
    }

    if (current.type === "BinaryExpression" && (current.operator === "+" || current.operator === "-")) {
      const left = extractLinear(current.left);
      const right = extractLinear(current.right);
      if (!left || !right) {
        return null;
      }

      if (left.argIndex && right.argIndex) {
        return null;
      }

      if (left.argIndex) {
        const offset = current.operator === "+" ? left.offset + right.offset : left.offset - right.offset;
        return { argIndex: left.argIndex, offset };
      }

      if (right.argIndex) {
        if (current.operator !== "+") {
          return null;
        }
        const offset = left.offset + right.offset;
        return { argIndex: right.argIndex, offset };
      }

      const offset = current.operator === "+" ? left.offset + right.offset : left.offset - right.offset;
      return { argIndex: null, offset };
    }

    return null;
  };

  const linear = extractLinear(indexExpression);
  if (!linear || !linear.argIndex) {
    return null;
  }

  if (linear.offset >= 0) {
    return { argIndex: linear.argIndex, offset: linear.offset, direction: 1 };
  }

  return { argIndex: linear.argIndex, offset: Math.abs(linear.offset), direction: -1 };
}

function extractArrayWrapperInfo(func, arrayName) {
  if (!func || func.type !== "FunctionDeclaration") {
    return null;
  }

  if (func.body.length !== 1 || func.body[0].type !== "ReturnStatement") {
    return null;
  }

  const [returnExpression] = func.body[0].arguments;
  if (!returnExpression || returnExpression.type !== "IndexExpression") {
    return null;
  }

  if (returnExpression.base.type !== "Identifier" || returnExpression.base.name !== arrayName) {
    return null;
  }

  const parameterNames = func.parameters.filter((param) => param.type === "Identifier").map((param) => param.name);
  if (parameterNames.length === 0) {
    return null;
  }

  const indexInfo = resolveArrayIndexExpression(returnExpression.index, parameterNames);
  if (!indexInfo) {
    return null;
  }

  return {
    argIndex: indexInfo.argIndex,
    offset: indexInfo.offset,
    direction: indexInfo.direction,
  };
}

function extractWrapperFromFunction(func, arrayName, functionNameOverride = null) {
  const info = extractArrayWrapperInfo(func, arrayName);
  if (!info) {
    return null;
  }

  const functionName = functionNameOverride || (func.identifier ? func.identifier.name : null);
  if (!functionName) {
    return null;
  }

  return {
    functionName,
    argIndex: info.argIndex,
    offset: info.offset,
    direction: info.direction,
  };
}

function extractWrapper(statement, arrayName) {
  if (statement.type === "FunctionDeclaration") {
    const wrapper = extractWrapperFromFunction(statement, arrayName);
    if (!wrapper) {
      return null;
    }
    return {
      ...wrapper,
      canRemove: true,
      declarationType: "FunctionDeclaration",
    };
  }

  if (statement.type === "LocalStatement") {
    for (let index = 0; index < statement.variables.length; index += 1) {
      const variable = statement.variables[index];
      const initializer = statement.init[index];
      if (!variable || variable.type !== "Identifier") {
        continue;
      }
      if (!initializer || initializer.type !== "FunctionDeclaration") {
        continue;
      }
      const wrapper = extractWrapperFromFunction(initializer, arrayName, variable.name);
      if (!wrapper) {
        continue;
      }
      return {
        ...wrapper,
        canRemove: statement.variables.length === 1 && statement.init.length === 1,
        declarationType: "LocalStatement",
      };
    }
  }

  if (statement.type === "AssignmentStatement") {
    for (let index = 0; index < statement.variables.length; index += 1) {
      const variable = statement.variables[index];
      const initializer = statement.init[index];
      if (!variable || variable.type !== "Identifier") {
        continue;
      }
      if (!initializer || initializer.type !== "FunctionDeclaration") {
        continue;
      }
      const wrapper = extractWrapperFromFunction(initializer, arrayName, variable.name);
      if (!wrapper) {
        continue;
      }
      return {
        ...wrapper,
        canRemove: false,
        declarationType: "AssignmentStatement",
      };
    }
  }

  return null;
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function extractWrapperTable(statement, wrapperName) {
  if (
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    statement.init[0].type !== "TableConstructorExpression" ||
    statement.variables[0].type !== "Identifier"
  ) {
    return null;
  }

  const tableName = statement.variables[0].name;
  const tableExpression = statement.init[0];
  const wrappers = new Map();

  for (const field of tableExpression.fields) {
    const key = getWrapperTableKey(field);
    if (!key || !field.value || field.value.type !== "FunctionDeclaration") {
      return null;
    }

    const info = extractWrapperFunctionInfo(field.value, wrapperName);
    if (!info) {
      return null;
    }

    wrappers.set(key, info);
  }

  if (wrappers.size === 0) {
    return null;
  }

  return {
    tableName,
    wrappers,
    canRemove: true,
  };
}

function extractDirectWrapperTable(statement, arrayName) {
  if (
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    statement.init[0].type !== "TableConstructorExpression" ||
    statement.variables[0].type !== "Identifier"
  ) {
    return null;
  }

  const tableName = statement.variables[0].name;
  const tableExpression = statement.init[0];
  const wrappers = new Map();

  for (const field of tableExpression.fields) {
    const key = getWrapperTableKey(field);
    if (!key || !field.value || field.value.type !== "FunctionDeclaration") {
      return null;
    }

    const info = extractArrayWrapperInfo(field.value, arrayName);
    if (!info) {
      return null;
    }

    wrappers.set(key, {
      argIndex: info.argIndex,
      offset: info.offset,
      direction: info.direction,
    });
  }

  if (wrappers.size === 0) {
    return null;
  }

  return {
    tableName,
    wrappers,
    canRemove: true,
    direct: true,
  };
}

function getWrapperTableKey(field) {
  if (field.type === "TableKeyString" && field.key && field.key.name) {
    return field.key.name;
  }
  if (field.type === "TableKey" && field.key && field.key.type === "StringLiteral") {
    return field.key.value;
  }
  return null;
}

function extractWrapperFunctionInfo(func, wrapperName) {
  if (!func || func.type !== "FunctionDeclaration") {
    return null;
  }

  if (func.body.length !== 1 || func.body[0].type !== "ReturnStatement") {
    return null;
  }

  const [returnExpression] = func.body[0].arguments;
  if (!returnExpression || returnExpression.type !== "CallExpression") {
    return null;
  }

  if (returnExpression.base.type !== "Identifier" || returnExpression.base.name !== wrapperName) {
    return null;
  }

  if (returnExpression.arguments.length !== 1) {
    return null;
  }

  const argExpression = unwrapParentheses(returnExpression.arguments[0]);
  const parameterNames = func.parameters
    .filter((param) => param.type === "Identifier")
    .map((param) => param.name);

  const resolveArgIndex = (identifier) => {
    const index = parameterNames.indexOf(identifier);
    return index >= 0 ? index + 1 : null;
  };

  if (argExpression.type === "Identifier") {
    const argIndex = resolveArgIndex(argExpression.name);
    if (!argIndex) {
      return null;
    }
    return { argIndex, offset: 0, direction: 1 };
  }

  if (argExpression.type === "BinaryExpression" && (argExpression.operator === "+" || argExpression.operator === "-")) {
    const left = unwrapParentheses(argExpression.left);
    const right = unwrapParentheses(argExpression.right);
    let argIndex = null;
    let offsetValue = null;
    let direction = argExpression.operator === "+" ? 1 : -1;

    if (left.type === "Identifier") {
      argIndex = resolveArgIndex(left.name);
      offsetValue = evaluateNumeric(right);
    } else if (argExpression.operator === "+" && right.type === "Identifier") {
      argIndex = resolveArgIndex(right.name);
      offsetValue = evaluateNumeric(left);
    }

    if (!argIndex || offsetValue === null) {
      return null;
    }

    return { argIndex, offset: offsetValue, direction };
  }

  return null;
}

function getWrapperTableCallInfo(base) {
  if (base.type === "IndexExpression" && base.base.type === "Identifier") {
    if (base.index.type === "StringLiteral") {
      return { tableName: base.base.name, key: base.index.value };
    }
    if (base.index.type === "Identifier") {
      return { tableName: base.base.name, key: base.index.name };
    }
  }

  if (base.type === "MemberExpression" && base.base.type === "Identifier") {
    return { tableName: base.base.name, key: base.identifier.name };
  }

  return null;
}

function getChildContext(parent, key, context) {
  if (!parent || !parent.type) {
    return context;
  }

  if (parent.type === "AssignmentStatement" && key === "variables") {
    return { ...context, inLValue: true };
  }

  if (parent.type === "LocalStatement" && key === "variables") {
    return { ...context, inLValue: true };
  }

  if (parent.type === "ForNumericStatement" && key === "variable") {
    return { ...context, inLValue: true };
  }

  if (parent.type === "ForGenericStatement" && key === "variables") {
    return { ...context, inLValue: true };
  }

  return context;
}

function replaceWrapperCalls(node, wrapper, values, state, wrapperTables, arrayName, context = { inLValue: false }) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    let changed = false;
    const nextArray = node.map((entry) => {
      const nextEntry = replaceWrapperCalls(entry, wrapper, values, state, wrapperTables, arrayName, context);
      if (nextEntry !== entry) {
        changed = true;
      }
      return nextEntry;
    });
    return changed ? nextArray : node;
  }

  if (
    (node.type === "LocalStatement" || node.type === "AssignmentStatement") &&
    node.init.length === 1 &&
    node.variables.length === 1 &&
    node.init[0].type === "Identifier" &&
    (node.init[0].name === arrayName || state.aliases.has(node.init[0].name))
  ) {
    state.aliases.add(node.variables[0].name);
  }

  let next = node;
  for (const [key, value] of Object.entries(node)) {
    const childContext = getChildContext(node, key, context);
    const nextValue = replaceWrapperCalls(value, wrapper, values, state, wrapperTables, arrayName, childContext);
    if (nextValue !== value) {
      if (next === node) {
        next = { ...node };
      }
      next[key] = nextValue;
    }
  }

  if (
    wrapper &&
    next.type === "CallExpression" &&
    next.base.type === "Identifier" &&
    next.base.name === wrapper.functionName
  ) {
    const argNode = next.arguments[wrapper.argIndex - 1];
    const indexValue = evaluateNumeric(argNode);
    if (indexValue !== null) {
      const arrayIndex = wrapper.direction === 1 ? indexValue + wrapper.offset : indexValue - wrapper.offset;
      if (arrayIndex >= 1 && arrayIndex <= values.length) {
        state.changed = true;
        return cloneNode(values[arrayIndex - 1]);
      }
    }
  }

  if (
    next.type === "CallExpression" &&
    (next.base.type === "IndexExpression" || next.base.type === "MemberExpression")
  ) {
    const callInfo = getWrapperTableCallInfo(next.base);
    if (callInfo && wrapperTables.has(callInfo.tableName)) {
      const tableInfo = wrapperTables.get(callInfo.tableName);
      const wrapperInfo = tableInfo.wrappers.get(callInfo.key);
      if (wrapperInfo) {
        const argNode = next.arguments[wrapperInfo.argIndex - 1];
        const argValue = evaluateNumeric(argNode);
        if (argValue !== null) {
          let arrayIndex = null;
          if (tableInfo.direct) {
            arrayIndex =
              wrapperInfo.direction === 1 ? argValue + wrapperInfo.offset : argValue - wrapperInfo.offset;
          } else if (wrapper) {
            const wrapperArg =
              wrapperInfo.direction === 1 ? argValue + wrapperInfo.offset : argValue - wrapperInfo.offset;
            arrayIndex = wrapper.direction === 1 ? wrapperArg + wrapper.offset : wrapperArg - wrapper.offset;
          }
          if (arrayIndex !== null && arrayIndex >= 1 && arrayIndex <= values.length) {
            state.changed = true;
            return cloneNode(values[arrayIndex - 1]);
          }
        }
        state.preserveWrapperTables.add(callInfo.tableName);
      }
    }
  }

  if (
    !context.inLValue &&
    next.type === "IndexExpression" &&
    next.base.type === "Identifier" &&
    (next.base.name === arrayName || state.aliases.has(next.base.name))
  ) {

    const resolvedIndex = replaceWrapperCalls(
      next.index,
      wrapper,
      values,
      state,
      wrapperTables,
      arrayName,
      { ...context, inLValue: false }
    );

    const indexValue = evaluateLiteral(resolvedIndex);
    if (typeof indexValue === "number" && Number.isInteger(indexValue)) {
      if (indexValue >= 1 && indexValue <= values.length) {
        state.changed = true;
        return cloneNode(values[indexValue - 1]);
      }
    } else if (isLiteralValue(indexValue)) {

    }

    if (resolvedIndex !== next.index) {
      next.index = resolvedIndex;
      state.changed = true;
    }
  }

  return next;
}

function isLikelyBase64String(value, alphabetSet) {
  if (typeof value !== "string" || value.length < 4) {
    return false;
  }

  const paddingIndex = value.indexOf("=");
  if (paddingIndex !== -1) {
    const paddingCount = value.length - paddingIndex;
    if (paddingCount > 2) {
      return false;
    }
    for (let index = paddingIndex; index < value.length; index += 1) {
      if (value[index] !== "=") {
        return false;
      }
    }
    if (value.length % 4 !== 0) {
      return false;
    }
  } else {
    const mod = value.length % 4;
    if (mod === 1) {
      return false;
    }
  }

  for (const char of value) {
    if (char === "=") {
      continue;
    }
    if (!alphabetSet.has(char)) {
      return false;
    }
  }

  return true;
}

function shouldDecodeBase64(values, alphabetMap) {
  if (!alphabetMap || typeof alphabetMap.keys !== "function") {
    return false;
  }

  const alphabetSet = new Set(alphabetMap.keys());
  let total = 0;
  let matches = 0;

  for (const entry of values) {
    if (!entry || entry.type !== "StringLiteral") {
      continue;
    }
    total += 1;
    if (isLikelyBase64String(entry.value, alphabetSet)) {
      matches += 1;
    }
  }

  if (total === 0) {
    return false;
  }

  const required = total < 3 ? total : Math.ceil(total * 0.6);
  return matches >= required;
}

function shouldDecodeChunkMap(values, mapInfo) {
  if (!mapInfo || !mapInfo.map || !mapInfo.keyLength) {
    return false;
  }

  const { map, keyLength } = mapInfo;
  if (keyLength < 2) {
    return false;
  }

  let total = 0;
  let matches = 0;

  for (const entry of values) {
    if (!entry || entry.type !== "StringLiteral") {
      continue;
    }
    total += 1;
    const value = entry.value;
    if (value.length % keyLength !== 0) {
      continue;
    }

    let ok = true;
    for (let index = 0; index < value.length; index += keyLength) {
      const chunk = value.slice(index, index + keyLength);
      if (!map.has(chunk)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches += 1;
    }
  }

  if (total === 0) {
    return false;
  }

  const required = total < 3 ? total : Math.ceil(total * 0.6);
  return matches >= required;
}

function decodeChunkMapString(value, map, keyLength) {
  if (value.length % keyLength !== 0) {
    return null;
  }

  let out = "";
  for (let index = 0; index < value.length; index += keyLength) {
    const chunk = value.slice(index, index + keyLength);
    const code = map.get(chunk);
    if (code === undefined) {
      return null;
    }
    out += String.fromCharCode(code);
  }
  return out;
}

function hasIdentifierReference(ast, names, options = {}) {
  const skipFunctionNames = options.skipFunctionNames || new Set();
  const skipTableNames = options.skipTableNames || new Set();
  const targetNames = Array.isArray(names) ? new Set(names) : names instanceof Set ? names : new Set([names]);
  let found = false;

  const visit = (node, parent = null, key = null) => {
    if (found || !node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, parent, key));
      return;
    }

    if (
      node.type === "FunctionDeclaration" &&
      node.identifier &&
      skipFunctionNames.has(node.identifier.name)
    ) {
      return;
    }

    if (
      node.type === "LocalStatement" &&
      node.variables &&
      node.variables.some((variable) => variable.type === "Identifier" && skipTableNames.has(variable.name))
    ) {
      return;
    }

    if (node.type === "Identifier" && targetNames.has(node.name)) {
      if (parent && parent.type === "LocalStatement" && key === "variables") {
        return;
      }
      if (parent && parent.type === "FunctionDeclaration" && key === "identifier") {
        return;
      }
      if (parent && parent.type === "ForNumericStatement" && key === "variable") {
        return;
      }
      if (parent && parent.type === "ForGenericStatement" && key === "variables") {
        return;
      }

      found = true;
      return;
    }

    for (const [childKey, childValue] of Object.entries(node)) {
      if (Array.isArray(childValue)) {
        childValue.forEach((entry) => visit(entry, node, childKey));
      } else if (childValue && typeof childValue === "object") {
        visit(childValue, node, childKey);
      }
    }
  };

  visit(ast);
  return found;
}

function decodeConstantArrayChunk(chunk, parentArrayName, parentValues, parentCanRemoveArray, parentWrapper, parentWrapperTables) {
  let nextChunk = chunk;

  const arrayDeclaration = findTopLevelArrayDeclaration(nextChunk);
  if (!arrayDeclaration && !parentArrayName) {
    return { ast: nextChunk, changed: false };
  }

  const arrayName = arrayDeclaration ? arrayDeclaration.arrayName : parentArrayName;
  let values = arrayDeclaration ? arrayDeclaration.values : (parentValues ? [...parentValues] : null);

  for (const statement of nextChunk.body) {
    const ranges = detectRotationStatement(statement, arrayName);
    if (!ranges) {
      continue;
    }

    const shift = ranges[1][1];
    values = rotateArray(values, shift);
    break;
  }

  let didChunkDecode = false;
  let chunkDecodeStatement = null;
  for (const statement of nextChunk.body) {
    const chunkMap = extractChunkDecodeMap(statement);
    if (!chunkMap) {
      continue;
    }
    if (!shouldDecodeChunkMap(values, chunkMap)) {
      continue;
    }
    values = values.map((entry) => {
      if (entry && entry.type === "StringLiteral") {
        const decoded = decodeChunkMapString(entry.value, chunkMap.map, chunkMap.keyLength);
        if (decoded !== null) {
          return createStringLiteral(decoded);
        }
      }
      return entry;
    });
    didChunkDecode = true;
    chunkDecodeStatement = chunkMap.statement;
    break;
  }

  let didDecode = false;
  for (const statement of nextChunk.body) {
    const map = extractDecodeAlphabet(statement);
    if (!map) {
      continue;
    }
    if (shouldDecodeBase64(values, map)) {
      values = values.map((entry) => {
        if (entry && entry.type === "StringLiteral") {
          const decoded = decodeBase64String(entry.value, map);
          return createStringLiteral(decoded);
        }
        return entry;
      });
      didDecode = true;
      break;
    }
  }

  let wrapper = null;
  for (const statement of nextChunk.body) {
    wrapper = extractWrapper(statement, arrayName);
    if (wrapper) {
      break;
    }
  }

  if (!wrapper && parentWrapper) {
    wrapper = parentWrapper;
  }

  const wrapperTables = parentWrapperTables ? new Map(parentWrapperTables) : new Map();
  for (const statement of nextChunk.body) {
    const directTable = extractDirectWrapperTable(statement, arrayName);
    if (directTable) {
      wrapperTables.set(directTable.tableName, directTable);
      continue;
    }

    if (!wrapper) {
      continue;
    }
    const table = extractWrapperTable(statement, wrapper.functionName);
    if (table) {
      wrapperTables.set(table.tableName, { ...table, direct: false });
    }
  }

  const state = { changed: false, preserveWrapperTables: new Set(), aliases: new Set() };
  nextChunk = replaceWrapperCalls(nextChunk, wrapper, values, state, wrapperTables, arrayName);
  if (!state.changed) {
    return { ast: nextChunk, changed: false };
  }

  const wrapperReferenced = wrapper ? hasIdentifierReference(nextChunk, wrapper.functionName) : false;
  const removeWrapper = Boolean(wrapper && wrapper.canRemove && !wrapperReferenced);

  const removableWrapperTables = new Set();
  for (const [name, tableInfo] of wrapperTables.entries()) {
    if (!tableInfo.canRemove) {
      continue;
    }
    if (state.preserveWrapperTables.has(name)) {
      continue;
    }
    const referenced = hasIdentifierReference(nextChunk, name);
    if (!referenced) {
      removableWrapperTables.add(name);
    }
  }

  const arrayReferenced = hasIdentifierReference(nextChunk, new Set([arrayName, ...state.aliases]), {
    skipFunctionNames: removeWrapper && wrapper ? new Set([wrapper.functionName]) : new Set(),
    skipTableNames: removableWrapperTables,
  });

  const removeArray = arrayDeclaration.canRemove && !arrayReferenced;

  nextChunk.body = nextChunk.body.filter((statement) => {
    if (
      removeArray &&
      statement.type === "LocalStatement" &&
      statement.variables.length === 1 &&
      statement.variables[0].type === "Identifier" &&
      statement.variables[0].name === arrayName
    ) {
      return false;
    }

    if (
      removeWrapper &&
      statement.type === "FunctionDeclaration" &&
      statement.identifier &&
      statement.identifier.name === wrapper.functionName
    ) {
      return false;
    }

    if (
      removeWrapper &&
      statement.type === "LocalStatement" &&
      statement.variables.length === 1 &&
      statement.variables[0].type === "Identifier" &&
      statement.variables[0].name === wrapper.functionName &&
      statement.init.length === 1 &&
      statement.init[0].type === "FunctionDeclaration"
    ) {
      return false;
    }

    if (
      statement.type === "LocalStatement" &&
      statement.variables.length === 1 &&
      statement.variables[0].type === "Identifier" &&
      removableWrapperTables.has(statement.variables[0].name)
    ) {
      return false;
    }

    if (removeArray && detectRotationStatement(statement, arrayName)) {
      return false;
    }
    if (removeArray && didDecode && extractDecodeAlphabet(statement)) {
      return false;
    }
    if (removeArray && didChunkDecode && chunkDecodeStatement && statement === chunkDecodeStatement) {
      return false;
    }
    return true;
  });

  return {
    ast: nextChunk,
    changed: state.changed,
    info: {
      arrayName,
      values,
      wrapper,
      wrapperTables,
      canRemoveArray: arrayDeclaration ? arrayDeclaration.canRemove : parentCanRemoveArray
    }
  };
}

function decodeConstantArray(ast) {
  let changed = false;

  const transformNode = (node, currentInfo) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((n) => transformNode(n, currentInfo));
    }

    if (node.type === "FunctionDeclaration") {
      return {
        ...node,
        body: transformBlock(node.body, currentInfo),
      };
    }

    if (node.type === "IfStatement") {
      return {
        ...node,
        clauses: node.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? transformNode(clause.condition, currentInfo) : clause.condition,
          body: transformBlock(clause.body || [], currentInfo),
        })),
      };
    }

    if (node.type === "WhileStatement" || node.type === "RepeatStatement" || node.type === "DoStatement") {
      return {
        ...node,
        condition: node.condition ? transformNode(node.condition, currentInfo) : node.condition,
        body: transformBlock(node.body, currentInfo),
      };
    }

    const next = {};
    for (const [key, value] of Object.entries(node)) {
      next[key] = transformNode(value, currentInfo);
    }
    return next;
  };

  const transformBlock = (body, parentInfo = null) => {
    const block = decodeConstantArrayChunk(
      {
        type: "Chunk",
        body,
        comments: [],
      },
      parentInfo?.arrayName,
      parentInfo?.values,
      parentInfo?.canRemoveArray,
      parentInfo?.wrapper,
      parentInfo?.wrapperTables
    );
    changed = changed || block.changed;

    const nextInfo = block.info || parentInfo;
    return block.ast.body.map((n) => transformNode(n, nextInfo));
  };

  const nextAst = cloneNode(ast);
  nextAst.body = transformBlock(nextAst.body);
  return { ast: nextAst, changed };
}

module.exports = {
  decodeConstantArray,
};