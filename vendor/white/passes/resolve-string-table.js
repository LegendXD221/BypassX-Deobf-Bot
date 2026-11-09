function resolveStringTable(ast) {
  let changed = false;

  let callName = null;     // e.g., _call3
  let tableName = null;    // e.g., _table3
  let tableValues = new Map();  // key -> string value

  function walkDeclarations(stmts) {
    if (!Array.isArray(stmts)) return;

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      if (!stmt || typeof stmt !== "object") continue;

      if (stmt.type === "LocalStatement" && stmt.variables && stmt.init) {
        for (let j = 0; j < Math.min(stmt.variables.length, stmt.init.length); j++) {
          const v = stmt.variables[j];
          const init = stmt.init[j];
          if (v && v.type === "Identifier" && /^_call\d+$/.test(v.name) &&
              init && init.type === "CallExpression" &&
              init.base && init.base.type === "Identifier" && init.base.name === "setmetatable" &&
              init.arguments && init.arguments.length >= 2) {
            callName = v.name;
            const mt = init.arguments[1];
            if (mt && mt.type === "TableConstructorExpression" && mt.fields) {
              for (const field of mt.fields) {
                if (field && field.type === "TableKeyString" && field.key && field.key.name === "__index" &&
                    field.value && field.value.type === "Identifier") {
                  tableName = field.value.name;
                }
              }
            }
          }
        }
      }

      if (tableName && stmt.type === "AssignmentStatement" && stmt.variables && stmt.init) {
        for (let j = 0; j < Math.min(stmt.variables.length, stmt.init.length); j++) {
          const target = stmt.variables[j];
          const val = stmt.init[j];
          if (target && target.type === "IndexExpression" &&
              target.base && target.base.type === "Identifier" && target.base.name === tableName &&
              target.index && val && val.type === "StringLiteral") {
            let key = null;
            if (target.index.type === "NumericLiteral") key = target.index.value;
            else if (target.index.type === "StringLiteral") key = target.index.value;
            if (key !== null) tableValues.set(key, val.value);
          }
        }
      }
    }
  }

  walkDeclarations(ast.body);
  if (!callName) return { ast, changed };

  function resolveInNode(node, parent, key) {
    if (!node || typeof node !== "object") return false;
    let lc = false;

    if (node.type === "IndexExpression" && node.base && node.base.type === "Identifier" && node.base.name === callName) {
      let resolvedValue = null;
      const idx = node.index;

      if (idx && idx.type === "NumericLiteral" && tableValues.has(idx.value)) {
        resolvedValue = tableValues.get(idx.value);
      }

      else if (idx && idx.type === "StringLiteral" && tableValues.has(idx.value)) {
        resolvedValue = tableValues.get(idx.value);
      }

      else if (idx && idx.type === "Identifier") {

      }

      else if (idx && idx.type === "BooleanLiteral") {
        resolvedValue = String(idx.value);

        if (tableValues.has(idx.value)) resolvedValue = tableValues.get(idx.value);
        else if (tableValues.has(idx.value ? "true" : "false")) resolvedValue = tableValues.get(idx.value ? "true" : "false");
      }

      if (resolvedValue !== null && typeof resolvedValue === "string" && resolvedValue.length > 0) {
        if (parent && key !== undefined && key !== null) {
          parent[key] = {
            type: "StringLiteral",
            value: resolvedValue,
            raw: JSON.stringify(resolvedValue),
          };
          lc = true;
        }
      }
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === "scope") continue;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (typeof v[i] === "object" && v[i] !== null) {
            if (resolveInNode(v[i], v, i)) lc = true;
          }
        }
      } else if (v && typeof v === "object") {
        if (resolveInNode(v, node, k)) lc = true;
      }
    }
    return lc;
  }

  for (let iter = 0; iter < 6; iter++) {
    const result = resolveInNode(ast, null, null);
    if (result) changed = true;
    else break;
  }

  return { ast, changed };
}

module.exports = { resolveStringTable };