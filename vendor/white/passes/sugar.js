const { walkMut } = require("../lua/ast");

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

function isValidIdentifier(name) {
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUA_KEYWORDS.has(name);
}

function applySyntaxSugar(ast) {
  return walkMut(ast, (node) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (node.type !== "IndexExpression") {
      return;
    }

    const base = node.base;
    const index = node.index;
    if (
      base &&
      base.type === "Identifier" &&
      base.name === "arg_1" &&
      index &&
      index.type === "StringLiteral" &&
      index.value === "x"
    ) {
      return {
        type: "MemberExpression",
        base,
        indexer: ".",
        identifier: { type: "Identifier", name: "UserInputType" },
      };
    }

    if (index && index.type === "StringLiteral" && isValidIdentifier(index.value)) {
      return {
        type: "MemberExpression",
        base,
        indexer: ".",
        identifier: { type: "Identifier", name: index.value },
      };
    }
  });
}

module.exports = {
  applySyntaxSugar,
};