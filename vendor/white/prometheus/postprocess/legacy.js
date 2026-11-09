const { cloneNode, walk } = require("../../lua/ast");
const { emitChunk } = require("../../lua/emit");
const { looksObfuscated } = require("../../passes/obfuscation");
const { foldConstants, evaluateLiteral, evaluateNumeric, collectShadowedIdentifiers } = require("../../passes/constant-fold");
const { runPrometheusInlining } = require("../inliner");

const RNG_MOD_45 = 35184372088832;
const RNG_MOD_8 = 257;
const GALACTIC_PAD = "Å";
const METHOD_HELPERS = new Set(["Connect", "Create", "Destroy", "FindFirstChild", "GetService", "HttpGet", "WaitForChild", "ClearAllChildren", "Clone", "FindFirstAncestor", "GetAttribute", "SetAttribute", "GetChildren", "GetDescendants", "IsA", "Parent", "Name", "Position", "Size", "BackgroundColor3", "BackgroundTransparency", "BorderColor3", "BorderSizePixel", "TextColor3", "Text", "TextSize", "Font", "TextWrapped", "Visible", "ZIndex", "LayoutOrder", "AutomaticSize", "Active", "Selectable", "AnchorPoint", "Rotation", "Image", "ScaleType", "TileSize", "ImageColor3", "ImageTransparency", "CornerRadius", "Thickness", "Color", "Transparency", "Offset", "Scale"]);
const PAYLOAD_IDENTIFIERS = new Set(["Color3", "Enum", "Instance", "UDim", "UDim2", "game", "print", "getgenv", "getreg", "getrenv", "getthreadidentity", "setthreadidentity", "_G", "shared", "hookmetamethod", "hookfunction", "newcclosure", "checkcaller"]);
const HELPER_IDENTIFIERS = new Set(["debug", "math", "pcall", "setmetatable", "string", "table"]);
const PAYLOAD_SCORE_IDENTIFIERS = new Set([
  "Color3",
  "Enum",
  "Instance",
  "UDim",
  "UDim2",
  "Vector3",
  "CFrame",
  "game",
  "workspace",
  "task",
  "tick",
  "wait",
  "print",
  "loadstring",
  "getgenv",
  "shared",
]);
const PAYLOAD_SCORE_MEMBERS = new Set([
  "CreateButton",
  "CreateDivider",
  "CreateHomeTab",
  "CreateLabel",
  "CreateSlider",
  "CreateTab",
  "CreateToggle",
  "CreateWindow",
  "FieldOfView",
  "FindFirstChild",
  "GetAttribute",
  "GetMouseLocation",
  "GetPropertyChangedSignal",
  "GetService",
  "Heartbeat",
  "HipHeight",
  "HttpGet",
  "Humanoid",
  "HumanoidRootPart",
  "InputBegan",
  "InputEnded",
  "IsA",
  "JumpHeight",
  "JumpPower",
  "JumpRequest",
  "LocalPlayer",
  "MouseButton1Click",
  "MouseButton1Down",
  "Notification",
  "Players",
  "Play",
  "ReplicatedStorage",
  "RenderStepped",
  "RunService",
  "SendNotification",
  "SetAttribute",
  "Stepped",
  "TranslateBy",
  "TweenService",
  "UseJumpPower",
  "UserInputService",
  "VIPServer",
  "VIPServerOwner",
  "WaitForChild",
  "WalkSpeed",
]);
const ANTI_TAMPER_IDENTIFIER_SIGNALS = new Set(["newproxy"]);
const ANTI_TAMPER_HELPER_IDENTIFIERS = new Set(["error", "pcall", "tonumber", "tostring"]);
const ANTI_TAMPER_DEBUG_MEMBERS = new Set(["getinfo", "getupvalue", "sethook", "traceback"]);
const ANTI_TAMPER_HELPER_MEMBERS = new Set(["gmatch", "random"]);
const ANTI_TAMPER_STRING_MEMBERS = new Set(["dump"]);
const PAYLOAD_SIGNAL_TEXT_REGEX = /\b(?:Create(?:Button|Divider|HomeTab|Label|Slider|Tab|Toggle|Window)|Drop Kick Tool|HttpGet|JumpPower|NoDashCooldown|NoFatigue|Notification|Players|VIPServer|WaitForChild|WalkSpeed)\b/;
const COMMON_BIGRAMS = new Set([
  "an",
  "at",
  "de",
  "ed",
  "en",
  "er",
  "he",
  "in",
  "io",
  "is",
  "it",
  "ld",
  "le",
  "ll",
  "lo",
  "nd",
  "ng",
  "nt",
  "on",
  "or",
  "ou",
  "pl",
  "pr",
  "re",
  "rl",
  "ro",
  "rv",
  "sc",
  "se",
  "th",
  "to",
  "tt",
  "ui",
  "wo",
]);
const USER_INPUT_ENUM_MEMBERS = new Set([
  "Focus",
  "Gamepad1",
  "Gamepad2",
  "Gamepad3",
  "Gamepad4",
  "Gamepad5",
  "Gamepad6",
  "Keyboard",
  "MouseButton1",
  "MouseButton2",
  "MouseButton3",
  "MouseMovement",
  "Touch",
  "TextInput",
]);
const ROBLOX_CONSTRUCTOR_ROOTS = new Set([
  "CFrame",
  "ColorSequence",
  "ColorSequenceKeypoint",
  "Instance",
  "NumberSequence",
  "NumberSequenceKeypoint",
  "TweenInfo",
  "UDim",
  "UDim2",
  "Vector2",
  "Vector3",
]);
const FONT_ENUM_MEMBERS = new Set([
  "Arial",
  "ArialBold",
  "ArialItalic",
  "Code",
  "Gotham",
  "GothamBlack",
  "GothamBold",
  "GothamMedium",
  "SourceSans",
  "SourceSansBold",
  "SourceSansItalic",
]);
const EASING_STYLE_ENUM_MEMBERS = new Set([
  "Back",
  "Bounce",
  "Circular",
  "Cubic",
  "Elastic",
  "Exponential",
  "Linear",
  "Quad",
  "Quart",
  "Quint",
  "Sine",
]);
const ROBLOX_SERVICE_NAMES = new Set([
  "CollectionService",
  "CoreGui",
  "Debris",
  "HttpService",
  "InsertService",
  "Lighting",
  "MarketplaceService",
  "Players",
  "ReplicatedFirst",
  "ReplicatedStorage",
  "RunService",
  "SoundService",
  "StarterGui",
  "Teams",
  "TeleportService",
  "TextService",
  "TweenService",
  "UserInputService",
  "Workspace",
]);
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

const SHADOWABLE_GLOBALS = new Set([
  ...PAYLOAD_IDENTIFIERS,
  ...HELPER_IDENTIFIERS,
  "select",
  "unpack",
]);

const KNOWN_GLOBAL_LIKE_NAMES = new Set([
  ...SHADOWABLE_GLOBALS,
  ...PAYLOAD_SCORE_IDENTIFIERS,
  "workspace",
  "_ENV",
  "script",
  "plugin",
]);

function collectShadowedGlobals(ast) {
  const shadowed = new Set();

  walk(ast, (node) => {
    if (node.type === "LocalStatement") {
      for (const variable of node.variables) {
        if (variable && variable.type === "Identifier" && SHADOWABLE_GLOBALS.has(variable.name)) {
          shadowed.add(variable.name);
        }
      }
    }

    if (node.type === "FunctionDeclaration" && node.isLocal && node.identifier && node.identifier.type === "Identifier") {
      if (SHADOWABLE_GLOBALS.has(node.identifier.name)) {
        shadowed.add(node.identifier.name);
      }
    }

    if (node.type === "AssignmentStatement") {
      for (const variable of node.variables) {
        if (variable && variable.type === "Identifier" && SHADOWABLE_GLOBALS.has(variable.name)) {
          shadowed.add(variable.name);
        }
      }
    }
  });

  return shadowed;
}

function isIdentifier(node, name = null) {
  return node && node.type === "Identifier" && (name === null || node.name === name);
}

function isStringLiteral(node, value = null) {
  return node && node.type === "StringLiteral" && (value === null || node.value === value);
}

function isNumericLiteral(node, value = null) {
  return (
    node &&
    node.type === "NumericLiteral" &&
    (value === null || node.value === value)
  );
}

function isNilLiteral(node) {
  return node && node.type === "NilLiteral";
}

function isValidIdentifierName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !LUA_KEYWORDS.has(value);
}

function normalizeLiteralKey(value) {
  if (value === null) {
    return "nil";
  }
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  if (typeof value === "boolean") {
    return `b:${value}`;
  }
  return null;
}

function getLiteralKeyFromNode(node) {
  if (!node) {
    return null;
  }
  if (node.type === "StringLiteral") {
    return normalizeLiteralKey(node.value);
  }
  if (node.type === "NumericLiteral") {
    return normalizeLiteralKey(node.value);
  }
  if (node.type === "BooleanLiteral") {
    return normalizeLiteralKey(node.value);
  }
  if (node.type === "NilLiteral") {
    return normalizeLiteralKey(null);
  }
  return null;
}

function extractTableLiteralConstants(tableNode) {
  if (!tableNode || tableNode.type !== "TableConstructorExpression") {
    return null;
  }

  const constants = new Map();
  let arrayIndex = 1;

  for (const field of tableNode.fields) {
    if (field.type === "TableValue") {
      if (isLiteralLike(field.value)) {
        const key = normalizeLiteralKey(arrayIndex);
        if (key) {
          constants.set(key, clone(field.value));
        }
      }
      arrayIndex += 1;
      continue;
    }

    if (!field.key || !field.value || !isLiteralLike(field.value)) {
      continue;
    }

    if (field.type === "TableKeyString") {
      const key = normalizeLiteralKey(field.key.name);
      if (key) {
        constants.set(key, clone(field.value));
      }
      continue;
    }

    if (field.type === "TableKey") {
      const key = getLiteralKeyFromNode(field.key);
      if (key) {
        constants.set(key, clone(field.value));
      }
    }
  }

  return constants;
}

function cloneTableConstants(map) {
  const next = new Map();
  if (!map) {
    return next;
  }
  for (const [tableName, tableMap] of map.entries()) {
    const cloneMap = new Map();
    for (const [key, value] of tableMap.entries()) {
      cloneMap.set(key, clone(value));
    }
    next.set(tableName, cloneMap);
  }
  return next;
}

function clone(value) {
  return cloneNode(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unwrapParentheses(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function extractEncryptParams(ast) {
  let params = null;

  const inspectStatements = (statements) => {
    if (params) {
      return;
    }

    for (let index = 0; index < statements.length - 1; index += 1) {
      params =
        matchEncryptRngAssignments(statements[index], statements[index + 1]) ||
        matchEncryptRngAssignmentsLoose(statements[index], statements[index + 1]) ||
        params;
      if (params) {
        return;
      }
    }

    for (const statement of statements) {
      if (params) {
        return;
      }

      if (statement.type === "IfStatement") {
        statement.clauses.forEach((clause) => inspectStatements(clause.body || []));
        continue;
      }

      if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement") {
        inspectStatements(statement.body);
      }
    }
  };

  walk(ast, (node) => {
    if (!params && node.type === "FunctionDeclaration") {
      inspectStatements(node.body);
    }
  });

  return params;
}

function extractNumberValue(node) {
  const value = evaluateNumeric(node);
  if (value !== null && Number.isFinite(value)) {
    return value;
  }
  return isNumericLiteral(node) ? node.value : null;
}

function extractState45Constants(expression) {
  if (
    !expression ||
    expression.type !== "BinaryExpression" ||
    expression.operator !== "%" ||
    !isNumericLiteral(expression.right, RNG_MOD_45)
  ) {
    return null;
  }

  const base = unwrapParentheses(expression.left);
  if (!base || base.type !== "BinaryExpression" || base.operator !== "+") {
    return null;
  }

  const add45 = extractNumberValue(base.right);
  if (add45 === null) {
    return null;
  }

  const multiply = unwrapParentheses(base.left);
  if (!multiply || multiply.type !== "BinaryExpression" || multiply.operator !== "*") {
    return null;
  }

  const mul45 = extractNumberValue(multiply.right) ?? extractNumberValue(multiply.left);
  if (mul45 === null) {
    return null;
  }

  return {
    add45,
    mul45,
  };
}

function extractState8Multiplier(expression) {
  if (
    !expression ||
    expression.type !== "BinaryExpression" ||
    expression.operator !== "%" ||
    !isNumericLiteral(expression.right, RNG_MOD_8)
  ) {
    return null;
  }

  const multiply = unwrapParentheses(expression.left);
  if (!multiply || multiply.type !== "BinaryExpression" || multiply.operator !== "*") {
    return null;
  }

  return extractNumberValue(multiply.right) ?? extractNumberValue(multiply.left);
}

function matchEncryptRngAssignments(first, second) {
  if (
    !first ||
    first.type !== "AssignmentStatement" ||
    first.variables.length !== 1 ||
    first.init.length !== 1 ||
    !second
  ) {
    return null;
  }

  const [state45Target] = first.variables;
  const state45Expression = unwrapParentheses(first.init[0]);
  const state8Pattern = extractState8Pattern(second);

  if (!isIdentifier(state45Target) || !state8Pattern || !isIdentifier(state8Pattern.target)) {
    return null;
  }

  const state8Target = state8Pattern.target;
  const state8Expression = state8Pattern.expression;

  if (
    !state45Expression ||
    state45Expression.type !== "BinaryExpression" ||
    state45Expression.operator !== "%" ||
    !isNumericLiteral(state45Expression.right, RNG_MOD_45)
  ) {
    return null;
  }

  const state45Base = unwrapParentheses(state45Expression.left);
  if (!state45Base || state45Base.type !== "BinaryExpression" || state45Base.operator !== "+") {
    return null;
  }

  const state45Mul = unwrapParentheses(state45Base.left);
  if (
    !state45Mul ||
    state45Mul.type !== "BinaryExpression" ||
    state45Mul.operator !== "*" ||
    !isIdentifier(state45Mul.left, state45Target.name) ||
    !isNumericLiteral(state45Mul.right)
  ) {
    return null;
  }

  if (
    !state8Expression ||
    state8Expression.type !== "BinaryExpression" ||
    state8Expression.operator !== "%" ||
    !isNumericLiteral(state8Expression.right, RNG_MOD_8)
  ) {
    return null;
  }

  const state8Mul = unwrapParentheses(state8Expression.left);
  if (
    !state8Mul ||
    state8Mul.type !== "BinaryExpression" ||
    state8Mul.operator !== "*" ||
    !isIdentifier(state8Mul.left, state8Target.name) ||
    !isNumericLiteral(state8Mul.right)
  ) {
    return null;
  }

  return {
    add45: state45Base.right.value,
    mul45: state45Mul.right.value,
    mul8: state8Mul.right.value,
  };
}

function matchEncryptRngAssignmentsLoose(first, second) {
  if (
    !first ||
    first.type !== "AssignmentStatement" ||
    first.variables.length !== 1 ||
    first.init.length !== 1 ||
    !second
  ) {
    return null;
  }

  const state45 = extractState45Constants(unwrapParentheses(first.init[0]));
  if (!state45) {
    return null;
  }

  const state8Pattern = extractState8Pattern(second);
  if (!state8Pattern) {
    return null;
  }

  const mul8 = extractState8Multiplier(state8Pattern.expression);
  if (mul8 === null) {
    return null;
  }

  return {
    add45: state45.add45,
    mul45: state45.mul45,
    mul8,
  };
}

function extractState8Pattern(statement) {
  if (
    statement &&
    statement.type === "AssignmentStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1
  ) {
    return {
      target: statement.variables[0],
      expression: unwrapParentheses(statement.init[0]),
    };
  }

  if (
    !statement ||
    statement.type !== "RepeatStatement" ||
    statement.body.length !== 1 ||
    statement.body[0].type !== "AssignmentStatement" ||
    statement.body[0].variables.length !== 1 ||
    statement.body[0].init.length !== 1 ||
    !statement.condition ||
    statement.condition.type !== "BinaryExpression" ||
    statement.condition.operator !== "~=" ||
    !isNumericLiteral(statement.condition.right, 1)
  ) {
    return null;
  }

  const [target] = statement.body[0].variables;
  if (!isIdentifier(target) || !isIdentifier(statement.condition.left, target.name)) {
    return null;
  }

  return {
    target,
    expression: unwrapParentheses(statement.body[0].init[0]),
  };
}

function isProbablyEncryptedString(node) {
  return (
    isStringLiteral(node) &&
    typeof node.value === "string" &&
    node.value.length > 0
  );
}

function collectEncryptedCalls(ast) {
  const calls = [];

  walk(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.arguments.length === 2 &&
      isProbablyEncryptedString(node.arguments[0]) &&
      isNumericLiteral(node.arguments[1]) &&
      node.arguments[1].value > 255
    ) {
      calls.push(node);
    }
  });

  return calls;
}

function decodePrometheusString(value, seed, params, secretKey8) {
  let state45 = seed % RNG_MOD_45;
  let state8 = (seed % 255) + 2;
  let prevValues = [];
  let prev = secretKey8;
  let output = "";

  const nextRandomByte = () => {
    if (prevValues.length === 0) {
      state45 = ((state45 * params.mul45) + params.add45) % RNG_MOD_45;
      do {
        state8 = (state8 * params.mul8) % RNG_MOD_8;
      } while (state8 === 1);

      const r = state8 % 32;
      const n = (Math.floor(state45 / (2 ** (13 - ((state8 - r) / 32)))) % (2 ** 32)) / (2 ** r);
      const rnd = Math.floor((n % 1) * (2 ** 32)) + Math.floor(n);
      const low16 = rnd % 65536;
      const high16 = (rnd - low16) / 65536;
      const b1 = low16 % 256;
      const b2 = (low16 - b1) / 256;
      const b3 = high16 % 256;
      const b4 = (high16 - b3) / 256;
      prevValues = [b1, b2, b3, b4];
    }

    return prevValues.pop();
  };

  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index) & 0xff;
    prev = (byte + nextRandomByte() + prev) % 256;
    output += String.fromCharCode(prev);
  }

  return output;
}

function extractGalacticAlphabet(ast) {
  let best = null;
  let bestUnique = 0;
  let bestNonAscii = 0;

  walk(ast, (node) => {
    if (node.type !== "StringLiteral" || typeof node.value !== "string") {
      return;
    }

    const value = node.value;
    if (value.length < 64 || value.length > 80) {
      return;
    }

    const unique = new Set(value).size;
    if (unique < 50) {
      return;
    }

    let nonAscii = 0;
    for (const ch of value) {
      if (ch.charCodeAt(0) > 0x7f) {
        nonAscii += 1;
      }
    }

    if (unique > bestUnique || (unique === bestUnique && nonAscii > bestNonAscii)) {
      best = value;
      bestUnique = unique;
      bestNonAscii = nonAscii;
    }
  });

  return best;
}

function extractGalacticStripSequence(ast) {
  let strip = null;

  walk(ast, (node) => {
    if (
      strip ||
      node.type !== "CallExpression" ||
      node.arguments.length !== 2
    ) {
      return;
    }

    if (
      node.base.type === "MemberExpression" &&
      (node.base.indexer === "." || node.base.indexer === ":") &&
      node.base.identifier.name === "gsub" &&
      isStringLiteral(node.arguments[0]) &&
      isStringLiteral(node.arguments[1], "")
    ) {
      strip = node.arguments[0].value;
    }
  });

  return strip;
}

function collectGalacticIndexCalls(ast) {
  const calls = [];

  walk(ast, (node) => {
    if (
      node.type !== "IndexExpression" ||
      node.base.type !== "Identifier" ||
      node.index.type !== "CallExpression" ||
      node.index.base.type !== "Identifier" ||
      node.index.arguments.length !== 2
    ) {
      return;
    }

    const [encoded, seed] = node.index.arguments;
    if (!isStringLiteral(encoded) || !isNumericLiteral(seed)) {
      return;
    }

    calls.push({
      tableName: node.base.name,
      decoderName: node.index.base.name,
      encoded: encoded.value,
      seed: seed.value,
    });
  });

  return calls;
}

function decodeGalacticBase64(value, alphabet, stripSequence) {
  let input = value;
  if (stripSequence) {
    input = input.split(stripSequence).join("");
  }

  const map = new Map();
  for (let index = 0; index < alphabet.length; index += 1) {
    map.set(alphabet[index], index);
  }

  const bytes = [];
  for (let index = 0; index < input.length; index += 4) {
    const r = input[index];
    const g = input[index + 1];
    const e = input[index + 2];
    const z = input[index + 3];
    if (!r || !g) {
      break;
    }

    const x = map.has(r) ? map.get(r) : 0;
    const a = map.has(g) ? map.get(g) : 0;
    const U = e && e !== GALACTIC_PAD ? (map.has(e) ? map.get(e) : 0) : null;
    const c = z && z !== GALACTIC_PAD ? (map.has(z) ? map.get(z) : 0) : null;
    const packed = ((x << 18) | (a << 12) | ((U || 0) << 6) | (c || 0)) >>> 0;
    const b1 = (packed >> 16) & 0xff;
    const b2 = (packed >> 8) & 0xff;
    const b3 = packed & 0xff;
    bytes.push(b1);
    if (e !== GALACTIC_PAD) {
      bytes.push(b2);
    }
    if (z !== GALACTIC_PAD) {
      bytes.push(b3);
    }
  }

  return bytes;
}

function decodeGalacticString(value, seed, alphabet, stripSequence) {
  const bytes = decodeGalacticBase64(value, alphabet, stripSequence);
  let state45 = seed % RNG_MOD_45;
  let state8 = (seed % 255) + 2;
  let cached = [];
  let rolling = 227;
  let output = "";

  const nextRandomByte = () => {
    if (cached.length === 0) {
      state45 = ((state45 * 181) + 19980906807297) % RNG_MOD_45;
      do {
        state8 = (state8 * 19) % RNG_MOD_8;
      } while (state8 === 1);

      const r = state8 % 32;
      const n = (Math.floor(state45 / (2 ** (13 - ((state8 - r) / 32)))) % (2 ** 32)) / (2 ** r);
      const rnd = Math.floor((n % 1) * (2 ** 32)) + Math.floor(n);
      const low16 = rnd % 65536;
      const high16 = (rnd - low16) / 65536;
      const b1 = low16 % 256;
      const b2 = (low16 - b1) / 256;
      const b3 = high16 % 256;
      const b4 = (high16 - b3) / 256;
      cached = [b1, b2, b3, b4];
    }

    return cached.pop();
  };

  for (const byte of bytes) {
    const rnd = nextRandomByte();
    const x = (byte ^ rnd) & 0xff;
    rolling = (x + rnd + rolling) % 256;
    output += String.fromCharCode(rolling);
  }

  return output;
}

function extractGalacticDecoder(ast) {
  const calls = collectGalacticIndexCalls(ast);
  if (calls.length < 6) {
    return null;
  }

  const alphabet = extractGalacticAlphabet(ast);
  if (!alphabet) {
    return null;
  }

  const stripSequence = extractGalacticStripSequence(ast);
  const [first] = calls;

  return {
    alphabet,
    cache: new Map(),
    decoderName: first.decoderName,
    stripSequence,
    tableName: first.tableName,
  };
}

function scoreDecodedString(value) {
  let score = 0;

  if (/^[\x20-\x7e]+$/.test(value)) {
    score += value.length;
    score += (value.match(/[ ,.!?:;/-]/g) || []).length * 3;
    score += (value.match(/[A-Za-z]{2,}/g) || []).reduce((total, word) => {
      const vowelCount = (word.match(/[AEIOUaeiou]/g) || []).length;
      if (vowelCount === 0) {
        return total - 8;
      }
      let nextScore = total + Math.min(word.length, 6);
      const lowerWord = word.toLowerCase();
      for (let index = 0; index < lowerWord.length - 1; index += 1) {
        const bigram = lowerWord.slice(index, index + 2);
        if (COMMON_BIGRAMS.has(bigram)) {
          nextScore += 2;
        }
      }
      if (/q(?!u)/.test(lowerWord)) {
        nextScore -= 8;
      }
      if (/^[bcdfghjklmnpqrstvwxyz]{5,}$/i.test(word)) {
        nextScore -= 8;
      }
      return nextScore;
    }, 0);
    if (/\s/.test(value)) {
      score += 4;
    }
    if (/[.!?]$/.test(value)) {
      score += 4;
    }
    if (/[A-Za-z]/.test(value) && /[0-9_]/.test(value) && !/\s/.test(value)) {
      score -= 6;
    }
  } else {
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (code >= 32 && code <= 126) {
        score += 1;
      } else {
        score -= 4;
      }
    }
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    score += 12;
  }

  if (/^[A-Za-z0-9_ :.()-]+$/.test(value)) {
    score += 4;
  }

  if (/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/i.test(value)) {
    score += 24;
  } else if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/:?#]|$)/.test(value)) {
    score += 12;
  }

  if (METHOD_HELPERS.has(value)) {
    score += 12;
  }

  if (ROBLOX_SERVICE_NAMES.has(value)) {
    score += 16;
  }

  if (PAYLOAD_IDENTIFIERS.has(value)) {
    score += 8;
  }

  if (PAYLOAD_SCORE_MEMBERS.has(value)) {
    score += 14;
  }

  if (/^(Size|Position|Parent|Name|Visible|Active|Text|Image|Color|Background|AnchorPoint|Rotation|ZIndex|Transparency|Thickness|CornerRadius|Font|TextSize|TextWrapped|BorderColor|BorderSize|LayoutOrder|AutomaticSize|Selectable|ImageColor3|ImageTransparency|ScaleType|TileSize|ScrollBarThickness|ScrollBarImageTransparency|CanvasSize|CanvasPosition|AbsoluteSize|AbsolutePosition)$/.test(value)) {
    score += 18;
  }

  if (/^(MouseButton1Click|MouseButton1Down|MouseButton2Click|MouseEnter|MouseLeave|InputBegan|InputEnded|Changed|GetPropertyChangedSignal|AncestryChanged|ChildAdded|ChildRemoved|DescendantAdded|DescendantRemoving|Touched|TouchTap|TouchLongPress|Swipe|Pan|Pinch|Rotate|TouchPan|TouchRotate|TouchSwipe)$/.test(value)) {
    score += 16;
  }

  if (/^(Enum\.Font|Enum\.EasingStyle|Enum\.EasingDirection|Enum\.ScaleType|Enum\.TextXAlignment|Enum\.TextYAlignment|Enum\.UserInputType|Enum\.KeyCode|Enum\.FillDirection|Enum\.HorizontalAlignment|Enum\.VerticalAlignment|Enum\.ScrollingDirection|Enum\.ScrollBarVisibility)$/.test(value)) {
    score += 20;
  }

  if (/^(Connect|Create|Destroy|FindFirstChild|GetService|HttpGet|WaitForChild|ClearAllChildren|Clone|FindFirstAncestor|GetAttribute|SetAttribute|GetChildren|GetDescendants|IsA|SetAttribute|GetAttribute)$/.test(value)) {
    score += 14;
  }

  return score;
}

function inferSecretKey8(params, calls) {
  if (!params || calls.length === 0) {
    return null;
  }

  const samples = calls.slice(0, 32);
  let best = null;
  let secondBest = null;

  for (let candidate = 0; candidate < 256; candidate += 1) {
    let score = 0;
    let printableCount = 0;
    let totalLength = 0;
    let decodedStrings = [];

    for (const call of samples) {
      const encoded = call.arguments && call.arguments[0] && call.arguments[0].value;
      const seed = call.arguments && call.arguments[1] && call.arguments[1].value;
      if (typeof encoded !== "string" || typeof seed !== "number") continue;

      const decoded = decodePrometheusString(encoded, seed, params, candidate);
      decodedStrings.push(decoded);
      totalLength += decoded.length;

      const printable = (decoded.match(/[\x20-\x7e]/g) || []).length;
      printableCount += printable;

      score += scoreDecodedString(decoded);

      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(decoded)) {
        score += 20;
      }
      if (METHOD_HELPERS.has(decoded)) {
        score += 30;
      }
      if (ROBLOX_SERVICE_NAMES.has(decoded)) {
        score += 40;
      }
      if (PAYLOAD_IDENTIFIERS.has(decoded)) {
        score += 25;
      }
      if (/^(Size|Position|Parent|Name|Visible|Active|Text|Image|Color|Background|AnchorPoint|Rotation|ZIndex|Transparency|Thickness|CornerRadius|Font|TextSize|TextWrapped|BorderColor|BorderSize|LayoutOrder|AutomaticSize)$/.test(decoded)) {
        score += 35;
      }
      if (/^(MouseButton1Click|MouseButton1Down|MouseButton2Click|MouseEnter|MouseLeave|InputBegan|InputEnded|Changed|GetPropertyChangedSignal)$/.test(decoded)) {
        score += 30;
      }
    }

    if (totalLength > 0) {
      const printableRatio = printableCount / totalLength;
      if (printableRatio > 0.85) {
        score += 50;
      } else if (printableRatio > 0.7) {
        score += 20;
      } else if (printableRatio < 0.3) {
        score -= 100;
      }
    }

    if (!best || score > best.score) {
      secondBest = best;
      best = { score, value: candidate, strings: decodedStrings };
    } else if (!secondBest || score > secondBest.score) {
      secondBest = { score, value: candidate };
    }
  }

  const minimumScore = Math.max(12, Math.min(80, calls.length * 4));

  if (best && best.score >= minimumScore) {
    if (secondBest && (best.score - secondBest.score) < 10) {
      return null;
    }
    return best.value;
  }

  return null;
}

function extractSecretKey8(ast) {
  let secretKey8 = null;

  const inspectStatements = (statements) => {
    if (secretKey8 !== null) {
      return;
    }

    for (let index = 0; index < statements.length - 1; index += 1) {
      const statement = statements[index];
      const nextStatement = statements[index + 1];

      if (
        statement.type !== "LocalStatement" ||
        statement.variables.length !== 1 ||
        statement.init.length !== 1 ||
        !isIdentifier(statement.variables[0]) ||
        !isNumericLiteral(statement.init[0]) ||
        !nextStatement ||
        nextStatement.type !== "ForNumericStatement" ||
        nextStatement.body.length < 2
      ) {
        continue;
      }

      const stateName = statement.variables[0].name;
      const [updateStatement, appendStatement] = nextStatement.body;
      if (
        !updateStatement ||
        updateStatement.type !== "AssignmentStatement" ||
        updateStatement.variables.length !== 1 ||
        updateStatement.init.length !== 1 ||
        !isIdentifier(updateStatement.variables[0], stateName) ||
        !appendStatement ||
        appendStatement.type !== "AssignmentStatement" ||
        appendStatement.variables.length !== 1 ||
        appendStatement.init.length !== 1
      ) {
        continue;
      }

      const updateExpression = unwrapParentheses(updateStatement.init[0]);
      if (
        !updateExpression ||
        updateExpression.type !== "BinaryExpression" ||
        updateExpression.operator !== "%" ||
        !isNumericLiteral(updateExpression.right, 256)
      ) {
        continue;
      }

      const appendExpression = unwrapParentheses(appendStatement.init[0]);
      if (
        !appendExpression ||
        appendExpression.type !== "BinaryExpression" ||
        appendExpression.operator !== ".." ||
        appendExpression.right.type !== "IndexExpression" ||
        appendExpression.right.index.type !== "BinaryExpression" ||
        appendExpression.right.index.operator !== "+" ||
        !isIdentifier(appendExpression.right.index.left, stateName) ||
        !isNumericLiteral(appendExpression.right.index.right, 1)
      ) {
        continue;
      }

      secretKey8 = statement.init[0].value;
      return;
    }

    for (const statement of statements) {
      if (secretKey8 !== null) {
        return;
      }

      if (statement.type === "IfStatement") {
        statement.clauses.forEach((clause) => inspectStatements(clause.body || []));
        continue;
      }

      if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement") {
        inspectStatements(statement.body);
      }
    }
  };

  walk(ast, (node) => {
    if (
      secretKey8 !== null ||
      node.type !== "FunctionDeclaration" ||
      node.body.length < 3
    ) {
      return;
    }

    inspectStatements(node.body);
  });

  return secretKey8;
}

function isStringProxyInitializer(node) {
  const expression = unwrapParentheses(node);
  if (
    !expression ||
    expression.type !== "CallExpression" ||
    !isIdentifier(expression.base, "setmetatable") ||
    expression.arguments.length !== 2
  ) {
    return false;
  }

  const [tableArgument, metaArgument] = expression.arguments;
  if (
    !tableArgument ||
    tableArgument.type !== "TableConstructorExpression" ||
    tableArgument.fields.length !== 0 ||
    !metaArgument ||
    metaArgument.type !== "TableConstructorExpression"
  ) {
    return false;
  }

  let hasIndex = false;
  let hasMetaHidden = false;
  for (const field of metaArgument.fields) {
    const keyName =
      field.type === "TableKeyString"
        ? field.key.name
        : field.type === "TableKey"
          ? extractStaticStringValue(field.key)
          : null;

    if (keyName === "__index" && isIdentifier(field.value)) {
      hasIndex = true;
    }
    if (
      keyName === "__metatable" &&
      (isNilLiteral(field.value) || (field.value.type === "BooleanLiteral" && field.value.value === false))
    ) {
      hasMetaHidden = true;
    }
  }

  return hasIndex && hasMetaHidden;
}

function isAliasableExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }

  return (
    expression.type === "Identifier" ||
    expression.type === "MemberExpression" ||
    (
      expression.type === "IndexExpression" &&
      expression.base &&
      expression.base.type === "Identifier" &&
      expression.index &&
      expression.index.type === "StringLiteral"
    )
  );
}

function isHalfLengthExpression(node, parameterName) {
  const expression = unwrapParentheses(node);
  if (
    !expression ||
    expression.type !== "BinaryExpression" ||
    expression.operator !== "/" ||
    !isNumericLiteral(expression.right, 2)
  ) {
    return false;
  }

  const left = unwrapParentheses(expression.left);
  return (
    left &&
    left.type === "UnaryExpression" &&
    left.operator === "#" &&
    isIdentifier(left.argument, parameterName)
  );
}

function isLiteralStringBuilder(node) {
  const expression = unwrapParentheses(node);
  if (
    !expression ||
    expression.type !== "FunctionDeclaration" ||
    expression.parameters.length !== 1 ||
    !isIdentifier(expression.parameters[0]) ||
    expression.body.length !== 3
  ) {
    return false;
  }

  const [setupStatement, loopStatement, returnStatement] = expression.body;
  if (
    !setupStatement ||
    setupStatement.type !== "LocalStatement" ||
    setupStatement.variables.length !== 2 ||
    setupStatement.init.length !== 2 ||
    !loopStatement ||
    loopStatement.type !== "ForNumericStatement" ||
    !isIdentifier(loopStatement.variable) ||
    !returnStatement ||
    returnStatement.type !== "ReturnStatement" ||
    returnStatement.arguments.length !== 1 ||
    !isIdentifier(returnStatement.arguments[0])
  ) {
    return false;
  }

  const parameter = expression.parameters[0].name;
  const emptyIndex = setupStatement.init.findIndex((initializer) => isStringLiteral(initializer, ""));
  if (emptyIndex < 0) {
    return false;
  }

  const builderVariable = setupStatement.variables[emptyIndex];
  const tableIndex = emptyIndex === 0 ? 1 : 0;
  const tableVariable = setupStatement.variables[tableIndex];
  const tableInitializer = unwrapParentheses(setupStatement.init[tableIndex]);
  if (
    !isIdentifier(builderVariable) ||
    !isIdentifier(tableVariable) ||
    !tableInitializer ||
    tableInitializer.type !== "IndexExpression" ||
    !isIdentifier(tableInitializer.base, parameter) ||
    !tableInitializer.index ||
    tableInitializer.index.type !== "UnaryExpression" ||
    tableInitializer.index.operator !== "#" ||
    !isIdentifier(tableInitializer.index.argument, parameter)
  ) {
    return false;
  }

  if (
    loopStatement.body.length !== 1 ||
    !isNumericLiteral(loopStatement.start, 1) ||
    !(
      isIdentifier(loopStatement.end, tableVariable.name) ||
      (
        loopStatement.end.type === "UnaryExpression" &&
        loopStatement.end.operator === "#" &&
        isIdentifier(loopStatement.end.argument, tableVariable.name)
      )
    ) ||
    !isNumericLiteral(loopStatement.step, 1)
  ) {
    return false;
  }

  const [assignment] = loopStatement.body;
  const loopIndexName = loopStatement.variable.name;
  if (
    !assignment ||
    assignment.type !== "AssignmentStatement" ||
    assignment.variables.length !== 1 ||
    assignment.init.length !== 1 ||
    !isIdentifier(assignment.variables[0], builderVariable.name) ||
    assignment.init[0].type !== "BinaryExpression" ||
    assignment.init[0].operator !== ".." ||
    !isIdentifier(assignment.init[0].left, builderVariable.name) ||
    assignment.init[0].right.type !== "IndexExpression" ||
    !isIdentifier(assignment.init[0].right.base, tableVariable.name) ||
    assignment.init[0].right.index.type !== "IndexExpression" ||
    !isIdentifier(assignment.init[0].right.index.base, parameter) ||
    !isIdentifier(assignment.init[0].right.index.index, loopIndexName) ||
    !isIdentifier(returnStatement.arguments[0], builderVariable.name)
  ) {
    return false;
  }

  return true;
}

function isReorderStringBuilder(node) {
  const expression = unwrapParentheses(node);
  if (
    !expression ||
    expression.type !== "FunctionDeclaration" ||
    expression.parameters.length !== 1 ||
    !isIdentifier(expression.parameters[0]) ||
    expression.body.length !== 3
  ) {
    return false;
  }

  const [setupStatement, loopStatement, returnStatement] = expression.body;
  if (
    !setupStatement ||
    setupStatement.type !== "LocalStatement" ||
    setupStatement.variables.length !== 1 ||
    setupStatement.init.length !== 1 ||
    !isIdentifier(setupStatement.variables[0]) ||
    !isStringLiteral(setupStatement.init[0], "") ||
    !loopStatement ||
    loopStatement.type !== "ForNumericStatement" ||
    !isIdentifier(loopStatement.variable) ||
    !returnStatement ||
    returnStatement.type !== "ReturnStatement" ||
    returnStatement.arguments.length !== 1 ||
    !isIdentifier(returnStatement.arguments[0], setupStatement.variables[0].name)
  ) {
    return false;
  }

  const parameterName = expression.parameters[0].name;
  if (
    !isNumericLiteral(loopStatement.start, 1) ||
    !isNumericLiteral(loopStatement.step, 1) ||
    !isHalfLengthExpression(loopStatement.end, parameterName) ||
    loopStatement.body.length !== 1
  ) {
    return false;
  }

  const [assignment] = loopStatement.body;
  const builderName = setupStatement.variables[0].name;
  const loopIndexName = loopStatement.variable.name;
  if (
    !assignment ||
    assignment.type !== "AssignmentStatement" ||
    assignment.variables.length !== 1 ||
    assignment.init.length !== 1 ||
    !isIdentifier(assignment.variables[0], builderName)
  ) {
    return false;
  }

  const concatExpression = assignment.init[0];
  if (
    !concatExpression ||
    concatExpression.type !== "BinaryExpression" ||
    concatExpression.operator !== ".." ||
    !isIdentifier(concatExpression.left, builderName)
  ) {
    return false;
  }

  const rightIndex = unwrapParentheses(concatExpression.right);
  if (
    !rightIndex ||
    rightIndex.type !== "IndexExpression" ||
    !isIdentifier(rightIndex.base, parameterName)
  ) {
    return false;
  }

  const sumExpression = unwrapParentheses(rightIndex.index);
  if (
    !sumExpression ||
    sumExpression.type !== "BinaryExpression" ||
    sumExpression.operator !== "+" ||
    !isHalfLengthExpression(sumExpression.left, parameterName)
  ) {
    return false;
  }

  const innerIndex = unwrapParentheses(sumExpression.right);
  if (
    !innerIndex ||
    innerIndex.type !== "IndexExpression" ||
    !isIdentifier(innerIndex.base, parameterName) ||
    !isIdentifier(innerIndex.index, loopIndexName)
  ) {
    return false;
  }

  return true;
}

function extractInitializerHintNames(ast, predicate) {
  const names = new Set();

  walk(ast, (node) => {
    if (node.type !== "LocalStatement" && node.type !== "AssignmentStatement") {
      return;
    }

    const pairCount = Math.min(node.variables.length, node.init.length);
    for (let index = 0; index < pairCount; index += 1) {
      const variable = node.variables[index];
      const initializer = node.init[index];
      if (!isIdentifier(variable) || !predicate(initializer)) {
        continue;
      }
      names.add(variable.name);
    }
  });

  return [...names];
}

function extractLiteralStringBuilderNames(ast) {
  return extractInitializerHintNames(ast, isLiteralStringBuilder);
}

function extractReorderStringBuilderNames(ast) {
  return extractInitializerHintNames(ast, isReorderStringBuilder);
}

function extractStringProxyNames(ast) {
  return extractInitializerHintNames(ast, isStringProxyInitializer);
}

function isTableConcatExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }

  if (
    expression.type === "MemberExpression" &&
    expression.indexer === "." &&
    isIdentifier(expression.base, "table") &&
    expression.identifier &&
    expression.identifier.name === "concat"
  ) {
    return true;
  }

  if (
    expression.type === "IndexExpression" &&
    isIdentifier(expression.base, "table") &&
    expression.index &&
    expression.index.type === "StringLiteral" &&
    expression.index.value === "concat"
  ) {
    return true;
  }

  return false;
}

function extractTableConcatAliases(ast) {
  const aliases = new Set();

  walk(ast, (node) => {
    if (node.type !== "LocalStatement" && node.type !== "AssignmentStatement") {
      return;
    }

    const pairCount = Math.min(node.variables.length, node.init.length);
    for (let index = 0; index < pairCount; index += 1) {
      const variable = node.variables[index];
      const initializer = node.init[index];
      if (!isIdentifier(variable) || !initializer) {
        continue;
      }

      if (isTableConcatExpression(initializer)) {
        aliases.add(variable.name);
        continue;
      }

      const resolved = unwrapParentheses(initializer);
      if (resolved && resolved.type === "Identifier" && aliases.has(resolved.name)) {
        aliases.add(variable.name);
      }
    }
  });

  return aliases;
}

function evaluateLiteralStringBuilderArgument(argument) {
  const expression = unwrapParentheses(argument);
  if (!expression || expression.type !== "TableConstructorExpression" || expression.fields.length < 2) {
    return null;
  }

  const lastField = expression.fields[expression.fields.length - 1];
  if (
    lastField.type !== "TableValue" ||
    lastField.value.type !== "TableConstructorExpression" ||
    !lastField.value.fields.every((field) => field.type === "TableValue" && isStringLiteral(field.value))
  ) {
    return null;
  }

  const parts = lastField.value.fields.map((field) => field.value.value);
  let output = "";

  for (let index = 0; index < expression.fields.length - 1; index += 1) {
    const field = expression.fields[index];
    if (field.type !== "TableValue" || !isNumericLiteral(field.value) || !Number.isInteger(field.value.value)) {
      return null;
    }

    const partIndex = field.value.value - 1;
    if (partIndex < 0 || partIndex >= parts.length) {
      return null;
    }

    output += parts[partIndex];
  }

  return output;
}

function evaluateReorderStringBuilderArgument(argument) {
  const expression = unwrapParentheses(argument);
  if (!expression || expression.type !== "TableConstructorExpression") {
    return null;
  }

  const { fields } = expression;
  if (fields.length < 2 || fields.length % 2 !== 0) {
    return null;
  }

  const half = fields.length / 2;
  const indices = [];
  const parts = [];

  for (let index = 0; index < half; index += 1) {
    const field = fields[index];
    if (
      field.type !== "TableValue" ||
      !isNumericLiteral(field.value) ||
      !Number.isInteger(field.value.value)
    ) {
      return null;
    }
    indices.push(field.value.value);
  }

  for (let index = half; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.type !== "TableValue" || !isStringLiteral(field.value)) {
      return null;
    }
    parts.push(field.value.value);
  }

  let output = "";
  for (const position of indices) {
    const partIndex = position - 1;
    if (partIndex < 0 || partIndex >= parts.length) {
      return null;
    }
    output += parts[partIndex];
  }

  return output;
}

function extractStaticStringValue(node) {
  if (isStringLiteral(node)) {
    return node.value;
  }

  const expression = unwrapParentheses(node);
  if (
    expression &&
    expression.type === "TableCallExpression"
  ) {
    return (
      evaluateReorderStringBuilderArgument(expression.arguments) ??
      evaluateLiteralStringBuilderArgument(expression.arguments)
    );
  }

  if (
    expression &&
    expression.type === "CallExpression" &&
    expression.arguments.length === 1
  ) {
    return (
      evaluateReorderStringBuilderArgument(expression.arguments[0]) ??
      evaluateLiteralStringBuilderArgument(expression.arguments[0])
    );
  }

  return null;
}

function evaluateLiteralStringBuilderCall(base, argument, state) {
  if (!isIdentifier(base) || !state.literalStringBuilders.has(base.name)) {
    return null;
  }

  const value = evaluateLiteralStringBuilderArgument(argument);
  if (value === null) {
    return null;
  }

  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
    __decrypted: true,
  };
}

function evaluateReorderStringBuilderCall(base, argument, state) {
  if (!isIdentifier(base) || !state.reorderStringBuilders.has(base.name)) {
    return null;
  }

  const value = evaluateReorderStringBuilderArgument(argument);
  if (value === null) {
    return null;
  }

  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
    __decrypted: true,
  };
}

function inferEnumClassFromMember(memberName) {
  if (USER_INPUT_ENUM_MEMBERS.has(memberName)) {
    return "UserInputType";
  }

  if (FONT_ENUM_MEMBERS.has(memberName)) {
    return "Font";
  }

  if (EASING_STYLE_ENUM_MEMBERS.has(memberName)) {
    return "EasingStyle";
  }

  return null;
}

function isLikelyRgbCall(args) {
  return (
    args.length === 3 &&
    args.every((argument) =>
      isNumericLiteral(argument) &&
      Number.isFinite(argument.value) &&
      argument.value >= 0 &&
      argument.value <= 255 &&
      Number.isInteger(argument.value))
  );
}

function isSelfMethodCall(base, firstArgument) {
  return (
    deepEqual(firstArgument, base) ||
    (
      isIdentifier(firstArgument) &&
      isIdentifier(base) &&
      firstArgument.name === base.name
    )
  );
}

function rewriteExpression(node, state, options = {}) {
  if (!node || typeof node !== "object") {
    return node;
  }

  const allowTableConstants = options.allowTableConstants !== false;

  switch (node.type) {
    case "Identifier":
      if (state.aliases.has(node.name)) {
        return clone(state.aliases.get(node.name));
      }
      return node;
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return node;
    case "UnaryExpression":
      return {
        ...node,
        argument: rewriteExpression(node.argument, state, options),
      };
    case "BinaryExpression":
    case "LogicalExpression":
      return {
        ...node,
        left: rewriteExpression(node.left, state, options),
        right: rewriteExpression(node.right, state, options),
      };
    case "ParenthesisExpression":
      return {
        ...node,
        expression: rewriteExpression(node.expression, state, options),
      };
    case "TableConstructorExpression":
      return {
        ...node,
        fields: node.fields.map((field) => {
          if (field.type === "TableValue") {
            return {
              ...field,
              value: rewriteExpression(field.value, state, options),
            };
          }
          return {
            ...field,
            key: rewriteExpression(field.key, state, options),
            value: rewriteExpression(field.value, state, options),
          };
        }),
      };
    case "MemberExpression":
      {
        const base = rewriteExpression(node.base, state, options);
        const enumClass = inferEnumClassFromMember(node.identifier.name);
        if (
          enumClass &&
          base.type === "IndexExpression" &&
          isIdentifier(base.base, "Enum")
        ) {
          return {
            ...node,
            base: toPropertyNode({ type: "Identifier", name: "Enum" }, enumClass),
          };
        }

        if (allowTableConstants && base.type === "Identifier" && state.tableConstants && state.tableConstants.has(base.name)) {
          const key = normalizeLiteralKey(node.identifier.name);
          if (key) {
            const tableMap = state.tableConstants.get(base.name);
            if (tableMap && tableMap.has(key)) {
              return clone(tableMap.get(key));
            }
          }
        }

        return {
          ...node,
          base,
        };
      }
    case "IndexExpression": {
      const base = rewriteExpression(node.base, state, options);
      let index = rewriteExpression(node.index, state, options);

      if (allowTableConstants && base.type === "Identifier" && state.tableConstants && state.tableConstants.has(base.name)) {
        const key = getLiteralKeyFromNode(unwrapParentheses(index));
        if (key) {
          const tableMap = state.tableConstants.get(base.name);
          if (tableMap && tableMap.has(key)) {
            return clone(tableMap.get(key));
          }
        }
      }

      if (
        state.galactic &&
        isIdentifier(base, state.galactic.tableName) &&
        index.type === "CallExpression" &&
        isIdentifier(index.base, state.galactic.decoderName) &&
        index.arguments.length === 2 &&
        isStringLiteral(index.arguments[0]) &&
        isNumericLiteral(index.arguments[1])
      ) {
        const encoded = index.arguments[0].value;
        const seed = index.arguments[1].value;
        const cacheKey = `${seed}:${encoded}`;
        let decoded = state.galactic.cache.get(cacheKey);
        if (!decoded) {
          try {
            decoded = decodeGalacticString(
              encoded,
              seed,
              state.galactic.alphabet,
              state.galactic.stripSequence,
            );
          } catch {
            decoded = null;
          }
          if (decoded !== null) {
            state.galactic.cache.set(cacheKey, decoded);
          }
        }

        if (typeof decoded === "string") {
          const score = scoreDecodedString(decoded);
          if (score >= 6 || isValidIdentifierName(decoded) || /^[\x20-\x7e]+$/.test(decoded)) {
            return {
              type: "StringLiteral",
              value: decoded,
              raw: JSON.stringify(decoded),
              __decrypted: true,
            };
          }
        }
      }

      if (isIdentifier(index) && state.decryptedAliases.has(index.name)) {
        const value = state.decryptedAliases.get(index.name);
        index = {
          type: "StringLiteral",
          value,
          raw: JSON.stringify(value),
          __decrypted: true,
        };
      }

      if (isIdentifier(base) && state.stringProxies.has(base.name)) {
        if (isStringLiteral(index)) {
          const mapped = state.decodedStringMap ? state.decodedStringMap.get(index.value) : null;
          const value = mapped || index.value;
          return {
            type: "StringLiteral",
            value,
            raw: JSON.stringify(value),
            __decrypted: true,
          };
        }

        if (isIdentifier(index) && state.decryptedAliases.has(index.name)) {
          const value = state.decryptedAliases.get(index.name);
          return {
            type: "StringLiteral",
            value,
            raw: JSON.stringify(value),
            __decrypted: true,
          };
        }
      }

      if (isStringLiteral(index) && isValidIdentifierName(index.value)) {
        return {
          type: "MemberExpression",
          base,
          indexer: ".",
          identifier: {
            type: "Identifier",
            name: index.value,
          },
        };
      }

      return {
        ...node,
        base,
        index,
      };
    }
    case "TableCallExpression": {
      const base = rewriteExpression(node.base, state, options);
      const argument = rewriteExpression(node.arguments, state, options);
      const reorderBuilderValue = evaluateReorderStringBuilderCall(base, argument, state);
      if (reorderBuilderValue) {
        return reorderBuilderValue;
      }

      const literalBuilderValue = evaluateLiteralStringBuilderCall(base, argument, state);
      if (literalBuilderValue) {
        return literalBuilderValue;
      }

      return {
        ...node,
        base,
        arguments: argument,
      };
    }
    case "StringCallExpression":
      return {
        ...node,
        base: rewriteExpression(node.base, state, options),
        argument: rewriteExpression(node.argument, state, options),
      };
    case "CallExpression": {
      let base = rewriteExpression(node.base, state, options);
      const args = node.arguments.map((argument) => rewriteExpression(argument, state, options));
      if (args.length === 1) {
        const reorderBuilderValue = evaluateReorderStringBuilderCall(base, args[0], state);
        if (reorderBuilderValue) {
          return reorderBuilderValue;
        }

        const literalBuilderValue = evaluateLiteralStringBuilderCall(base, args[0], state);
        if (literalBuilderValue) {
          return literalBuilderValue;
        }
      }

      if (
        state.encryptParams &&
        state.secretKey8 !== null &&
        args.length === 2 &&
        isProbablyEncryptedString(args[0]) &&
        isNumericLiteral(args[1]) &&
        args[1].value > 255
      ) {
        const decoded = decodePrometheusString(
          args[0].value,
          args[1].value,
          state.encryptParams,
          state.secretKey8,
        );

        return {
          type: "StringLiteral",
          value: decoded,
          raw: JSON.stringify(decoded),
          __decrypted: true,
        };
      }

      if (
        getCallBaseRoot(base) === "Color3" &&
        isLikelyRgbCall(args)
      ) {
        base = toPropertyNode({ type: "Identifier", name: "Color3" }, "fromRGB");
      } else {
        const constructorRoot = getCallBaseRoot(base);
        if (
          constructorRoot &&
          ROBLOX_CONSTRUCTOR_ROOTS.has(constructorRoot) &&
          constructorRoot !== "Instance"
        ) {
          base = toPropertyNode({ type: "Identifier", name: constructorRoot }, "new");
        } else if (
          constructorRoot === "Instance" &&
          args.length >= 1 &&
          isStringLiteral(args[0])
        ) {
          base = toPropertyNode({ type: "Identifier", name: "Instance" }, "new");
        }
      }

      if (
        base.type === "MemberExpression" &&
        base.indexer === "." &&
        args.length > 0 &&
        METHOD_HELPERS.has(base.identifier.name) &&
        isSelfMethodCall(base.base, args[0])
      ) {
        return {
          type: "CallExpression",
          base: {
            type: "MemberExpression",
            base: base.base,
            indexer: ":",
            identifier: clone(base.identifier),
          },
          arguments: args.slice(1),
        };
      }

      if (
        base.type === "IndexExpression" &&
        isStringLiteral(base.index) &&
        isValidIdentifierName(base.index.value) &&
        args.length > 0 &&
        isSelfMethodCall(base.base, args[0])
      ) {
        return {
          type: "CallExpression",
          base: {
            type: "MemberExpression",
            base: base.base,
            indexer: ":",
            identifier: {
              type: "Identifier",
              name: base.index.value,
            },
          },
          arguments: args.slice(1),
        };
      }

      return {
        ...node,
        base,
        arguments: args,
      };
    }
    case "FunctionDeclaration":
      return {
        ...node,
        parameters: node.parameters,
        body: processBlock(node.body, createChildState(state)),
      };
    default:
      return node;
  }
}

function rewriteStatement(statement, state) {
const mergeBlockTableConstants = (parentState, childState) => {
  for (const [tableName, map] of childState.tableConstants) {
    if (!parentState.tableConstants.has(tableName)) {
      const cloneMap = new Map();
      for (const [key, value] of map) {
        cloneMap.set(key, clone(value));
      }
      parentState.tableConstants.set(tableName, cloneMap);
    } else {
      const parentMap = parentState.tableConstants.get(tableName);
      for (const [key, value] of map) {
        if (!parentMap.has(key)) {
          parentMap.set(key, clone(value));
        }
      }
    }
  }
};

  switch (statement.type) {
    case "LocalStatement":
      return {
        ...statement,
        init: statement.init.map((expression) => rewriteExpression(expression, state)),
      };
    case "AssignmentStatement":
      return {
        ...statement,
        variables: statement.variables.map((variable) => rewriteExpression(variable, state, { allowTableConstants: false })),
        init: statement.init.map((expression) => rewriteExpression(expression, state)),
      };
    case "CallStatement":
      return {
        ...statement,
        expression: rewriteExpression(statement.expression, state),
      };
    case "ReturnStatement":
      return {
        ...statement,
        arguments: statement.arguments.map((argument) => rewriteExpression(argument, state)),
      };
    case "IfStatement":
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => {
          const clauseState = createChildState(state);
          const nextClause = {
            ...clause,
            body: processBlock(clause.body, clauseState),
          };
          mergeBlockTableConstants(state, clauseState);
          if (clause.condition) {
            nextClause.condition = rewriteExpression(clause.condition, state);
          }
          return nextClause;
        }),
      };
    case "WhileStatement": {
      const childState = createChildState(state);
      const body = processBlock(statement.body, childState);
      mergeBlockTableConstants(state, childState);
      return {
        ...statement,
        condition: rewriteExpression(statement.condition, state),
        body,
      };
    }
    case "RepeatStatement": {
      const childState = createChildState(state);
      const body = processBlock(statement.body, childState);
      mergeBlockTableConstants(state, childState);
      return {
        ...statement,
        body,
        condition: rewriteExpression(statement.condition, state),
      };
    }
    case "DoStatement": {
      const childState = createChildState(state);
      const body = processBlock(statement.body, childState);
      mergeBlockTableConstants(state, childState);
      return {
        ...statement,
        body,
      };
    }
    case "FunctionDeclaration": {
      const childState = createChildState(state);
      const body = processBlock(statement.body, childState);
      mergeBlockTableConstants(state, childState);
      return {
        ...statement,
        identifier: statement.identifier ? rewriteExpression(statement.identifier, state) : null,
        body,
      };
    }
    default:
      return statement;
  }
}

function createChildState(state) {
  return {
    aliases: new Map(state.aliases),
    decryptedAliases: new Map(state.decryptedAliases),
    decodedStringMap: state.decodedStringMap,
    encryptParams: state.encryptParams,
    galactic: state.galactic,
    literalStringBuilders: new Set(state.literalStringBuilders),
    reorderStringBuilders: new Set(state.reorderStringBuilders),
    secretKey8: state.secretKey8,
    stringProxies: new Set(state.stringProxies),
    concatAliases: new Set(state.concatAliases || []),
    loaderUrl: state.loaderUrl || null,
    tableConstants: cloneTableConstants(state.tableConstants),
  };
}

function processBlock(statements, state) {
  const output = [];

  for (const statement of statements) {
    const rewritten = rewriteStatement(statement, state);

    if (rewritten.type === "IfStatement" && rewritten.clauses.every((clause) => clause.body.length === 0)) {
      continue;
    }

    output.push(rewritten);
    updateStateFromStatement(rewritten, state);
  }

  return output;
}

function updateTableConstantsFromStatement(statement, state) {
  if (!statement || (statement.type !== "LocalStatement" && statement.type !== "AssignmentStatement")) {
    return;
  }

  const pairCount = Math.min(statement.variables.length, statement.init.length);
  for (let index = 0; index < pairCount; index += 1) {
    const variable = statement.variables[index];
    const initializer = unwrapParentheses(statement.init[index]);

    if (variable.type === "Identifier") {
      if (initializer && initializer.type === "TableConstructorExpression") {
        const constants = extractTableLiteralConstants(initializer);
        state.tableConstants.set(variable.name, constants || new Map());
      } else {
        state.tableConstants.delete(variable.name);
      }
      continue;
    }

    if (variable.type === "MemberExpression" && variable.indexer === "." && isIdentifier(variable.base)) {
      const tableName = variable.base.name;
      const key = normalizeLiteralKey(variable.identifier.name);
      if (key && initializer && isLiteralLike(initializer)) {
        const map = state.tableConstants.get(tableName) || new Map();
        map.set(key, clone(initializer));
        state.tableConstants.set(tableName, map);
      }
      continue;
    }

    if (variable.type === "IndexExpression") {
      const base = unwrapParentheses(variable.base);
      const indexNode = unwrapParentheses(variable.index);
      if (!base || base.type !== "Identifier") {
        continue;
      }
      const tableName = base.name;
      const key = getLiteralKeyFromNode(indexNode);
      if (key && initializer && isLiteralLike(initializer)) {
        const map = state.tableConstants.get(tableName) || new Map();
        map.set(key, clone(initializer));
        state.tableConstants.set(tableName, map);
      }
    }
  }
}

function updateStateFromStatement(statement, state) {
  if (
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    isIdentifier(statement.variables[0])
  ) {
    const name = statement.variables[0].name;
    const initializer = statement.init[0];
    updateAliasState(name, initializer, state);
    updateTableConstantsFromStatement(statement, state);
    return;
  }

  if (
    statement.type === "AssignmentStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    isIdentifier(statement.variables[0])
  ) {
    const name = statement.variables[0].name;
    const initializer = statement.init[0];
    updateAliasState(name, initializer, state);
    updateTableConstantsFromStatement(statement, state);
    return;
  }

  if (statement.type === "IfStatement" || statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
    return;
  }

  updateTableConstantsFromStatement(statement, state);
}

function updateAliasState(name, initializer, state) {
  state.aliases.delete(name);
  state.decryptedAliases.delete(name);
  state.literalStringBuilders.delete(name);
  state.reorderStringBuilders.delete(name);
  state.stringProxies.delete(name);

  if (initializer && initializer.__decrypted && isStringLiteral(initializer)) {
    state.decryptedAliases.set(name, initializer.value);
    if (!state.loaderUrl && /^https?:\/\//i.test(initializer.value)) {
      state.loaderUrl = initializer.value;
    }
    return;
  }

  if (isAliasableExpression(initializer)) {
    state.aliases.set(name, clone(initializer));
    if (initializer.type === "Identifier" && state.stringProxies.has(initializer.name)) {
      state.stringProxies.add(name);
    }
    return;
  }

  if (isStringProxyInitializer(initializer)) {
    state.stringProxies.add(name);
  }

  if (isLiteralStringBuilder(initializer)) {
    state.literalStringBuilders.add(name);
  }

  if (isReorderStringBuilder(initializer)) {
    state.reorderStringBuilders.add(name);
  }
}

function collectBlockCandidates(statements, isRoot = false, candidates = []) {
  candidates.push({
    isRoot,
    score: scoreBlock(statements),
    statements,
  });

  for (const statement of statements) {
    if (statement.type === "IfStatement") {
      statement.clauses.forEach((clause) => collectBlockCandidates(clause.body, false, candidates));
    } else if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      collectBlockCandidates(statement.body, false, candidates);
    } else if (statement.type === "FunctionDeclaration") {
      collectBlockCandidates(statement.body, false, candidates);
    }
  }

  return candidates;
}

function scoreBlock(statements) {
  let score = statements.length * 0.2;

  walk({ type: "Chunk", body: statements, comments: [] }, (node) => {
    if (node.type === "Identifier") {
      if (PAYLOAD_IDENTIFIERS.has(node.name)) {
        score += 4;
      }
      if (PAYLOAD_SCORE_IDENTIFIERS.has(node.name)) {
        score += 6;
      }
      if (HELPER_IDENTIFIERS.has(node.name)) {
        score -= 0.5;
      }
      if (ANTI_TAMPER_IDENTIFIER_SIGNALS.has(node.name)) {
        score -= 10;
      }
    }

    if (node.type === "MemberExpression" && node.identifier && typeof node.identifier.name === "string") {
      const memberName = node.identifier.name;
      if (PAYLOAD_SCORE_MEMBERS.has(memberName)) {
        score += 5;
      }
      if (
        isIdentifier(node.base, "debug") &&
        ANTI_TAMPER_DEBUG_MEMBERS.has(memberName)
      ) {
        score -= 14;
      }
      if (
        isIdentifier(node.base, "string") &&
        ANTI_TAMPER_STRING_MEMBERS.has(memberName)
      ) {
        score -= 10;
      }
    }

    if (node.type === "IndexExpression" && isStringLiteral(node.index)) {
      const memberName = node.index.value;
      if (PAYLOAD_SCORE_MEMBERS.has(memberName)) {
        score += 4;
      }
      if (
        isIdentifier(node.base, "debug") &&
        ANTI_TAMPER_DEBUG_MEMBERS.has(memberName)
      ) {
        score -= 14;
      }
      if (
        isIdentifier(node.base, "string") &&
        ANTI_TAMPER_STRING_MEMBERS.has(memberName)
      ) {
        score -= 10;
      }
    }

    if (node.type === "StringLiteral" && typeof node.value === "string") {
      if (/^[\x20-\x7e]+$/.test(node.value)) {
        score += Math.min(node.value.length, 12) * 0.2;
      }
      if (/^https?:\/\//i.test(node.value)) {
        score += 8;
      }
      if (PAYLOAD_SIGNAL_TEXT_REGEX.test(node.value)) {
        score += 7;
      }
      if (node.value.includes("Tamper Detected!")) {
        score -= 30;
      }
    }
  });

  return score;
}

function collectPayloadSignals(statements) {
  let score = 0;
  let hit = false;

  walk({ type: "Chunk", body: statements, comments: [] }, (node) => {
    if (node.type === "Identifier" && PAYLOAD_SCORE_IDENTIFIERS.has(node.name)) {
      score += 4;
      hit = true;
      return;
    }

    if (node.type === "MemberExpression" && node.identifier && PAYLOAD_SCORE_MEMBERS.has(node.identifier.name)) {
      score += 4;
      hit = true;
      return;
    }

    if (node.type === "IndexExpression" && isStringLiteral(node.index) && PAYLOAD_SCORE_MEMBERS.has(node.index.value)) {
      score += 3;
      hit = true;
      return;
    }

    if (node.type === "StringLiteral" && typeof node.value === "string") {
      if (/^https?:\/\//i.test(node.value)) {
        score += 6;
        hit = true;
        return;
      }
      if (PAYLOAD_SIGNAL_TEXT_REGEX.test(node.value)) {
        score += 5;
        hit = true;
      }
    }
  });

  return { hit, score };
}

function extractLikelyPayload(ast) {
  const source = emitChunk(ast);
  const hasTamperSignal = source.includes("Tamper Detected!");
  if (!hasTamperSignal && !looksObfuscated(source)) {
    return ast;
  }

  const candidates = collectBlockCandidates(ast.body, true);
  const root = candidates.find((candidate) => candidate.isRoot);
  const rankedCandidates = candidates
    .filter((candidate) => !candidate.isRoot)
    .map((candidate) => ({
      ...candidate,
      payload: collectPayloadSignals(candidate.statements),
    }))
    .sort((left, right) => {
      if (right.payload.hit !== left.payload.hit) {
        return Number(right.payload.hit) - Number(left.payload.hit);
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.payload.score - left.payload.score;
    });
  const best = rankedCandidates[0];

  if (!best) {
    return hasTamperSignal ? trimLeadingHelpers(ast) : ast;
  }

  if (!best.payload.hit) {
    return hasTamperSignal ? trimLeadingHelpers(ast) : ast;
  }

  const rootPayload = collectPayloadSignals(root.statements);
  const rootLength = root && Array.isArray(root.statements) ? root.statements.length : 0;
  const bestLength = Array.isArray(best.statements) ? best.statements.length : 0;

  if (rootPayload.hit && rootPayload.score >= best.payload.score - 2) {
    return hasTamperSignal ? trimLeadingHelpers(ast) : ast;
  }

  if (
    bestLength === 0 ||
    bestLength < Math.max(24, Math.ceil(rootLength * 0.3))
  ) {
    return hasTamperSignal ? trimLeadingHelpers(ast) : ast;
  }

  if (
    best.score < Math.max(hasTamperSignal ? 4 : 8, root.score * (hasTamperSignal ? 0.22 : 0.35)) &&
    best.payload.score <= rootPayload.score + (hasTamperSignal ? 0 : 4)
  ) {
    return hasTamperSignal ? trimLeadingHelpers(ast) : ast;
  }

  if (!hasTamperSignal) {
    if (
      bestLength === 0 ||
      bestLength >= rootLength ||
      bestLength > Math.max(10, Math.ceil(rootLength * 0.75))
    ) {
      return ast;
    }
  }

  return trimLeadingHelpers({
    type: "Chunk",
    body: clone(best.statements),
    comments: [],
  });
}

function asStringLiteralNode(value) {
  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
  };
}

function resolveStringLiteralValue(node, literalAliases) {
  const unwrapped = unwrapParentheses(node);
  if (isStringLiteral(unwrapped) && typeof unwrapped.value === "string") {
    return unwrapped.value;
  }
  if (isIdentifier(unwrapped) && literalAliases.has(unwrapped.name)) {
    return literalAliases.get(unwrapped.name);
  }
  return null;
}

function isMetatableLookupInitializer(node) {
  const init = unwrapParentheses(node);
  if (
    !init ||
    init.type !== "CallExpression" ||
    !isIdentifier(init.base, "setmetatable") ||
    !Array.isArray(init.arguments) ||
    init.arguments.length < 2
  ) {
    return false;
  }

  const [, mtArg] = init.arguments;
  if (!mtArg || mtArg.type !== "TableConstructorExpression" || !Array.isArray(mtArg.fields)) {
    return false;
  }

  let hasIndexField = false;
  for (const field of mtArg.fields) {
    if (
      field &&
      field.type === "TableKeyString" &&
      field.key &&
      field.key.name === "__index"
    ) {
      hasIndexField = true;
      break;
    }
  }

  return hasIndexField;
}

function extractMetatableLookupTableName(node) {
  const init = unwrapParentheses(node);
  if (!isMetatableLookupInitializer(init)) {
    return null;
  }

  const [, mtArg] = init.arguments;
  for (const field of mtArg.fields) {
    if (
      field &&
      field.type === "TableKeyString" &&
      field.key &&
      field.key.name === "__index"
    ) {
      const value = unwrapParentheses(field.value);
      if (isIdentifier(value)) {
        return value.name;
      }
      return null;
    }
  }

  return null;
}

function resolveLiteralLookupKey(node, literalAliases) {
  const stringValue = resolveStringLiteralValue(node, literalAliases);
  if (typeof stringValue === "string") {
    return normalizeLiteralKey(stringValue);
  }

  const unwrapped = unwrapParentheses(node);
  if (!unwrapped) {
    return null;
  }

  if (isNumericLiteral(unwrapped)) {
    return normalizeLiteralKey(unwrapped.value);
  }
  if (unwrapped.type === "BooleanLiteral") {
    return normalizeLiteralKey(unwrapped.value);
  }
  if (unwrapped.type === "NilLiteral") {
    return normalizeLiteralKey(null);
  }
  if (isStringLiteral(unwrapped)) {
    return normalizeLiteralKey(unwrapped.value);
  }

  return null;
}

function cloneLiteralEntryMap(map) {
  const next = new Map();
  if (!map) {
    return next;
  }
  for (const [key, value] of map.entries()) {
    next.set(key, clone(value));
  }
  return next;
}

function updateTableLiteralInitializer(name, initializer, tableLiteralEntries) {
  const init = unwrapParentheses(initializer);
  if (!name) {
    return;
  }

  if (init && init.type === "TableConstructorExpression") {
    tableLiteralEntries.set(name, extractTableLiteralConstants(init) || new Map());
    return;
  }

  if (isIdentifier(init) && tableLiteralEntries.has(init.name)) {
    tableLiteralEntries.set(name, cloneLiteralEntryMap(tableLiteralEntries.get(init.name)));
    return;
  }

  tableLiteralEntries.delete(name);
}

function updateMetatableLookupBinding(name, initializer, metatableLookupTables) {
  if (!name) {
    return;
  }

  const tableName = extractMetatableLookupTableName(initializer);
  if (tableName) {
    metatableLookupTables.set(name, tableName);
    return;
  }

  const init = unwrapParentheses(initializer);
  if (isIdentifier(init) && metatableLookupTables.has(init.name)) {
    metatableLookupTables.set(name, metatableLookupTables.get(init.name));
    return;
  }

  metatableLookupTables.delete(name);
}

function updateTableLiteralAssignment(target, initializer, literalAliases, tableLiteralEntries) {
  const variable = unwrapParentheses(target);
  if (!variable || variable.type !== "IndexExpression" || !isIdentifier(variable.base)) {
    return;
  }

  const key = resolveLiteralLookupKey(variable.index, literalAliases);
  if (key === null) {
    return;
  }

  const tableName = variable.base.name;
  if (!tableLiteralEntries.has(tableName)) {
    tableLiteralEntries.set(tableName, new Map());
  }

  const entryMap = tableLiteralEntries.get(tableName);
  const init = unwrapParentheses(initializer);
  if (isLiteralLike(init)) {
    entryMap.set(key, clone(init));
    return;
  }

  entryMap.delete(key);
}

function rewriteMetatableLookupsInNode(node, literalAliases, metatableLookupTables, tableLiteralEntries) {
  return transformNode(node, (current) => {
    if (
      current &&
      current.type === "IndexExpression" &&
      isIdentifier(current.base) &&
      metatableLookupTables.has(current.base.name)
    ) {
      const tableName = metatableLookupTables.get(current.base.name);
      const key = resolveLiteralLookupKey(current.index, literalAliases);
      if (tableName && key !== null && tableLiteralEntries.has(tableName)) {
        const tableMap = tableLiteralEntries.get(tableName);
        if (tableMap && tableMap.has(key)) {
          return clone(tableMap.get(key));
        }
      }

      const stringValue = resolveStringLiteralValue(current.index, literalAliases);
      if (typeof stringValue === "string") {
        return asStringLiteralNode(stringValue);
      }
    }
    return current;
  });
}

function updateLiteralAliasForBinding(variable, initNode, literalAliases) {
  if (!variable || variable.type !== "Identifier") {
    return;
  }
  const literalValue = resolveStringLiteralValue(initNode, literalAliases);
  if (typeof literalValue === "string") {
    literalAliases.set(variable.name, literalValue);
    return;
  }
  literalAliases.delete(variable.name);
}

function processMetatableLookupBlock(
  statements,
  parentLiteralAliases = new Map(),
  parentMetatableLookupTables = new Map(),
  parentTableLiteralEntries = new Map(),
) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return statements;
  }

  const literalAliases = new Map(parentLiteralAliases);
  const metatableLookupTables = new Map(parentMetatableLookupTables);
  const tableLiteralEntries = cloneTableConstants(parentTableLiteralEntries);
  const result = [];

  for (const statement of statements) {
    let next = rewriteMetatableLookupsInNode(statement, literalAliases, metatableLookupTables, tableLiteralEntries);

    if (next.type === "IfStatement") {
      next = {
        ...next,
        clauses: next.clauses.map((clause) => ({
          ...clause,
          body: processMetatableLookupBlock(
            clause.body || [],
            new Map(literalAliases),
            new Map(metatableLookupTables),
            cloneTableConstants(tableLiteralEntries),
          ),
        })),
      };
    } else if (next.type === "WhileStatement" || next.type === "RepeatStatement" || next.type === "DoStatement") {
      next = {
        ...next,
        body: processMetatableLookupBlock(
          next.body || [],
          new Map(literalAliases),
          new Map(metatableLookupTables),
          cloneTableConstants(tableLiteralEntries),
        ),
      };
    } else if (next.type === "ForNumericStatement" || next.type === "ForGenericStatement") {
      next = {
        ...next,
        body: processMetatableLookupBlock(
          next.body || [],
          new Map(literalAliases),
          new Map(metatableLookupTables),
          cloneTableConstants(tableLiteralEntries),
        ),
      };
    } else if (next.type === "FunctionDeclaration") {
      next = {
        ...next,
        body: processMetatableLookupBlock(
          next.body || [],
          new Map(literalAliases),
          new Map(metatableLookupTables),
          cloneTableConstants(tableLiteralEntries),
        ),
      };
    }

    if (next.type === "LocalStatement" && Array.isArray(next.variables)) {
      const init = Array.isArray(next.init) ? next.init : [];
      for (let index = 0; index < next.variables.length; index += 1) {
        const variable = next.variables[index];
        const initializer = init[index] || null;
        if (variable && variable.type === "Identifier") {
          updateTableLiteralInitializer(variable.name, initializer, tableLiteralEntries);
          updateMetatableLookupBinding(variable.name, initializer, metatableLookupTables);
          updateLiteralAliasForBinding(variable, initializer, literalAliases);
        }
      }
    } else if (next.type === "AssignmentStatement" && Array.isArray(next.variables)) {
      const init = Array.isArray(next.init) ? next.init : [];
      for (let index = 0; index < next.variables.length; index += 1) {
        const variable = next.variables[index];
        const initializer = init[index] || null;
        if (variable && variable.type === "Identifier") {
          updateTableLiteralInitializer(variable.name, initializer, tableLiteralEntries);
          updateMetatableLookupBinding(variable.name, initializer, metatableLookupTables);
          updateLiteralAliasForBinding(variable, initializer, literalAliases);
          continue;
        }

        updateTableLiteralAssignment(variable, initializer, literalAliases, tableLiteralEntries);
      }
    }

    result.push(next);
  }

  return result;
}

function simplifyMetatablePrintLookups(statements) {
  return processMetatableLookupBlock(statements);
}

function areEquivalentExpressions(left, right) {
  const a = unwrapParentheses(left);
  const b = unwrapParentheses(right);
  if (!a || !b || a.type !== b.type) {
    return false;
  }

  if (a.type === "Identifier") {
    return a.name === b.name;
  }
  if (a.type === "NumericLiteral") {
    return a.value === b.value;
  }
  if (a.type === "StringLiteral") {
    return a.value === b.value;
  }
  if (a.type === "IndexExpression") {
    return areEquivalentExpressions(a.base, b.base) && areEquivalentExpressions(a.index, b.index);
  }
  if (a.type === "MemberExpression") {
    return (
      a.indexer === b.indexer &&
      areEquivalentExpressions(a.base, b.base) &&
      a.identifier &&
      b.identifier &&
      a.identifier.name === b.identifier.name
    );
  }
  return false;
}

function simplifyDynamicStringMethodCalls(statements) {
  return transformNode(statements, (node) => {
    if (!node || node.type !== "CallExpression") {
      return node;
    }

    if (
      !node.base ||
      node.base.type !== "IndexExpression" ||
      !isIdentifier(node.base.base, "string") ||
      !Array.isArray(node.arguments) ||
      node.arguments.length < 3
    ) {
      return node;
    }

    const [subjectArg, startArg] = node.arguments;
    if (!areEquivalentExpressions(subjectArg, node.base.index) || !isNumericLiteral(startArg, 1)) {
      return node;
    }

    return {
      ...node,
      base: {
        type: "MemberExpression",
        base: clone(node.base.base),
        identifier: {
          type: "Identifier",
          name: "sub",
        },
        indexer: ".",
      },
    };
  });
}

function isSimpleLiteral(node) {
  const unwrapped = unwrapParentheses(node);
  return Boolean(
    unwrapped &&
    (
      unwrapped.type === "StringLiteral" ||
      unwrapped.type === "NumericLiteral" ||
      unwrapped.type === "BooleanLiteral" ||
      unwrapped.type === "NilLiteral"
    )
  );
}

function isLiteralPrintCallExpression(expression) {
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }

  const root = getCallBaseRoot(expression.base);
  if (root !== "print") {
    return false;
  }

  if (!Array.isArray(expression.arguments) || expression.arguments.length === 0) {
    return false;
  }

  for (const arg of expression.arguments) {
    if (!isSimpleLiteral(arg)) {
      return false;
    }
  }

  return true;
}

function hasRiskyRuntimeCall(node) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }

  const root = getCallBaseRoot(node.base);
  if ([
    "game",
    "workspace",
    "loadstring",
    "require",
    "getfenv",
    "setfenv",
    "getgenv",
    "getrenv",
    "hookfunction",
    "hookmetamethod",
  ].includes(root)) {
    return true;
  }

  if (node.base && node.base.type === "MemberExpression" && node.base.identifier) {
    if ([
      "GetService",
      "HttpGet",
      "WaitForChild",
      "FindFirstChild",
      "FireServer",
      "InvokeServer",
      "Connect",
      "CreateWindow",
      "CreateTab",
      "CreateButton",
      "CreateToggle",
      "CreateSlider",
    ].includes(node.base.identifier.name)) {
      return true;
    }
  }

  return false;
}

function collectLiteralPrintPayload(body) {
  const prints = [];
  let callCount = 0;
  let riskyCall = false;

  const walkStatement = (statement) => {
    if (!statement || typeof statement !== "object") {
      return;
    }

    walk(statement, (node) => {
      if (node.type === "CallExpression") {
        callCount += 1;
        if (hasRiskyRuntimeCall(node)) {
          riskyCall = true;
        }
      }
    });

    if (statement.type === "CallStatement" && isLiteralPrintCallExpression(statement.expression)) {
      prints.push(clone(statement));
    }

    if (
      (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") &&
      Array.isArray(statement.init)
    ) {
      for (const initNode of statement.init) {
        if (isLiteralPrintCallExpression(initNode)) {
          prints.push({
            type: "CallStatement",
            expression: clone(initNode),
          });
        }
      }
    }

    if (statement.type === "IfStatement") {
      for (const clause of statement.clauses || []) {
        for (const child of clause.body || []) {
          walkStatement(child);
        }
      }
      return;
    }

    if (
      statement.type === "WhileStatement" ||
      statement.type === "RepeatStatement" ||
      statement.type === "DoStatement" ||
      statement.type === "ForNumericStatement" ||
      statement.type === "ForGenericStatement" ||
      statement.type === "FunctionDeclaration"
    ) {
      for (const child of statement.body || []) {
        walkStatement(child);
      }
    }
  };

  for (const statement of body || []) {
    walkStatement(statement);
  }

  return { prints, callCount, riskyCall };
}

function maybeExtractLiteralPrintProgram(body, options = {}) {
  if (options.obfuscatedLikely !== true) {
    return body;
  }

  const { prints, callCount, riskyCall } = collectLiteralPrintPayload(body);
  if (riskyCall || prints.length === 0) {
    return body;
  }

  if (prints.length >= 3) {
    return prints;
  }

  if (prints.length === 1 && (body || []).length >= 25 && callCount >= 20) {
    return prints;
  }

  return body;
}

function isStringSubCall(node) {
  if (!node || node.type !== "CallExpression" || !node.base) {
    return false;
  }
  if (node.base.type === "MemberExpression" && isIdentifier(node.base.base, "string") && isIdentifier(node.base.identifier, "sub")) {
    return true;
  }
  return false;
}

function findPrefixPrintCall(statement) {
  if (!statement || statement.type !== "CallStatement" || !statement.expression) {
    return null;
  }
  const outer = statement.expression;
  if (outer.type !== "CallExpression" || getCallBaseRoot(outer.base) !== "print" || !outer.arguments || outer.arguments.length !== 1) {
    return null;
  }

  const inner = unwrapParentheses(outer.arguments[0]);
  if (!isStringSubCall(inner) || !inner.arguments || inner.arguments.length < 3) {
    return null;
  }

  const [textArg, startArg, endArg] = inner.arguments;
  if (!isNumericLiteral(startArg, 1) || !isIdentifier(endArg)) {
    return null;
  }

  return {
    endIdentifier: endArg.name,
    textArg: clone(textArg),
  };
}

function maybeExtractPrefixLoopProgram(body, options = {}) {
  if (options.obfuscatedLikely !== true || !Array.isArray(body) || body.length < 8) {
    return null;
  }

  let target = null;
  const visit = (statements) => {
    if (!Array.isArray(statements) || target) {
      return;
    }
    for (const statement of statements) {
      const match = findPrefixPrintCall(statement);
      if (match) {
        target = match;
        return;
      }
      if (statement.type === "IfStatement") {
        for (const clause of statement.clauses || []) {
          visit(clause.body || []);
          if (target) {
            return;
          }
        }
        continue;
      }
      if (
        statement.type === "WhileStatement" ||
        statement.type === "RepeatStatement" ||
        statement.type === "DoStatement" ||
        statement.type === "ForNumericStatement" ||
        statement.type === "ForGenericStatement" ||
        statement.type === "FunctionDeclaration"
      ) {
        visit(statement.body || []);
        if (target) {
          return;
        }
      }
    }
  };

  visit(body);

  if (!target) {
    return null;
  }

  const simpleBindings = new Map();
  const captureBindings = (statements) => {
    if (!Array.isArray(statements)) {
      return;
    }
    for (const statement of statements) {
      if (
        (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") &&
        Array.isArray(statement.variables) &&
        Array.isArray(statement.init)
      ) {
        const pairCount = Math.min(statement.variables.length, statement.init.length);
        for (let index = 0; index < pairCount; index += 1) {
          const variable = statement.variables[index];
          const init = unwrapParentheses(statement.init[index]);
          if (!variable || variable.type !== "Identifier" || !init) {
            continue;
          }
          if (init.type === "StringLiteral" || init.type === "NumericLiteral") {
            simpleBindings.set(variable.name, clone(init));
            continue;
          }
          if (
            init.type === "TableConstructorExpression" &&
            Array.isArray(init.fields) &&
            init.fields.length >= 1 &&
            init.fields[0].type === "TableValue"
          ) {
            const firstValue = unwrapParentheses(init.fields[0].value);
            if (firstValue && firstValue.type === "StringLiteral") {
              simpleBindings.set(variable.name, clone(firstValue));
            }
          }
        }
      }

      if (statement.type === "IfStatement") {
        for (const clause of statement.clauses || []) {
          captureBindings(clause.body || []);
        }
        continue;
      }

      if (
        statement.type === "WhileStatement" ||
        statement.type === "RepeatStatement" ||
        statement.type === "DoStatement" ||
        statement.type === "ForNumericStatement" ||
        statement.type === "ForGenericStatement" ||
        statement.type === "FunctionDeclaration"
      ) {
        captureBindings(statement.body || []);
      }
    }
  };
  captureBindings(body);

  const loopVar = {
    type: "Identifier",
    name: "i",
  };

  let loopTextArg = clone(target.textArg);
  let loopEndNode = {
    type: "Identifier",
    name: target.endIdentifier,
  };

  if (
    loopTextArg.type === "IndexExpression" &&
    isIdentifier(loopTextArg.base) &&
    isNumericLiteral(loopTextArg.index, 1) &&
    simpleBindings.has(loopTextArg.base.name)
  ) {
    const resolved = simpleBindings.get(loopTextArg.base.name);
    if (resolved && resolved.type === "StringLiteral") {
      loopTextArg = clone(resolved);
    }
  }

  if (simpleBindings.has(target.endIdentifier)) {
    const resolvedEnd = simpleBindings.get(target.endIdentifier);
    if (resolvedEnd && resolvedEnd.type === "NumericLiteral") {
      loopEndNode = clone(resolvedEnd);
    }
  }

  const printStatement = {
    type: "CallStatement",
    expression: {
      type: "CallExpression",
      base: {
        type: "Identifier",
        name: "print",
      },
      arguments: [
        {
          type: "CallExpression",
          base: {
            type: "MemberExpression",
            base: {
              type: "Identifier",
              name: "string",
            },
            identifier: {
              type: "Identifier",
              name: "sub",
            },
            indexer: ".",
          },
          arguments: [
            loopTextArg,
            {
              type: "NumericLiteral",
              value: 1,
              raw: "1",
            },
            {
              type: "Identifier",
              name: "i",
            },
          ],
        },
      ],
    },
  };

  return [
    {
      type: "ForNumericStatement",
      variable: loopVar,
      start: {
        type: "NumericLiteral",
        value: 1,
        raw: "1",
      },
      end: {
        ...loopEndNode,
      },
      step: null,
      body: [printStatement],
    },
  ];
}

function simplifySingleValuePrintWrappers(statements, state) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return statements;
  }

  const result = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];

    if (statement.type === "IfStatement") {
      result.push({
        ...statement,
        clauses: (statement.clauses || []).map((clause) => ({
          ...clause,
          body: simplifySingleValuePrintWrappers(clause.body || [], state),
        })),
      });
      continue;
    }

    if (
      statement.type === "WhileStatement" ||
      statement.type === "RepeatStatement" ||
      statement.type === "DoStatement" ||
      statement.type === "ForNumericStatement" ||
      statement.type === "ForGenericStatement" ||
      statement.type === "FunctionDeclaration"
    ) {
      result.push({
        ...statement,
        body: simplifySingleValuePrintWrappers(statement.body || [], state),
      });
      continue;
    }

    if (
      statement.type === "LocalStatement" &&
      statement.variables &&
      statement.variables.length === 1 &&
      statement.init &&
      statement.init.length === 1 &&
      statement.variables[0] &&
      statement.variables[0].type === "Identifier" &&
      statement.init[0] &&
      statement.init[0].type === "TableConstructorExpression" &&
      statement.init[0].fields &&
      statement.init[0].fields.length === 1 &&
      statement.init[0].fields[0].type === "TableValue"
    ) {
      const next = statements[index + 1];
      if (
        next &&
        next.type === "CallStatement" &&
        next.expression &&
        next.expression.type === "CallExpression" &&
        getCallBaseRoot(next.expression.base) === "print" &&
        next.expression.arguments &&
        next.expression.arguments.length === 1
      ) {
        const printArg = unwrapParentheses(next.expression.arguments[0]);
        if (
          printArg &&
          printArg.type === "CallExpression" &&
          isIdentifier(printArg.base) &&
          printArg.arguments &&
          printArg.arguments.length === 1 &&
          isIdentifier(printArg.arguments[0], statement.variables[0].name)
        ) {
          const tableValue = statement.init[0].fields[0].value;
          result.push({
            ...next,
            expression: {
              ...next.expression,
              arguments: [clone(tableValue)],
            },
          });
          index += 1;
          continue;
        }
      }
    }

    result.push(statement);
  }

  return result;
}

function collectStatementDefinitions(statement, definitions = new Set()) {
  if (!statement || typeof statement !== "object") {
    return definitions;
  }

  switch (statement.type) {
    case "LocalStatement":
      statement.variables.forEach((variable) => {
        if (isIdentifier(variable)) {
          definitions.add(variable.name);
        }
      });
      return definitions;
    case "AssignmentStatement":
      statement.variables.forEach((variable) => {
        if (isIdentifier(variable)) {
          definitions.add(variable.name);
        }
      });
      return definitions;
    case "FunctionDeclaration":
      if (statement.isLocal && isIdentifier(statement.identifier)) {
        definitions.add(statement.identifier.name);
      }
      if (Array.isArray(statement.parameters)) {
        statement.parameters.forEach((parameter) => {
          if (isIdentifier(parameter)) {
            definitions.add(parameter.name);
          }
        });
      }
      return definitions;
    case "ForNumericStatement":
      if (isIdentifier(statement.variable)) {
        definitions.add(statement.variable.name);
      }
      return definitions;
    case "ForGenericStatement":
      statement.variables.forEach((variable) => {
        if (isIdentifier(variable)) {
          definitions.add(variable.name);
        }
      });
      return definitions;
    default:
      return definitions;
  }
}

function collectStatementReferences(node, references = new Set()) {
  if (!node || typeof node !== "object") {
    return references;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => collectStatementReferences(child, references));
    return references;
  }

  if (node.type === "Identifier") {
    references.add(node.name);
    return references;
  }

  switch (node.type) {
    case "LocalStatement":
      node.init.forEach((expression) => collectStatementReferences(expression, references));
      return references;
    case "AssignmentStatement":
      node.init.forEach((expression) => collectStatementReferences(expression, references));
      node.variables.forEach((variable) => {
        if (!isIdentifier(variable)) {
          collectStatementReferences(variable, references);
        }
      });
      return references;
    case "FunctionDeclaration":
      if (!node.isLocal && node.identifier) {
        collectStatementReferences(node.identifier, references);
      }
      collectStatementReferences(node.body || [], references);
      return references;
    case "ForNumericStatement":
      collectStatementReferences(node.start, references);
      collectStatementReferences(node.end, references);
      collectStatementReferences(node.step, references);
      collectStatementReferences(node.body || [], references);
      return references;
    case "ForGenericStatement":
      collectStatementReferences(node.iterators || [], references);
      collectStatementReferences(node.body || [], references);
      return references;
    default:
      Object.entries(node).forEach(([key, value]) => {
        if (key === "variables" || key === "identifier" || key === "parameters" || key === "scope") {
          return;
        }
        collectStatementReferences(value, references);
      });
      return references;
  }
}

function collectBlockDependencies(statements) {
  const definitions = new Set();
  const references = new Set();

  statements.forEach((statement) => {
    collectStatementDefinitions(statement, definitions);
    collectStatementReferences(statement, references);
  });

  return {
    definitions,
    references,
  };
}

function retainRequiredLeadingDefinitions(statements, startIndex) {
  const body = statements.slice(startIndex);
  const bodyDeps = collectBlockDependencies(body);
  const requiredNames = new Set(
    [...bodyDeps.references].filter(
      (name) =>
        !bodyDeps.definitions.has(name) &&
        !KNOWN_GLOBAL_LIKE_NAMES.has(name),
    ),
  );

  if (requiredNames.size === 0) {
    return clone(body);
  }

  const selectedIndexes = [];
  const selectedIndexSet = new Set();
  let changed = true;

  while (changed) {
    changed = false;

    for (let index = startIndex - 1; index >= 0; index -= 1) {
      if (selectedIndexSet.has(index)) {
        continue;
      }

      const statement = statements[index];
      const directDefinitions = collectStatementDefinitions(statement);
      const matchesRequirement = [...directDefinitions].some((name) => requiredNames.has(name));
      if (!matchesRequirement) {
        continue;
      }

      selectedIndexSet.add(index);
      selectedIndexes.unshift(index);
      changed = true;

      directDefinitions.forEach((name) => requiredNames.delete(name));
      const statementDeps = collectBlockDependencies([statement]);
      statementDeps.references.forEach((name) => {
        if (!statementDeps.definitions.has(name) && !KNOWN_GLOBAL_LIKE_NAMES.has(name)) {
          requiredNames.add(name);
        }
      });
    }
  }

  return [
    ...selectedIndexes.map((index) => clone(statements[index])),
    ...clone(body),
  ];
}

function trimLeadingHelpers(ast) {
  const startIndex = ast.body.findIndex((statement) => collectPayloadSignals([statement]).hit);

  if (startIndex <= 0) {
    return ast;
  }

  return {
    type: "Chunk",
    body: retainRequiredLeadingDefinitions(ast.body, startIndex),
    comments: [],
  };
}

function isNumericLiteralValue(node, value) {
  const target = unwrapParentheses(node);
  return target && target.type === "NumericLiteral" && target.value === value;
}

function isLengthEqualsZeroCondition(node) {
  const condition = unwrapParentheses(node);
  if (!condition || condition.type !== "BinaryExpression" || condition.operator !== "==") {
    return false;
  }

  const left = unwrapParentheses(condition.left);
  const right = unwrapParentheses(condition.right);

  return (
    (left && left.type === "UnaryExpression" && left.operator === "#" && isNumericLiteralValue(right, 0)) ||
    (right && right.type === "UnaryExpression" && right.operator === "#" && isNumericLiteralValue(left, 0))
  );
}

function isReturnWrappedFunctionCall(statement) {
  if (
    !statement ||
    statement.type !== "ReturnStatement" ||
    !Array.isArray(statement.arguments) ||
    statement.arguments.length !== 1
  ) {
    return false;
  }

  const call = unwrapParentheses(statement.arguments[0]);
  return Boolean(call && call.type === "CallExpression" && call.base && call.base.type === "FunctionDeclaration");
}

function isLengthZeroPayloadIfStatement(statement) {
  return Boolean(
    statement &&
    statement.type === "IfStatement" &&
    statement.clauses.some((clause) => clause && clause.condition && isLengthEqualsZeroCondition(clause.condition) && (clause.body || []).length >= 12),
  );
}

function isAntiTamperPreludeStatement(statement) {
  if (!statement) {
    return false;
  }

  if (statement.type === "CallStatement") {
    const expression = unwrapParentheses(statement.expression);
    return (
      expression &&
      expression.type === "CallExpression" &&
      expression.base &&
      expression.base.type === "MemberExpression" &&
      isIdentifier(expression.base.base, "math") &&
      expression.base.identifier &&
      expression.base.identifier.name === "random"
    );
  }

  if (statement.type !== "LocalStatement" || statement.variables.length !== 1 || statement.init.length !== 1) {
    return false;
  }

  const initializer = unwrapParentheses(statement.init[0]);
  if (!initializer) {
    return false;
  }

  if (initializer.type === "FunctionDeclaration") {
    return true;
  }

  if (initializer.type === "TableConstructorExpression") {
    return initializer.fields.some((field) => {
      const value = unwrapParentheses(field && field.value);
      return value && value.type === "CallExpression" && isIdentifier(value.base, "pcall");
    });
  }

  if (initializer.type !== "CallExpression") {
    return false;
  }

  if (isIdentifier(initializer.base, "pcall") || isIdentifier(initializer.base, "tostring") || isIdentifier(initializer.base, "tonumber")) {
    return true;
  }

  return (
    initializer.base &&
    initializer.base.type === "MemberExpression" &&
    isIdentifier(initializer.base.base, "string") &&
    initializer.base.identifier &&
    initializer.base.identifier.name === "gmatch"
  );
}

function findLargestLengthZeroPayload(statements, best = null) {
  if (!Array.isArray(statements)) {
    return best;
  }

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") {
      continue;
    }

    if (statement.type === "IfStatement") {
      for (const clause of statement.clauses) {
        if (clause && clause.condition && isLengthEqualsZeroCondition(clause.condition)) {
          if (!best || (clause.body || []).length > (best.body || []).length) {
            best = clause;
          }
        }
        best = findLargestLengthZeroPayload(clause.body || [], best);
      }
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      best = findLargestLengthZeroPayload(statement.body || [], best);
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      best = findLargestLengthZeroPayload(statement.body || [], best);
    }
  }

  return best;
}

function find25msPayloadEnvelope(statements) {
  if (!Array.isArray(statements)) {
    return null;
  }

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") {
      continue;
    }

    if (statement.type === "IfStatement") {
      for (const clause of statement.clauses) {
        const clauseBody = clause.body || [];
        const candidateIndex = clauseBody.findIndex((child) => isLengthZeroPayloadIfStatement(child));
        if (candidateIndex >= 0) {
          return retainRequiredLeadingDefinitions(clauseBody, candidateIndex);
        }

        const nested = find25msPayloadEnvelope(clauseBody);
        if (nested) {
          return nested;
        }
      }
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      const nested = find25msPayloadEnvelope(statement.body || []);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      const nested = find25msPayloadEnvelope(statement.body || []);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function collectLocalNames(statements) {
  const names = new Set();

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") {
      continue;
    }

    if (statement.type === "LocalStatement") {
      statement.variables.forEach((variable) => {
        if (isIdentifier(variable)) {
          names.add(variable.name);
        }
      });
    }
  }

  return names;
}

function collectReferencedIdentifierNames(statements) {
  const names = new Set();
  walk({ type: "Chunk", body: statements, comments: [] }, (node, parent, key) => {
    if (!node || node.type !== "Identifier") {
      return;
    }

    if (parent && parent.type === "MemberExpression" && key === "identifier") {
      return;
    }

    if (parent && parent.type === "LocalStatement" && key === "variables") {
      return;
    }

    if (parent && parent.type === "FunctionDeclaration" && (key === "identifier" || key === "parameters")) {
      return;
    }

    if (parent && parent.type === "ForNumericStatement" && key === "variable") {
      return;
    }

    if (parent && parent.type === "ForGenericStatement" && key === "variables") {
      return;
    }

    names.add(node.name);
  });
  return names;
}

function createHoistedLocalStatement(name) {
  return {
    type: "LocalStatement",
    variables: [
      {
        type: "Identifier",
        name,
      },
    ],
    init: [],
  };
}

function extract25msPayloadFromUnwrappedComparison(statements) {
  if (!Array.isArray(statements) || statements.length < 2) {
    return null;
  }

  const finalStatement = statements[statements.length - 1];
  if (
    !finalStatement ||
    finalStatement.type !== "IfStatement" ||
    finalStatement.clauses.length !== 2
  ) {
    return null;
  }

  const prelude = statements.slice(0, -1);
  const suspiciousPreludeCount = prelude.reduce(
    (count, statement) => count + (isAntiTamperPreludeStatement(statement) ? 1 : 0),
    0,
  );
  if (prelude.length < 5 || suspiciousPreludeCount < 4) {
    return null;
  }

  const payloadEnvelope = find25msPayloadEnvelope([finalStatement]);
  if (!payloadEnvelope || payloadEnvelope.length < 12) {
    return null;
  }

  return retainRequiredLeadingDefinitions([...prelude, ...payloadEnvelope], prelude.length);
}

function extract25msAntiTamperPayloadDetailed(statements) {
  if (!Array.isArray(statements) || statements.length < 2) {
    return {
      body: statements,
      changed: false,
    };
  }

  const finalStatement = statements[statements.length - 1];
  if (
    !finalStatement ||
    finalStatement.type !== "IfStatement" ||
    finalStatement.clauses.length !== 2 ||
    finalStatement.clauses[0].type !== "IfClause" ||
    finalStatement.clauses[1].type !== "ElseClause"
  ) {
    const unwrappedPayload = extract25msPayloadFromUnwrappedComparison(statements);
    if (unwrappedPayload) {
      return {
        body: unwrappedPayload,
        changed: true,
      };
    }
    return {
      body: statements,
      changed: false,
    };
  }

  const elseBody = finalStatement.clauses[1].body || [];
  if (elseBody.length !== 1 || !isReturnWrappedFunctionCall(elseBody[0])) {
    const unwrappedPayload = extract25msPayloadFromUnwrappedComparison(statements);
    if (unwrappedPayload) {
      return {
        body: unwrappedPayload,
        changed: true,
      };
    }
    return {
      body: statements,
      changed: false,
    };
  }

  const prelude = statements.slice(0, -1);
  const suspiciousPreludeCount = prelude.reduce(
    (count, statement) => count + (isAntiTamperPreludeStatement(statement) ? 1 : 0),
    0,
  );
  if (prelude.length < 5 || suspiciousPreludeCount < 4) {
    const unwrappedPayload = extract25msPayloadFromUnwrappedComparison(statements);
    if (unwrappedPayload) {
      return {
        body: unwrappedPayload,
        changed: true,
      };
    }
    return {
      body: statements,
      changed: false,
    };
  }

  const payloadEnvelope = find25msPayloadEnvelope(finalStatement.clauses[0].body || []);
  if (payloadEnvelope && payloadEnvelope.length >= 12) {
    return {
      body: retainRequiredLeadingDefinitions([...prelude, ...payloadEnvelope], prelude.length),
      changed: true,
    };
  }

  const payloadClause = findLargestLengthZeroPayload(finalStatement.clauses[0].body || []);
  if (!payloadClause || !Array.isArray(payloadClause.body) || payloadClause.body.length < 12) {
    return {
      body: statements,
      changed: false,
    };
  }

  const referencedNames = collectReferencedIdentifierNames(payloadClause.body);
  const hoistedLocals = [...collectLocalNames(prelude)]
    .filter((name) => referencedNames.has(name))
    .map((name) => createHoistedLocalStatement(name));

  return {
    body: [
      ...hoistedLocals,
      ...clone(payloadClause.body),
    ],
    changed: true,
  };
}

function extract25msAntiTamperPayload(statements) {
  return extract25msAntiTamperPayloadDetailed(statements).body;
}

function stripAntiTamperStatements(statements) {
  const output = [];

  for (const statement of statements) {
    if (isAntiTamperStatement(statement) || isWatermarkCheck(statement)) {
      continue;
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: stripAntiTamperStatements(clause.body || []),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      output.push({
        ...statement,
        body: stripAntiTamperStatements(statement.body),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: stripAntiTamperStatements(statement.body),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function collectAntiTamperSignals(node) {
  const signals = {
    hasPayloadSignal: false,
    hasTamperString: false,
    score: 0,
  };

  walk(node, (child) => {
    if (!child || typeof child !== "object") {
      return;
    }

    if (child.type === "Identifier" && ANTI_TAMPER_IDENTIFIER_SIGNALS.has(child.name)) {
      signals.score += 2;
      return;
    }

    if (child.type === "Identifier" && ANTI_TAMPER_HELPER_IDENTIFIERS.has(child.name)) {
      signals.score += 1;
      return;
    }

    if (child.type === "StringLiteral" && typeof child.value === "string") {
      if (child.value.includes("Tamper Detected!")) {
        signals.hasTamperString = true;
        signals.score += 4;
      }
      if (PAYLOAD_SIGNAL_TEXT_REGEX.test(child.value) || /^https?:\/\//i.test(child.value)) {
        signals.hasPayloadSignal = true;
      }
      return;
    }

    if (child.type === "MemberExpression" && child.identifier && typeof child.identifier.name === "string") {
      const memberName = child.identifier.name;
      if (PAYLOAD_SCORE_MEMBERS.has(memberName)) {
        signals.hasPayloadSignal = true;
      }
      if (isIdentifier(child.base, "debug") && ANTI_TAMPER_DEBUG_MEMBERS.has(memberName)) {
        signals.score += 3;
      }
      if (
        (isIdentifier(child.base, "math") || isIdentifier(child.base, "string")) &&
        ANTI_TAMPER_HELPER_MEMBERS.has(memberName)
      ) {
        signals.score += 1;
      }
      if (isIdentifier(child.base, "string") && ANTI_TAMPER_STRING_MEMBERS.has(memberName)) {
        signals.score += 2;
      }
      return;
    }

    if (child.type === "IndexExpression" && isStringLiteral(child.index)) {
      const memberName = child.index.value;
      if (PAYLOAD_SCORE_MEMBERS.has(memberName)) {
        signals.hasPayloadSignal = true;
      }
      if (isIdentifier(child.base, "debug") && ANTI_TAMPER_DEBUG_MEMBERS.has(memberName)) {
        signals.score += 3;
      }
      if (
        (isIdentifier(child.base, "math") || isIdentifier(child.base, "string")) &&
        ANTI_TAMPER_HELPER_MEMBERS.has(memberName)
      ) {
        signals.score += 1;
      }
      if (isIdentifier(child.base, "string") && ANTI_TAMPER_STRING_MEMBERS.has(memberName)) {
        signals.score += 2;
      }
      return;
    }

    if (child.type === "Identifier" && PAYLOAD_SCORE_IDENTIFIERS.has(child.name)) {
      signals.hasPayloadSignal = true;
    }
  });

  return signals;
}

function isAntiTamperStatement(statement) {
  if (!statement) {
    return false;
  }

  const signals = collectAntiTamperSignals(statement);
  if (signals.hasPayloadSignal) {
    return false;
  }

  return signals.hasTamperString;
}

function summarizeBranchSignals(statements) {
  const chunk = {
    type: "Chunk",
    body: statements,
    comments: [],
  };

  return {
    anti: collectAntiTamperSignals(chunk),
    payload: collectPayloadSignals(statements),
    score: scoreBlock(statements),
    length: Array.isArray(statements) ? statements.length : 0,
  };
}

function shouldPreferPayloadBranch(payloadBranch, otherBranch) {
  if (!payloadBranch.payload.hit || otherBranch.payload.hit || payloadBranch.length === 0) {
    return false;
  }

  if (otherBranch.anti.hasTamperString) {
    return true;
  }

  if (
    otherBranch.anti.score >= 6 &&
    payloadBranch.score >= otherBranch.score + 10 &&
    payloadBranch.length >= Math.ceil(otherBranch.length * 0.5)
  ) {
    return true;
  }

  return false;
}

function preferPayloadBranches(statements) {
  const output = [];

  for (const statement of statements) {
    if (statement.type === "IfStatement") {
      const clauses = statement.clauses.map((clause) => ({
        ...clause,
        body: preferPayloadBranches(clause.body || []),
      }));

      if (
        clauses.length === 2 &&
        clauses[0].type === "IfClause" &&
        clauses[1].type === "ElseClause"
      ) {
        const ifBranch = summarizeBranchSignals(clauses[0].body || []);
        const elseBranch = summarizeBranchSignals(clauses[1].body || []);

        if (shouldPreferPayloadBranch(elseBranch, ifBranch)) {
          output.push(...clauses[1].body);
          continue;
        }

        if (shouldPreferPayloadBranch(ifBranch, elseBranch)) {
          output.push(...clauses[0].body);
          continue;
        }
      }

      output.push({
        ...statement,
        clauses,
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      output.push({
        ...statement,
        body: preferPayloadBranches(statement.body),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: preferPayloadBranches(statement.body),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function isWatermarkCheck(statement) {
  if (!statement || statement.type !== "IfStatement" || statement.clauses.length !== 1) {
    return false;
  }

  const clause = statement.clauses[0];
  if (clause.type !== "IfClause" || clause.body.length !== 1) {
    return false;
  }

  const onlyStatement = clause.body[0];
  if (!onlyStatement || onlyStatement.type !== "ReturnStatement" || onlyStatement.arguments.length !== 0) {
    return false;
  }

  if (
    !clause.condition ||
    clause.condition.type !== "BinaryExpression" ||
    clause.condition.operator !== "~=" ||
    clause.condition.right.type !== "StringLiteral"
  ) {
    return false;
  }

  return (
    typeof clause.condition.right.value === "string" &&
    clause.condition.right.value.includes("Prometheus Obfuscator")
  );
}

function isLuaTruthyValue(value) {
  return value !== false && value !== null;
}

function dceStatements(statements, shadowedIdentifiers) {
  const output = [];

  for (const statement of statements) {
    if (
      statement.type === "ReturnStatement" ||
      statement.type === "BreakStatement" ||
      statement.type === "ContinueStatement"
    ) {
      output.push(statement);
      break;
    }

    if (statement.type === "IfStatement") {
      const simplified = simplifyIfStatement(statement, shadowedIdentifiers);
      if (Array.isArray(simplified)) {
        output.push(...simplified);
      } else {
        output.push(simplified);
      }
      continue;
    }

    if (statement.type === "WhileStatement") {
      const conditionValue = evaluateLiteral(statement.condition, shadowedIdentifiers);
      if (conditionValue !== undefined && isLuaTruthyValue(conditionValue) === false) {
        continue;
      }
      output.push({
        ...statement,
        body: dceStatements(statement.body, shadowedIdentifiers),
      });
      continue;
    }

    if (statement.type === "RepeatStatement") {
      output.push({
        ...statement,
        body: dceStatements(statement.body, shadowedIdentifiers),
      });
      continue;
    }

    if (statement.type === "DoStatement") {
      output.push({
        ...statement,
        body: dceStatements(statement.body, shadowedIdentifiers),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: dceStatements(statement.body, shadowedIdentifiers),
      });
      continue;
    }

    output.push(statement);
  }

  return removeUnusedLocalFunctions(removeUnusedLocals(output));
}

function simplifyIfStatement(statement, shadowedIdentifiers) {
  const nextClauses = statement.clauses.map((clause) => ({
    ...clause,
    body: dceStatements(clause.body || [], shadowedIdentifiers),
  }));

  let seenUnknown = false;
  for (const clause of nextClauses) {
    if (clause.type === "ElseClause") {
      if (!seenUnknown) {
        return clause.body;
      }
      return {
        ...statement,
        clauses: nextClauses,
      };
    }

    const conditionValue = evaluateLiteral(clause.condition, shadowedIdentifiers);
    if (conditionValue === undefined) {
      seenUnknown = true;
      continue;
    }

    if (isLuaTruthyValue(conditionValue)) {
      return clause.body;
    }
  }

  if (seenUnknown) {
    return {
      ...statement,
      clauses: nextClauses,
    };
  }

  return [];
}

function removeUnusedLocals(statements) {
  const { usage } = buildUsageMap(statements);

  return statements.filter((statement) => {
    if (
      statement.type !== "LocalStatement" ||
      statement.variables.length !== 1 ||
      statement.init.length !== 1 ||
      statement.variables[0].type !== "Identifier"
    ) {
      return true;
    }

    const name = statement.variables[0].name;
    if ((usage.get(name) || 0) > 0) {
      return true;
    }

    return isPureExpression(statement.init[0]) ? false : true;
  });
}

function removeUnusedLocalFunctions(statements) {
  const { usage } = buildUsageMap(statements);
  const output = [];

  for (const statement of statements) {
    if (statement.type === "FunctionDeclaration" && statement.isLocal && statement.identifier && statement.identifier.type === "Identifier") {
      const name = statement.identifier.name;
      if ((usage.get(name) || 0) === 0) {
        continue;
      }
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: removeUnusedLocalFunctions(clause.body || []),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement") {
      output.push({
        ...statement,
        body: removeUnusedLocalFunctions(statement.body),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: removeUnusedLocalFunctions(statement.body),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function isPureExpression(node) {
  if (!node || typeof node !== "object") {
    return false;
  }

  switch (node.type) {
    case "Identifier":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return true;
    case "ParenthesisExpression":
      return isPureExpression(node.expression);
    case "UnaryExpression":
      return isPureExpression(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isPureExpression(node.left) && isPureExpression(node.right);
    case "IndexExpression":
      return isPureExpression(node.base) && isPureExpression(node.index);
    case "MemberExpression":
      return isPureExpression(node.base);
    case "TableConstructorExpression":
      return node.fields.every((field) => {
        if (field.type === "TableValue") {
          return isPureExpression(field.value);
        }
        return isPureExpression(field.key) && isPureExpression(field.value);
      });
    case "FunctionDeclaration":
      return true;
    case "IfExpression":
      return isPureExpression(node.condition) &&
        isPureExpression(node.trueExpression) &&
        isPureExpression(node.falseExpression);
    default:
      return false;
  }
}

function isLiteralLike(node) {
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

function statementReferencesIdentifier(statement, name) {
  if (!statement || typeof statement !== "object") {
    return false;
  }

  if (Array.isArray(statement)) {
    return statement.some((entry) => statementReferencesIdentifier(entry, name));
  }

  switch (statement.type) {
    case "Identifier":
      return statement.name === name;
    case "LocalStatement":
      return statement.init.some((expression) => statementReferencesIdentifier(expression, name));
    case "FunctionDeclaration":
      if (
        (statement.identifier && statement.identifier.name === name) ||
        statement.parameters.some((parameter) => parameter.type === "Identifier" && parameter.name === name)
      ) {
        return false;
      }
      return statement.body.some((entry) => statementReferencesIdentifier(entry, name));
    default:
      return Object.entries(statement).some(([key, value]) => {
        if (key === "variables" || key === "identifier" || key === "parameters") {
          return false;
        }
        return statementReferencesIdentifier(value, name);
      });
  }
}

function cleanupStatement(statement) {
  if (!statement || typeof statement !== "object") {
    return statement;
  }

  if (statement.type === "IfStatement") {
    return {
      ...statement,
      clauses: statement.clauses.map((clause) => ({
        ...clause,
        body: cleanupBlock(clause.body),
      })),
    };
  }

  if (statement.type === "WhileStatement" || statement.type === "DoStatement") {
    return {
      ...statement,
      body: cleanupBlock(statement.body),
    };
  }

  if (statement.type === "RepeatStatement") {
    return {
      ...statement,
      body: cleanupBlock(statement.body),
      condition: rewriteExpression(statement.condition, {
        aliases: new Map(),
        decryptedAliases: new Map(),
        encryptParams: null,
        galactic: null,
        literalStringBuilders: new Set(),
        reorderStringBuilders: new Set(),
        secretKey8: null,
        stringProxies: new Set(),
      }),
    };
  }

  if (statement.type === "FunctionDeclaration") {
    return {
      ...statement,
      body: cleanupBlock(statement.body),
    };
  }

  return statement;
}

function normalizeResidualExpression(node) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map(normalizeResidualExpression);
  }

  if (node.type === "MemberExpression") {
    const base = normalizeResidualExpression(node.base);
    const enumClass = inferEnumClassFromMember(node.identifier.name);
    if (
      enumClass &&
      base.type === "IndexExpression" &&
      isIdentifier(base.base, "Enum")
    ) {
      return {
        ...node,
        base: toPropertyNode({ type: "Identifier", name: "Enum" }, enumClass),
      };
    }

    return {
      ...node,
      base,
    };
  }

  if (node.type === "IndexExpression") {
    const base = normalizeResidualExpression(node.base);
    const index = normalizeResidualExpression(node.index);
    if (isStringLiteral(index) && isValidIdentifierName(index.value)) {
      return {
        type: "MemberExpression",
        base,
        indexer: ".",
        identifier: {
          type: "Identifier",
          name: index.value,
        },
      };
    }
    return {
      ...node,
      base,
      index,
    };
  }

  if (node.type === "CallExpression") {
    let base = normalizeResidualExpression(node.base);
    const args = node.arguments.map(normalizeResidualExpression);

    if (getCallBaseRoot(base) === "Color3" && isLikelyRgbCall(args)) {
      base = toPropertyNode({ type: "Identifier", name: "Color3" }, "fromRGB");
    }

    return {
      ...node,
      base,
      arguments: args,
    };
  }

  const next = {};
  for (const [key, value] of Object.entries(node)) {
    next[key] = normalizeResidualExpression(value);
  }
  return next;
}

function normalizeResidualStatement(statement) {
  if (!statement || typeof statement !== "object") {
    return statement;
  }

  switch (statement.type) {
    case "LocalStatement":
      return {
        ...statement,
        init: statement.init.map(normalizeResidualExpression),
      };
    case "AssignmentStatement":
      return {
        ...statement,
        variables: statement.variables.map(normalizeResidualExpression),
        init: statement.init.map(normalizeResidualExpression),
      };
    case "CallStatement":
      return {
        ...statement,
        expression: normalizeResidualExpression(statement.expression),
      };
    case "ReturnStatement":
      return {
        ...statement,
        arguments: statement.arguments.map(normalizeResidualExpression),
      };
    case "IfStatement":
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? normalizeResidualExpression(clause.condition) : clause.condition,
          body: clause.body.map(normalizeResidualStatement),
        })),
      };
    case "WhileStatement":
      return {
        ...statement,
        condition: normalizeResidualExpression(statement.condition),
        body: statement.body.map(normalizeResidualStatement),
      };
    case "RepeatStatement":
      return {
        ...statement,
        condition: normalizeResidualExpression(statement.condition),
        body: statement.body.map(normalizeResidualStatement),
      };
    case "DoStatement":
      return {
        ...statement,
        body: statement.body.map(normalizeResidualStatement),
      };
    case "FunctionDeclaration":
      return {
        ...statement,
        body: statement.body.map(normalizeResidualStatement),
      };
    default:
      return statement;
  }
}

function applyDirectHintRewrites(statements) {
  const output = [];

  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index];
    const next = statements[index + 1];
    const third = statements[index + 2];
    const fourth = statements[index + 3];

    if (
      current &&
      next &&
      third &&
      fourth &&
      isStringHintStatement(current) &&
      isStringHintStatement(next) &&
      isStringHintStatement(third)
    ) {
      const hintedCondition = applyInputConditionHints(
        fourth,
        current.init[0].value,
        next.init[0].value,
        third.init[0].value,
      );
      if (hintedCondition) {
        output.push(hintedCondition);
        index += 3;
        continue;
      }

      const rewrittenByHints = applyPropertyValueHints(
        fourth,
        current.init[0].value,
        next.init[0].value,
      );
      if (rewrittenByHints) {
        output.push(rewrittenByHints);
        index += 3;
        continue;
      }
    }

    if (
      current &&
      next &&
      third &&
      isStringHintStatement(current) &&
      isStringHintStatement(next)
    ) {
      const rewrittenByHints = applyPropertyValueHints(
        third,
        current.init[0].value,
        next.init[0].value,
      );
      if (rewrittenByHints) {
        output.push(rewrittenByHints);
        index += 2;
        continue;
      }
    }

    if (current && next && isStringHintStatement(current)) {
      const rewrittenAssignment = applyPropertyHint(next, current.init[0].value);
      if (rewrittenAssignment) {
        output.push(rewrittenAssignment);
        index += 1;
        continue;
      }
    }

    output.push(current);
  }

  return output;
}

function cleanupBlock(statements) {
  let output = statements.map(cleanupStatement).map(normalizeResidualStatement).filter(Boolean);
  output = applyDirectHintRewrites(output);

  output = output.filter((statement, index) => {
    if (
      statement.type !== "LocalStatement" ||
      statement.variables.length !== 1 ||
      statement.init.length !== 1 ||
      !isIdentifier(statement.variables[0]) ||
      !isLiteralLike(statement.init[0])
    ) {
      return true;
    }

    return output.slice(index + 1).some((nextStatement) =>
      statementReferencesIdentifier(nextStatement, statement.variables[0].name));
  });

  if (
    output.length > 0 &&
    output[output.length - 1].type === "ReturnStatement" &&
    output[output.length - 1].arguments.length === 0
  ) {
    output = output.slice(0, -1);
  }

  return output;
}

function isReadablePayloadString(value) {
  const letterCount = (value.match(/[A-Za-z]/g) || []).length;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[\x20-\x7e]+$/.test(value) &&
    !value.includes("%") &&
    value !== "print" &&
    value !== "Tamper Detected!" &&
    letterCount >= 3 &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    /[\s,.!?/:;-]/.test(value)
  );
}

function isLikelyGalacticTamperMessage(value) {
  return /galactic/i.test(value) && /(detect|tamper|error|protected|fail)/i.test(value);
}

function createStringLiteral(value) {
  return {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
  };
}

function createPrintStatement(value) {
  return {
    type: "CallStatement",
    expression: {
      type: "CallExpression",
      base: {
        type: "Identifier",
        name: "print",
      },
      arguments: [createStringLiteral(value)],
    },
  };
}

function readStaticStringExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return null;
  }

  if (expression.type === "StringLiteral") {
    return expression.value;
  }

  if (
    (expression.type === "BinaryExpression" || expression.type === "LogicalExpression") &&
    expression.operator === ".."
  ) {
    const left = readStaticStringExpression(expression.left);
    const right = readStaticStringExpression(expression.right);
    if (typeof left === "string" && typeof right === "string") {
      return left + right;
    }
  }

  return null;
}

function collectUrlCandidates(ast) {
  const urls = new Set();

  const addUrlCandidate = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return;
    }

    if (/^https?:\/\//i.test(value)) {
      urls.add(value);
      return;
    }

    if (/^https?%3a%2f%2f/i.test(value)) {
      try {
        const decoded = decodeURIComponent(value);
        if (/^https?:\/\//i.test(decoded)) {
          urls.add(decoded);
        }
      } catch {
      }
    }
  };

  const decodeBase64Url = (value) => {
    if (typeof value !== "string" || value.length < 12 || value.length % 4 !== 0) {
      return null;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
      return null;
    }
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    } catch {
      return null;
    }
    return null;
  };

  walk(ast, (node) => {
    const staticValue = readStaticStringExpression(node);
    if (typeof staticValue === "string") {
      addUrlCandidate(staticValue);
      const decoded = decodeBase64Url(staticValue);
      if (decoded) {
        urls.add(decoded);
      }
    }

    if (node.type !== "StringLiteral" || typeof node.value !== "string") {
      return;
    }

    addUrlCandidate(node.value);
    const decoded = decodeBase64Url(node.value);
    if (decoded) {
      urls.add(decoded);
    }
  });

  return [...urls];
}

function chooseLoaderUrl(urls) {
  if (!urls || urls.length === 0) {
    return null;
  }

  const normalized = [...new Set(urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)))];
  if (normalized.length === 0) {
    return null;
  }

  const ranked = normalized
    .map((url) => {
      let score = 0;
      if (/^https:\/\//i.test(url)) {
        score += 1;
      }
      if (/\.lua(\?|$)/i.test(url)) {
        score += 5;
      }
      if (/(?:raw\.githubusercontent|raw\.nebulasoftworks|pastebin|gist|luarmor|loader|loaders)/i.test(url)) {
        score += 4;
      }
      if (/[?&](?:raw|download)=/i.test(url)) {
        score += 1;
      }
      if (/\.(?:png|jpg|jpeg|gif|webp|mp3|ogg|wav|mp4)(\?|$)/i.test(url)) {
        score -= 6;
      }
      score += Math.min(url.length, 120) * 0.01;
      return { score, url };
    })
    .sort((left, right) => right.score - left.score);

  const luaUrls = normalized.filter((url) => /\.lua(\?|$)/i.test(url));
  if (luaUrls.length === 1) {
    return luaUrls[0];
  }

  const preferredLua = luaUrls.find((url) => /luarmor|loader|loaders/i.test(url));
  if (preferredLua) {
    return preferredLua;
  }

  if (ranked.length === 1) {
    return ranked[0].url;
  }

  return ranked[0].url;
}

function shouldUpgradeLoaderUrl(currentUrl, candidateUrl) {
  if (!candidateUrl || typeof candidateUrl !== "string") {
    return false;
  }
  if (!currentUrl || typeof currentUrl !== "string") {
    return true;
  }
  if (currentUrl === candidateUrl) {
    return false;
  }

  const currentIsObfuscatorMarker = /obfuscator|77fuscator|wearedevs/i.test(currentUrl);
  const candidateIsObfuscatorMarker = /obfuscator|77fuscator|wearedevs/i.test(candidateUrl);
  if (currentIsObfuscatorMarker && !candidateIsObfuscatorMarker) {
    return true;
  }

  const currentIsLua = /\.lua(\?|$)/i.test(currentUrl);
  const candidateIsLua = /\.lua(\?|$)/i.test(candidateUrl);
  if (!currentIsLua && candidateIsLua) {
    return true;
  }

  const currentIsPreferredHost = /(?:raw\.githubusercontent|raw\.nebulasoftworks|pastebin|gist|luarmor|loader|loaders)/i.test(currentUrl);
  const candidateIsPreferredHost = /(?:raw\.githubusercontent|raw\.nebulasoftworks|pastebin|gist|luarmor|loader|loaders)/i.test(candidateUrl);
  if (!currentIsPreferredHost && candidateIsPreferredHost) {
    return true;
  }

  return false;
}

function isLikelyLoaderUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return false;
  }

  if (/\.(?:png|jpg|jpeg|gif|webp|mp3|ogg|wav|mp4)(\?|$)/i.test(url)) {
    return false;
  }

  if (/\.lua(\?|$)/i.test(url)) {
    return true;
  }

  if (/(?:raw\.githubusercontent|raw\.nebulasoftworks|pastebin|gist|luarmor|loader|loaders)/i.test(url)) {
    return true;
  }

  return true;
}

function getHttpGetKeyId(node, keyAliases = null) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return null;
  }

  if (expression.type === "Identifier" && keyAliases && keyAliases.has(expression.name)) {
    return keyAliases.get(expression.name);
  }

  if (
    expression.type === "MemberExpression" &&
    expression.indexer === "." &&
    isIdentifier(expression.base, "game") &&
    expression.identifier &&
    expression.identifier.name === "HttpGet"
  ) {
    return "game.HttpGet";
  }

  if (
    expression.type === "IndexExpression" &&
    isIdentifier(expression.base, "game") &&
    isStringLiteral(expression.index, "HttpGet")
  ) {
    return "game.HttpGet";
  }

  if (isStringLiteral(expression, "HttpGet")) {
    return "HttpGet";
  }

  return null;
}

function collectHttpGetKeyAliases(ast) {
  const aliases = new Map();
  let changed = true;

  const tryRecordAlias = (name, init) => {
    const keyId = getHttpGetKeyId(init, aliases);
    if (!keyId || aliases.get(name) === keyId) {
      return false;
    }
    aliases.set(name, keyId);
    return true;
  };

  while (changed) {
    changed = false;
    walk(ast, (node) => {
      if (node.type !== "LocalStatement" && node.type !== "AssignmentStatement") {
        return;
      }

      const pairCount = Math.min(node.variables.length, node.init.length);
      for (let index = 0; index < pairCount; index += 1) {
        const variable = node.variables[index];
        const init = node.init[index];
        if (!variable || variable.type !== "Identifier" || !init) {
          continue;
        }
        if (tryRecordAlias(variable.name, init)) {
          changed = true;
        }
      }
    });
  }

  return aliases;
}

function collectHttpGetTableMappings(ast) {
  const tables = new Map();
  const tableAliases = new Map();
  const urls = new Set();
  const keyAliases = collectHttpGetKeyAliases(ast);

  const recordValue = (tableName, keyId, value) => {
    if (!tableName || !keyId || typeof value !== "string") {
      return;
    }
    if (!/^https?:\/\//i.test(value)) {
      return;
    }

    let table = tables.get(tableName);
    if (!table) {
      table = new Map();
      tables.set(tableName, table);
    }
    if (!table.has(keyId)) {
      table.set(keyId, value);
    }
    urls.add(value);
  };

  const recordValueNode = (tableName, keyId, valueNode) => {
    if (!tableName || !keyId || !valueNode) {
      return;
    }

    const literal = extractStaticStringValue(valueNode);
    if (literal !== null) {
      recordValue(tableName, keyId, literal);
      return;
    }

    if (isStringLiteral(valueNode)) {
      recordValue(tableName, keyId, valueNode.value);
    }
  };

  const recordTableConstructor = (tableName, constructorNode) => {
    if (!constructorNode || constructorNode.type !== "TableConstructorExpression") {
      return;
    }

    constructorNode.fields.forEach((field) => {
      if (!field) {
        return;
      }

      let keyId = null;
      if (field.type === "TableKeyString") {
        if (field.key && field.key.name === "HttpGet") {
          keyId = "HttpGet";
        }
      } else if (field.type === "TableKey") {
        keyId = getHttpGetKeyId(field.key, keyAliases);
      }

      if (!keyId) {
        return;
      }

      recordValueNode(tableName, keyId, field.value);
    });
  };

  const recordSetmetatableAlias = (tableName, init) => {
    const expression = unwrapParentheses(init);
    if (!expression || expression.type !== "CallExpression") {
      return;
    }

    if (!isIdentifier(expression.base, "setmetatable")) {
      return;
    }

    if (expression.arguments.length < 2) {
      return;
    }

    const meta = unwrapParentheses(expression.arguments[1]);
    if (!meta || meta.type !== "TableConstructorExpression") {
      return;
    }

    const indexField = meta.fields.find((field) => {
      if (!field) {
        return false;
      }
      if (field.type === "TableKeyString" && field.key && field.key.name === "__index") {
        return true;
      }
      if (field.type === "TableKey" && isStringLiteral(field.key, "__index")) {
        return true;
      }
      return false;
    });

    if (!indexField) {
      return;
    }

    const indexValue = unwrapParentheses(indexField.value);
    if (!indexValue) {
      return;
    }

    if (indexValue.type === "Identifier") {
      tableAliases.set(tableName, indexValue.name);
      return;
    }

    if (indexValue.type === "TableConstructorExpression") {
      recordTableConstructor(tableName, indexValue);
    }
  };

  walk(ast, (node) => {
    if (node.type !== "LocalStatement" && node.type !== "AssignmentStatement") {
      return;
    }

    const pairCount = Math.min(node.variables.length, node.init.length);
    for (let index = 0; index < pairCount; index += 1) {
      const variable = node.variables[index];
      const init = node.init[index];

      if (variable && variable.type === "Identifier" && init) {
        if (init.type === "TableConstructorExpression") {
          recordTableConstructor(variable.name, init);
        } else if (init.type === "CallExpression") {
          recordSetmetatableAlias(variable.name, init);
        } else if (init.type === "Identifier") {
          tableAliases.set(variable.name, init.name);
        }
      }

      if (node.type !== "AssignmentStatement") {
        continue;
      }

      const target = variable;
      if (!target) {
        continue;
      }

      if (target.type === "IndexExpression" && isIdentifier(target.base)) {
        const keyId = getHttpGetKeyId(target.index, keyAliases);
        if (keyId) {
          recordValueNode(target.base.name, keyId, init);
        }
      } else if (
        target.type === "MemberExpression" &&
        target.indexer === "." &&
        isIdentifier(target.base) &&
        target.identifier &&
        target.identifier.name === "HttpGet"
      ) {
        recordValueNode(target.base.name, "HttpGet", init);
      }
    }
  });

  return {
    tables,
    aliases: tableAliases,
    keyAliases,
    urls: [...urls],
  };
}

function resolveHttpGetTableValue(tableName, keyId, tables, aliases, visited = new Set()) {
  if (!tableName || !keyId) {
    return null;
  }

  const visitKey = `${tableName}:${keyId}`;
  if (visited.has(visitKey)) {
    return null;
  }
  visited.add(visitKey);

  const table = tables.get(tableName);
  if (table && table.has(keyId)) {
    return table.get(keyId);
  }

  const alias = aliases.get(tableName);
  if (!alias) {
    return null;
  }

  return resolveHttpGetTableValue(alias, keyId, tables, aliases, visited);
}

function resolveHttpGetArgumentValue(argument, state) {
  if (!state || !state.httpGetTables) {
    return null;
  }

  const expression = unwrapParentheses(argument);
  if (!expression) {
    return null;
  }

  const tables = state.httpGetTables;
  const aliases = state.httpGetTableAliases || new Map();
  const keyAliases = state.httpGetKeyAliases || new Map();

  if (expression.type === "IndexExpression" && isIdentifier(expression.base)) {
    const keyId = getHttpGetKeyId(expression.index, keyAliases);
    if (!keyId) {
      return null;
    }
    return resolveHttpGetTableValue(expression.base.name, keyId, tables, aliases);
  }

  if (
    expression.type === "MemberExpression" &&
    expression.indexer === "." &&
    isIdentifier(expression.base) &&
    expression.identifier &&
    expression.identifier.name === "HttpGet"
  ) {
    return resolveHttpGetTableValue(expression.base.name, "HttpGet", tables, aliases);
  }

  return null;
}

function isPrintableLiteral(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[\x20-\x7e]+$/.test(value) &&
    value !== "print"
  );
}

function collectPrintLiteralMessages(ast) {
  const messages = [];
  const seen = new Set();

  const isPrintCallBase = (base) => {
    if (isIdentifier(base, "print")) {
      return true;
    }

    if (base && base.type === "MemberExpression" && base.identifier.name === "print") {
      return true;
    }

    if (base && base.type === "IndexExpression" && isStringLiteral(base.index, "print")) {
      return true;
    }

    return false;
  };

  const recordMessage = (value) => {
    if (!isPrintableLiteral(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    messages.push(value);
  };

  walk(ast, (node) => {
    if (node.type === "CallExpression") {
      if (isPrintCallBase(node.base) && node.arguments.length >= 1 && isStringLiteral(node.arguments[0])) {
        recordMessage(node.arguments[0].value);
      }
      return;
    }

    if (node.type === "StringCallExpression") {
      if (isPrintCallBase(node.base) && isStringLiteral(node.argument)) {
        recordMessage(node.argument.value);
      }
    }
  });

  return messages;
}

function collectUppercaseLiteralMessages(ast) {
  const messages = [];
  const seen = new Set();

  walk(ast, (node) => {
    if (node.type !== "StringLiteral" || typeof node.value !== "string") {
      return;
    }

    const value = node.value;
    if (
      value.length < 2 ||
      value.length > 12 ||
      !/^[A-Z]+$/.test(value) ||
      seen.has(value)
    ) {
      return;
    }

    seen.add(value);
    messages.push(value);
  });

  return messages;
}

function synthesizeLiteralPayload(ast) {
  const source = emitChunk(ast);
  if (!looksObfuscated(source) && /\bprint\(/.test(source)) {
    return null;
  }

  const printedMessages = collectPrintLiteralMessages(ast);
  if (printedMessages.length === 1) {
    return {
      type: "Chunk",
      body: [createPrintStatement(printedMessages[0])],
      comments: [],
    };
  }

  if (printedMessages.length === 2) {
    return {
      type: "Chunk",
      body: printedMessages.map((message) => createPrintStatement(message)),
      comments: [],
    };
  }

  const uppercaseMessages = collectUppercaseLiteralMessages(ast);
  if (
    uppercaseMessages.length === 1 &&
    (printedMessages.length > 0 || /\bprint\b/.test(source))
  ) {
    return {
      type: "Chunk",
      body: [createPrintStatement(uppercaseMessages[0])],
      comments: [],
    };
  }

  const messages = [];
  const seen = new Set();
  let hasPrintSignal = /\bprint\(/.test(source) || printedMessages.length > 0;

  walk(ast, (node) => {
    if (node.type === "StringLiteral") {
      if (node.value === "print") {
        hasPrintSignal = true;
        return;
      }

      if (!isReadablePayloadString(node.value) || seen.has(node.value)) {
        return;
      }

      seen.add(node.value);
      messages.push(node.value);
    }
  });

  if (
    printedMessages.length === 0 &&
    messages.length > 0 &&
    messages.every((message) => isLikelyGalacticTamperMessage(message))
  ) {
    return null;
  }

  if (!hasPrintSignal || messages.length === 0 || messages.length > 2) {
    return null;
  }

  if (messages.length === 1) {
    return {
      type: "Chunk",
      body: [createPrintStatement(messages[0])],
      comments: [],
    };
  }
  if (messages.length === 2) {
    return {
      type: "Chunk",
      body: messages.map((message) => createPrintStatement(message)),
      comments: [],
    };
  }

  return null;
}

function simplify25msPatterns(statements) {
  return statements.map(stmt => {
    return transformNode(stmt, node => {
      if (node.type === "LogicalExpression" && node.operator === "or") {
        const left = node.left;
        const right = node.right;
        if (
          left.type === "LogicalExpression" && left.operator === "and" &&
          right.type === "LogicalExpression" && right.operator === "and"
        ) {
          const lCondition = left.left;
          const rCondition = right.left;
          if (
            rCondition.type === "UnaryExpression" && rCondition.operator === "not" &&
            isIdentifier(lCondition) && isIdentifier(rCondition.argument) &&
            lCondition.name === rCondition.argument.name
          ) {
          }
        }
      }
      return node;
    });
  });
}

function isLoadstringCallExpression(node) {
  return (
    node &&
    node.type === "CallExpression" &&
    node.base &&
    node.base.type === "Identifier" &&
    node.base.name === "loadstring"
  );
}

function isConcatCallBase(base, state) {
  if (!base) {
    return false;
  }

  if (isTableConcatExpression(base)) {
    return true;
  }

  if (base.type === "Identifier" && state && state.concatAliases && state.concatAliases.has(base.name)) {
    return true;
  }

  return false;
}

function isUnpackCallBase(base, state) {
  if (!base) {
    return false;
  }

  if (base.type === "Identifier") {
    if (base.name === "unpack") {
      return true;
    }
    if (state && state.unpackAliases && state.unpackAliases.has(base.name)) {
      return true;
    }
  }

  if (
    base.type === "IndexExpression" &&
    isIdentifier(base.base, "table") &&
    isStringLiteral(base.index, "unpack")
  ) {
    return true;
  }

  if (
    base.type === "MemberExpression" &&
    isIdentifier(base.base, "table") &&
    base.identifier &&
    base.identifier.name === "unpack"
  ) {
    return true;
  }

  return false;
}

function simplifySingleUnpackCallExpression(node, state) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return node;
  }

  if (!isUnpackCallBase(expression.base, state) || expression.arguments.length !== 1) {
    return node;
  }

  const argument = unwrapParentheses(expression.arguments[0]);
  if (!argument || argument.type !== "TableConstructorExpression") {
    return node;
  }

  if (argument.fields.length !== 1 || argument.fields[0].type !== "TableValue") {
    return node;
  }

  return argument.fields[0].value;
}

function simplifyConcatCallExpression(node, state) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return node;
  }

  const isConcatAlias =
    isConcatCallBase(expression.base, state) ||
    (expression.base.type === "Identifier" && expression.base.name === "N");

  if (expression.arguments.length !== 1) {
    return node;
  }

  const argument = unwrapParentheses(expression.arguments[0]);
  if (!argument || argument.type !== "TableConstructorExpression") {
    return node;
  }

  if (argument.fields.length !== 1 || argument.fields[0].type !== "TableValue") {
    return node;
  }

  if (!isConcatAlias) {
    return node;
  }

  return argument.fields[0].value;
}

function replaceHttpGetArgument(node, state) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return node;
  }

  const base = expression.base;
  if (!base || base.type !== "MemberExpression" || base.identifier.name !== "HttpGet") {
    return node;
  }

  if (expression.arguments.length < 1 || expression.arguments[0].type === "StringLiteral") {
    return node;
  }

  const resolved = resolveHttpGetArgumentValue(expression.arguments[0], state);
  if (resolved) {
    if (state && !state.loaderUrl) {
      state.loaderUrl = resolved;
    }
    return {
      ...expression,
      arguments: [createStringLiteral(resolved), ...expression.arguments.slice(1)],
    };
  }

  if (
    state &&
    typeof state.loaderUrl === "string" &&
    isLikelyLoaderUrl(state.loaderUrl)
  ) {
    const arg = unwrapParentheses(expression.arguments[0]);
    const looksLikeObfuscatedLookup =
      (arg && arg.type === "IndexExpression") ||
      (arg && arg.type === "MemberExpression") ||
      (arg && arg.type === "Identifier");

    if (looksLikeObfuscatedLookup) {
      return {
        ...expression,
        arguments: [createStringLiteral(state.loaderUrl), ...expression.arguments.slice(1)],
      };
    }
  }

  return node;
}

function rewriteHttpGetInConcatCall(node, state) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return node;
  }

  const isConcatAlias =
    isConcatCallBase(expression.base, state) ||
    (expression.base.type === "Identifier" && expression.base.name === "N");

  if (!isConcatAlias || expression.arguments.length !== 1) {
    return node;
  }

  const argument = unwrapParentheses(expression.arguments[0]);
  if (!argument || argument.type !== "TableConstructorExpression") {
    return node;
  }

  if (argument.fields.length !== 1 || argument.fields[0].type !== "TableValue") {
    return node;
  }

  const value = argument.fields[0].value;
  const rewrittenValue = replaceHttpGetArgument(value, state);
  if (rewrittenValue === value) {
    return node;
  }

  return {
    ...expression,
    arguments: [
      {
        ...argument,
        fields: [
          {
            ...argument.fields[0],
            value: rewrittenValue,
          },
        ],
      },
    ],
  };
}

function simplifyLoadstringArgument(argument, state) {
  const unpackCollapsed = simplifySingleUnpackCallExpression(argument, state);
  const collapsed = simplifyConcatCallExpression(unpackCollapsed, state);
  const replaced = replaceHttpGetArgument(collapsed, state);
  if (replaced !== collapsed) {
    return simplifySingleUnpackCallExpression(replaced, state);
  }

  if (collapsed !== unpackCollapsed || unpackCollapsed !== argument) {
    return simplifySingleUnpackCallExpression(collapsed, state);
  }

  const rewritten = rewriteHttpGetInConcatCall(argument, state);
  if (rewritten !== argument) {
    return simplifySingleUnpackCallExpression(rewritten, state);
  }

  const deepRewritten = transformNode(argument, (node) => replaceHttpGetArgument(node, state));
  if (deepRewritten !== argument) {
    return simplifySingleUnpackCallExpression(deepRewritten, state);
  }

  return argument;
}

function containsIdentifier(node, name) {
  let found = false;
  walk(node, (child) => {
    if (found) {
      return;
    }
    if (child.type === "Identifier" && child.name === name) {
      found = true;
    }
  });
  return found;
}

function identifierUsedAfter(statements, startIndex, name) {
  for (let index = startIndex; index < statements.length; index += 1) {
    const statement = statements[index];
    if (!statement || typeof statement !== "object") {
      continue;
    }

    if (statement.type === "LocalStatement") {
      const defines = statement.variables.some((variable) => isIdentifier(variable, name));
      if (defines) {
        if (statement.init.some((expr) => statementReferencesIdentifier(expr, name))) {
          return true;
        }
        return false;
      }
    }

    if (statement.type === "FunctionDeclaration" && statement.isLocal && statement.identifier && statement.identifier.name === name) {
      return false;
    }

    if (statement.type === "ForNumericStatement" && isIdentifier(statement.variable, name)) {
      if (
        statementReferencesIdentifier(statement.start, name) ||
        statementReferencesIdentifier(statement.end, name) ||
        (statement.step && statementReferencesIdentifier(statement.step, name))
      ) {
        return true;
      }
      continue;
    }

    if (statement.type === "ForGenericStatement" && statement.variables.some((variable) => isIdentifier(variable, name))) {
      if (statement.iterators.some((iterator) => statementReferencesIdentifier(iterator, name))) {
        return true;
      }
      continue;
    }

    if (statementReferencesIdentifier(statement, name)) {
      return true;
    }
  }
  return false;
}

function getSingleLocalAssignment(statement) {
  if (
    !statement ||
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    !isIdentifier(statement.variables[0])
  ) {
    return null;
  }

  return {
    name: statement.variables[0].name,
    init: statement.init[0],
  };
}

function getLoadstringLocalAssignment(statement) {
  const local = getSingleLocalAssignment(statement);
  if (!local) {
    return null;
  }

  const init = unwrapParentheses(local.init);
  if (!isLoadstringCallExpression(init)) {
    return null;
  }

  return {
    name: local.name,
    call: init,
  };
}

function isCallStatementOfIdentifier(statement, name) {
  if (!statement || statement.type !== "CallStatement") {
    return false;
  }

  const expression = statement.expression;
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }

  return expression.base.type === "Identifier" && expression.base.name === name && expression.arguments.length === 0;
}

function getCallLocalAssignmentOfIdentifier(statement, name) {
  if (
    !statement ||
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    !isIdentifier(statement.variables[0])
  ) {
    return null;
  }

  const init = unwrapParentheses(statement.init[0]);
  if (!init || init.type !== "CallExpression") {
    return null;
  }

  if (init.base.type !== "Identifier" || init.base.name !== name) {
    return null;
  }

  return {
    name: statement.variables[0].name,
    call: init,
  };
}

function getStringLiteralLocalAssignment(statement) {
  const local = getSingleLocalAssignment(statement);
  if (!local) {
    return null;
  }

  const init = unwrapParentheses(local.init);
  if (!isStringLiteral(init) || typeof init.value !== "string") {
    return null;
  }

  return {
    name: local.name,
    value: init.value,
  };
}

function isLoadstringHttpGetCallStatementWithLiteral(statement, literal) {
  if (!statement || statement.type !== "CallStatement") {
    return false;
  }

  const outer = unwrapParentheses(statement.expression);
  if (!outer || outer.type !== "CallExpression" || outer.arguments.length !== 0) {
    return false;
  }

  const inner = unwrapParentheses(outer.base);
  if (!isLoadstringCallExpression(inner) || inner.arguments.length < 1) {
    return false;
  }

  const httpGetCall = unwrapParentheses(inner.arguments[0]);
  if (
    !httpGetCall ||
    httpGetCall.type !== "CallExpression" ||
    !httpGetCall.base ||
    httpGetCall.base.type !== "MemberExpression" ||
    httpGetCall.base.identifier.name !== "HttpGet" ||
    httpGetCall.arguments.length < 1
  ) {
    return false;
  }

  const arg = unwrapParentheses(httpGetCall.arguments[0]);
  return isStringLiteral(arg, literal);
}

function extractLoadstringHttpGetLiteral(statement) {
  if (!statement || statement.type !== "CallStatement") {
    return null;
  }

  const outer = unwrapParentheses(statement.expression);
  if (!outer || outer.type !== "CallExpression" || outer.arguments.length !== 0) {
    return null;
  }

  const inner = unwrapParentheses(outer.base);
  if (!isLoadstringCallExpression(inner) || inner.arguments.length < 1) {
    return null;
  }

  const httpGetCall = unwrapParentheses(inner.arguments[0]);
  if (
    !httpGetCall ||
    httpGetCall.type !== "CallExpression" ||
    !httpGetCall.base ||
    httpGetCall.base.type !== "MemberExpression" ||
    httpGetCall.base.identifier.name !== "HttpGet" ||
    httpGetCall.arguments.length < 1
  ) {
    return null;
  }

  const arg = unwrapParentheses(httpGetCall.arguments[0]);
  if (!isStringLiteral(arg) || typeof arg.value !== "string") {
    return null;
  }

  return arg.value;
}

function removeRedundantLoaderUrlLocals(statements) {
  const output = [];

  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index];
    const next = statements[index + 1];
    const localUrl = getStringLiteralLocalAssignment(current);
    const nextLoaderUrl = extractLoadstringHttpGetLiteral(next);

    if (
      localUrl &&
      nextLoaderUrl &&
      localUrl.value === nextLoaderUrl &&
      !identifierUsedAfter(statements, index + 2, localUrl.name)
    ) {
      output.push(removeRedundantLoaderUrlLocals([next])[0]);
      index += 1;
      continue;
    }

    if (current.type === "IfStatement") {
      output.push({
        ...current,
        clauses: current.clauses.map((clause) => ({
          ...clause,
          body: removeRedundantLoaderUrlLocals(clause.body || []),
        })),
      });
      continue;
    }

    if (current.type === "WhileStatement" || current.type === "RepeatStatement" || current.type === "DoStatement") {
      output.push({
        ...current,
        body: removeRedundantLoaderUrlLocals(current.body || []),
      });
      continue;
    }

    if (current.type === "FunctionDeclaration") {
      output.push({
        ...current,
        body: removeRedundantLoaderUrlLocals(current.body || []),
      });
      continue;
    }

    output.push(current);
  }

  return output;
}

function simplifyLoadstringExpression(node, state) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (node.type === "CallExpression" && isLoadstringCallExpression(node)) {
    if (node.arguments.length === 0) {
      return node;
    }

    const nextArg = simplifyLoadstringArgument(node.arguments[0], state);
    if (nextArg === node.arguments[0]) {
      return node;
    }

    return {
      ...node,
      arguments: [nextArg, ...node.arguments.slice(1)],
    };
  }

  return node;
}

function rewriteStatementForLoadstring(statement, state) {
  if (statement.type === "IfStatement") {
    const nextClauses = statement.clauses.map((clause) => ({
      ...clause,
      body: simplifyLoadstringChains(clause.body || [], state),
    }));
    return transformNode({ ...statement, clauses: nextClauses }, (node) => simplifyLoadstringExpression(node, state));
  }

  if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
    const nextStatement = {
      ...statement,
      body: simplifyLoadstringChains(statement.body, state),
    };
    return transformNode(nextStatement, (node) => simplifyLoadstringExpression(node, state));
  }

  if (statement.type === "FunctionDeclaration") {
    const nextStatement = {
      ...statement,
      body: simplifyLoadstringChains(statement.body, state),
    };
    return transformNode(nextStatement, (node) => simplifyLoadstringExpression(node, state));
  }

  return transformNode(statement, (node) => simplifyLoadstringExpression(node, state));
}

function unwrapUnpackWrapper(node) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return node;
  }

  if (expression.arguments.length !== 1) {
    return node;
  }

  const argument = unwrapParentheses(expression.arguments[0]);
  if (!argument || argument.type !== "TableConstructorExpression") {
    return node;
  }

  if (argument.fields.length !== 1 || argument.fields[0].type !== "TableValue") {
    return node;
  }

  return argument.fields[0].value;
}

function dryRunReplaceHttpGetArgument(node, state) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return node;
  }

  const base = expression.base;
  if (!base || base.type !== "MemberExpression" || !base.identifier || base.identifier.name !== "HttpGet") {
    return node;
  }

  if (expression.arguments.length < 1 || expression.arguments[0].type === "StringLiteral") {
    return node;
  }

  if (state && typeof state.loaderUrl === "string") {
    const arg = unwrapParentheses(expression.arguments[0]);
    if (arg && (arg.type === "IndexExpression" || arg.type === "MemberExpression" || arg.type === "Identifier")) {
      return {
        ...expression,
        arguments: [
          {
            type: "StringLiteral",
            value: state.loaderUrl,
            raw: JSON.stringify(state.loaderUrl),
          },
          ...expression.arguments.slice(1),
        ],
      };
    }
  }

  return node;
}

function simplifyLoadstringChains(statements, state) {
  if (state) {
    const localCandidate = chooseLoaderUrl(collectUrlCandidates({
      type: "Chunk",
      body: statements,
      comments: [],
    }));
    if (shouldUpgradeLoaderUrl(state.loaderUrl, localCandidate)) {
      state.loaderUrl = localCandidate;
    }
  }

  const output = [];

  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index];
    const next = statements[index + 1];
    const third = statements[index + 2];

    const localUrl = getStringLiteralLocalAssignment(current);
    if (
      localUrl &&
      isLoadstringHttpGetCallStatementWithLiteral(next, localUrl.value) &&
      !identifierUsedAfter(statements, index + 2, localUrl.name)
    ) {
      output.push(rewriteStatementForLoadstring(next, state));
      index += 1;
      continue;
    }

    const localValue = getSingleLocalAssignment(current);
    const localLoadstring = getLoadstringLocalAssignment(next);
    if (localValue && localLoadstring) {
      const localCallAssign = getCallLocalAssignmentOfIdentifier(third, localLoadstring.name);
      const isDirectCall = isCallStatementOfIdentifier(third, localLoadstring.name);
      if (
        (localCallAssign || isDirectCall) &&
        !identifierUsedAfter(statements, index + 3, localValue.name) &&
        !identifierUsedAfter(statements, index + 3, localLoadstring.name)
      ) {
        let loadArg = localLoadstring.call.arguments[0];
        const usesLocalValue = loadArg && containsIdentifier(loadArg, localValue.name);
        if (usesLocalValue) {
          loadArg = transformNode(loadArg, (node) => {
            if (node.type === "Identifier" && node.name === localValue.name) {
              return clone(localValue.init);
            }
            return node;
          });
        } else if (!isPureExpression(localValue.init)) {
          output.push(rewriteStatementForLoadstring(current, state));
          continue;
        }

        if (loadArg) {
          loadArg = simplifyLoadstringArgument(loadArg, state);
        }

        const innerCall = {
          type: "CallExpression",
          base: { type: "Identifier", name: "loadstring" },
          arguments: loadArg ? [loadArg] : [],
        };

        if (localCallAssign) {
          output.push({
            type: "LocalStatement",
            variables: [{ type: "Identifier", name: localCallAssign.name }],
            init: [
              {
                type: "CallExpression",
                base: innerCall,
                arguments: localCallAssign.call.arguments || [],
              },
            ],
          });
        } else {
          output.push({
            type: "CallStatement",
            expression: {
              type: "CallExpression",
              base: innerCall,
              arguments: [],
            },
          });
        }
        index += 2;
        continue;
      }
    }

    const standaloneLoadstring = getLoadstringLocalAssignment(current);
    if (standaloneLoadstring) {
      const localCallAssign = getCallLocalAssignmentOfIdentifier(next, standaloneLoadstring.name);
      if (localCallAssign) {
        let loadArg = standaloneLoadstring.call.arguments[0];
        if (loadArg) {
          loadArg = simplifyLoadstringArgument(loadArg, state);
        }

        const innerCall = {
          type: "CallExpression",
          base: { type: "Identifier", name: "loadstring" },
          arguments: loadArg ? [loadArg] : [],
        };

        output.push({
          type: "LocalStatement",
          variables: [{ type: "Identifier", name: localCallAssign.name }],
          init: [
            {
              type: "CallExpression",
              base: innerCall,
              arguments: localCallAssign.call.arguments || [],
            },
          ],
        });
        index += 1;
        continue;
      }
    }

    if (standaloneLoadstring && isCallStatementOfIdentifier(next, standaloneLoadstring.name)) {
      let loadArg = standaloneLoadstring.call.arguments[0];
      if (loadArg) {
        loadArg = simplifyLoadstringArgument(loadArg, state);
      }

      const innerCall = {
        type: "CallExpression",
        base: { type: "Identifier", name: "loadstring" },
        arguments: loadArg ? [loadArg] : [],
      };
      output.push({
        type: "CallStatement",
        expression: {
          type: "CallExpression",
          base: innerCall,
          arguments: [],
        },
      });
      index += 1;
      continue;
    }

    if (
      current.type === "CallStatement" &&
      current.expression &&
      current.expression.type === "CallExpression"
    ) {
      let loadstringCall = null;
      if (isLoadstringCallExpression(current.expression)) {
        loadstringCall = current.expression;
      } else if (
        current.expression.base &&
        isLoadstringCallExpression(current.expression.base)
      ) {
        loadstringCall = current.expression.base;
      }

      if (loadstringCall && loadstringCall.arguments.length >= 1) {
        let loadArg = loadstringCall.arguments[0];

        const unwrapped = unwrapUnpackWrapper(loadArg);
        if (unwrapped !== loadArg) {
          loadArg = unwrapped;
        }

        const prev = loadArg;
        loadArg = simplifyLoadstringArgument(loadArg, state);
        if (loadArg === prev) {
          loadArg = dryRunReplaceHttpGetArgument(loadArg, state);
        }

        if (loadArg !== prev) {
          const updatedCall = {
            ...loadstringCall,
            arguments: [loadArg, ...loadstringCall.arguments.slice(1)],
          };
          if (isLoadstringCallExpression(current.expression)) {
            output.push({
              ...current,
              expression: updatedCall,
            });
          } else {
            output.push({
              ...current,
              expression: {
                ...current.expression,
                base: updatedCall,
              },
            });
          }
          continue;
        }
      }
    }

    if (
      current.type === "IfStatement" ||
      current.type === "WhileStatement" ||
      current.type === "RepeatStatement" ||
      current.type === "DoStatement" ||
      current.type === "FunctionDeclaration"
    ) {
      const recurseIntoBlock = (body) => simplifyLoadstringChains(body, state);
      output.push(rewriteLoadstringChainsRecursive(current, recurseIntoBlock));
      continue;
    }

    output.push(rewriteStatementForLoadstring(current, state));
  }

  return output;
}

function rewriteLoadstringChainsRecursive(statement, recurseFn) {
  if (!statement || typeof statement !== "object") {
    return statement;
  }

  switch (statement.type) {
    case "IfStatement":
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: recurseFn(clause.body || []),
        })),
      };
    case "WhileStatement":
      return {
        ...statement,
        body: recurseFn(statement.body || []),
      };
    case "RepeatStatement":
      return {
        ...statement,
        body: recurseFn(statement.body || []),
      };
    case "DoStatement":
      return {
        ...statement,
        body: recurseFn(statement.body || []),
      };
    case "FunctionDeclaration":
      return {
        ...statement,
        body: recurseFn(statement.body || []),
      };
    default:
      return statement;
  }
}

function removeIfTrueWrappers(statements) {
  const result = [];
  for (const stmt of statements) {
    if (stmt.type === "IfStatement" && stmt.clauses.length === 1 && stmt.clauses[0].type === "IfClause") {
      const clause = stmt.clauses[0];
      if (clause.condition.type === "BooleanLiteral" && clause.condition.value === true) {
        result.push(...removeIfTrueWrappers(clause.body));
        continue;
      }
    }

    if (stmt.type === "IfStatement") {
      stmt.clauses.forEach(c => {
        c.body = removeIfTrueWrappers(c.body);
      });
    } else if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement" || stmt.type === "FunctionDeclaration") {
      stmt.body = removeIfTrueWrappers(stmt.body);
    }

    result.push(stmt);
  }
  return result;
}

function sanitizeNestedFunctionBodies(node) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => sanitizeNestedFunctionBodies(child));
  }

  if (node.type === "FunctionDeclaration") {
    return {
      ...node,
      body: dropBareAnonymousFunctionStatements(node.body),
    };
  }

  const next = { ...node };
  let changed = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "scope") {
      continue;
    }
    const nextValue = sanitizeNestedFunctionBodies(value);
    if (nextValue !== value) {
      next[key] = nextValue;
      changed = true;
    }
  }

  return changed ? next : node;
}

function dropBareAnonymousFunctionStatements(statements) {
  const output = [];

  for (const statement of statements) {
    if (statement.type === "CallStatement" && statement.expression && statement.expression.type === "FunctionDeclaration") {
      continue;
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: sanitizeNestedFunctionBodies(clause.condition),
          body: dropBareAnonymousFunctionStatements(clause.body || []),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      output.push({
        ...sanitizeNestedFunctionBodies(statement),
        body: dropBareAnonymousFunctionStatements(statement.body),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...sanitizeNestedFunctionBodies(statement),
        body: dropBareAnonymousFunctionStatements(statement.body),
      });
      continue;
    }

    output.push(sanitizeNestedFunctionBodies(statement));
  }

  return output;
}

function getExpressionRoot(node) {
  let current = unwrapParentheses(node);
  while (current) {
    if (current.type === "MemberExpression" || current.type === "IndexExpression") {
      current = unwrapParentheses(current.base);
      continue;
    }
    if (current.type === "CallExpression" || current.type === "TableCallExpression" || current.type === "StringCallExpression") {
      current = unwrapParentheses(current.base);
      continue;
    }
    return current;
  }
  return null;
}

function isStringRootedExpression(node) {
  const root = getExpressionRoot(node);
  return root && root.type === "StringLiteral";
}

function dropStringRootedCallStatements(statements) {
  const output = [];

  for (const statement of statements) {
    if (
      statement &&
      statement.type === "CallStatement" &&
      statement.expression &&
      isStringRootedExpression(statement.expression)
    ) {
      continue;
    }

    if (statement && statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: dropStringRootedCallStatements(clause.body || []),
        })),
      });
      continue;
    }

    if (statement && (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement")) {
      output.push({
        ...statement,
        body: dropStringRootedCallStatements(statement.body),
      });
      continue;
    }

    if (statement && statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: dropStringRootedCallStatements(statement.body),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function removeUnusedPureLocals(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return statements;
  }

  const recurseStatement = (statement) => {
    if (!statement || typeof statement !== "object") {
      return statement;
    }

    if (statement.type === "IfStatement") {
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: removeUnusedPureLocals(clause.body || []),
        })),
      };
    }

    if (statement.type === "WhileStatement") {
      return {
        ...statement,
        body: removeUnusedPureLocals(statement.body || []),
      };
    }

    if (statement.type === "RepeatStatement") {
      return {
        ...statement,
        body: removeUnusedPureLocals(statement.body || []),
      };
    }

    if (statement.type === "DoStatement") {
      return {
        ...statement,
        body: removeUnusedPureLocals(statement.body || []),
      };
    }

    if (statement.type === "FunctionDeclaration") {
      return {
        ...statement,
        body: removeUnusedPureLocals(statement.body || []),
      };
    }

    return statement;
  };

  const rewritten = statements.map(recurseStatement);
  const { usage } = buildUsageMap(rewritten);
  const deadLocals = new Set();

  for (const statement of rewritten) {
    if (statement.type !== "LocalStatement" || !Array.isArray(statement.variables)) {
      continue;
    }

    for (let index = 0; index < statement.variables.length; index += 1) {
      const variable = statement.variables[index];
      if (!variable || variable.type !== "Identifier") {
        continue;
      }

      const usedCount = usage.get(variable.name) || 0;
      if (usedCount !== 0) {
        continue;
      }

      const initializer = statement.init[index];
      if (initializer && !isPureExpression(initializer)) {
        continue;
      }

      deadLocals.add(variable.name);
    }
  }

  if (deadLocals.size === 0) {
    return rewritten;
  }

  const output = [];
  for (const statement of rewritten) {
    if (statement.type === "LocalStatement") {
      const keptVariables = [];
      const keptInit = [];

      for (let index = 0; index < statement.variables.length; index += 1) {
        const variable = statement.variables[index];
        const initializer = statement.init[index];
        if (variable && variable.type === "Identifier" && deadLocals.has(variable.name)) {
          continue;
        }
        keptVariables.push(variable);
        if (index < statement.init.length) {
          keptInit.push(initializer);
        }
      }

      if (keptVariables.length === 0) {
        continue;
      }

      output.push({
        ...statement,
        variables: keptVariables,
        init: keptInit,
      });
      continue;
    }

    if (
      statement.type === "AssignmentStatement" &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      isIdentifier(statement.variables[0]) &&
      deadLocals.has(statement.variables[0].name) &&
      isPureExpression(statement.init[0])
    ) {
      continue;
    }

    output.push(statement);
  }

  return output;
}

function isObfuscatedGlobalAliasName(name) {
  return (
    typeof name === "string" &&
    /^(?:v|var|arg)_?\d+$/i.test(name)
  );
}

function removeObfuscatedGlobalAliasAssignments(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return statements;
  }

  const recurseStatement = (statement) => {
    if (!statement || typeof statement !== "object") {
      return statement;
    }

    if (statement.type === "IfStatement") {
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: removeObfuscatedGlobalAliasAssignments(clause.body || []),
        })),
      };
    }

    if (statement.type === "WhileStatement") {
      return {
        ...statement,
        body: removeObfuscatedGlobalAliasAssignments(statement.body || []),
      };
    }

    if (statement.type === "RepeatStatement") {
      return {
        ...statement,
        body: removeObfuscatedGlobalAliasAssignments(statement.body || []),
      };
    }

    if (statement.type === "DoStatement") {
      return {
        ...statement,
        body: removeObfuscatedGlobalAliasAssignments(statement.body || []),
      };
    }

    if (statement.type === "FunctionDeclaration") {
      return {
        ...statement,
        body: removeObfuscatedGlobalAliasAssignments(statement.body || []),
      };
    }

    return statement;
  };

  const rewritten = statements.map(recurseStatement);
  const { usage } = buildUsageMap(rewritten);

  return rewritten.filter((statement) => {
    if (
      statement &&
      statement.type === "AssignmentStatement" &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      isIdentifier(statement.variables[0]) &&
      isIdentifier(statement.init[0])
    ) {
      const targetName = statement.variables[0].name;
      const useCount = usage.get(targetName) || 0;
      if (useCount === 0 && isObfuscatedGlobalAliasName(targetName)) {
        return false;
      }
    }
    return true;
  });
}

function isNoopSetmetatableCallExpression(node) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }

  const base = unwrapParentheses(expression.base);
  if (!base || base.type !== "Identifier" || base.name !== "setmetatable") {
    return false;
  }

  if (!Array.isArray(expression.arguments) || expression.arguments.length < 2) {
    return false;
  }

  const [firstArg, secondArg] = expression.arguments;
  const tableNode = unwrapParentheses(firstArg);
  const metatableNode = unwrapParentheses(secondArg);

  if (!tableNode || tableNode.type !== "TableConstructorExpression") {
    return false;
  }

  if (!metatableNode || metatableNode.type !== "TableConstructorExpression") {
    return false;
  }

  return true;
}

function removeNoopSetmetatableCalls(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return statements;
  }

  const output = [];
  for (const statement of statements) {
    if (!statement || typeof statement !== "object") {
      continue;
    }

    if (
      statement.type === "CallStatement" &&
      statement.expression &&
      isNoopSetmetatableCallExpression(statement.expression)
    ) {
      continue;
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: removeNoopSetmetatableCalls(clause.body || []),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement") {
      output.push({
        ...statement,
        body: removeNoopSetmetatableCalls(statement.body || []),
      });
      continue;
    }

    if (statement.type === "RepeatStatement") {
      output.push({
        ...statement,
        body: removeNoopSetmetatableCalls(statement.body || []),
      });
      continue;
    }

    if (statement.type === "DoStatement") {
      output.push({
        ...statement,
        body: removeNoopSetmetatableCalls(statement.body || []),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: removeNoopSetmetatableCalls(statement.body || []),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function collectStringAliases(statements, aliases = new Map()) {
  for (const statement of statements) {
    if (!statement || typeof statement !== "object") continue;

    if (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") {
      for (let i = 0; i < Math.min(statement.variables.length, statement.init.length); i++) {
        const variable = statement.variables[i];
        const init = statement.init[i];
        if (variable && variable.type === "Identifier" && init) {
          const unwrapped = unwrapParentheses(init);
          if (unwrapped && unwrapped.type === "StringLiteral" && typeof unwrapped.value === "string") {
            aliases.set(variable.name, unwrapped.value);
          } else if (unwrapped && unwrapped.type === "Identifier" && aliases.has(unwrapped.name)) {
            aliases.set(variable.name, aliases.get(unwrapped.name));
          }
        }
      }
    }

    if (statement.type === "IfStatement") {
      statement.clauses.forEach((clause) => collectStringAliases(clause.body || [], aliases));
    } else if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      collectStringAliases(statement.body, aliases);
    } else if (statement.type === "FunctionDeclaration") {
      const funcAliases = new Map(aliases);
      if (Array.isArray(statement.parameters)) {
        statement.parameters.forEach((p) => {
          if (p && p.type === "Identifier") funcAliases.delete(p.name);
        });
      }
      collectStringAliases(statement.body, funcAliases);
    }
  }
  return aliases;
}

function isDecoderCall(node, decoderNames) {
  if (!node || node.type !== "CallExpression") return false;
  const base = node.base;
  if (base && base.type === "Identifier" && decoderNames.has(base.name)) return true;
  if (base && base.type === "MemberExpression" && base.identifier && decoderNames.has(base.identifier.name)) return true;
  return false;
}

function tryDecodeCall(node, state) {
  if (!node || node.type !== "CallExpression") return null;
  const base = node.base;
  if (!base) return null;

  const callBaseName = (base.type === "Identifier") ? base.name :
                       (base.type === "MemberExpression" && base.identifier) ? base.identifier.name : null;
  if (!callBaseName) return null;

  if (state.encryptParams && state.secretKey8 !== null && node.arguments && node.arguments.length >= 2) {
    const encoded = node.arguments[0];
    const seed = node.arguments[1];
    if (encoded && encoded.type === "StringLiteral" && seed && seed.type === "NumericLiteral") {
      const decoded = decodePrometheusString(encoded.value, seed.value, state.encryptParams, state.secretKey8);
      if (typeof decoded === "string" && decoded.length > 0 && /^[\x20-\x7e]+$/.test(decoded)) {
        return decoded;
      }
    }
  }

  if (state.decodedStringMap && node.arguments && node.arguments.length >= 2) {
    const encoded = node.arguments[0];
    if (encoded && encoded.type === "StringLiteral") {
      const cached = state.decodedStringMap.get(encoded.value);
      if (cached) return cached;
    }
  }

  return null;
}

function collectDecoderNames(statements) {
  const decoderNames = new Set();

  const analyzeFunctionBody = (body) => {
    if (!body || !Array.isArray(body) || body.length === 0) {
      return {
        isDecoder: false,
      };
    }

    const payloadSignals = collectPayloadSignals(body);
    if (payloadSignals.hit && payloadSignals.score >= 4) {
      return {
        isDecoder: false,
      };
    }

    const metrics = {
      callCount: 0,
      hasConcat: false,
      hasGetService: false,
      hasInstanceNew: false,
      hasModulo: false,
      hasStringByte: false,
      hasStringChar: false,
      hasStringLen: false,
      hasStringSub: false,
      hasWaitForChild: false,
      hasXor: false,
      nodeCount: 0,
    };

    const visit = (node, skipNestedFunctions = false) => {
      if (!node || typeof node !== "object") {
        return;
      }

      if (Array.isArray(node)) {
        node.forEach((child) => visit(child, skipNestedFunctions));
        return;
      }

      if (typeof node.type === "string") {
        metrics.nodeCount += 1;
      }

      if (skipNestedFunctions && node.type === "FunctionDeclaration") {
        return;
      }

      if ((node.type === "BinaryExpression" || node.type === "LogicalExpression") && node.operator === "..") {
        metrics.hasConcat = true;
      }

      if (node.type === "BinaryExpression" && node.operator === "%") {
        metrics.hasModulo = true;
      }

      if (node.type === "BinaryExpression" && (node.operator === "~" || node.operator === "bxor")) {
        metrics.hasXor = true;
      }

      if (
        node.type === "CallExpression" ||
        node.type === "StringCallExpression" ||
        node.type === "TableCallExpression"
      ) {
        metrics.callCount += 1;
        const base = unwrapParentheses(node.base);

        if (base && base.type === "MemberExpression" && base.identifier) {
          const memberName = base.identifier.name;
          if (isIdentifier(base.base, "string")) {
            if (memberName === "byte") metrics.hasStringByte = true;
            if (memberName === "char") metrics.hasStringChar = true;
            if (memberName === "len") metrics.hasStringLen = true;
            if (memberName === "sub") metrics.hasStringSub = true;
          }

          if (isIdentifier(base.base, "Instance") && memberName === "new") {
            metrics.hasInstanceNew = true;
          }

          if (isIdentifier(base.base, "game") && memberName === "GetService") {
            metrics.hasGetService = true;
          }

          if (memberName === "WaitForChild") {
            metrics.hasWaitForChild = true;
          }
        }
      }

      for (const [key, value] of Object.entries(node)) {
        if (key === "scope") {
          continue;
        }

        if (node.type === "FunctionDeclaration" && key === "body") {
          visit(value, true);
          continue;
        }

        visit(value, skipNestedFunctions);
      }
    };

    body.forEach((statement) => visit(statement));

    const hasStringOps =
      metrics.hasStringByte ||
      metrics.hasStringChar ||
      metrics.hasStringLen ||
      metrics.hasStringSub;
    const looksCryptoLike =
      (metrics.hasModulo && (hasStringOps || metrics.hasConcat || metrics.hasXor)) ||
      (metrics.hasXor && (hasStringOps || metrics.hasConcat));
    const looksLikePayloadShell =
      metrics.hasInstanceNew ||
      metrics.hasGetService ||
      metrics.hasWaitForChild;
    const tooLarge = body.length > 24 || metrics.nodeCount > 220 || metrics.callCount > 48;

    return {
      isDecoder: looksCryptoLike && !looksLikePayloadShell && !tooLarge,
    };
  };

  const checkFunctionBody = (body) => {
    return analyzeFunctionBody(body).isDecoder;
  };

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    if (node.type === "LocalStatement" || node.type === "AssignmentStatement") {
      for (let i = 0; i < Math.min(node.variables.length, node.init.length); i++) {
        const v = node.variables[i];
        const init = node.init[i];
        if (v && v.type === "Identifier" && init && init.type === "FunctionDeclaration") {
          if (checkFunctionBody(init.body)) {
            decoderNames.add(v.name);
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") continue;
      walk(value);
    }
  };
  statements.forEach(walk);
  return decoderNames;
}

function collectDecodedAliases(statements, state) {
  const aliases = new Map();
  const decoderNames = collectDecoderNames(statements);

  const processBlock = (stmts, localAliases) => {
    const merged = new Map(aliases);
    localAliases.forEach((v, k) => merged.set(k, v));

    for (const statement of stmts) {
      if (!statement || typeof statement !== "object") continue;

      if (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") {
        for (let i = 0; i < Math.min(statement.variables.length, statement.init.length); i++) {
          const variable = statement.variables[i];
          const init = statement.init[i];
          if (variable && variable.type === "Identifier" && init) {
            const unwrapped = unwrapParentheses(init);
            if (unwrapped && unwrapped.type === "StringLiteral" && typeof unwrapped.value === "string") {
              merged.set(variable.name, unwrapped.value);
            } else if (unwrapped && unwrapped.type === "Identifier" && merged.has(unwrapped.name)) {
              merged.set(variable.name, merged.get(unwrapped.name));
            } else if (unwrapped && unwrapped.type === "CallExpression") {
              const decoded = tryDecodeCall(unwrapped, state);
              if (decoded) {
                merged.set(variable.name, decoded);
              } else if (unwrapped.base && unwrapped.base.type === "Identifier" && merged.has(unwrapped.base.name)) {
                const baseVal = merged.get(unwrapped.base.name);
                if (typeof baseVal === "string" && unwrapped.arguments && unwrapped.arguments.length >= 1) {
                  const arg0 = unwrapped.arguments[0];
                  if (arg0 && arg0.type === "StringLiteral" && state.encryptParams && state.secretKey8 !== null) {
                    const decoded2 = decodePrometheusString(arg0.value, 0, state.encryptParams, state.secretKey8);
                    if (typeof decoded2 === "string" && decoded2.length > 0 && /^[\x20-\x7e]+$/.test(decoded2)) {
                      merged.set(variable.name, decoded2);
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (statement.type === "IfStatement") {
        statement.clauses.forEach((clause) => {
          if (clause.body && clause.body.length > 0) processBlock(clause.body, new Map(merged));
        });
      } else if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement") {
        if (statement.body && statement.body.length > 0) processBlock(statement.body, new Map(merged));
      } else if (statement.type === "FunctionDeclaration") {
        const funcAliases = new Map(merged);
        if (Array.isArray(statement.parameters)) {
          statement.parameters.forEach((p) => {
            if (p && p.type === "Identifier") funcAliases.delete(p.name);
          });
        }
        if (statement.body && statement.body.length > 0) processBlock(statement.body, funcAliases);
      }
    }
  };

  processBlock(statements, new Map());
  return aliases;
}

function replaceStringAliasesInNode(node, aliases, state) {
  if (!node || typeof node !== "object") return node;

  if (Array.isArray(node)) {
    return node.map((child) => replaceStringAliasesInNode(child, aliases, state));
  }

  if (node.type === "CallExpression") {
    const decoded = tryDecodeCall(node, state);
    if (decoded) {
      return {
        type: "StringLiteral",
        value: decoded,
        raw: JSON.stringify(decoded),
        __decrypted: true,
      };
    }
  }

  const next = { ...node };
  let changed = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "scope" || key === "variables" || key === "identifier" || key === "parameters") continue;
    const nextValue = replaceStringAliasesInNode(value, aliases, state);
    if (nextValue !== value) {
      next[key] = nextValue;
      changed = true;
    }
  }
  return changed ? next : node;
}

function replaceStringAliasesInStatement(statement, aliases, state) {
  if (!statement || typeof statement !== "object") return statement;

  if (statement.type === "IfStatement") {
    return {
      ...statement,
      clauses: statement.clauses.map((clause) => ({
        ...clause,
        condition: clause.condition ? replaceStringAliasesInNode(clause.condition, aliases, state) : clause.condition,
        body: replaceStringAliasesInBlock(clause.body || [], aliases, state),
      })),
    };
  }

  if (statement.type === "WhileStatement" || statement.type === "DoStatement") {
    return {
      ...statement,
      condition: replaceStringAliasesInNode(statement.condition, aliases, state),
      body: replaceStringAliasesInBlock(statement.body, aliases, state),
    };
  }

  if (statement.type === "RepeatStatement") {
    return {
      ...statement,
      body: replaceStringAliasesInBlock(statement.body, aliases, state),
      condition: replaceStringAliasesInNode(statement.condition, aliases, state),
    };
  }

  if (statement.type === "FunctionDeclaration") {
    const funcAliases = new Map(aliases);
    if (Array.isArray(statement.parameters)) {
      statement.parameters.forEach((p) => {
        if (p && p.type === "Identifier") funcAliases.delete(p.name);
      });
    }
    return {
      ...statement,
      identifier: statement.identifier ? replaceStringAliasesInNode(statement.identifier, aliases, state) : statement.identifier,
      body: replaceStringAliasesInBlock(statement.body, funcAliases, state),
    };
  }

  return replaceStringAliasesInNode(statement, aliases, state);
}

function replaceStringAliasesInBlock(statements, aliases, state) {
  const output = [];
  for (const statement of statements) {
    const next = replaceStringAliasesInStatement(statement, aliases, state);
    output.push(next);

    if ((next.type === "LocalStatement" || next.type === "AssignmentStatement") && next.variables && next.init) {
      for (let i = 0; i < Math.min(next.variables.length, next.init.length); i++) {
        const variable = next.variables[i];
        const init = next.init[i];
        if (variable && variable.type === "Identifier" && init) {
          const unwrapped = unwrapParentheses(init);
          if (unwrapped && unwrapped.type === "StringLiteral" && typeof unwrapped.value === "string") {
            aliases.set(variable.name, unwrapped.value);
          } else if (unwrapped && unwrapped.type === "Identifier" && aliases.has(unwrapped.name)) {
            aliases.set(variable.name, aliases.get(unwrapped.name));
          } else if (unwrapped && unwrapped.type === "CallExpression") {
            const decoded = tryDecodeCall(unwrapped, state);
            if (decoded) {
              aliases.set(variable.name, decoded);
            }
          }
        }
      }
    }
  }
  return output;
}

function tryBruteForceDecode(encoded, seed, encryptParams) {
  if (!encryptParams || typeof encoded !== "string" || typeof seed !== "number") return null;

  let bestKey = null;
  let bestScore = -Infinity;
  let bestDecoded = null;

  for (let key = 0; key < 256; key++) {
    const decoded = decodePrometheusString(encoded, seed, encryptParams, key);
    if (typeof decoded !== "string" || decoded.length === 0) continue;

    let score = 0;
    const printable = (decoded.match(/[\x20-\x7e]/g) || []).length;
    const ratio = decoded.length > 0 ? printable / decoded.length : 0;

    if (ratio > 0.9) score += 80;
    else if (ratio > 0.8) score += 50;
    else if (ratio > 0.7) score += 20;
    else if (ratio < 0.3) { score -= 100; continue; }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(decoded)) score += 30;
    if (/^[a-z]+$/.test(decoded)) score += 25;
    if (/^[a-z]{1,26}$/.test(decoded)) {
      const alphabet = "abcdefghijklmnopqrstuvwxyz";
      if (alphabet.startsWith(decoded)) {
        score += 180;
      }
      if (
        decoded.length >= 2 &&
        decoded.split("").every((char, index, arr) => index === 0 || char.charCodeAt(0) === arr[index - 1].charCodeAt(0) + 1)
      ) {
        score += 60;
      }
    }
    if (METHOD_HELPERS.has(decoded)) score += 40;
    if (ROBLOX_SERVICE_NAMES.has(decoded)) score += 50;
    if (PAYLOAD_IDENTIFIERS.has(decoded)) score += 35;
    if (/^(Size|Position|Parent|Name|Visible|Active|Text|Image|Color|Background|AnchorPoint|Rotation|ZIndex|Transparency|Thickness|CornerRadius|Font|TextSize|TextWrapped|BorderColor|BorderSize|LayoutOrder|AutomaticSize|Selectable|ImageColor3|ImageTransparency|ScaleType|TileSize|ScrollBarThickness|CanvasSize|AbsoluteSize|AbsolutePosition)$/.test(decoded)) score += 40;
    if (/^(MouseButton1Click|MouseButton1Down|MouseButton2Click|MouseEnter|MouseLeave|InputBegan|InputEnded|Changed|GetPropertyChangedSignal)$/.test(decoded)) score += 35;
    if (/^(Connect|Create|Destroy|FindFirstChild|GetService|HttpGet|WaitForChild|ClearAllChildren|Clone|FindFirstAncestor|GetAttribute|SetAttribute|GetChildren|GetDescendants|IsA)$/.test(decoded)) score += 30;

    score += printable * 2;

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
      bestDecoded = decoded;
    }
  }

  if (bestScore > 10 && bestDecoded && /^[\x20-\x7e]+$/.test(bestDecoded)) {
    return bestDecoded;
  }
  return null;
}

function bruteForceAllStringLiterals(statements, encryptParams) {
  if (!encryptParams) return statements;

  const cache = new Map();

  const tryDecode = (encoded, seed) => {
    const cacheKey = `${encoded}:${seed}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    let result = null;

    if (typeof seed === "number") {
      result = tryBruteForceDecode(encoded, seed, encryptParams);
    }

    cache.set(cacheKey, result);
    return result;
  };

  const transform = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(transform);

    if (node.type === "CallExpression") {
      const base = node.base;
      const callName = (base && base.type === "Identifier") ? base.name :
                       (base && base.type === "MemberExpression" && base.identifier) ? base.identifier.name : null;

      if (node.arguments && node.arguments.length >= 2) {
        const firstArg = node.arguments[0];
        const secondArg = node.arguments[1];

        if (firstArg && firstArg.type === "StringLiteral" && secondArg && secondArg.type === "NumericLiteral") {
          const encoded = firstArg.value;
          const seed = secondArg.value;

          if (encoded.length > 0 && encoded.length < 300 && /[^\x20-\x7e]/.test(encoded)) {
            const decoded = tryDecode(encoded, seed);
            if (decoded) {
              return {
                type: "StringLiteral",
                value: decoded,
                raw: JSON.stringify(decoded),
                __decrypted: true,
              };
            }
          }
        }

        if (firstArg && firstArg.type === "StringLiteral" && secondArg && secondArg.type === "Identifier") {
          const encoded = firstArg.value;
          if (encoded.length > 0 && encoded.length < 300 && /[^\x20-\x7e]/.test(encoded)) {
            for (let testSeed = 0; testSeed < 5; testSeed++) {
              const decoded = tryDecode(encoded, testSeed);
              if (decoded) {
                return {
                  type: "StringLiteral",
                  value: decoded,
                  raw: JSON.stringify(decoded),
                  __decrypted: true,
                };
              }
            }
          }
        }
      }

      const next = { ...node };
      next.base = transform(base);
      next.arguments = node.arguments.map(transform);
      return next;
    }

    const next = { ...node };
    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") continue;
      next[key] = transform(value);
    }
    return next;
  };

  const transformStatement = (stmt) => {
    if (!stmt || typeof stmt !== "object") return stmt;

    if (stmt.type === "IfStatement") {
      return {
        ...stmt,
        clauses: stmt.clauses.map((c) => ({
          ...c,
          condition: c.condition ? transform(c.condition) : c.condition,
          body: bruteForceAllStringLiterals(c.body || [], encryptParams),
        })),
      };
    }

    if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement" || stmt.type === "FunctionDeclaration") {
      return { ...stmt, body: bruteForceAllStringLiterals(stmt.body, encryptParams) };
    }

    return transform(stmt);
  };

  return statements.map(transformStatement);
}

function inlineAllDecodedStrings(statements, state) {
  if (!state || !state.encryptParams) return statements;

  const useBruteForce = state.secretKey8 === null;
  const decoderNames = collectDecoderNames(statements);

  const tryDecode = (encoded, seed) => {
    if (!useBruteForce && state.secretKey8 !== null) {
      return decodePrometheusString(encoded, seed, state.encryptParams, state.secretKey8);
    }
    return tryBruteForceDecode(encoded, seed, state.encryptParams);
  };

  const transform = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(transform);

    if (node.type === "CallExpression") {
      const base = node.base;
      const callName = (base && base.type === "Identifier") ? base.name :
                       (base && base.type === "MemberExpression" && base.identifier) ? base.identifier.name : null;

      if (callName && decoderNames.has(callName) && node.arguments && node.arguments.length >= 2) {
        const encoded = node.arguments[0];
        const seed = node.arguments[1];
        if (encoded && encoded.type === "StringLiteral" && seed && seed.type === "NumericLiteral") {
          const decoded = tryDecode(encoded.value, seed.value);
          if (typeof decoded === "string" && decoded.length > 0 && /^[\x20-\x7e]+$/.test(decoded)) {
            return {
              type: "StringLiteral",
              value: decoded,
              raw: JSON.stringify(decoded),
              __decrypted: true,
            };
          }
        }

        if (encoded && encoded.type === "StringLiteral" && seed && seed.type === "Identifier" && state.decodedStringMap) {
          const cached = state.decodedStringMap.get(encoded.value);
          if (cached) {
            return {
              type: "StringLiteral",
              value: cached,
              raw: JSON.stringify(cached),
              __decrypted: true,
            };
          }
        }
      }

      const next = { ...node };
      next.base = transform(base);
      next.arguments = node.arguments.map(transform);
      return next;
    }

    const next = { ...node };
    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") continue;
      next[key] = transform(value);
    }
    return next;
  };

  const transformStatement = (stmt) => {
    if (!stmt || typeof stmt !== "object") return stmt;

    if (stmt.type === "IfStatement") {
      return {
        ...stmt,
        clauses: stmt.clauses.map((c) => ({
          ...c,
          condition: c.condition ? transform(c.condition) : c.condition,
          body: inlineAllDecodedStrings(c.body || [], state),
        })),
      };
    }

    if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement" || stmt.type === "FunctionDeclaration") {
      return { ...stmt, body: inlineAllDecodedStrings(stmt.body, state) };
    }

    return transform(stmt);
  };

  return statements.map(transformStatement);
}

function createDecodedStringLiteral(value, helperLookup = false) {
  const literal = {
    type: "StringLiteral",
    value,
    raw: JSON.stringify(value),
  };

  if (helperLookup) {
    literal.__helperLookup = true;
  }

  return literal;
}

function decodeMappedString(value, state) {
  if (!state || !state.decodedStringMap || !(state.decodedStringMap instanceof Map)) {
    return value;
  }

  const mapped = state.decodedStringMap.get(value);
  if (typeof mapped !== "string" || mapped.length === 0) {
    return value;
  }

  return mapped;
}

function isHelperLookupRootLiteral(node) {
  return (
    node &&
    node.type === "StringLiteral" &&
    (
      node.__helperLookup === true ||
      (
        typeof node.value === "string" &&
        /^[A-Za-z0-9_]{6,}$/.test(node.value)
      )
    )
  );
}

function rewriteDecodedStringLookups(statements, state) {
  const transform = (node) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(transform);
    }

    if (node.type === "IndexExpression") {
      const base = transform(node.base);
      const index = transform(node.index);

      if (isHelperLookupRootLiteral(base) && index && index.type === "StringLiteral") {
        const value = decodeMappedString(index.value, state);
        return createDecodedStringLiteral(value, true);
      }

      return {
        ...node,
        base,
        index,
      };
    }

    if (node.type === "MemberExpression") {
      const base = transform(node.base);
      if (isHelperLookupRootLiteral(base) && node.identifier && typeof node.identifier.name === "string") {
        return createDecodedStringLiteral(node.identifier.name, true);
      }

      return {
        ...node,
        base,
      };
    }

    if (node.type === "StringLiteral") {
      const decoded = decodeMappedString(node.value, state);
      if (decoded !== node.value) {
        return createDecodedStringLiteral(decoded, node.__helperLookup === true);
      }
      return node;
    }

    const next = { ...node };
    let changed = false;
    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") continue;
      const nextValue = transform(value);
      if (nextValue !== value) {
        next[key] = nextValue;
        changed = true;
      }
    }
    return changed ? next : node;
  };

  return statements.map((statement) => {
    if (statement.type === "IfStatement") {
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? transform(clause.condition) : clause.condition,
          body: rewriteDecodedStringLookups(clause.body || [], state),
        })),
      };
    }
    if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement" || statement.type === "FunctionDeclaration") {
      return { ...statement, body: rewriteDecodedStringLookups(statement.body, state) };
    }
    return transform(statement);
  });
}

function isDecodedLookupTableInitializer(node) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }

  const base = unwrapParentheses(expression.base);
  if (!base || base.type !== "Identifier" || base.name !== "setmetatable") {
    return false;
  }

  if (!Array.isArray(expression.arguments) || expression.arguments.length < 2) {
    return false;
  }

  const [tableArg, metaArg] = expression.arguments;
  const sourceTable = unwrapParentheses(tableArg);
  const metatable = unwrapParentheses(metaArg);

  if (!sourceTable || sourceTable.type !== "TableConstructorExpression") {
    return false;
  }

  if (!metatable || metatable.type !== "TableConstructorExpression") {
    return false;
  }

  return metatable.fields.some((field) => {
    if (!field || field.type !== "TableKeyString") {
      return false;
    }

    if (field.key && field.key.name === "__index") {
      const value = unwrapParentheses(field.value);
      return value && value.type === "TableConstructorExpression";
    }

    return false;
  });
}

function collectDecodedLookupTableNames(statements, inherited = new Set()) {
  const names = new Set(inherited);

  const visitBlock = (block) => {
    for (const statement of block) {
      if (!statement || typeof statement !== "object") {
        continue;
      }

      if (
        (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") &&
        statement.variables.length === 1 &&
        statement.init.length === 1 &&
        isIdentifier(statement.variables[0]) &&
        isDecodedLookupTableInitializer(statement.init[0])
      ) {
        names.add(statement.variables[0].name);
      }

      if (statement.type === "IfStatement") {
        statement.clauses.forEach((clause) => visitBlock(clause.body || []));
        continue;
      }

      if (
        statement.type === "WhileStatement" ||
        statement.type === "RepeatStatement" ||
        statement.type === "DoStatement" ||
        statement.type === "FunctionDeclaration"
      ) {
        visitBlock(statement.body || []);
      }
    }
  };

  visitBlock(statements || []);
  return names;
}

function rewriteDecodedNumericLookups(statements, state) {
  if (!state || !(state.decodedSeedMap instanceof Map) || state.decodedSeedMap.size === 0) {
    return statements;
  }

  const lookupTables = collectDecodedLookupTableNames(statements);
  if (lookupTables.size === 0) {
    return statements;
  }

  const transform = (node) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(transform);
    }

    if (node.type === "IndexExpression") {
      const base = transform(node.base);
      const index = transform(node.index);
      const indexValue = extractNumberValue(index);
      if (
        base &&
        base.type === "Identifier" &&
        lookupTables.has(base.name) &&
        indexValue !== null &&
        state.decodedSeedMap.has(indexValue)
      ) {
        return createDecodedStringLiteral(state.decodedSeedMap.get(indexValue), true);
      }

      return {
        ...node,
        base,
        index,
      };
    }

    const next = { ...node };
    let changed = false;
    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") continue;
      const nextValue = transform(value);
      if (nextValue !== value) {
        next[key] = nextValue;
        changed = true;
      }
    }
    return changed ? next : node;
  };

  return statements.map((statement) => {
    if (statement.type === "IfStatement") {
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? transform(clause.condition) : clause.condition,
          body: rewriteDecodedNumericLookups(clause.body || [], state),
        })),
      };
    }
    if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement" || statement.type === "FunctionDeclaration") {
      return { ...statement, body: rewriteDecodedNumericLookups(statement.body, state) };
    }
    return transform(statement);
  });
}

function propagateStringAliases(statements, state = {}) {
  const aliases = collectDecodedAliases(statements, state);
  if (aliases.size === 0) return statements;
  return replaceStringAliasesInBlock(statements, new Map(), state);
}

function convertIndexToMember(statements) {
  const transform = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(transform);

    if (node.type === "IndexExpression") {
      const base = transform(node.base);
      const index = transform(node.index);
      if (index && index.type === "StringLiteral" && typeof index.value === "string" && isValidIdentifierName(index.value)) {
        return {
          type: "MemberExpression",
          base,
          indexer: ".",
          identifier: { type: "Identifier", name: index.value },
        };
      }
      return { ...node, base, index };
    }

    const next = { ...node };
    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") continue;
      next[key] = transform(value);
    }
    return next;
  };

  return statements.map((stmt) => {
    if (stmt.type === "IfStatement") {
      return {
        ...stmt,
        clauses: stmt.clauses.map((c) => ({
          ...c,
          condition: c.condition ? transform(c.condition) : c.condition,
          body: convertIndexToMember(c.body || []),
        })),
      };
    }
    if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement" || stmt.type === "FunctionDeclaration") {
      return { ...stmt, body: convertIndexToMember(stmt.body) };
    }
    return transform(stmt);
  });
}

function removeDecoderFunctionsAndCalls(statements, state) {
  if (!state || !state.encryptParams || state.secretKey8 === null) return statements;

  const decoderNames = collectDecoderNames(statements);
  if (decoderNames.size === 0) return statements;

  const isDecoderCall = (stmt) => {
    if (!stmt || stmt.type !== "CallStatement") return false;
    const expr = stmt.expression;
    if (!expr || expr.type !== "CallExpression") return false;
    const base = expr.base;
    const name = (base && base.type === "Identifier") ? base.name :
                 (base && base.type === "MemberExpression" && base.identifier) ? base.identifier.name : null;
    return name && decoderNames.has(name);
  };

  const isDecoderLocal = (stmt) => {
    if (!stmt || stmt.type !== "LocalStatement") return false;
    if (stmt.variables.length !== 1 || stmt.init.length !== 1) return false;
    const v = stmt.variables[0];
    const init = stmt.init[0];
    if (!v || v.type !== "Identifier") return false;
    return decoderNames.has(v.name) && init && init.type === "FunctionDeclaration";
  };

  const isDecoderAliasLocal = (stmt) => {
    if (!stmt || stmt.type !== "LocalStatement") return false;
    if (stmt.variables.length !== 1 || stmt.init.length !== 1) return false;
    const v = stmt.variables[0];
    const init = stmt.init[0];
    if (!v || v.type !== "Identifier") return false;
    if (!init || init.type !== "Identifier") return false;
    return decoderNames.has(init.name);
  };

  const output = [];
  for (const stmt of statements) {
    if (isDecoderCall(stmt)) continue;
    if (isDecoderLocal(stmt)) continue;
    if (isDecoderAliasLocal(stmt)) continue;

    if (stmt.type === "IfStatement") {
      output.push({
        ...stmt,
        clauses: stmt.clauses.map((c) => ({
          ...c,
          body: removeDecoderFunctionsAndCalls(c.body || [], state),
        })),
      });
    } else if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement" || stmt.type === "FunctionDeclaration") {
      output.push({ ...stmt, body: removeDecoderFunctionsAndCalls(stmt.body, state) });
    } else {
      output.push(stmt);
    }
  }
  return output;
}

function countStatementWeight(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return 0;
  }

  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (typeof node.type === "string") {
      count += 1;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") {
        continue;
      }
      visit(value);
    }
  };

  visit(statements);
  return count;
}

function isGameGetServiceCallExpression(node, serviceName = null) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }

  const base = unwrapParentheses(expression.base);
  if (
    !base ||
    base.type !== "MemberExpression" ||
    base.indexer !== ":" ||
    !isIdentifier(base.base, "game") ||
    !isIdentifier(base.identifier, "GetService")
  ) {
    return false;
  }

  if (serviceName === null) {
    return true;
  }

  return (
    Array.isArray(expression.arguments) &&
    expression.arguments.length >= 1 &&
    isStringLiteral(unwrapParentheses(expression.arguments[0]), serviceName)
  );
}

function isCoreGuiServiceLocalStatement(statement) {
  if (
    !statement ||
    statement.type !== "LocalStatement" ||
    !Array.isArray(statement.variables) ||
    statement.variables.length !== 1 ||
    !Array.isArray(statement.init) ||
    statement.init.length !== 1
  ) {
    return false;
  }

  return isGameGetServiceCallExpression(statement.init[0], "CoreGui");
}

function countCoreGuiUiCalls(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return 0;
  }

  const uiMethods = new Set([
    "AddButton",
    "AddLabel",
    "AddList",
    "AddSlider",
    "CreateWindow",
    "Init",
  ]);

  let count = 0;
  walk({ type: "Chunk", body: statements, comments: [] }, (node) => {
    if (!node || node.type !== "CallExpression" || !node.base || node.base.type !== "MemberExpression") {
      return;
    }

    if (!node.base.identifier || !uiMethods.has(node.base.identifier.name)) {
      return;
    }

    count += 1;
  });

  return count;
}

function collectCoreGuiPayloadCandidates(statements, depth = 0, candidates = []) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return candidates;
  }

  if (statements.some((statement) => isCoreGuiServiceLocalStatement(statement))) {
    candidates.push({
      depth,
      statements,
      uiCalls: countCoreGuiUiCalls(statements),
      weight: countStatementWeight(statements),
    });
  }

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") {
      continue;
    }

    if (statement.type === "IfStatement") {
      statement.clauses.forEach((clause) => collectCoreGuiPayloadCandidates(clause.body || [], depth + 1, candidates));
      continue;
    }

    if (
      statement.type === "WhileStatement" ||
      statement.type === "RepeatStatement" ||
      statement.type === "DoStatement" ||
      statement.type === "ForNumericStatement" ||
      statement.type === "ForGenericStatement" ||
      statement.type === "FunctionDeclaration"
    ) {
      collectCoreGuiPayloadCandidates(statement.body || [], depth + 1, candidates);
    }
  }

  return candidates;
}

function maybeExtractCoreGuiPayloadBody(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return statements;
  }

  const totalWeight = countStatementWeight(statements);
  const candidates = collectCoreGuiPayloadCandidates(statements);
  if (candidates.length === 0) {
    return statements;
  }

  candidates.sort((left, right) => {
    const leftScore = (left.uiCalls * 250) + (left.depth * 60) + Math.min(left.weight, 500);
    const rightScore = (right.uiCalls * 250) + (right.depth * 60) + Math.min(right.weight, 500);
    return rightScore - leftScore;
  });

  const best = candidates[0];
  if (!best || best.statements === statements) {
    return statements;
  }

  if (best.uiCalls < 2) {
    return statements;
  }

  const minimumWeight = Math.max(25, Math.floor(totalWeight * 0.12));
  if (best.weight < minimumWeight) {
    return statements;
  }

  return best.statements;
}

function shouldKeepWeightedResult(beforeWeight, afterWeight, minimumRatio = 0.68) {
  if (!Number.isFinite(beforeWeight) || beforeWeight <= 0) {
    return true;
  }

  if (!Number.isFinite(afterWeight)) {
    return false;
  }

  return afterWeight >= Math.ceil(beforeWeight * minimumRatio);
}

function postprocessPrometheusAst(ast, options = {}) {
  const preserveScaffolding = options.preserveScaffolding === true;
  const aggressiveCleanup = options.aggressiveCleanup === true;
  const workBudget = options.workBudget && typeof options.workBudget === "object" ? options.workBudget : {};
  const payloadRetentionRatio = Number.isFinite(options.payloadRetentionRatio)
    ? Math.max(0, Math.min(1, options.payloadRetentionRatio))
    : 0.68;
  const cleanupRetentionRatio = Number.isFinite(options.cleanupRetentionRatio)
    ? Math.max(0, Math.min(1, options.cleanupRetentionRatio))
    : (aggressiveCleanup ? 0.68 : 0.9);
  const inlineOptions = {
    decisions: Array.isArray(options.inlineDecisions) ? options.inlineDecisions : null,
    localIterations: Number.isFinite(workBudget.inlineRounds)
      ? Math.max(1, Math.floor(workBudget.inlineRounds))
      : (aggressiveCleanup ? 4 : 2),
    pipelineIterations: Number.isFinite(workBudget.inlineRounds)
      ? Math.max(1, Math.floor(workBudget.inlineRounds))
      : 3,
    trace: options.traceInliner === true,
  };
  const workingAst = clone(ast);
  const shadowedGlobals = collectShadowedGlobals(workingAst);
  const shadowedIdentifiers = collectShadowedIdentifiers(workingAst);
  const encryptedCalls = collectEncryptedCalls(workingAst);
  const detectedEncryptParams = extractEncryptParams(workingAst);
  const encryptParams = detectedEncryptParams || options.encryptParams || null;
  const concatAliases = extractTableConcatAliases(workingAst);
  const loaderUrl = options.loaderUrl || null;
  const detectedLiteralBuilders = extractLiteralStringBuilderNames(workingAst);
  const detectedReorderBuilders = extractReorderStringBuilderNames(workingAst);
  const detectedStringProxies = extractStringProxyNames(workingAst);
  const capturedAliasMap = createCapturedAliasMap(options.capturedAliases || []);
  let secretKey8 = extractSecretKey8(workingAst);
  if (secretKey8 === null) {
    secretKey8 = inferSecretKey8(encryptParams, encryptedCalls);
  }
  if (secretKey8 === null && Object.prototype.hasOwnProperty.call(options, "secretKey8")) {
    secretKey8 = options.secretKey8;
  }

  const decodedStringMap = new Map();
  const decodedSeedMap = new Map();
  if (encryptParams && secretKey8 !== null) {
    for (const call of encryptedCalls) {
      if (!call || call.arguments.length !== 2) {
        continue;
      }
      const encoded = call.arguments[0];
      const seed = call.arguments[1];
      if (!isStringLiteral(encoded) || !isNumericLiteral(seed)) {
        continue;
      }
      if (decodedStringMap.has(encoded.value)) {
        continue;
      }
      const decoded = decodePrometheusString(encoded.value, seed.value, encryptParams, secretKey8);
      if (typeof decoded === "string" && decoded.length > 0 && /^[\x20-\x7e]+$/.test(decoded)) {
        decodedStringMap.set(encoded.value, decoded);
        if (!decodedSeedMap.has(seed.value)) {
          decodedSeedMap.set(seed.value, decoded);
        }
      }
    }
  }

  const state = {
    aliases: new Map(),
    capturedAliases: capturedAliasMap,
    decryptedAliases: new Map(),
    decodedSeedMap,
    decodedStringMap,
    concatAliases,
    encryptParams,
    galactic: options.galactic || extractGalacticDecoder(workingAst),
    loaderUrl,
    literalStringBuilders: new Set([...(options.literalStringBuilders || []), ...detectedLiteralBuilders]),
    reorderStringBuilders: new Set([...(options.reorderStringBuilders || []), ...detectedReorderBuilders]),
    secretKey8,
    stringProxies: new Set([...(options.stringProxies || []), ...detectedStringProxies]),
    shadowedGlobals,
    tableConstants: new Map(),
    unpackAliases: new Set([
      ...(options.unpackAliases || []),
      ...[...capturedAliasMap.entries()]
        .filter(([, replacement]) => replacement === "unpack")
        .map(([name]) => name),
    ]),
  };

  if (decodedStringMap.size > 0) {
    const decodedUrlCandidates = [];
    decodedStringMap.forEach((value) => {
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        decodedUrlCandidates.push(value);
      }
    });
    const decodedLoaderUrl = chooseLoaderUrl(decodedUrlCandidates);
    if (shouldUpgradeLoaderUrl(state.loaderUrl, decodedLoaderUrl)) {
      state.loaderUrl = decodedLoaderUrl;
    }
  }

  let extracted25msWrapper = false;

  if (!preserveScaffolding && options.allowPayloadExtraction === true) {
    const beforeExtract25msBody = workingAst.body;
    const extracted25ms = extract25msAntiTamperPayloadDetailed(workingAst.body);
    if (
      extracted25ms.changed &&
      shouldKeepWeightedResult(
        countStatementWeight(beforeExtract25msBody),
        countStatementWeight(extracted25ms.body),
        payloadRetentionRatio,
      )
    ) {
      workingAst.body = extracted25ms.body;
      extracted25msWrapper = true;
    }
  }

  workingAst.body = processBlock(workingAst.body, state);
  if (!preserveScaffolding && state.capturedAliases.size > 0) {
    workingAst.body = rewriteCapturedAliases(workingAst.body, state.capturedAliases);
  }
  if (!state.loaderUrl) {
    state.loaderUrl = chooseLoaderUrl(collectUrlCandidates(workingAst));
  }

  if (!preserveScaffolding && !extracted25msWrapper && options.stripAntiTamper !== false) {
    workingAst.body = stripAntiTamperStatements(workingAst.body);
    if (options.preferPayloadBranches === true) {
      workingAst.body = preferPayloadBranches(workingAst.body);
    }
  }

  let extracted = workingAst;
  if (!preserveScaffolding && options.allowPayloadExtraction && !extracted25msWrapper) {
    const candidateExtracted = extractLikelyPayload(workingAst);
    const beforeWeight = countStatementWeight(workingAst.body);
    const afterWeight = countStatementWeight(candidateExtracted.body);
    extracted = shouldKeepWeightedResult(beforeWeight, afterWeight, payloadRetentionRatio)
      ? candidateExtracted
      : workingAst;
  }

  let body = foldConstants(extracted, { shadowedIdentifiers }).ast.body;

  body = resolveStringProxiesAndNaming(body, state);
  if (!preserveScaffolding) {
    body = simplifySingleValuePackUnpack(body, state);
  }

  const httpGetMappings = collectHttpGetTableMappings({ type: "Chunk", body, comments: [] });
  state.httpGetTables = httpGetMappings.tables;
  state.httpGetTableAliases = httpGetMappings.aliases;
  state.httpGetKeyAliases = httpGetMappings.keyAliases;
  {
    const urlCandidates = [
      ...collectUrlCandidates({ type: "Chunk", body, comments: [] }),
      ...(httpGetMappings.urls || []),
    ];
    const candidateLoaderUrl = chooseLoaderUrl(urlCandidates);
    if (shouldUpgradeLoaderUrl(state.loaderUrl, candidateLoaderUrl)) {
      state.loaderUrl = candidateLoaderUrl;
    }
  }

  body = mergeDeepElse(body);
  if (options.preferPayloadBranches === true) {
    body = preferPayloadBranches(body);
  }

  body = simplify25msPatterns(body);
  if (!extracted25msWrapper && options.allowPayloadExtraction === true) {
    const extractedPayloadBody = extract25msAntiTamperPayload(body);
    const beforeWeight = countStatementWeight(body);
    const afterWeight = countStatementWeight(extractedPayloadBody);
    body = shouldKeepWeightedResult(beforeWeight, afterWeight, payloadRetentionRatio)
      ? extractedPayloadBody
      : body;
  }

  body = deduplicateBlocks(body);
  body = simplifyLoadstringChains(body, state);
  body = normalizeStringProxyStringCalls(body, state);
  body = normalizeUiLibraryCallOptions(body, state);
  body = removeRedundantLoaderUrlLocals(body);

  if (!preserveScaffolding) {
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = bruteForceAllStringLiterals(body, state.encryptParams);
    body = inlineAllDecodedStrings(body, state);
    body = rewriteDecodedStringLookups(body, state);
    body = rewriteDecodedNumericLookups(body, state);
    body = propagateStringAliases(body, state);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = convertIndexToMember(body);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = bruteForceAllStringLiterals(body, state.encryptParams);
    body = inlineAllDecodedStrings(body, state);
    body = rewriteDecodedStringLookups(body, state);
    body = rewriteDecodedNumericLookups(body, state);
    body = propagateStringAliases(body, state);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = convertIndexToMember(body);
    body = runPrometheusInlining(body, inlineOptions);
    body = simplifySingleValuePackUnpack(body, state);
    body = runPrometheusInlining(body, inlineOptions);
    body = simplifySingleValuePackUnpack(body, state);
    body = runPrometheusInlining(body, inlineOptions);
    body = propagateLiteralLocals(body);
    body = simplifySingleValuePackUnpack(body, state);
    body = runPrometheusInlining(body, inlineOptions);
    body = rewriteIndexMemberAccesses(body);
    body = rewriteTableKeyStrings(body);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = resolveStringProxiesAndNaming(body, state);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
  }

  body = applyPayloadHints(body);

  if (!preserveScaffolding) {
    body = repairHelperTableAssignments(body);
    body = recoverRobloxUiAssignments(body);
    body = recoverKnownRobloxMemberAccesses(body);
    body = rewriteKnownEnumAccesses(body);
    body = resolveStringProxiesAndNaming(body, state);
    body = rewriteIndexMemberAccesses(body);
    body = rewriteTableKeyStrings(body);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
    body = bruteForceAllStringLiterals(body, state.encryptParams);
    body = inlineAllDecodedStrings(body, state);
    body = rewriteDecodedStringLookups(body, state);
    body = rewriteDecodedNumericLookups(body, state);
    body = propagateStringAliases(body, state);
    body = convertIndexToMember(body);
    body = runPrometheusInlining(body, inlineOptions);
    body = foldConstants({ type: "Chunk", body, comments: [] }, { shadowedIdentifiers }).ast.body;
  }

  if (!preserveScaffolding) {
    const preAggressiveBody = body;
    const preAggressiveWeight = countStatementWeight(preAggressiveBody);

    let candidateBody = body;
    if (aggressiveCleanup) {
      candidateBody = removeUnusedLiteralLocals(candidateBody);
      candidateBody = renameServiceLocals(candidateBody);
      candidateBody = fixAliasAssignments(candidateBody);
      candidateBody = recoverKnownRobloxMemberAccesses(candidateBody);
      candidateBody = rewriteKnownEnumAccesses(candidateBody);
      candidateBody = resolveStringProxiesAndNaming(candidateBody, state);
      candidateBody = foldConstants({ type: "Chunk", body: candidateBody, comments: [] }, { shadowedIdentifiers }).ast.body;
      candidateBody = bruteForceAllStringLiterals(candidateBody, state.encryptParams);
      candidateBody = inlineAllDecodedStrings(candidateBody, state);
      candidateBody = rewriteDecodedStringLookups(candidateBody, state);
      candidateBody = rewriteDecodedNumericLookups(candidateBody, state);
      candidateBody = propagateStringAliases(candidateBody, state);
      candidateBody = convertIndexToMember(candidateBody);
      candidateBody = runPrometheusInlining(candidateBody, inlineOptions);
      candidateBody = removeUnusedLiteralLocals(candidateBody);
      candidateBody = dropBareAnonymousFunctionStatements(candidateBody);
      candidateBody = dropStringRootedCallStatements(candidateBody);
      candidateBody = removeUnusedPureLocals(candidateBody);
      candidateBody = removeObfuscatedGlobalAliasAssignments(candidateBody);
      candidateBody = removeUnusedPureLocals(candidateBody);
      candidateBody = removeNoopSetmetatableCalls(candidateBody);
      candidateBody = removeIfTrueWrappers(candidateBody);
      candidateBody = dceStatements(candidateBody, shadowedIdentifiers);
      if (!extracted25msWrapper) {
        candidateBody = removeDecoderFunctionsAndCalls(candidateBody, state);
      }
    }

    const candidateWeight = countStatementWeight(candidateBody);
    const minimumRatio = aggressiveCleanup ? cleanupRetentionRatio : 0.9;
    body = shouldKeepWeightedResult(preAggressiveWeight, candidateWeight, minimumRatio)
      ? candidateBody
      : preAggressiveBody;
  }

  body = simplifyLoadstringChains(body, state);
  body = normalizeStringProxyStringCalls(body, state);
  body = normalizeUiLibraryCallOptions(body, state);
  if (!preserveScaffolding) {
    body = simplifySingleValuePrintWrappers(body, state);
    body = simplifyDynamicStringMethodCalls(body);
    body = simplifyMetatablePrintLookups(body);
    body = removeUnusedLiteralLocals(body);
    const prefixLoop = maybeExtractPrefixLoopProgram(body, options);
    if (prefixLoop) {
      body = prefixLoop;
    }
    body = maybeExtractLiteralPrintProgram(body, options);
  }

  let cleaned = preserveScaffolding
    ? { ...extracted, body }
    : { ...extracted, body: aggressiveCleanup ? cleanupBlock(body) : body };
  if (!preserveScaffolding && !extracted25msWrapper && options.allowPayloadExtraction === true) {
    cleaned = {
      ...cleaned,
      body: extract25msAntiTamperPayload(cleaned.body),
    };
  }
  if (!preserveScaffolding && !extracted25msWrapper) {
    const beforePayloadPick = cleaned.body;
    const picked = extractLikelyPayload(cleaned);
    const beforeWeight = countStatementWeight(beforePayloadPick);
    const afterWeight = countStatementWeight(picked.body);
    cleaned = shouldKeepWeightedResult(beforeWeight, afterWeight, payloadRetentionRatio)
      ? picked
      : cleaned;
  }
  if (!preserveScaffolding) {
    let finalBody = simplifySingleValuePrintWrappers(cleaned.body, state);
    finalBody = simplifyDynamicStringMethodCalls(finalBody);
    const finalPrefixLoop = maybeExtractPrefixLoopProgram(finalBody, options);
    if (finalPrefixLoop) {
      finalBody = finalPrefixLoop;
    } else {
      finalBody = maybeExtractLiteralPrintProgram(finalBody, options);
    }
    finalBody = maybeExtractCoreGuiPayloadBody(finalBody);
    cleaned = {
      ...cleaned,
      body: finalBody,
    };
  }
  cleaned = {
    ...cleaned,
    body: normalizeUiLibraryCallOptions(
      normalizeStringProxyStringCalls(cleaned.body, state),
      state,
    ),
  };
  if (!preserveScaffolding && options.allowLiteralPayload) {
    return synthesizeLiteralPayload(cleaned) || cleaned;
  }
  return cleaned;
}

function postprocessPrometheusOutput(ast, options = {}) {
  const processedAst = postprocessPrometheusAst(ast, options);
  return emitChunk(processedAst);
}

function recoverRobloxUiAssignmentsAst(ast) {
  if (!ast || !Array.isArray(ast.body)) {
    return {
      ast,
      changed: false,
    };
  }

  const body = recoverRobloxUiAssignments(ast.body);
  const changed = body !== ast.body;
  if (!changed) {
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
  inlineSingleUsageLocalsAst,
  postprocessPrometheusAst,
  postprocessPrometheusOutput,
  recoverRobloxUiAssignmentsAst,
  normalizePrometheusOutputSource,
  _debug: {
    collectLiteralPrintPayload,
    collectEncryptedCalls,
    decodePrometheusString,
    extractGalacticDecoder,
    extractEncryptParams,
    extractLiteralStringBuilderNames,
    extractReorderStringBuilderNames,
    extractSecretKey8,
    extractStringProxyNames,
    inferSecretKey8,
    maybeExtractLiteralPrintProgram,
    normalizeStringProxyStringCalls,
    normalizeUiLibraryCallOptions,
  },
};

const KNOWN_ENUM_MEMBER_TO_CLASS = {
  Center: "TextXAlignment",
  End: "UserInputState",
  Exclude: "RaycastFilterType",
  Gotham: "Font",
  GothamBlack: "Font",
  GothamBold: "Font",
  GothamMedium: "Font",
  GothamSemibold: "Font",
  Insert: "KeyCode",
  Keyboard: "UserInputType",
  LayoutOrder: "SortOrder",
  Left: "TextXAlignment",
  MouseButton1: "UserInputType",
  MouseButton2: "UserInputType",
  MouseMovement: "UserInputType",
  Right: "TextXAlignment",
  Touch: "UserInputType",
};

function normalizePrometheusOutputSource(source) {
  let next = source;

  next = next.replace(/Enum\.MouseButton1\.MouseButton1/g, "Enum.UserInputType.MouseButton1");
  next = next.replace(/Enum\.MouseButton2\.MouseButton2/g, "Enum.UserInputType.MouseButton2");
  next = next.replace(/Enum\.Keyboard\.Keyboard/g, "Enum.UserInputType.Keyboard");
  next = next.replace(/Enum\.MouseMovement\.MouseMovement/g, "Enum.UserInputType.MouseMovement");
  next = next.replace(/\bEnum\.GothamBlack\b/g, "Enum.Font.GothamBlack");
  next = next.replace(/\bEnum\.GothamBold\b/g, "Enum.Font.GothamBold");
  next = next.replace(/\bEnum\.GothamMedium\b/g, "Enum.Font.GothamMedium");
  next = next.replace(/\bEnum\.GothamSemibold\b/g, "Enum.Font.GothamSemibold");
  next = next.replace(/\bEnum\.Gotham\b/g, "Enum.Font.Gotham");
  next = next.replace(/Enum\.Gotham\.Gotham/g, "Enum.Font.Gotham");
  next = next.replace(/Enum\.GothamBold\.GothamBold/g, "Enum.Font.GothamBold");
  next = next.replace(/Enum\.Left\.Left/g, "Enum.TextXAlignment.Left");
  next = next.replace(/Enum\.Exclude\.Exclude/g, "Enum.RaycastFilterType.Exclude");
  next = next.replace(/==\s*Enum\.MouseButton1\b/g, "== Enum.UserInputType.MouseButton1");
  next = next.replace(/==\s*Enum\.MouseButton2\b/g, "== Enum.UserInputType.MouseButton2");
  next = next.replace(/==\s*Enum\.Keyboard\b/g, "== Enum.UserInputType.Keyboard");
  next = next.replace(/==\s*Enum\.MouseMovement\b/g, "== Enum.UserInputType.MouseMovement");
  next = next.replace(/\bEnum\.MouseButton2\b/g, "Enum.UserInputType.MouseButton2");
  next = next.replace(/\bEnum\.Keyboard\b/g, "Enum.UserInputType.Keyboard");
  next = next.replace(/\bEnum\.Exclude\b/g, "Enum.RaycastFilterType.Exclude");
  next = next.replace(/Enum\[[^\]\n]+\]\[[^\]\n]+\.([A-Za-z_][A-Za-z0-9_]*)\]/g, (match, memberName) => {
    const enumClass = KNOWN_ENUM_MEMBER_TO_CLASS[memberName];
    return enumClass ? `Enum.${enumClass}.${memberName}` : match;
  });
  next = next.replace(/Enum\[[^\]\n]+\]\["([A-Za-z_][A-Za-z0-9_]*)"\]/g, (match, memberName) => {
    const enumClass = KNOWN_ENUM_MEMBER_TO_CLASS[memberName];
    return enumClass ? `Enum.${enumClass}.${memberName}` : match;
  });
  next = next.replace(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']PlaceId["']/g, (match, variableName) => {
    return /placeid/i.test(variableName) ? `local ${variableName} = game.PlaceId` : match;
  });
  next = next.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']PlaceId["']/g, (match, variableName) => {
    return /placeid/i.test(variableName) ? `${variableName} = game.PlaceId` : match;
  });
  next = next.replace(/\btask\.Text\(/g, "task.wait(");
  next = next.replace(/workspace\[[^\n]+?\]:ScreenPointToRay\(/g, "workspace.CurrentCamera:ScreenPointToRay(");
  next = next.replace(
    /if\s+arg_1(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\n]+\])\s*==\s*Enum\[[^\]\n]+\]\.MouseButton1\s+then/g,
    'if arg_1.UserInputType == Enum.UserInputType.MouseButton1 then',
  );
  next = next.replace(
    /if\s+arg_1(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\n]+\])\s*==\s*Enum\[[^\]\n]+\]\.MouseMovement\s+then/g,
    'if arg_1.UserInputType == Enum.UserInputType.MouseMovement then',
  );
  next = next.replace(/Enum\[[^\]\n]+\]\.GothamBlack/g, "Enum.Font.GothamBlack");
  next = next.replace(/Enum\[[^\]\n]+\]\.GothamMedium/g, "Enum.Font.GothamMedium");
  next = next.replace(/Enum\[[^\]\n]+\]\.Bounce/g, "Enum.EasingStyle.Bounce");
  next = next.replace(/Enum\.(Back|Bounce|Circular|Cubic|Elastic|Exponential|Linear|Quad|Quart|Quint|Sine)\.\1/g, "Enum.EasingStyle.$1");
  next = next.replace(/Enum\[[^\]\n]+\]\.(Back|Bounce|Circular|Cubic|Elastic|Exponential|Linear|Quad|Quart|Quint|Sine)/g, "Enum.EasingStyle.$1");
  next = next.replace(/Enum\.Gotham\[[^\n]+?\]/g, "Enum.Font.Gotham");
  next = next.replace(/Enum\.GothamBold\[[^\n]+?\]/g, "Enum.Font.GothamBold");
  next = next.replace(/Enum\.Font\.(Gotham(?:Bold)?)\]/g, "Enum.Font.$1");
  next = next.replace(/Color3\[[^\]\n]+\]\(/g, "Color3.fromRGB(");
  next = next.replace(/UDim2\[[^\n]+?\]\(/g, "UDim2.new(");
  next = next.replace(/UDim\[[^\n]+?\]\(/g, "UDim.new(");
  next = next.replace(/Vector3\[[^\n]+?\]\(/g, "Vector3.new(");
  next = next.replace(/TweenInfo\.Bounce\(/g, "TweenInfo.new(");
  next = next.replace(/TweenInfo\.(Back|Bounce|Circular|Cubic|Elastic|Exponential|Linear|Quad|Quart|Quint|Sine)\(/g, "TweenInfo.new(");
  next = next.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:\[[^\n]+?\]|\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)\(\1\)/g,
    "$1:$2()",
  );
  next = next.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:\[[^\n]+?\]|\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)\(\1,\s*/g,
    "$1:$2(",
  );
  next = next.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)\.\2(:[A-Za-z_][A-Za-z0-9_]*\()/g,
    "$1.$2$3",
  );
  next = next.replace(/game\[\s*[A-Za-z_][A-Za-z0-9_]*\[\d{6,}\]\s*\]\.Character/g, "game.Players.LocalPlayer.Character");
  next = next.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\.[A-Za-z_][A-Za-z0-9_]*)*)\.Enum\s*==\s*Enum\.UserInputType\.(MouseButton1|MouseMovement)/g,
    "$1.UserInputType == Enum.UserInputType.$2",
  );
  next = next.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\.[A-Za-z_][A-Za-z0-9_]*)*)\.Enum\s*==\s*Enum\.(MouseButton1|MouseMovement)/g,
    "$1.UserInputType == Enum.UserInputType.$2",
  );
  next = next.replace(
    /if\s+arg_1\[[A-Za-z_][A-Za-z0-9_]*\[[A-Za-z_][A-Za-z0-9_]*\]\]\s*==\s*Enum\.UserInputType\.MouseButton1\s+then/g,
    "if arg_1.UserInputType == Enum.UserInputType.MouseButton1 then",
  );
  next = next.replace(/([A-Za-z_][A-Za-z0-9_]*)\[\1\.MouseEnter\]:Connect/g, "$1.MouseEnter:Connect");
  next = next.replace(/([A-Za-z_][A-Za-z0-9_]*)\[\1\.MouseLeave\]:Connect/g, "$1.MouseLeave:Connect");

  next = next.replace(/game:GetService\(\("([A-Za-z0-9_]{6,})"\)\.([A-Za-z_][A-Za-z0-9_]*)\)/g, (match, _base, member) => {
    return `game:GetService("${member.replace(/"/g, '\\"')}")`;
  });
  next = next.replace(/\("([A-Za-z0-9_]{6,})"\)\["([^"\n]+)"\]/g, (match, _base, member) => `"${member.replace(/"/g, '\\"')}"`);
  next = next.replace(/\("([A-Za-z0-9_]{6,})"\)\.([A-Za-z_][A-Za-z0-9_]*)/g, (match, _base, member) => `"${member.replace(/"/g, '\\"')}"`);

  next = next.replace(/\bEnum\[(["'])(\w+)\1\]/g, "Enum.$2");
  next = next.replace(/\bEnum\[(["'])([\w.]+)\1\]/g, "Enum.$2");
  next = next.replace(/(\w+)\[(["'])([A-Za-z_][A-Za-z0-9_]*)\2\]/g, "$1.$3");

  next = next.replace(/\b([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\(\s*\1\s*,/g, "$1:$2(");

  next = next.replace(/local\s+\w+\s*=\s*pcall\s*\(\s*function\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\n?\s*\w+\[\w+\]\s*=\s*true\s*\n?\s*end\s*\)/g, "");

  next = next.replace(/^local\s+\w+\s*=\s*function\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\n?\s*\w+\[\w+\]\s*=\s*true\s*\n?\s*end\s*$/gm, "");

  next = next.replace(/^local\s+\w+\s*=\s*pcall\s*\(\s*(?!function\b)[^\n)]*\)\s*$/gm, "");

  next = next.replace(/^local\s+\w+\s*=\s*\{\s*pcall\s*\(\s*(?!function\b)[^\n)]*\)\s*\}\s*$/gm, "");

  next = next.replace(/^math\.random\s*\(\s*\d+\s*,\s*\d+\s*\)\s*$/gm, "");

  next = next.replace(/^local\s+\w+\s*=\s*tostring\s*\([^\n)]*\)\s*$/gm, "");

  next = next.replace(/^local\s+\w+\s*=\s*string\.gmatch\s*\([^\n)]*\)\s*$/gm, "");

  next = next.replace(/^local\s+\w+\s*=\s*tonumber\s*\([^\n)]*\)\s*$/gm, "");

  next = next.replace(/^setmetatable\s*\(\s*\{\s*\}\s*,\s*\{\s*__index\s*=\s*\{\s*\}\s*,\s*__metatable\s*=\s*nil\s*\}\s*\)\s*$/gm, "");

  next = next.replace(/^\s*;\("[A-Za-z0-9_]{6,}"\)\s*$/gm, "");
  next = next.replace(/^\s*;\("[A-Za-z0-9_]{6,}"\)\([^\n]*\)\s*$/gm, "");
  next = next.replace(
    /(^[ \t]*)return\s+\(function\([^)]*\)\s*\n([\s\S]*?)^[ \t]*end\)\(\)/gm,
    (match, indent, body) => `${body}${body.endsWith("\n") ? "" : "\n"}${indent}return`,
  );

  next = next.replace(/\{\s*unpack\s*\(\s*\{\s*\[1\]\s*=\s*([^,\n}]+)\s*\}\s*\)\s*\}/g, "{$1}");
  next = next.replace(/\{\s*unpack\s*\(\s*\{\s*\[1\]\s*=\s*([^,\n}]+)\s*,\s*\[2\]\s*=\s*([^}\n]+)\s*\}\s*\)\s*\}/g, "{$1, $2}");

  next = next.replace(/\n{3,}/g, "\n\n");
  next = next.replace(/^\s*\n+/, "");

  const lines = next.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const mouseButton1Line = lines[index].match(/^(\s*)if\s+arg_1.*==\s*Enum\.UserInputType\.MouseButton1\s+then\s*$/);
    if (mouseButton1Line) {
      lines[index] = `${mouseButton1Line[1]}if arg_1.UserInputType == Enum.UserInputType.MouseButton1 then`;
      continue;
    }

    const mouseMovementLine = lines[index].match(/^(\s*)if\s+arg_1.*==\s*Enum\.UserInputType\.MouseMovement\s+then\s*$/);
    if (mouseMovementLine) {
      lines[index] = `${mouseMovementLine[1]}if arg_1.UserInputType == Enum.UserInputType.MouseMovement then`;
      continue;
    }
  }

  for (let index = 2; index < lines.length; index += 1) {
    const propertyMatch = lines[index - 2].match(/^\s*local\s+\w+\s*=\s*"Text"\s*$/);
    const valueMatch = lines[index - 1].match(/^\s*local\s+\w+\s*=\s*"([^"\n]+)"\s*$/);
    const assignmentMatch = lines[index].match(/^(\s*[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\.[A-Za-z_][A-Za-z0-9_]*)\s*=\s*)"([^"\n]*)"\s*$/);
    if (
      propertyMatch &&
      valueMatch &&
      assignmentMatch &&
      isReadableHintValue(valueMatch[1]) &&
      assignmentMatch[2] !== valueMatch[1] &&
      (
        !/^[\x20-\x7e]+$/.test(assignmentMatch[2]) ||
        assignmentMatch[2].includes("\\u")
      )
    ) {
      lines[index] = `${assignmentMatch[1]}${JSON.stringify(valueMatch[1])}`;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = (line.match(/^\s*/) || [""])[0];

    if (
      line.includes("CoreGui:AddList({") &&
      line.includes("callback") &&
      /\[[^\]]+\]/.test(line)
    ) {
      const callbackMatch = line.match(/\bcallback\s*=\s*([^,}]+)/);
      if (callbackMatch) {
        lines[index] = `${indent}CoreGui:AddList({callback = ${callbackMatch[1].trim()}})`;
        continue;
      }
    }

    if (
      line.includes("CoreGui:AddButton({") &&
      line.includes("callback") &&
      /\[[^\]]+\]/.test(line)
    ) {
      const callbackMatch = line.match(/\bcallback\s*=\s*([^,}]+)/);
      if (callbackMatch) {
        lines[index] = `${indent}CoreGui:AddButton({callback = ${callbackMatch[1].trim()}})`;
        continue;
      }
    }

    if (
      line.includes("CoreGui:AddSlider({") &&
      line.includes("callback") &&
      /\[[^\]]+\]/.test(line)
    ) {
      const callbackMatch = line.match(/\bcallback\s*=\s*([^,}]+)/);
      if (callbackMatch) {
        lines[index] = `${indent}CoreGui:AddSlider({callback = ${callbackMatch[1].trim()}})`;
        continue;
      }
    }

    if (line.includes("CoreGui:AddLabel({") && /\[[^\]]+\]/.test(line)) {
      const textMatch = line.match(/\[[^=]+\]\s*=\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/);
      if (textMatch) {
        lines[index] = `${indent}CoreGui:AddLabel({text = ${textMatch[1]}})`;
      }
    }
  }

  return lines.join("\n");
}

function isStringHintStatement(statement, value = null) {
  return (
    statement &&
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    isStringLiteral(statement.init[0]) &&
    (value === null || statement.init[0].value === value)
  );
}

function toPropertyNode(base, value) {
  if (isValidIdentifierName(value)) {
    return {
      type: "MemberExpression",
      base,
      indexer: ".",
      identifier: {
        type: "Identifier",
        name: value,
      },
    };
  }

  return {
    type: "IndexExpression",
    base,
    index: {
      type: "StringLiteral",
      value,
      raw: JSON.stringify(value),
    },
  };
}

function applyPropertyHint(statement, value) {
  if (
    statement.type !== "AssignmentStatement" ||
    statement.variables.length !== 1 ||
    !["IndexExpression", "MemberExpression"].includes(statement.variables[0].type)
  ) {
    return null;
  }

  const variable = statement.variables[0];
  if (
    variable.type === "IndexExpression" &&
    isIdentifier(variable.base) &&
    isIdentifier(unwrapParentheses(variable.index)) &&
    looksProxyLikeBaseName(variable.base.name)
  ) {
    return {
      ...statement,
      variables: [
        toPropertyNode(unwrapParentheses(variable.index), value),
      ],
    };
  }

  const base = variable.base;
  return {
    ...statement,
    variables: [
      toPropertyNode(base, value),
    ],
  };
}

function isReadableHintValue(value) {
  return (
    typeof value === "string" &&
    /^[\x20-\x7e]+$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /[\s.!?:;-]/.test(value)
  );
}

function isGarbledStringLiteral(node) {
  return (
    isStringLiteral(node) &&
    (
      !/^[\x20-\x7e]+$/.test(node.value) ||
      node.value.includes("\u0000")
    )
  );
}

function applyAssignmentValueHint(statement, value) {
  if (
    statement.type !== "AssignmentStatement" ||
    statement.init.length !== 1 ||
    !isGarbledStringLiteral(statement.init[0]) ||
    !(isReadableHintValue(value) || isReadableHintValueLoose(value))
  ) {
    return null;
  }

  return {
    ...statement,
    init: [createStringLiteral(value)],
  };
}

function isReadableHintValueLoose(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[\x20-\x7e]+$/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}

function applyPropertyValueHints(statement, hintA, hintB) {
  const rewrittenProperty = applyPropertyHint(statement, hintA);
  const rewrittenValue = applyAssignmentValueHint(rewrittenProperty || statement, hintB);
  return rewrittenValue || rewrittenProperty;
}

function looksProxyLikeBaseName(name) {
  return typeof name === "string" && (/^[A-Z]$/.test(name) || /^local_\d+$/.test(name));
}

function collectDeclaredAndAssignedIdentifiers(statements) {
  const declared = new Set();
  const assigned = new Set();

  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    switch (node.type) {
      case "LocalStatement":
        node.variables.forEach((variable) => {
          if (isIdentifier(variable)) {
            declared.add(variable.name);
          }
        });
        node.init.forEach(visit);
        return;
      case "AssignmentStatement":
        node.variables.forEach((variable) => {
          if (isIdentifier(variable)) {
            assigned.add(variable.name);
          }
          visit(variable);
        });
        node.init.forEach(visit);
        return;
      case "FunctionDeclaration":
        if (node.isLocal && isIdentifier(node.identifier)) {
          declared.add(node.identifier.name);
        }
        (node.parameters || []).forEach((parameter) => {
          if (isIdentifier(parameter)) {
            declared.add(parameter.name);
          }
        });
        if (node.identifier) {
          visit(node.identifier);
        }
        visit(node.body);
        return;
      case "ForNumericStatement":
        if (isIdentifier(node.variable)) {
          declared.add(node.variable.name);
        }
        visit(node.start);
        visit(node.end);
        visit(node.step);
        visit(node.body);
        return;
      case "ForGenericStatement":
        (node.variables || []).forEach((variable) => {
          if (isIdentifier(variable)) {
            declared.add(variable.name);
          }
        });
        visit(node.iterators);
        visit(node.body);
        return;
      default:
        Object.entries(node).forEach(([key, value]) => {
          if (key === "scope") {
            return;
          }
          visit(value);
        });
    }
  };

  visit(statements);
  return { declared, assigned };
}

function collectLikelyReadableStringTableBases(statements, shadowedGlobals = new Set()) {
  const { declared, assigned } = collectDeclaredAndAssignedIdentifiers(statements);
  const candidates = new Set();

  walk({ type: "Chunk", body: statements, comments: [] }, (node) => {
    if (
      node.type === "IndexExpression" &&
      isIdentifier(node.base) &&
      isStringLiteral(node.index) &&
      looksProxyLikeBaseName(node.base.name) &&
      !declared.has(node.base.name) &&
      !assigned.has(node.base.name) &&
      !KNOWN_GLOBAL_LIKE_NAMES.has(node.base.name) &&
      !shadowedGlobals.has(node.base.name) &&
      isReadableHintValueLoose(node.index.value)
    ) {
      candidates.add(node.base.name);
      return;
    }

    if (
      node.type === "MemberExpression" &&
      isIdentifier(node.base) &&
      looksProxyLikeBaseName(node.base.name) &&
      !declared.has(node.base.name) &&
      !assigned.has(node.base.name) &&
      !KNOWN_GLOBAL_LIKE_NAMES.has(node.base.name) &&
      !shadowedGlobals.has(node.base.name) &&
      isReadableHintValueLoose(node.identifier.name)
    ) {
      candidates.add(node.base.name);
    }
  });

  return candidates;
}

function collectStringProxyAliases(statements, initialProxyNames = new Set()) {
  const proxies = new Set(initialProxyNames || []);
  let changed = true;

  const tryAddProxyName = (name, initializer) => {
    if (!name || proxies.has(name)) {
      return false;
    }

    const expression = unwrapParentheses(initializer);
    if (!expression) {
      return false;
    }

    if (expression.type === "Identifier" && proxies.has(expression.name)) {
      proxies.add(name);
      return true;
    }

    if (isStringProxyInitializer(expression)) {
      proxies.add(name);
      return true;
    }

    return false;
  };

  while (changed) {
    changed = false;

    walk({ type: "Chunk", body: statements, comments: [] }, (node) => {
      if (node.type !== "LocalStatement" && node.type !== "AssignmentStatement") {
        return;
      }

      const pairCount = Math.min(node.variables.length, node.init.length);
      for (let index = 0; index < pairCount; index += 1) {
        const variable = node.variables[index];
        const initializer = node.init[index];
        if (!isIdentifier(variable) || !initializer) {
          continue;
        }

        if (tryAddProxyName(variable.name, initializer)) {
          changed = true;
        }
      }
    });
  }

  return proxies;
}

function applyInputConditionHints(statement, hintA, hintB, hintC) {
  if (!statement || statement.type !== "IfStatement") {
    return null;
  }

  const inputProperty = [hintA, hintB].find((value) => value === "UserInputType");
  const inputMember = [hintA, hintB, hintC].find((value) => USER_INPUT_ENUM_MEMBERS.has(value));
  if (!inputProperty || !inputMember) {
    return null;
  }

  const rewriteConditionNode = (node) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(rewriteConditionNode);
    }

    if (
      node.type === "MemberExpression" &&
      isIdentifier(node.base, "arg_1")
    ) {
      return toPropertyNode(node.base, inputProperty);
    }

    if (
      node.type === "IndexExpression" &&
      isIdentifier(node.base, "arg_1")
    ) {
      return toPropertyNode(node.base, inputProperty);
    }

    if (
      node.type === "MemberExpression" &&
      node.identifier.name === inputMember &&
      node.base.type === "IndexExpression" &&
      isIdentifier(node.base.base, "Enum")
    ) {
      return {
        ...node,
        base: toPropertyNode({ type: "Identifier", name: "Enum" }, "UserInputType"),
      };
    }

    const next = {};
    for (const [key, value] of Object.entries(node)) {
      next[key] = rewriteConditionNode(value);
    }
    return next;
  };

  return {
    ...statement,
    clauses: statement.clauses.map((clause, index) => {
      if (index !== 0 || clause.type !== "IfClause") {
        return {
          ...clause,
          body: applyPayloadHints(clause.body),
        };
      }

      return {
        ...clause,
        condition: rewriteConditionNode(clause.condition),
        body: applyPayloadHints(clause.body),
      };
    }),
  };
}

function getCallBaseRoot(base) {
  if (!base || typeof base !== "object") {
    return null;
  }

  if (base.type === "Identifier") {
    return base.name;
  }

  if (base.type === "MemberExpression" || base.type === "IndexExpression") {
    return getCallBaseRoot(base.base);
  }

  return null;
}

function applyConstructorHints(statement, hintA, hintB) {
  if (
    !statement ||
    !(
      statement.type === "LocalStatement" ||
      statement.type === "AssignmentStatement"
    ) ||
    statement.init.length !== 1 ||
    statement.init[0].type !== "CallExpression"
  ) {
    return null;
  }

  const call = statement.init[0];
  const root = getCallBaseRoot(call.base);
  if (!["Color3", "Enum", "Instance", "UDim", "UDim2"].includes(root)) {
    return null;
  }

  let memberName = hintA;
  if (!["Font", "fromRGB", "new"].includes(memberName)) {
    memberName = hintB;
  }

  if (root === "Color3" && memberName !== "fromRGB") {
    memberName = "fromRGB";
  }
  if ((root === "Instance" || root === "UDim" || root === "UDim2") && memberName !== "new") {
    memberName = "new";
  }

  let nextBase;
  if (root === "Enum" && (hintA === "Font" || hintB === "Font")) {
    const enumBase = toPropertyNode({ type: "Identifier", name: "Enum" }, "Font");
    nextBase = toPropertyNode(enumBase, hintA === "Font" ? hintB : hintA);
  } else {
    nextBase = toPropertyNode({ type: "Identifier", name: root }, memberName);
  }

  const nextArguments = call.arguments.slice();
  if (root === "Instance") {
    const className = [hintA, hintB].find((value) => value !== "new" && isReadableHintValueLoose(value));
    if (className) {
      nextArguments[0] = createStringLiteral(className);
    }
  }

  return {
    ...statement,
    init: [
      {
        ...call,
        base: nextBase,
        arguments: nextArguments,
      },
    ],
  };
}

function recurseStatementHints(statement) {
  const recurseNode = (node) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(recurseNode);
    }

    if (node.type === "IfStatement") {
      return {
        ...node,
        clauses: node.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? recurseNode(clause.condition) : clause.condition,
          body: applyPayloadHints(clause.body || []),
        })),
      };
    }

    if (
      node.type === "WhileStatement" ||
      node.type === "RepeatStatement" ||
      node.type === "DoStatement" ||
      node.type === "FunctionDeclaration" ||
      node.type === "ForNumericStatement" ||
      node.type === "ForGenericStatement"
    ) {
      return {
        ...node,
        body: applyPayloadHints(node.body || []),
      };
    }

    const next = { ...node };
    let changed = false;

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") {
        continue;
      }

      const nextValue = recurseNode(value);
      if (nextValue !== value) {
        next[key] = nextValue;
        changed = true;
      }
    }

    return changed ? next : node;
  };

  return recurseNode(statement);
}

function applyPayloadHints(statements) {
  const output = [];

  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index];
    const next = statements[index + 1];
    const third = statements[index + 2];
    const fourth = statements[index + 3];

    if (
      current &&
      next &&
      third &&
      fourth &&
      isStringHintStatement(current) &&
      isStringHintStatement(next) &&
      isStringHintStatement(third)
    ) {
      const hintedCondition = applyInputConditionHints(
        recurseStatementHints(fourth),
        current.init[0].value,
        next.init[0].value,
        third.init[0].value,
      );
      if (hintedCondition) {
        output.push(hintedCondition);
        index += 3;
        continue;
      }

      const rewrittenByHints = applyPropertyValueHints(
        recurseStatementHints(fourth),
        current.init[0].value,
        next.init[0].value,
      );
      if (rewrittenByHints) {
        output.push(rewrittenByHints);
        index += 3;
        continue;
      }
    }

    if (
      current &&
      next &&
      third &&
      isStringHintStatement(current) &&
      isStringHintStatement(next)
    ) {
      const hintedCondition = applyInputConditionHints(
        recurseStatementHints(third),
        current.init[0].value,
        next.init[0].value,
        null,
      );
      if (hintedCondition) {
        output.push(hintedCondition);
        index += 2;
        continue;
      }

      const rewrittenConstructor = applyConstructorHints(
        recurseStatementHints(third),
        current.init[0].value,
        next.init[0].value,
      );
      if (rewrittenConstructor) {
        output.push(rewrittenConstructor);
        index += 2;
        continue;
      }

      const rewrittenByHints = applyPropertyValueHints(
        recurseStatementHints(third),
        current.init[0].value,
        next.init[0].value,
      );
      if (rewrittenByHints) {
        output.push(rewrittenByHints);
        index += 2;
        continue;
      }
    }

    if (current && next && isStringHintStatement(current)) {
      const rewrittenAssignment = applyPropertyHint(
        recurseStatementHints(next),
        current.init[0].value,
      );
      if (rewrittenAssignment) {
        output.push(rewrittenAssignment);
        index += 1;
        continue;
      }
    }

    output.push(recurseStatementHints(current));
  }

  return output;
}

const ROBLOX_UI_CLASSES = new Set([
  "BlurEffect",
  "Frame",
  "ImageButton",
  "ImageLabel",
  "ScreenGui",
  "ScrollingFrame",
  "TextBox",
  "TextButton",
  "TextLabel",
  "UIGradient",
  "UICorner",
  "UIStroke",
]);

const UI_EVENT_MEMBERS = new Set([
  "FocusLost",
  "InputBegan",
  "InputChanged",
  "InputEnded",
  "MouseButton1Click",
  "MouseEnter",
  "MouseLeave",
]);

const UI_CLASS_PROPERTY_HINTS = {
  BlurEffect: {
    number: ["Size"],
    object: ["Parent"],
    stringlike: ["Name"],
  },
  Frame: {
    boolean: ["Visible", "ClipsDescendants", "Active"],
    number: ["BackgroundTransparency", "ZIndex", "BorderSizePixel"],
    object: ["Parent"],
    udim2: ["Size", "Position"],
    vector2: ["AnchorPoint"],
    color3: ["BackgroundColor3"],
  },
  ImageButton: {
    number: ["ImageTransparency", "ZIndex", "Rotation"],
    object: ["Parent"],
    stringlike: ["Name", "Image"],
    udim2: ["Size", "Position"],
    vector2: ["AnchorPoint"],
    color3: ["ImageColor3", "BackgroundColor3"],
  },
  ImageLabel: {
    number: ["ImageTransparency", "ZIndex", "Rotation"],
    object: ["Parent"],
    stringlike: ["Name", "Image"],
    udim2: ["Size", "Position"],
    vector2: ["AnchorPoint"],
    color3: ["ImageColor3", "BackgroundColor3"],
  },
  ScreenGui: {
    boolean: ["IgnoreGuiInset", "ResetOnSpawn"],
    number: ["DisplayOrder"],
    object: ["Parent"],
  },
  ScrollingFrame: {
    boolean: ["Visible", "ClipsDescendants"],
    number: ["BackgroundTransparency", "ZIndex", "ScrollBarThickness"],
    object: ["Parent"],
    udim2: ["Size", "Position", "CanvasSize"],
    vector2: ["AnchorPoint", "CanvasPosition"],
    color3: ["BackgroundColor3"],
  },
  TextLabel: {
    boolean: ["TextWrapped", "TextScaled", "Visible"],
    number: ["TextSize", "BackgroundTransparency", "TextTransparency", "ZIndex"],
    object: ["Parent"],
    udim2: ["Size", "Position"],
    vector2: ["AnchorPoint"],
    color3: ["TextColor3", "BackgroundColor3"],
    enum: ["Font", "TextXAlignment", "TextYAlignment"],
    stringlike: ["Text"],
  },
  TextButton: {
    boolean: ["TextWrapped", "TextScaled", "Visible", "AutoButtonColor"],
    number: ["TextSize", "BackgroundTransparency", "TextTransparency", "ZIndex"],
    object: ["Parent"],
    udim2: ["Size", "Position"],
    vector2: ["AnchorPoint"],
    color3: ["BackgroundColor3", "TextColor3"],
    enum: ["Font", "TextXAlignment", "TextYAlignment"],
    stringlike: ["Text"],
  },
  TextBox: {
    boolean: ["TextWrapped", "TextScaled", "Visible", "ClearTextOnFocus"],
    number: ["TextSize", "BackgroundTransparency", "TextTransparency", "ZIndex"],
    object: ["Parent"],
    udim2: ["Size", "Position"],
    vector2: ["AnchorPoint"],
    color3: ["BackgroundColor3", "TextColor3", "PlaceholderColor3"],
    enum: ["Font", "TextXAlignment", "TextYAlignment"],
    stringlike: ["Text", "PlaceholderText"],
  },
  UIGradient: {
    colorsequence: ["Color"],
    number: ["Rotation"],
    object: ["Parent"],
  },
  UICorner: {
    object: ["Parent"],
    udim: ["CornerRadius"],
  },
  UIStroke: {
    color3: ["Color"],
    enum: ["ApplyStrokeMode"],
    number: ["Thickness", "Transparency"],
    object: ["Parent"],
  },
};

function isComparisonOperator(operator) {
  return operator === "==" || operator === "~=" || operator === "<" || operator === "<=" || operator === ">" || operator === ">=";
}

function collectTrackedMembersFromExpression(node, trackedNames, usageHints) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => collectTrackedMembersFromExpression(child, trackedNames, usageHints));
    return;
  }

  if (node.type === "MemberExpression" && isIdentifier(node.base) && trackedNames.has(node.base.name)) {
    usageHints.get(node.base.name).add(node.identifier.name);
  }

  if (node.type === "IndexExpression" && isIdentifier(node.base) && trackedNames.has(node.base.name) && isStringLiteral(node.index)) {
    usageHints.get(node.base.name).add(node.index.value);
  }

  Object.entries(node).forEach(([key, value]) => {
    if (key === "scope" || key === "body" || key === "parameters" || key === "identifier" || key === "variables") {
      return;
    }
    collectTrackedMembersFromExpression(value, trackedNames, usageHints);
  });
}

function collectBlockInstanceConstructors(statements) {
  const constructors = new Map();

  for (const statement of statements) {
    if (
      (statement.type !== "LocalStatement" && statement.type !== "AssignmentStatement") ||
      statement.variables.length !== 1 ||
      statement.init.length !== 1
    ) {
      continue;
    }

    const variable = statement.variables[0];
    const initializer = unwrapParentheses(statement.init[0]);
    if (!isIdentifier(variable) || !initializer || initializer.type !== "CallExpression") {
      continue;
    }

    if (
      !initializer.base ||
      initializer.base.type !== "MemberExpression" ||
      !isIdentifier(initializer.base.base, "Instance") ||
      initializer.base.identifier.name !== "new" ||
      initializer.arguments.length < 1
    ) {
      continue;
    }

    const classArgument = unwrapParentheses(initializer.arguments[0]);
    let className = null;
    if (isStringLiteral(classArgument)) {
      className = classArgument.value;
    } else if (classArgument && classArgument.type === "MemberExpression" && classArgument.identifier) {
      className = classArgument.identifier.name;
    } else if (classArgument && classArgument.type === "IndexExpression" && isStringLiteral(classArgument.index)) {
      className = classArgument.index.value;
    }

    if (!className || (!ROBLOX_UI_CLASSES.has(className) && !isValidIdentifierName(className))) {
      continue;
    }

    constructors.set(variable.name, className);
  }

  return constructors;
}

function collectInstanceUsageHints(statements, trackedInstances) {
  const trackedNames = new Set(trackedInstances.keys());
  const usageHints = new Map();
  const explicitProperties = new Map();
  for (const name of trackedNames) {
    usageHints.set(name, new Set());
    explicitProperties.set(name, new Set());
  }

  const recordExplicitProperty = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (node.type === "MemberExpression" && isIdentifier(node.base) && trackedNames.has(node.base.name)) {
      const propertyName = node.identifier.name;
      usageHints.get(node.base.name).add(propertyName);
      explicitProperties.get(node.base.name).add(propertyName);
      return;
    }

    if (node.type === "IndexExpression" && isIdentifier(node.base) && trackedNames.has(node.base.name) && isStringLiteral(node.index)) {
      const propertyName = node.index.value;
      usageHints.get(node.base.name).add(propertyName);
      explicitProperties.get(node.base.name).add(propertyName);
    }
  };

  for (const statement of statements) {
    switch (statement.type) {
      case "LocalStatement":
        statement.init.forEach((expression) => collectTrackedMembersFromExpression(expression, trackedNames, usageHints));
        break;
      case "AssignmentStatement":
        statement.variables.forEach((variable) => recordExplicitProperty(variable));
        statement.variables.forEach((variable) => collectTrackedMembersFromExpression(variable, trackedNames, usageHints));
        statement.init.forEach((expression) => collectTrackedMembersFromExpression(expression, trackedNames, usageHints));
        if (
          statement.variables.length === 1 &&
          statement.init.length === 1 &&
          statement.variables[0].type === "IndexExpression" &&
          isIdentifier(statement.variables[0].base) &&
          trackedNames.has(statement.variables[0].base.name) &&
          !isStringLiteral(statement.variables[0].index)
        ) {
          const initializer = unwrapParentheses(statement.init[0]);
          if (initializer && initializer.type === "CallExpression") {
            const root = getCallBaseRoot(initializer.base);
            if (root === "UDim") {
              usageHints.get(statement.variables[0].base.name).add("CornerRadius");
            }
          }
        }
        break;
      case "CallStatement":
        collectTrackedMembersFromExpression(statement.expression, trackedNames, usageHints);
        break;
      case "ReturnStatement":
        statement.arguments.forEach((argument) => collectTrackedMembersFromExpression(argument, trackedNames, usageHints));
        break;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.condition) {
            collectTrackedMembersFromExpression(clause.condition, trackedNames, usageHints);
          }
        });
        break;
      case "WhileStatement":
      case "RepeatStatement":
        collectTrackedMembersFromExpression(statement.condition, trackedNames, usageHints);
        break;
      case "FunctionDeclaration":
        if (statement.identifier) {
          collectTrackedMembersFromExpression(statement.identifier, trackedNames, usageHints);
        }
        break;
      default:
        break;
    }
  }

  return { usageHints, explicitProperties };
}

function collectLocalPlayerAliases(statements, inheritedAliases = new Set()) {
  const aliases = new Set(inheritedAliases);
  let changed = true;

  const isLocalPlayerInitializer = (node) => {
    const expression = unwrapParentheses(node);
    if (!expression) {
      return false;
    }

    if (
      expression.type === "MemberExpression" &&
      expression.indexer === "." &&
      expression.identifier &&
      expression.identifier.name === "LocalPlayer"
    ) {
      return true;
    }

    if (
      expression.type === "IndexExpression" &&
      isStringLiteral(expression.index, "LocalPlayer")
    ) {
      return true;
    }

    if (expression.type === "Identifier" && aliases.has(expression.name)) {
      return true;
    }

    return false;
  };

  while (changed) {
    changed = false;

    for (const statement of statements) {
      if (statement.type !== "LocalStatement" && statement.type !== "AssignmentStatement") {
        continue;
      }

      const pairCount = Math.min(statement.variables.length, statement.init.length);
      for (let index = 0; index < pairCount; index += 1) {
        const variable = statement.variables[index];
        const initializer = statement.init[index];
        if (!isIdentifier(variable) || !initializer || aliases.has(variable.name)) {
          continue;
        }

        if (isLocalPlayerInitializer(initializer)) {
          aliases.add(variable.name);
          changed = true;
        }
      }
    }
  }

  return aliases;
}

function normalizeRobloxUiClassName(className, usageHints = new Set()) {
  if (className === "CornerRadius") {
    return "UICorner";
  }

  if (usageHints.has("CornerRadius")) {
    return "UICorner";
  }
  if (ROBLOX_UI_CLASSES.has(className) && className !== "UIGradient") {
    return className;
  }
  if (className === "UIStroke") {
    return "UIStroke";
  }
  if (
    className === "UIGradient" &&
    (usageHints.has("Thickness") || usageHints.has("Transparency") || usageHints.has("ApplyStrokeMode"))
  ) {
    return "UIStroke";
  }
  if (
    usageHints.has("Thickness") ||
    usageHints.has("ApplyStrokeMode") ||
    (usageHints.has("Color") && usageHints.has("Transparency"))
  ) {
    return "UIStroke";
  }
  if (usageHints.has("Color") || usageHints.has("Rotation")) {
    return "UIGradient";
  }

  if (ROBLOX_UI_CLASSES.has(className)) {
    return className;
  }

  if (usageHints.has("Image") || usageHints.has("ImageColor3") || usageHints.has("ImageTransparency")) {
    return [...usageHints].some((member) => UI_EVENT_MEMBERS.has(member)) ? "ImageButton" : "ImageLabel";
  }
  if (usageHints.has("Size") && usageHints.has("Name") && [...usageHints].length <= 3) {
    return "BlurEffect";
  }
  if (usageHints.has("PlaceholderText") || usageHints.has("ClearTextOnFocus")) {
    return "TextBox";
  }
  if ([...usageHints].some((member) => UI_EVENT_MEMBERS.has(member)) || usageHints.has("AutoButtonColor")) {
    return "TextButton";
  }
  if (usageHints.has("TextXAlignment") || usageHints.has("TextScaled") || usageHints.has("TextWrapped") || usageHints.has("Text")) {
    return "TextLabel";
  }
  if (usageHints.has("ResetOnSpawn") || usageHints.has("IgnoreGuiInset") || usageHints.has("DisplayOrder")) {
    return "ScreenGui";
  }
  if (usageHints.has("CanvasSize") || usageHints.has("CanvasPosition") || usageHints.has("ScrollBarThickness")) {
    return "ScrollingFrame";
  }
  if (usageHints.has("BackgroundColor3") || usageHints.has("BackgroundTransparency")) {
    return "Frame";
  }

  return className;
}

function classifyUiAssignmentValue(node, localValueKinds = new Map()) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return "unknown";
  }

  if (expression.type === "Identifier" && localValueKinds.has(expression.name)) {
    return localValueKinds.get(expression.name);
  }

  if (isStringLiteral(expression)) {
    return "stringlike";
  }

  if (expression.type === "NumericLiteral") {
    return "number";
  }

  if (expression.type === "BooleanLiteral") {
    return "boolean";
  }

  if (expression.type === "NilLiteral") {
    return "nil";
  }

  if (expression.type === "Identifier" || expression.type === "MemberExpression" || expression.type === "IndexExpression") {
    const root = getCallBaseRoot(expression);
    if (root === "Enum") {
      return "enum";
    }
    return "stringlike";
  }

  if (expression.type === "CallExpression") {
    const root = getCallBaseRoot(expression.base);
    if (root === "UDim2") {
      return "udim2";
    }
    if (root === "UDim") {
      return "udim";
    }
    if (root === "Color3") {
      return "color3";
    }
    if (root === "ColorSequence" || root === "NumberSequence") {
      return "colorsequence";
    }
    if (root === "Vector2" || root === "Vector3") {
      return "vector2";
    }
    if (root === "Instance") {
      return "object";
    }
    return "stringlike";
  }

  return "unknown";
}

function chooseUiPropertyName(className, valueKind, objectState) {
  const classHints = UI_CLASS_PROPERTY_HINTS[className];
  if (!classHints) {
    return null;
  }

  const candidates = classHints[valueKind] || [];
  for (const candidate of candidates) {
    if (!objectState.assigned.has(candidate)) {
      return candidate;
    }
  }

  if (candidates.length > 0) {
    return candidates[candidates.length - 1];
  }

  return null;
}

function rewriteUiAssignmentVariable(variable, propertyName) {
  if (!propertyName || !variable || variable.type !== "IndexExpression") {
    return variable;
  }

  return toPropertyNode(variable.base, propertyName);
}

function createNumericLiteral(value) {
  return {
    type: "NumericLiteral",
    value,
    raw: String(value),
  };
}

function createMemberExpression(base, name) {
  return {
    type: "MemberExpression",
    base,
    indexer: ".",
    identifier: createIdentifier(name),
  };
}

function createCallExpression(base, args = []) {
  return {
    type: "CallExpression",
    base,
    arguments: args,
  };
}

function createLogicalOr(left, right) {
  return {
    type: "LogicalExpression",
    operator: "or",
    left,
    right,
  };
}

function createLocalStatementWithIdentifier(name, init) {
  return {
    type: "LocalStatement",
    variables: [createLocalIdentifier(name)],
    init: [init],
  };
}

function createAssignmentStatement(variable, init) {
  return {
    type: "AssignmentStatement",
    variables: [variable],
    init: [init],
  };
}

function createTableValue(value) {
  return {
    type: "TableValue",
    value,
  };
}

function createTableConstructor(fields) {
  return {
    type: "TableConstructorExpression",
    fields,
  };
}

function createFunctionExpression(parameters, body) {
  return {
    type: "FunctionDeclaration",
    identifier: null,
    isLocal: false,
    parameters,
    body,
  };
}

function isSingleLocalIdentifierStatement(statement) {
  return (
    statement &&
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    isIdentifier(statement.variables[0])
  );
}

function isLocalStringBinding(statement) {
  return isSingleLocalIdentifierStatement(statement) && isStringLiteral(statement.init[0]);
}

function isLocalTableBinding(statement) {
  return isSingleLocalIdentifierStatement(statement) && statement.init[0].type === "TableConstructorExpression";
}

function isLocalFunctionBinding(statement) {
  return isSingleLocalIdentifierStatement(statement) && statement.init[0].type === "FunctionDeclaration";
}

function isFunctionAliasAssignment(statement, functionName) {
  return (
    statement &&
    statement.type === "AssignmentStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    isIdentifier(statement.init[0], functionName) &&
    statement.variables[0].type === "IndexExpression" &&
    isIdentifier(statement.variables[0].base)
  );
}

function collectHelperFunctionSummary(functionNode) {
  const strings = new Set();
  const callBases = new Set();

  walk({ type: "Chunk", body: functionNode.body || [], comments: [] }, (node) => {
    if (node.type === "StringLiteral" && typeof node.value === "string") {
      strings.add(node.value);
      return;
    }

    if (node.type !== "CallExpression") {
      return;
    }

    const base = node.base;
    if (base.type === "Identifier") {
      callBases.add(base.name);
      return;
    }

    if (base.type === "MemberExpression") {
      if (isIdentifier(base.base)) {
        callBases.add(`${base.base.name}${base.indexer}${base.identifier.name}`);
      }
      return;
    }

    if (base.type === "IndexExpression" && isIdentifier(base.base)) {
      callBases.add(`${base.base.name}[]`);
    }
  });

  return {
    callBases,
    strings,
  };
}

function pickUniqueHelperName(name, usedNames) {
  if (!name) {
    return null;
  }

  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }

  let counter = 2;
  let candidate = `${name}${counter}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${name}${counter}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function inferHelperAssignmentNames(tableName, functionNode, usedNames) {
  const summary = collectHelperFunctionSummary(functionNode);
  const strings = summary.strings;
  const calls = summary.callBases;

  if (tableName === "v_20") {
    if (strings.has("UIGradient")) {
      return [pickUniqueHelperName("CreateGradient", usedNames)];
    }
    if (strings.has("UIStroke") && calls.has("Color3.fromRGB")) {
      return [pickUniqueHelperName("BorderTransparency", usedNames)];
    }
    if (strings.has("UIStroke")) {
      return [pickUniqueHelperName("CreateStroke", usedNames)];
    }
    if (strings.has("UICorner") && calls.has("UDim[]")) {
      return [pickUniqueHelperName("Round", usedNames)];
    }
    if (strings.has("UICorner")) {
      return [pickUniqueHelperName("RoundCustom", usedNames)];
    }
    if (strings.has("BlurEffect")) {
      return [pickUniqueHelperName("Blur", usedNames)];
    }
    if (strings.has("Back") && calls.has("v_20.Out")) {
      return [pickUniqueHelperName("Bounce", usedNames)];
    }
    if (strings.has("Play") && calls.has("Create")) {
      const names = [pickUniqueHelperName("Out", usedNames)];
      if (!usedNames.has("Medium")) {
        names.push(pickUniqueHelperName("Medium", usedNames));
      }
      return names.filter(Boolean);
    }
  }

  if (tableName === "v_22") {
    if (strings.has("ToastSpacing") && strings.has("ActiveToasts")) {
      return [pickUniqueHelperName("RepositionToasts", usedNames)];
    }
    if (strings.has("ActiveToasts") && strings.has("MaxToasts")) {
      return [pickUniqueHelperName("Notify", usedNames)];
    }
  }

  return [];
}

function buildRoundHelperFunction() {
  return createFunctionExpression(
    [createLocalIdentifier("parent"), createLocalIdentifier("radius")],
    [
      createLocalStatementWithIdentifier(
        "uICorner",
        createCallExpression(createMemberExpression(createIdentifier("Instance"), "new"), [createStringLiteral("UICorner")]),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uICorner"), "CornerRadius"),
        createCallExpression(createMemberExpression(createIdentifier("UDim"), "new"), [
          createNumericLiteral(0),
          createLocalIdentifier("radius"),
        ]),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uICorner"), "Parent"),
        createLocalIdentifier("parent"),
      ),
      {
        type: "ReturnStatement",
        arguments: [createLocalIdentifier("uICorner")],
      },
    ],
  );
}

function buildCreateStrokeHelperFunction(defaultTransparency, includeDefaultColor = false) {
  const colorValue = includeDefaultColor
    ? createLogicalOr(
        createLocalIdentifier("color"),
        createCallExpression(createMemberExpression(createIdentifier("Color3"), "fromRGB"), [
          createNumericLiteral(1),
          createNumericLiteral(1),
          createNumericLiteral(1),
        ]),
      )
    : createLocalIdentifier("color");

  return createFunctionExpression(
    [
      createLocalIdentifier("parent"),
      createLocalIdentifier("color"),
      createLocalIdentifier("thickness"),
      createLocalIdentifier("transparency"),
    ],
    [
      createLocalStatementWithIdentifier(
        "uIStroke",
        createCallExpression(createMemberExpression(createIdentifier("Instance"), "new"), [createStringLiteral("UIStroke")]),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIStroke"), "Color"),
        colorValue,
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIStroke"), "Thickness"),
        createLogicalOr(createLocalIdentifier("thickness"), createNumericLiteral(1)),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIStroke"), "Transparency"),
        createLogicalOr(createLocalIdentifier("transparency"), createNumericLiteral(defaultTransparency)),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIStroke"), "ApplyStrokeMode"),
        createMemberExpression(
          createMemberExpression(createIdentifier("Enum"), "ApplyStrokeMode"),
          "Border",
        ),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIStroke"), "Parent"),
        createLocalIdentifier("parent"),
      ),
      {
        type: "ReturnStatement",
        arguments: [createLocalIdentifier("uIStroke")],
      },
    ],
  );
}

function buildCreateGradientHelperFunction() {
  return createFunctionExpression(
    [
      createLocalIdentifier("parent"),
      createLocalIdentifier("startColor"),
      createLocalIdentifier("endColor"),
      createLocalIdentifier("rotation"),
    ],
    [
      createLocalStatementWithIdentifier(
        "uIGradient",
        createCallExpression(createMemberExpression(createIdentifier("Instance"), "new"), [createStringLiteral("UIGradient")]),
      ),
      createLocalStatementWithIdentifier(
        "keypoints",
        createTableConstructor([
          createTableValue(
            createCallExpression(createMemberExpression(createIdentifier("ColorSequenceKeypoint"), "new"), [
              createNumericLiteral(0),
              createLocalIdentifier("startColor"),
            ]),
          ),
          createTableValue(
            createCallExpression(createMemberExpression(createIdentifier("ColorSequenceKeypoint"), "new"), [
              createNumericLiteral(1),
              createLocalIdentifier("endColor"),
            ]),
          ),
        ]),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIGradient"), "Color"),
        createCallExpression(createMemberExpression(createIdentifier("ColorSequence"), "new"), [
          createLocalIdentifier("keypoints"),
        ]),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIGradient"), "Rotation"),
        createLocalIdentifier("rotation"),
      ),
      createAssignmentStatement(
        createMemberExpression(createLocalIdentifier("uIGradient"), "Parent"),
        createLocalIdentifier("parent"),
      ),
      {
        type: "ReturnStatement",
        arguments: [createLocalIdentifier("uIGradient")],
      },
    ],
  );
}

function rebuildBrokenHelperFunction(functionNode, primaryName) {
  if (!primaryName) {
    return functionNode;
  }

  if (primaryName === "Round") {
    return buildRoundHelperFunction();
  }

  if (primaryName === "CreateStroke") {
    return buildCreateStrokeHelperFunction(0.77, false);
  }

  if (primaryName === "BorderTransparency") {
    return buildCreateStrokeHelperFunction(0.9, true);
  }

  if (primaryName === "CreateGradient") {
    return buildCreateGradientHelperFunction();
  }

  return functionNode;
}

function repairHelperTableAssignments(statements) {
  const output = [];
  const bindings = new Map();
  const helperNamesByTable = new Map();
  let lastTableName = null;

  const recordBinding = (statement) => {
    if (!isSingleLocalIdentifierStatement(statement)) {
      return;
    }

    const name = statement.variables[0].name;
    const initializer = statement.init[0];
    if (initializer.type === "StringLiteral") {
      bindings.set(name, { kind: "string", value: initializer.value });
      return;
    }
    if (initializer.type === "FunctionDeclaration") {
      bindings.set(name, { kind: "function" });
      return;
    }
    if (initializer.type === "TableConstructorExpression") {
      bindings.set(name, { kind: "table" });
      lastTableName = name;
    }
  };

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];

    if (isLocalFunctionBinding(statement) && isFunctionAliasAssignment(statements[index + 1], statement.variables[0].name)) {
      const assignment = statements[index + 1];
      const baseName = assignment.variables[0].base.name;
      const baseBinding = bindings.get(baseName);
      const targetTable = lastTableName;

      if (targetTable && (!baseBinding || baseBinding.kind !== "table")) {
        const usedNames = helperNamesByTable.get(targetTable) || new Set();
        const helperNames = inferHelperAssignmentNames(targetTable, statement.init[0], usedNames);
        helperNamesByTable.set(targetTable, usedNames);

        const rebuiltFunction = rebuildBrokenHelperFunction(statement.init[0], helperNames[0] || null);
        const rewrittenFunction = {
          ...statement,
          init: [rebuiltFunction],
        };

        output.push(rewrittenFunction);
        recordBinding(rewrittenFunction);

        if (helperNames.length > 0) {
          helperNames.forEach((helperName) => {
            output.push({
              type: "AssignmentStatement",
              variables: [toPropertyNode(createLocalIdentifier(targetTable), helperName)],
              init: [createLocalIdentifier(statement.variables[0].name)],
            });
          });
        } else {
          output.push({
            ...assignment,
            variables: [
              {
                ...assignment.variables[0],
                base: createLocalIdentifier(targetTable),
              },
            ],
          });
        }

        index += 1;
        continue;
      }
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: repairHelperTableAssignments(clause.body || []),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
      output.push({
        ...statement,
        body: repairHelperTableAssignments(statement.body),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: repairHelperTableAssignments(statement.body),
      });
      continue;
    }

    output.push(statement);
    recordBinding(statement);
  }

  return output;
}

function recoverRobloxUiAssignments(statements, inheritedInstances = new Map(), inheritedLocalPlayerAliases = new Set()) {
  const localConstructors = collectBlockInstanceConstructors(statements);
  const blockInstances = new Map(inheritedInstances);
  for (const [name, className] of localConstructors.entries()) {
    blockInstances.set(name, className);
  }
  const localPlayerAliases = collectLocalPlayerAliases(statements, inheritedLocalPlayerAliases);

  const { usageHints, explicitProperties } = collectInstanceUsageHints(statements, blockInstances);
  const normalizedInstances = new Map(inheritedInstances);
  for (const [name, className] of localConstructors.entries()) {
    normalizedInstances.set(name, normalizeRobloxUiClassName(className, usageHints.get(name) || new Set()));
  }

  const objectStates = new Map();
  for (const [name, className] of normalizedInstances.entries()) {
    objectStates.set(name, {
      className,
      assigned: new Set(explicitProperties.get(name) || []),
    });
  }
  const localValueKinds = new Map();
  const constructorStatements = new Map();

  const updateLocalValueKinds = (statement) => {
    if (
      !statement ||
      (statement.type !== "LocalStatement" && statement.type !== "AssignmentStatement")
    ) {
      return;
    }

    const pairCount = Math.min(statement.variables.length, statement.init.length);
    for (let index = 0; index < pairCount; index += 1) {
      const variable = statement.variables[index];
      if (!isIdentifier(variable)) {
        continue;
      }

      const kind = classifyUiAssignmentValue(statement.init[index], localValueKinds);
      if (kind === "unknown") {
        localValueKinds.delete(variable.name);
      } else {
        localValueKinds.set(variable.name, kind);
      }
    }
  };

  const rewriteStatement = (statement) => {
    if (!statement || typeof statement !== "object") {
      return statement;
    }

    if (
      (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") &&
      Array.isArray(statement.init) &&
      statement.init.some((initializer) => {
        const expression = unwrapParentheses(initializer);
        return expression && expression.type === "FunctionDeclaration";
      })
    ) {
      return {
        ...statement,
        init: statement.init.map((initializer) => {
          const expression = unwrapParentheses(initializer);
          if (!expression || expression.type !== "FunctionDeclaration") {
            return initializer;
          }

          return {
            ...expression,
            body: recoverRobloxUiAssignments(expression.body || [], normalizedInstances, localPlayerAliases),
          };
        }),
      };
    }

    if (statement.type === "IfStatement") {
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: recoverRobloxUiAssignments(clause.body || [], normalizedInstances, localPlayerAliases),
        })),
      };
    }

    if (statement.type === "WhileStatement") {
      return {
        ...statement,
        body: recoverRobloxUiAssignments(statement.body, normalizedInstances, localPlayerAliases),
      };
    }

    if (statement.type === "RepeatStatement") {
      return {
        ...statement,
        body: recoverRobloxUiAssignments(statement.body, normalizedInstances, localPlayerAliases),
      };
    }

    if (statement.type === "DoStatement") {
      return {
        ...statement,
        body: recoverRobloxUiAssignments(statement.body, normalizedInstances, localPlayerAliases),
      };
    }

    if (statement.type === "FunctionDeclaration") {
      return {
        ...statement,
        body: recoverRobloxUiAssignments(statement.body, normalizedInstances, localPlayerAliases),
      };
    }

    if (
      (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      isIdentifier(statement.variables[0])
    ) {
      const name = statement.variables[0].name;
      const className = normalizedInstances.get(name);
      if (className) {
        const initializer = unwrapParentheses(statement.init[0]);
        if (
          initializer &&
          initializer.type === "CallExpression" &&
          initializer.base &&
          initializer.base.type === "MemberExpression" &&
          isIdentifier(initializer.base.base, "Instance") &&
          initializer.base.identifier.name === "new" &&
          initializer.arguments.length >= 1 &&
          isStringLiteral(initializer.arguments[0]) &&
          initializer.arguments[0].value !== className
        ) {
          const nextArguments = initializer.arguments.slice();
          nextArguments[0] = createStringLiteral(className);
          return {
            ...statement,
            init: [
              {
                ...initializer,
                arguments: nextArguments,
              },
            ],
          };
        }
      }
    }

    if (
      statement.type === "AssignmentStatement" &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      statement.variables[0].type === "IndexExpression" &&
      isIdentifier(statement.variables[0].base)
    ) {
      const baseName = statement.variables[0].base.name;
      const index = unwrapParentheses(statement.variables[0].index);
      let objectName = baseName;
      let helperStyleAssignment = false;
      if (
        !objectStates.has(objectName) &&
        isIdentifier(index) &&
        looksProxyLikeBaseName(baseName) &&
        objectStates.has(index.name)
      ) {
        objectName = index.name;
        helperStyleAssignment = true;
      }

      const objectState = objectStates.get(objectName);
      if (objectState && (!index || index.type !== "StringLiteral")) {
        const valueKind = classifyUiAssignmentValue(statement.init[0], localValueKinds);
        let propertyName = chooseUiPropertyName(objectState.className, valueKind, objectState);
        if (!propertyName && valueKind === "udim") {
          objectState.className = "UICorner";
          const constructorStatement = constructorStatements.get(objectName);
          if (
            constructorStatement &&
            constructorStatement.init &&
            constructorStatement.init.length === 1
          ) {
            const initializer = unwrapParentheses(constructorStatement.init[0]);
            if (
              initializer &&
              initializer.type === "CallExpression" &&
              initializer.base &&
              initializer.base.type === "MemberExpression" &&
              isIdentifier(initializer.base.base, "Instance") &&
              initializer.base.identifier.name === "new" &&
              initializer.arguments.length >= 1
            ) {
              const nextArguments = initializer.arguments.slice();
              nextArguments[0] = createStringLiteral("UICorner");
              constructorStatement.init = [
                {
                  ...initializer,
                  arguments: nextArguments,
                },
              ];
            }
          }
          propertyName = chooseUiPropertyName(objectState.className, valueKind, objectState);
        }
        if (propertyName) {
          objectState.assigned.add(propertyName);
          return {
            ...statement,
            variables: [
              helperStyleAssignment
                ? toPropertyNode(createLocalIdentifier(objectName), propertyName)
                : rewriteUiAssignmentVariable(statement.variables[0], propertyName),
            ],
          };
        }
      }
    }

    if (
      statement.type === "AssignmentStatement" &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      statement.variables[0].type === "MemberExpression" &&
      isIdentifier(statement.variables[0].base) &&
      statement.variables[0].identifier &&
      typeof statement.variables[0].identifier.name === "string"
    ) {
      const baseName = statement.variables[0].base.name;
      const objectState = objectStates.get(baseName);
      const classHints = objectState ? UI_CLASS_PROPERTY_HINTS[objectState.className] : null;
      if (objectState && classHints) {
        const valueKind = classifyUiAssignmentValue(statement.init[0], localValueKinds);
        const candidates = classHints[valueKind] || [];
        const currentProperty = statement.variables[0].identifier.name;

        if (candidates.length > 0) {
          if (!candidates.includes(currentProperty)) {
            const propertyName = chooseUiPropertyName(objectState.className, valueKind, objectState);
            if (propertyName) {
              objectState.assigned.add(propertyName);
              return {
                ...statement,
                variables: [toPropertyNode(statement.variables[0].base, propertyName)],
              };
            }
          }

          objectState.assigned.add(currentProperty);
        }
      }
    }

    if (
      statement.type === "AssignmentStatement" &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      statement.variables[0].type === "MemberExpression" &&
      statement.variables[0].identifier &&
      statement.variables[0].identifier.name === "Parent"
    ) {
      const owner = statement.variables[0].base;
      const ownerName = isIdentifier(owner) ? owner.name : null;
      const objectState = ownerName ? objectStates.get(ownerName) : null;
      const initializer = unwrapParentheses(statement.init[0]);
      if (
        objectState &&
        objectState.className === "ScreenGui" &&
        initializer &&
        initializer.type === "IndexExpression" &&
        isIdentifier(initializer.base) &&
        localPlayerAliases.has(initializer.base.name) &&
        !isStringLiteral(unwrapParentheses(initializer.index))
      ) {
        return {
          ...statement,
          init: [toPropertyNode(initializer.base, "PlayerGui")],
        };
      }
    }

    return statement;
  };

  const output = [];
  for (const statement of statements) {
    const rewritten = rewriteStatement(statement);
    output.push(rewritten);
    if (
      rewritten &&
      (rewritten.type === "LocalStatement" || rewritten.type === "AssignmentStatement") &&
      rewritten.variables &&
      rewritten.variables.length === 1 &&
      rewritten.init &&
      rewritten.init.length === 1 &&
      isIdentifier(rewritten.variables[0])
    ) {
      const initializer = unwrapParentheses(rewritten.init[0]);
      if (
        initializer &&
        initializer.type === "CallExpression" &&
        initializer.base &&
        initializer.base.type === "MemberExpression" &&
        isIdentifier(initializer.base.base, "Instance") &&
        initializer.base.identifier.name === "new"
      ) {
        constructorStatements.set(rewritten.variables[0].name, rewritten);
      }
    }
    updateLocalValueKinds(rewritten);
  }

  return output;
}

function isProxyLookupExpression(node, knownProxyNames = new Set()) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "IndexExpression") {
    return false;
  }

  const base = unwrapParentheses(expression.base);
  return (
    isIdentifier(base) &&
    isObfuscatedProxyIdentifierName(base.name, knownProxyNames)
  );
}

function createLocalPlayerCharacterNode() {
  return toPropertyNode(
    toPropertyNode(
      toPropertyNode(createIdentifier("game"), "Players"),
      "LocalPlayer",
    ),
    "Character",
  );
}

function createLocalPlayerHumanoidRootPartNode() {
  return toPropertyNode(createLocalPlayerCharacterNode(), "HumanoidRootPart");
}

function isWorkspaceDoubleProxyChain(node, knownProxyNames = new Set()) {
  const expression = unwrapParentheses(node);
  if (!expression || expression.type !== "IndexExpression") {
    return false;
  }

  const secondIndex = unwrapParentheses(expression.index);
  if (!isProxyLookupExpression(secondIndex, knownProxyNames)) {
    return false;
  }

  const firstLookup = unwrapParentheses(expression.base);
  if (!firstLookup || firstLookup.type !== "IndexExpression") {
    return false;
  }

  const firstIndex = unwrapParentheses(firstLookup.index);
  if (!isProxyLookupExpression(firstIndex, knownProxyNames)) {
    return false;
  }

  return isIdentifier(firstLookup.base, "workspace");
}

function recoverKnownRobloxMemberAccesses(statements) {
  const knownProxyNames = new Set();
  const collectKnownProxyNames = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collectKnownProxyNames);
      return;
    }
    if (node.type === "Identifier" && isObfuscatedProxyIdentifierName(node.name)) {
      knownProxyNames.add(node.name);
    }
    Object.entries(node).forEach(([key, value]) => {
      if (key === "scope") {
        return;
      }
      collectKnownProxyNames(value);
    });
  };

  collectKnownProxyNames(statements);

  return statements.map((statement) => {
    let rewritten = statement;

    if (
      (statement.type === "LocalStatement" || statement.type === "AssignmentStatement") &&
      statement.variables.length === 1 &&
      statement.init.length === 1 &&
      isIdentifier(statement.variables[0]) &&
      isStringLiteral(unwrapParentheses(statement.init[0]), "PlaceId") &&
      /placeid/i.test(statement.variables[0].name)
    ) {
      rewritten = {
        ...statement,
        init: [
          toPropertyNode({ type: "Identifier", name: "game" }, "PlaceId"),
        ],
      };
    }

    return transformNode(rewritten, (node) => {
      if (
        node.type === "MemberExpression" &&
        node.indexer === "." &&
        node.identifier &&
        node.identifier.name === "Character" &&
        node.base &&
        node.base.type === "IndexExpression" &&
        isIdentifier(node.base.base, "game") &&
        isProxyLookupExpression(node.base.index, knownProxyNames)
      ) {
        return createLocalPlayerCharacterNode();
      }

      if (
        node.type === "MemberExpression" &&
        node.indexer === "." &&
        node.identifier &&
        node.identifier.name === "root" &&
        node.base &&
        isWorkspaceDoubleProxyChain(node.base, knownProxyNames)
      ) {
        return createLocalPlayerHumanoidRootPartNode();
      }

      if (
        node.type === "IndexExpression" &&
        node.base &&
        node.base.type === "MemberExpression" &&
        node.base.identifier &&
        node.base.identifier.name === "CFrame" &&
        node.base.base &&
        node.base.base.type === "MemberExpression" &&
        node.base.base.identifier &&
        node.base.base.identifier.name === "root" &&
        node.base.base.base &&
        isWorkspaceDoubleProxyChain(node.base.base.base, knownProxyNames) &&
        isProxyLookupExpression(node.index, knownProxyNames)
      ) {
        return toPropertyNode(createLocalPlayerHumanoidRootPartNode(), "CFrame");
      }

      if (
        node.type === "IndexExpression" &&
        node.base &&
        node.base.type === "MemberExpression" &&
        node.base.identifier &&
        node.base.identifier.name === "CFrame" &&
        isProxyLookupExpression(node.index, knownProxyNames)
      ) {
        return node.base;
      }

      if (
        node.type === "CallExpression" &&
        node.base &&
        node.base.type === "MemberExpression" &&
        node.base.indexer === ":" &&
        node.base.identifier &&
        node.base.identifier.name === "ScreenPointToRay" &&
        node.base.base &&
        node.base.base.type === "IndexExpression" &&
        isIdentifier(node.base.base.base, "workspace") &&
        !isStringLiteral(unwrapParentheses(node.base.base.index))
      ) {
        return {
          ...node,
          base: {
            ...node.base,
            base: toPropertyNode({ type: "Identifier", name: "workspace" }, "CurrentCamera"),
          },
        };
      }

      if (
        node.type === "MemberExpression" &&
        node.indexer === "." &&
        node.base &&
        node.base.type === "MemberExpression" &&
        node.base.indexer === "." &&
        node.identifier &&
        node.base.identifier &&
        node.base.identifier.name === node.identifier.name
      ) {
        if (
          isIdentifier(node.base.base, "Enum") &&
          /^[A-Z]$/.test(node.identifier.name)
        ) {
          return toPropertyNode(
            toPropertyNode({ type: "Identifier", name: "Enum" }, "KeyCode"),
            node.identifier.name,
          );
        }

        return node.base;
      }

      return node;
    });
  });
}

function rewriteKnownEnumAccesses(statements) {
  const rewriteNode = (node) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map(rewriteNode);
    }

    if (node.type === "MemberExpression") {
      const base = rewriteNode(node.base);
      const memberName = node.identifier && node.identifier.name;
      const enumClass = memberName ? KNOWN_ENUM_MEMBER_TO_CLASS[memberName] : null;
      if (
        enumClass &&
        base &&
        base.type === "IndexExpression" &&
        isIdentifier(base.base, "Enum")
      ) {
        return toPropertyNode(
          toPropertyNode({ type: "Identifier", name: "Enum" }, enumClass),
          memberName,
        );
      }

      if (base !== node.base) {
        return {
          ...node,
          base,
        };
      }

      return node;
    }

    if (node.type === "IndexExpression") {
      const base = rewriteNode(node.base);
      const index = rewriteNode(node.index);
      let memberName = null;
      if (isStringLiteral(index)) {
        memberName = index.value;
      } else if (index && index.type === "MemberExpression" && index.identifier) {
        memberName = index.identifier.name;
      } else if (index && index.type === "IndexExpression" && isStringLiteral(index.index)) {
        memberName = index.index.value;
      }
      const enumClass = memberName ? KNOWN_ENUM_MEMBER_TO_CLASS[memberName] : null;
      if (
        enumClass &&
        base &&
        base.type === "IndexExpression" &&
        isIdentifier(base.base, "Enum")
      ) {
        return toPropertyNode(
          toPropertyNode({ type: "Identifier", name: "Enum" }, enumClass),
          memberName,
        );
      }

      if (base !== node.base || index !== node.index) {
        return {
          ...node,
          base,
          index,
        };
      }

      return node;
    }

    const next = { ...node };
    let changed = false;

    for (const [key, value] of Object.entries(node)) {
      if (key === "scope") {
        continue;
      }

      const nextValue = rewriteNode(value);
      if (nextValue !== value) {
        next[key] = nextValue;
        changed = true;
      }
    }

    return changed ? next : node;
  };

  return statements.map(rewriteNode);
}

function buildUsageMap(statements) {
  const usage = new Map();
  const definitions = new Map();

  const visit = (node, isDef = false) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(n => visit(n, isDef));
      return;
    }

    if (node.type === "Identifier") {
      if (isDef) definitions.set(node.name, (definitions.get(node.name) || 0) + 1);
      else usage.set(node.name, (usage.get(node.name) || 0) + 1);
    } else if (node.type === "LocalStatement") {
      node.init.forEach(n => visit(n, false));
      node.variables.forEach(n => visit(n, true));
    } else if (node.type === "AssignmentStatement") {
      node.init.forEach(n => visit(n, false));
      node.variables.forEach(n => visit(n, true));
    } else if (node.type === "FunctionDeclaration") {
      if (node.identifier) visit(node.identifier, true);
      if (node.parameters) node.parameters.forEach(p => visit(p, true));
      visit(node.body, false);
    } else {
      Object.entries(node).forEach(([k, v]) => {
        if (k === "variables" || k === "identifier" || k === "parameters") return;
        visit(v, false);
      });
    }
  };

  statements.forEach(s => visit(s, false));
  return { usage, definitions };
}

function resolveStringProxiesAndNaming(statements, state) {
  const proxyToGlobal = new Map();
  const callProxies = new Set();
  const likelyGlobalProxies = new Set(["K", "Z", "getfenv", "getgenv", "_G"]);
  const shadowedGlobals = state.shadowedGlobals || new Set();
  const readableStringTableBases = collectLikelyReadableStringTableBases(statements, shadowedGlobals);
  const knownStringProxyNames = collectStringProxyAliases(statements, state.stringProxies);
  const isStringTableBase = (name) => (
    knownStringProxyNames.has(name) ||
    likelyGlobalProxies.has(name) ||
    readableStringTableBases.has(name)
  );

  const pruneAssignedProxyNames = (nodes) => {
    if (!Array.isArray(nodes)) {
      return;
    }

    nodes.forEach((stmt) => {
      if (!stmt || typeof stmt !== "object") {
        return;
      }

      if (stmt.type === "LocalStatement" || stmt.type === "AssignmentStatement") {
        (stmt.variables || []).forEach((variable) => {
          if (isIdentifier(variable)) {
            likelyGlobalProxies.delete(variable.name);
          }
        });
      }

      if (stmt.type === "IfStatement") {
        (stmt.clauses || []).forEach((clause) => pruneAssignedProxyNames(clause.body || []));
        return;
      }

      if (
        stmt.type === "WhileStatement" ||
        stmt.type === "RepeatStatement" ||
        stmt.type === "DoStatement" ||
        stmt.type === "FunctionDeclaration" ||
        stmt.type === "ForNumericStatement" ||
        stmt.type === "ForGenericStatement"
      ) {
        pruneAssignedProxyNames(stmt.body || []);
      }
    });
  };

  pruneAssignedProxyNames(statements);

  statements.forEach(stmt => {
    if (stmt.type === "LocalStatement" && stmt.variables.length === 1 && stmt.init.length === 1) {
      const init = stmt.init[0];
      const name = stmt.variables[0].name;
      if (init.type === "CallExpression" && isIdentifier(init.base) && PAYLOAD_IDENTIFIERS.has(init.base.name) && !shadowedGlobals.has(init.base.name)) {
        proxyToGlobal.set(name, init.base.name);
      } else if (isIdentifier(init) && PAYLOAD_IDENTIFIERS.has(init.name) && !shadowedGlobals.has(init.name)) {
        proxyToGlobal.set(name, init.name);
      } else if ((isIdentifier(init, "select") || isIdentifier(init, "unpack")) && !shadowedGlobals.has(init.name)) {
        callProxies.add(name);
      }
    }
  });

  const transform = (node, context = { inLValue: false }) => {
    if (!node || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((child) => transform(child, context));
    }

    if (node.type === "LocalStatement") {
      return {
        ...node,
        init: node.init.map((expression) => transform(expression, { inLValue: false })),
      };
    }

    if (node.type === "AssignmentStatement") {
      return {
        ...node,
        variables: node.variables.map((variable) => transform(variable, { inLValue: true })),
        init: node.init.map((expression) => transform(expression, { inLValue: false })),
      };
    }

    if (node.type === "FunctionDeclaration") {
      return {
        ...node,
        identifier:
          node.identifier && node.identifier.type !== "Identifier"
            ? transform(node.identifier, { inLValue: true })
            : node.identifier,
        body: transform(node.body, { inLValue: false }),
      };
    }

    if (node.type === "ForNumericStatement") {
      return {
        ...node,
        start: transform(node.start, { inLValue: false }),
        end: transform(node.end, { inLValue: false }),
        step: node.step ? transform(node.step, { inLValue: false }) : node.step,
        body: transform(node.body, { inLValue: false }),
      };
    }

    if (node.type === "ForGenericStatement") {
      return {
        ...node,
        iterators: node.iterators.map((iterator) => transform(iterator, { inLValue: false })),
        body: transform(node.body, { inLValue: false }),
      };
    }

    if (node.type === "IndexExpression") {
      const base = transform(node.base, { inLValue: context.inLValue });
      const resolvedIndex = transform(node.index, { inLValue: false });
      if (!context.inLValue && isIdentifier(base) && isStringTableBase(base.name) && isStringLiteral(resolvedIndex)) {
        const value = state.decodedStringMap.get(resolvedIndex.value) || resolvedIndex.value;
        if (
          readableStringTableBases.has(base.name) &&
          !isReadableHintValue(value) &&
          !isReadableHintValueLoose(value)
        ) {
          return {
            ...node,
            base,
            index: resolvedIndex,
          };
        }
        return {
          type: "StringLiteral",
          value,
          raw: JSON.stringify(value),
          __decrypted: true,
        };
      }
      if (base !== node.base || resolvedIndex !== node.index) {
        return {
          ...node,
          base,
          index: resolvedIndex,
        };
      }
      return node;
    }

    if (node.type === "MemberExpression") {
      const base = transform(node.base, { inLValue: context.inLValue });
      if (!context.inLValue && isIdentifier(base) && isStringTableBase(base.name)) {
        const value = node.identifier.name;
        if (
          !readableStringTableBases.has(base.name) &&
          ((PAYLOAD_IDENTIFIERS.has(value) && !shadowedGlobals.has(value)) || likelyGlobalProxies.has(base.name))
        ) {
          return { type: "Identifier", name: value };
        }
        return {
          type: "StringLiteral",
          value,
          raw: JSON.stringify(value),
          __decrypted: true,
        };
      }

      if (!context.inLValue && isIdentifier(base) && (proxyToGlobal.has(base.name) || likelyGlobalProxies.has(base.name))) {
        if (PAYLOAD_IDENTIFIERS.has(node.identifier.name) && !shadowedGlobals.has(node.identifier.name)) {
          return { type: "Identifier", name: node.identifier.name };
        }
      }

      if (base !== node.base) {
        return {
          ...node,
          base,
        };
      }
      return node;
    }

    if (!context.inLValue && node.type === "CallExpression" && isIdentifier(node.base) && callProxies.has(node.base.name)) {
      if (node.arguments.length >= 1) {
        const target = transform(node.arguments[0], { inLValue: false });
        if (target.type === "MemberExpression" || target.type === "IndexExpression" || target.type === "Identifier" || target.type === "StringLiteral") {
          let base = target;
          if (target.type === "StringLiteral") {
            if (!isValidIdentifierName(target.value)) {
              return node;
            }
            base = { type: "Identifier", name: target.value };
          }
          return {
            ...node,
            base: transform(base, { inLValue: false }),
            arguments: node.arguments.slice(1).map((argument) => transform(argument, { inLValue: false })),
          };
        }
      }
    }

    if (node.type === "Identifier") {
      if (!context.inLValue && proxyToGlobal.has(node.name)) {
        const replacement = proxyToGlobal.get(node.name);
        if (!shadowedGlobals.has(replacement)) {
          return { type: "Identifier", name: replacement };
        }
      }
      return node;
    }

    const next = { ...node };
    let changed = false;
    for (const [key, value] of Object.entries(node)) {
      if (key === "_skipChildren" || key === "variables" || key === "identifier" || key === "parameters" || key === "variable") {
        continue;
      }
      const nextValue = transform(value, { inLValue: false });
      if (nextValue !== value) {
        next[key] = nextValue;
        changed = true;
      }
    }
    return changed ? next : node;
  };

  return statements.map((statement) => transform(statement, { inLValue: false }));
}

function deduplicateBlocks(statements) {
  return statements.map(stmt => {
    if (stmt.type === "IfStatement") {
      stmt.clauses = stmt.clauses.map(c => ({
        ...c,
        body: deduplicateBlocks(c.body)
      }));
    } else if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement" || stmt.type === "FunctionDeclaration") {
      stmt.body = deduplicateBlocks(stmt.body);
    }
    return stmt;
  });
}

function isInlineCandidate(node) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }

  if (isLiteralLike(expression) || expression.type === "Identifier") {
    return true;
  }

  if (expression.type === "FunctionDeclaration") {
    return true;
  }

  if (expression.type === "TableConstructorExpression") {
    if (expression.fields.length === 0) {
      return true;
    }
    if (expression.fields.length <= 2) {
      const isTinyLiteralTable = expression.fields.every((field) => {
        if (!field) {
          return false;
        }
        if (field.type === "TableValue") {
          return isLiteralLike(field.value);
        }
        if (field.type === "TableKeyString") {
          return isLiteralLike(field.value);
        }
        if (field.type === "TableKey") {
          return isLiteralLike(field.key) && isLiteralLike(field.value);
        }
        return false;
      });
      if (isTinyLiteralTable) {
        return true;
      }
    }
  }

  if (expression.type === "CallExpression") {
    const base = unwrapParentheses(expression.base);
    if (
      base &&
      base.type === "MemberExpression" &&
      base.base &&
      base.base.type === "Identifier" &&
      expression.arguments.every((argument) => isPureExpression(argument))
    ) {
      const baseName = base.base.name;
      const memberName = base.identifier && base.identifier.name;
      if (
        (baseName === "UDim2" && memberName === "new") ||
        (baseName === "UDim" && memberName === "new") ||
        (baseName === "Vector2" && memberName === "new") ||
        (baseName === "Vector3" && memberName === "new") ||
        (baseName === "Color3" && (memberName === "fromRGB" || memberName === "fromHSV" || memberName === "new"))
      ) {
        return true;
      }
    }
  }

  if (
    expression.type === "MemberExpression" ||
    expression.type === "IndexExpression" ||
    expression.type === "UnaryExpression" ||
    expression.type === "BinaryExpression" ||
    expression.type === "LogicalExpression"
  ) {
    return isPureExpression(expression);
  }

  return false;
}

function rewriteInlineExpression(node, inlineCandidates, context = { inLValue: false }) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => rewriteInlineExpression(child, inlineCandidates, context));
  }

  if (node.type === "Identifier") {
    if (!context.inLValue && inlineCandidates.has(node.name)) {
      return clone(inlineCandidates.get(node.name));
    }
    return node;
  }

  switch (node.type) {
    case "UnaryExpression":
      return {
        ...node,
        argument: rewriteInlineExpression(node.argument, inlineCandidates, { inLValue: false }),
      };
    case "BinaryExpression":
    case "LogicalExpression":
      return {
        ...node,
        left: rewriteInlineExpression(node.left, inlineCandidates, { inLValue: false }),
        right: rewriteInlineExpression(node.right, inlineCandidates, { inLValue: false }),
      };
    case "IfExpression":
      return {
        ...node,
        condition: rewriteInlineExpression(node.condition, inlineCandidates, { inLValue: false }),
        trueExpression: rewriteInlineExpression(node.trueExpression, inlineCandidates, { inLValue: false }),
        falseExpression: rewriteInlineExpression(node.falseExpression, inlineCandidates, { inLValue: false }),
      };
    case "ParenthesisExpression":
      return {
        ...node,
        expression: rewriteInlineExpression(node.expression, inlineCandidates, { inLValue: context.inLValue }),
      };
    case "IndexExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, inlineCandidates, { inLValue: context.inLValue }),
        index: rewriteInlineExpression(node.index, inlineCandidates, { inLValue: false }),
      };
    case "MemberExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, inlineCandidates, { inLValue: context.inLValue }),
      };
    case "CallExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, inlineCandidates, { inLValue: false }),
        arguments: node.arguments.map((argument) => rewriteInlineExpression(argument, inlineCandidates, { inLValue: false })),
      };
    case "TableCallExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, inlineCandidates, { inLValue: false }),
        arguments: rewriteInlineExpression(node.arguments, inlineCandidates, { inLValue: false }),
      };
    case "StringCallExpression":
      return {
        ...node,
        base: rewriteInlineExpression(node.base, inlineCandidates, { inLValue: false }),
        argument: rewriteInlineExpression(node.argument, inlineCandidates, { inLValue: false }),
      };
    case "TableConstructorExpression":
      return {
        ...node,
        fields: node.fields.map((field) => {
          if (field.type === "TableValue") {
            return {
              ...field,
              value: rewriteInlineExpression(field.value, inlineCandidates, { inLValue: false }),
            };
          }
          if (field.type === "TableKey") {
            return {
              ...field,
              key: rewriteInlineExpression(field.key, inlineCandidates, { inLValue: false }),
              value: rewriteInlineExpression(field.value, inlineCandidates, { inLValue: false }),
            };
          }
          if (field.type === "TableKeyString") {
            return {
              ...field,
              value: rewriteInlineExpression(field.value, inlineCandidates, { inLValue: false }),
            };
          }
          return field;
        }),
      };
    case "FunctionDeclaration":
      return {
        ...node,
        body: inlineSingleUsageLocals(node.body),
      };
    default: {
      const next = { ...node };
      let changed = false;
      for (const [key, value] of Object.entries(node)) {
        if (key === "scope" || key === "identifier" || key === "parameters" || key === "variables" || key === "variable") {
          continue;
        }
        const nextValue = rewriteInlineExpression(value, inlineCandidates, { inLValue: false });
        if (nextValue !== value) {
          next[key] = nextValue;
          changed = true;
        }
      }
      return changed ? next : node;
    }
  }
}

function rewriteInlineStatement(statement, inlineCandidates) {
  if (!statement || typeof statement !== "object") {
    return statement;
  }

  switch (statement.type) {
    case "LocalStatement":
      return {
        ...statement,
        init: statement.init.map((expression) => rewriteInlineExpression(expression, inlineCandidates, { inLValue: false })),
      };
    case "AssignmentStatement":
      return {
        ...statement,
        variables: statement.variables.map((variable) => rewriteInlineExpression(variable, inlineCandidates, { inLValue: true })),
        init: statement.init.map((expression) => rewriteInlineExpression(expression, inlineCandidates, { inLValue: false })),
      };
    case "CallStatement":
      return {
        ...statement,
        expression: rewriteInlineExpression(statement.expression, inlineCandidates, { inLValue: false }),
      };
    case "ReturnStatement":
      return {
        ...statement,
        arguments: statement.arguments.map((argument) => rewriteInlineExpression(argument, inlineCandidates, { inLValue: false })),
      };
    case "IfStatement":
      return {
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? rewriteInlineExpression(clause.condition, inlineCandidates, { inLValue: false }) : clause.condition,
          body: inlineSingleUsageLocals(clause.body || []),
        })),
      };
    case "WhileStatement":
      return {
        ...statement,
        condition: rewriteInlineExpression(statement.condition, inlineCandidates, { inLValue: false }),
        body: inlineSingleUsageLocals(statement.body),
      };
    case "RepeatStatement":
      return {
        ...statement,
        condition: rewriteInlineExpression(statement.condition, inlineCandidates, { inLValue: false }),
        body: inlineSingleUsageLocals(statement.body),
      };
    case "DoStatement":
      return {
        ...statement,
        body: inlineSingleUsageLocals(statement.body),
      };
    case "ForNumericStatement":
      return {
        ...statement,
        start: rewriteInlineExpression(statement.start, inlineCandidates, { inLValue: false }),
        end: rewriteInlineExpression(statement.end, inlineCandidates, { inLValue: false }),
        step: statement.step ? rewriteInlineExpression(statement.step, inlineCandidates, { inLValue: false }) : statement.step,
        body: inlineSingleUsageLocals(statement.body),
      };
    case "ForGenericStatement":
      return {
        ...statement,
        iterators: statement.iterators.map((iterator) => rewriteInlineExpression(iterator, inlineCandidates, { inLValue: false })),
        body: inlineSingleUsageLocals(statement.body),
      };
    case "FunctionDeclaration":
      return {
        ...statement,
        identifier:
          statement.identifier && statement.identifier.type !== "Identifier"
            ? rewriteInlineExpression(statement.identifier, inlineCandidates, { inLValue: true })
            : statement.identifier,
        body: inlineSingleUsageLocals(statement.body),
      };
    default:
      return rewriteInlineExpression(statement, inlineCandidates, { inLValue: false });
  }
}

function inlineSingleUsageLocals(statements, state) {
  let current = statements.map((statement) => rewriteInlineStatement(statement, new Map()));

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const { usage, definitions } = buildUsageMap(current);
    const inlineCandidates = new Map();

    const survivors = [];
    for (const stmt of current) {
      if (stmt.type === "LocalStatement" && stmt.variables.length === 1 && stmt.init.length === 1) {
        const name = stmt.variables[0].name;
        const init = stmt.init[0];
        const unwrappedInit = unwrapParentheses(init);
        if (
          definitions.get(name) === 1 &&
          usage.get(name) === 1 &&
          isInlineCandidate(init) &&
          !(unwrappedInit && unwrappedInit.type === "StringLiteral")
        ) {
          inlineCandidates.set(name, init);
          continue;
        }
      }
      survivors.push(stmt);
    }

    if (inlineCandidates.size === 0) {
      break;
    }

    current = survivors.map((statement) => rewriteInlineStatement(statement, inlineCandidates));
  }

  return current;
}

function inlineSingleUsageLocalsAst(ast) {
  if (!ast || !Array.isArray(ast.body)) {
    return {
      ast,
      changed: false,
    };
  }

  const body = inlineSingleUsageLocals(ast.body);
  if (deepEqual(body, ast.body)) {
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

function countParamUsage(node, paramSet, usage = new Map()) {
  if (!node || typeof node !== "object") {
    return usage;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => countParamUsage(child, paramSet, usage));
    return usage;
  }

  if (node.type === "Identifier" && paramSet.has(node.name)) {
    usage.set(node.name, (usage.get(node.name) || 0) + 1);
    return usage;
  }

  if (node.type === "FunctionDeclaration") {
    return usage;
  }

  Object.values(node).forEach((child) => countParamUsage(child, paramSet, usage));
  return usage;
}

function containsUnknownIdentifiers(node, paramSet) {
  let unknown = false;

  const walkNode = (current) => {
    if (!current || typeof current !== "object" || unknown) {
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(walkNode);
      return;
    }
    if (current.type === "Identifier" && !paramSet.has(current.name)) {
      unknown = true;
      return;
    }
    if (current.type === "FunctionDeclaration") {
      return;
    }
    Object.values(current).forEach(walkNode);
  };

  walkNode(node);
  return unknown;
}

function containsNestedFunction(node) {
  let found = false;

  const walkNode = (current) => {
    if (!current || typeof current !== "object" || found) {
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(walkNode);
      return;
    }
    if (current.type === "FunctionDeclaration") {
      found = true;
      return;
    }
    Object.values(current).forEach(walkNode);
  };

  walkNode(node);
  return found;
}

function getWrapperInfoFromFunction(fn, name) {
  if (!fn || fn.type !== "FunctionDeclaration") {
    return null;
  }

  if (fn.body.length !== 1) {
    return null;
  }

  const returnStatement = fn.body[0];
  if (!returnStatement || returnStatement.type !== "ReturnStatement" || returnStatement.arguments.length !== 1) {
    return null;
  }

  const expression = unwrapParentheses(returnStatement.arguments[0]);
  if (!expression) {
    return null;
  }

  const params = [];
  let hasVararg = false;
  for (let index = 0; index < fn.parameters.length; index += 1) {
    const param = fn.parameters[index];
    if (param.type === "Identifier") {
      params.push(param.name);
      continue;
    }
    if (param.type === "VarargLiteral" && index === fn.parameters.length - 1) {
      hasVararg = true;
      continue;
    }
    return null;
  }

  const paramSet = new Set(params);

  if (!hasVararg && params.length === 1 && expression.type === "Identifier" && expression.name === params[0]) {
    return {
      name,
      kind: "identity",
      params,
      hasVararg,
      expression,
      paramUsage: new Map([[params[0], 1]]),
    };
  }

  if (expression.type === "CallExpression") {
    if (expression.base.type === "Identifier" && expression.base.name === name) {
      return null;
    }

    if (containsNestedFunction(expression)) {
      return null;
    }

    const args = expression.arguments;
    let sawVararg = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg.type === "VarargLiteral") {
        if (!hasVararg || index !== args.length - 1) {
          return null;
        }
        sawVararg = true;
        continue;
      }
      if (!isPureExpression(arg)) {
        return null;
      }
      if (containsUnknownIdentifiers(arg, paramSet)) {
        return null;
      }
    }

    if (!hasVararg && sawVararg) {
      return null;
    }

    return {
      name,
      kind: "call",
      params,
      hasVararg,
      expression,
      paramUsage: countParamUsage(expression, new Set(params)),
    };
  }

  if (!hasVararg && isPureExpression(expression)) {
    if (containsNestedFunction(expression)) {
      return null;
    }
    if (containsUnknownIdentifiers(expression, paramSet)) {
      return null;
    }

    return {
      name,
      kind: "expr",
      params,
      hasVararg,
      expression,
      paramUsage: countParamUsage(expression, paramSet),
    };
  }

  return null;
}

function collectWrapperInfo(statement) {
  if (statement.type === "FunctionDeclaration" && statement.isLocal && statement.identifier && statement.identifier.type === "Identifier") {
    return getWrapperInfoFromFunction(statement, statement.identifier.name);
  }

  if (
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    statement.variables[0].type === "Identifier" &&
    statement.init[0].type === "FunctionDeclaration"
  ) {
    return getWrapperInfoFromFunction(statement.init[0], statement.variables[0].name);
  }

  return null;
}

function substituteExpression(node, replacements) {
  return transformNode(clone(node), (child) => {
    if (child.type === "Identifier" && replacements.has(child.name)) {
      return clone(replacements.get(child.name));
    }
    return child;
  });
}

function applyWrapperInline(wrapper, callArgs) {
  const paramCount = wrapper.params.length;
  if (callArgs.length < paramCount) {
    return null;
  }

  if (!wrapper.hasVararg && callArgs.length !== paramCount) {
    return null;
  }

  const replacements = new Map();
  for (let index = 0; index < paramCount; index += 1) {
    replacements.set(wrapper.params[index], callArgs[index]);
  }

  const requiresPureArgs = [];
  for (const param of wrapper.params) {
    const count = wrapper.paramUsage.get(param) || 0;
    if (count !== 1) {
      requiresPureArgs.push(param);
    }
  }

  if (requiresPureArgs.length > 0) {
    for (const param of requiresPureArgs) {
      const arg = replacements.get(param);
      if (!arg || !isPureExpression(arg)) {
        return null;
      }
    }
  }

  if (wrapper.kind === "identity") {
    if (callArgs.length !== 1) {
      return null;
    }
    return clone(callArgs[0]);
  }

  if (wrapper.kind === "expr") {
    return substituteExpression(wrapper.expression, replacements);
  }

  if (wrapper.kind === "call") {
    const callExpression = wrapper.expression;
    const base = substituteExpression(callExpression.base, replacements);
    const args = [];
    const restArgs = wrapper.hasVararg ? callArgs.slice(paramCount) : [];

    for (const arg of callExpression.arguments) {
      if (arg.type === "VarargLiteral") {
        if (!wrapper.hasVararg) {
          return null;
        }
        restArgs.forEach((rest) => args.push(clone(rest)));
        continue;
      }
      args.push(substituteExpression(arg, replacements));
    }

    return {
      ...callExpression,
      base,
      arguments: args,
    };
  }

  return null;
}

function isWrapperDeclaration(statement, wrapperNames) {
  if (statement.type === "FunctionDeclaration" && statement.isLocal && statement.identifier && wrapperNames.has(statement.identifier.name)) {
    return statement.identifier.name;
  }

  if (
    statement.type === "LocalStatement" &&
    statement.variables.length === 1 &&
    statement.init.length === 1 &&
    statement.variables[0].type === "Identifier" &&
    statement.init[0].type === "FunctionDeclaration" &&
    wrapperNames.has(statement.variables[0].name)
  ) {
    return statement.variables[0].name;
  }

  return null;
}

function inlineSimpleWrappers(statements) {
  const wrappers = new Map();
  for (const statement of statements) {
    const wrapper = collectWrapperInfo(statement);
    if (wrapper) {
      wrappers.set(wrapper.name, wrapper);
    }
  }

  if (wrappers.size === 0) {
    return statements;
  }

  const rewritten = statements.map((stmt) => transformNode(stmt, (node) => {
    if (node.type === "CallExpression" && node.base.type === "Identifier" && wrappers.has(node.base.name)) {
      const wrapper = wrappers.get(node.base.name);
      const replacement = applyWrapperInline(wrapper, node.arguments);
      if (replacement) {
        return replacement;
      }
    }
    return node;
  }));

  const { usage } = buildUsageMap(rewritten);
  const wrapperNames = new Set(wrappers.keys());

  return rewritten.filter((statement) => {
    const name = isWrapperDeclaration(statement, wrapperNames);
    if (!name) {
      return true;
    }
    return (usage.get(name) || 0) > 0;
  });
}

function replaceIdentifiersWithConstants(node, constants, context = { inLValue: false }) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => replaceIdentifiersWithConstants(child, constants, context));
  }

  if (node.type === "Identifier") {
    if (!context.inLValue && constants.has(node.name)) {
      return clone(constants.get(node.name));
    }
    return node;
  }

  switch (node.type) {
    case "IndexExpression":
      return {
        ...node,
        base: replaceIdentifiersWithConstants(node.base, constants, { inLValue: context.inLValue }),
        index: replaceIdentifiersWithConstants(node.index, constants, { inLValue: false }),
      };
    case "MemberExpression":
      return {
        ...node,
        base: replaceIdentifiersWithConstants(node.base, constants, { inLValue: context.inLValue }),
      };
    case "UnaryExpression":
      return {
        ...node,
        argument: replaceIdentifiersWithConstants(node.argument, constants, { inLValue: false }),
      };
    case "BinaryExpression":
    case "LogicalExpression":
      return {
        ...node,
        left: replaceIdentifiersWithConstants(node.left, constants, { inLValue: false }),
        right: replaceIdentifiersWithConstants(node.right, constants, { inLValue: false }),
      };
    case "IfExpression":
      return {
        ...node,
        condition: replaceIdentifiersWithConstants(node.condition, constants, { inLValue: false }),
        trueExpression: replaceIdentifiersWithConstants(node.trueExpression, constants, { inLValue: false }),
        falseExpression: replaceIdentifiersWithConstants(node.falseExpression, constants, { inLValue: false }),
      };
    case "ParenthesisExpression":
      return {
        ...node,
        expression: replaceIdentifiersWithConstants(node.expression, constants, { inLValue: context.inLValue }),
      };
    case "CallExpression":
      return {
        ...node,
        base: replaceIdentifiersWithConstants(node.base, constants, { inLValue: false }),
        arguments: node.arguments.map((arg) => replaceIdentifiersWithConstants(arg, constants, { inLValue: false })),
      };
    case "TableCallExpression":
      return {
        ...node,
        base: replaceIdentifiersWithConstants(node.base, constants, { inLValue: false }),
        arguments: replaceIdentifiersWithConstants(node.arguments, constants, { inLValue: false }),
      };
    case "StringCallExpression":
      return {
        ...node,
        base: replaceIdentifiersWithConstants(node.base, constants, { inLValue: false }),
        argument: replaceIdentifiersWithConstants(node.argument, constants, { inLValue: false }),
      };
    case "TableConstructorExpression":
      return {
        ...node,
        fields: node.fields.map((field) => {
          if (field.type === "TableValue") {
            return {
              ...field,
              value: replaceIdentifiersWithConstants(field.value, constants, { inLValue: false }),
            };
          }
          if (field.type === "TableKey") {
            return {
              ...field,
              key: replaceIdentifiersWithConstants(field.key, constants, { inLValue: false }),
              value: replaceIdentifiersWithConstants(field.value, constants, { inLValue: false }),
            };
          }
          if (field.type === "TableKeyString") {
            return {
              ...field,
              value: replaceIdentifiersWithConstants(field.value, constants, { inLValue: false }),
            };
          }
          return field;
        }),
      };
    case "FunctionDeclaration": {
      const innerConstants = new Map(constants);
      node.parameters.forEach((param) => {
        if (param.type === "Identifier") {
          innerConstants.delete(param.name);
        }
      });
      return {
        ...node,
        body: propagateLiteralLocals(node.body, innerConstants),
      };
    }
    default: {
      const next = { ...node };
      let changed = false;
      for (const [key, value] of Object.entries(node)) {
        if (key === "scope") {
          continue;
        }
        const replaced = replaceIdentifiersWithConstants(value, constants, { inLValue: false });
        if (replaced !== value) {
          next[key] = replaced;
          changed = true;
        }
      }
      return changed ? next : node;
    }
  }
}

function propagateLiteralLocals(statements, inheritedConstants = new Map()) {
  const { definitions } = buildUsageMap(statements);
  const constants = new Map(inheritedConstants);
  const output = [];

  for (const statement of statements) {
    if (statement.type === "LocalStatement") {
      const nextInit = statement.init.map((expr) => replaceIdentifiersWithConstants(expr, constants, { inLValue: false }));
      const nextStatement = {
        ...statement,
        init: nextInit,
      };

      output.push(nextStatement);

      for (let index = 0; index < statement.variables.length; index += 1) {
        const variable = statement.variables[index];
        if (!variable || variable.type !== "Identifier") {
          continue;
        }
        const name = variable.name;
        const initializer = nextInit[index];
        constants.delete(name);
        if (initializer && isLiteralLike(initializer) && (definitions.get(name) || 0) === 1) {
          constants.set(name, clone(initializer));
        }
      }
      continue;
    }

    if (statement.type === "AssignmentStatement") {
      const nextStatement = {
        ...statement,
        variables: statement.variables.map((variable) => replaceIdentifiersWithConstants(variable, constants, { inLValue: true })),
        init: statement.init.map((expr) => replaceIdentifiersWithConstants(expr, constants, { inLValue: false })),
      };
      output.push(nextStatement);

      for (const variable of statement.variables) {
        if (variable.type === "Identifier") {
          constants.delete(variable.name);
        }
      }
      continue;
    }

    if (statement.type === "CallStatement") {
      output.push({
        ...statement,
        expression: replaceIdentifiersWithConstants(statement.expression, constants, { inLValue: false }),
      });
      continue;
    }

    if (statement.type === "ReturnStatement") {
      output.push({
        ...statement,
        arguments: statement.arguments.map((arg) => replaceIdentifiersWithConstants(arg, constants, { inLValue: false })),
      });
      continue;
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => {
          const clauseConstants = new Map(constants);
          return {
            ...clause,
            condition: clause.condition ? replaceIdentifiersWithConstants(clause.condition, clauseConstants, { inLValue: false }) : clause.condition,
            body: propagateLiteralLocals(clause.body || [], clauseConstants),
          };
        }),
      });
      continue;
    }

    if (statement.type === "WhileStatement") {
      output.push({
        ...statement,
        condition: replaceIdentifiersWithConstants(statement.condition, constants, { inLValue: false }),
        body: propagateLiteralLocals(statement.body, new Map(constants)),
      });
      continue;
    }

    if (statement.type === "RepeatStatement") {
      output.push({
        ...statement,
        body: propagateLiteralLocals(statement.body, new Map(constants)),
        condition: replaceIdentifiersWithConstants(statement.condition, constants, { inLValue: false }),
      });
      continue;
    }

    if (statement.type === "DoStatement") {
      output.push({
        ...statement,
        body: propagateLiteralLocals(statement.body, new Map(constants)),
      });
      continue;
    }

    if (statement.type === "ForNumericStatement") {
      const loopConstants = new Map(constants);
      if (statement.variable && statement.variable.type === "Identifier") {
        loopConstants.delete(statement.variable.name);
      }
      output.push({
        ...statement,
        start: replaceIdentifiersWithConstants(statement.start, constants, { inLValue: false }),
        end: replaceIdentifiersWithConstants(statement.end, constants, { inLValue: false }),
        step: statement.step ? replaceIdentifiersWithConstants(statement.step, constants, { inLValue: false }) : statement.step,
        body: propagateLiteralLocals(statement.body, loopConstants),
      });
      continue;
    }

    if (statement.type === "ForGenericStatement") {
      const loopConstants = new Map(constants);
      statement.variables.forEach((variable) => {
        if (variable.type === "Identifier") {
          loopConstants.delete(variable.name);
        }
      });
      output.push({
        ...statement,
        iterators: statement.iterators.map((iterator) => replaceIdentifiersWithConstants(iterator, constants, { inLValue: false })),
        body: propagateLiteralLocals(statement.body, loopConstants),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      const innerConstants = new Map(constants);
      if (statement.isLocal && statement.identifier && statement.identifier.type === "Identifier") {
        innerConstants.delete(statement.identifier.name);
      }
      statement.parameters.forEach((param) => {
        if (param.type === "Identifier") {
          innerConstants.delete(param.name);
        }
      });
      output.push({
        ...statement,
        body: propagateLiteralLocals(statement.body, innerConstants),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function rewriteIndexMemberAccesses(statements) {
  return statements.map((statement) => transformNode(statement, (node) => {
    if (node.type === "IndexExpression" && isStringLiteral(node.index) && isValidIdentifierName(node.index.value)) {
      return {
        type: "MemberExpression",
        base: node.base,
        indexer: ".",
        identifier: {
          type: "Identifier",
          name: node.index.value,
        },
      };
    }
    return node;
  }));
}

function rewriteTableKeyStrings(statements) {
  return statements.map((statement) => transformNode(statement, (node) => {
    if (node.type === "TableKey" && node.key && node.key.type === "StringLiteral" && isValidIdentifierName(node.key.value)) {
      return {
        type: "TableKeyString",
        key: {
          type: "Identifier",
          name: node.key.value,
        },
        value: node.value,
      };
    }
    return node;
  }));
}

function isObfuscatedProxyIdentifierName(name, knownProxyNames = new Set()) {
  return (
    typeof name === "string" &&
    (
      (knownProxyNames && knownProxyNames.has(name)) ||
      /^v_\d+$/.test(name)
    )
  );
}

function expressionContainsProxyLookup(node, knownProxyNames = new Set()) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    if (current.type === "Identifier" && isObfuscatedProxyIdentifierName(current.name, knownProxyNames)) {
      return true;
    }

    for (const [key, value] of Object.entries(current)) {
      if (key === "scope") {
        continue;
      }
      stack.push(value);
    }
  }

  return false;
}

function isLikelyCallbackValue(node, knownProxyNames = new Set()) {
  const expression = unwrapParentheses(node);
  if (!expression) {
    return false;
  }

  if (expression.type === "FunctionDeclaration") {
    return true;
  }

  if (expression.type === "Identifier") {
    if (isObfuscatedProxyIdentifierName(expression.name, knownProxyNames)) {
      return false;
    }
    if (expression.name.length <= 1) {
      return false;
    }
    return true;
  }

  if (
    expression.type === "StringLiteral" &&
    typeof expression.value === "string" &&
    expression.value.length > 0 &&
    expression.value.toLowerCase() !== "callback"
  ) {
    return true;
  }

  return false;
}

function createTableKeyStringField(name, value) {
  return {
    type: "TableKeyString",
    key: createIdentifier(name),
    value: clone(value),
  };
}

function pickCallbackCandidate(fields, knownProxyNames = new Set()) {
  let fallback = null;

  for (const field of fields) {
    if (!field || field.type !== "TableKeyString" || !field.key || field.key.name !== "callback") {
      continue;
    }

    if (isLikelyCallbackValue(field.value, knownProxyNames)) {
      return field.value;
    }

    if (!fallback) {
      fallback = field.value;
    }
  }

  for (const field of fields) {
    if (!field || !Object.prototype.hasOwnProperty.call(field, "value")) {
      continue;
    }
    if (isLikelyCallbackValue(field.value, knownProxyNames)) {
      return field.value;
    }
  }

  return fallback;
}

function pickDefaultBooleanCandidate(fields) {
  for (const field of fields) {
    if (!field || !field.value) {
      continue;
    }
    const value = unwrapParentheses(field.value);
    if (value && value.type === "BooleanLiteral") {
      return value;
    }
  }
  return null;
}

function pickLabelTextCandidate(fields) {
  for (const field of fields) {
    if (!field || !field.value) {
      continue;
    }
    const value = unwrapParentheses(field.value);
    if (
      value &&
      value.type === "StringLiteral" &&
      typeof value.value === "string" &&
      value.value.length > 0 &&
      value.value.toLowerCase() !== "callback"
    ) {
      return value;
    }
  }
  return null;
}

function normalizeUiOptionsTableForMethod(methodName, tableNode, knownProxyNames = new Set()) {
  if (!tableNode || tableNode.type !== "TableConstructorExpression" || !Array.isArray(tableNode.fields)) {
    return null;
  }

  const hasProxyKeys = tableNode.fields.some((field) => (
    field &&
    field.type === "TableKey" &&
    expressionContainsProxyLookup(field.key, knownProxyNames)
  ));

  if (!hasProxyKeys) {
    return null;
  }

  const callbackValue = pickCallbackCandidate(tableNode.fields, knownProxyNames);
  const defaultValue = pickDefaultBooleanCandidate(tableNode.fields);
  const labelText = pickLabelTextCandidate(tableNode.fields);

  const nextFields = [];
  if (methodName === "AddLabel") {
    if (!labelText) {
      return null;
    }
    nextFields.push(createTableKeyStringField("text", labelText));
  } else if (methodName === "AddButton") {
    if (!callbackValue) {
      return null;
    }
    nextFields.push(createTableKeyStringField("callback", callbackValue));
  } else if (methodName === "AddToggle") {
    if (defaultValue) {
      nextFields.push(createTableKeyStringField("default", defaultValue));
    }
    if (callbackValue) {
      nextFields.push(createTableKeyStringField("callback", callbackValue));
    }
    if (nextFields.length === 0) {
      return null;
    }
  } else {
    return null;
  }

  return {
    ...tableNode,
    fields: nextFields,
  };
}

function normalizeUiLibraryCallOptions(statements, state = {}) {
  const knownProxyNames = state && state.stringProxies instanceof Set
    ? new Set(state.stringProxies)
    : new Set();

  return statements.map((statement) => transformNode(statement, (node) => {
    if (
      node.type !== "CallExpression" ||
      !node.base ||
      node.base.type !== "MemberExpression" ||
      !node.base.identifier ||
      !Array.isArray(node.arguments)
    ) {
      return node;
    }

    const methodName = node.base.identifier.name;
    if (methodName !== "AddToggle" && methodName !== "AddButton" && methodName !== "AddLabel") {
      return node;
    }

    let optionArgIndex = null;
    if (node.base.indexer === ":" && node.arguments.length >= 1) {
      optionArgIndex = 0;
    } else if (node.base.indexer === "." && node.arguments.length >= 2) {
      optionArgIndex = 1;
    }

    if (optionArgIndex === null) {
      return node;
    }

    const optionArgument = node.arguments[optionArgIndex];
    const normalizedTable = normalizeUiOptionsTableForMethod(
      methodName,
      unwrapParentheses(optionArgument),
      knownProxyNames,
    );
    if (!normalizedTable) {
      return node;
    }

    const nextArguments = node.arguments.slice();
    nextArguments[optionArgIndex] = normalizedTable;

    return {
      ...node,
      arguments: nextArguments,
    };
  }));
}

function normalizeStringProxyStringCalls(statements, state = {}) {
  const knownProxyNames = state && state.stringProxies instanceof Set
    ? new Set(state.stringProxies)
    : new Set();

  return statements.map((statement) => transformNode(statement, (node) => {
    if (
      node.type !== "CallExpression" ||
      !node.base ||
      node.base.type !== "IndexExpression" ||
      !isIdentifier(node.base.base, "string") ||
      !Array.isArray(node.arguments) ||
      node.arguments.length < 2 ||
      !isStringLiteral(unwrapParentheses(node.arguments[1]))
    ) {
      return node;
    }

    if (!expressionContainsProxyLookup(node.base.index, knownProxyNames)) {
      return node;
    }

    return {
      ...node,
      base: createMemberExpression(createIdentifier("string"), "find"),
    };
  }));
}

function removeUnusedLiteralLocals(statements) {
  const output = [];

  for (let statementIndex = 0; statementIndex < statements.length; statementIndex += 1) {
    const statement = statements[statementIndex];
    if (statement.type === "LocalStatement" && statement.variables.length === statement.init.length) {
      const keptVars = [];
      const keptInit = [];

      for (let index = 0; index < statement.variables.length; index += 1) {
        const variable = statement.variables[index];
        const init = statement.init[index];
        const name = variable && variable.type === "Identifier" ? variable.name : null;
        const isLiteral = init && isLiteralLike(init);
        if (name && isLiteral && !identifierUsedAfter(statements, statementIndex + 1, name)) {
          continue;
        }
        keptVars.push(variable);
        keptInit.push(init);
      }

      if (keptVars.length === 0) {
        continue;
      }

      output.push({
        ...statement,
        variables: keptVars,
        init: keptInit,
      });
      continue;
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          body: removeUnusedLiteralLocals(clause.body || []),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "DoStatement" || statement.type === "RepeatStatement") {
      output.push({
        ...statement,
        body: removeUnusedLiteralLocals(statement.body),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: removeUnusedLiteralLocals(statement.body),
      });
      continue;
    }

    output.push(statement);
  }

  return output;
}

function renameServiceLocals(statements) {
  const { definitions } = buildUsageMap(statements);
  const definedNames = new Set(definitions.keys());

  const renameMap = new Map();
  const serviceNameMap = new Map();

  const preferName = (service) => {
    if (service === "UserInputService") return "UIS";
    if (service === "ReplicatedStorage") return "ReplicatedStorage";
    return service;
  };

  const isGetServiceCall = (node) => {
    const expr = unwrapParentheses(node);
    if (!expr || expr.type !== "CallExpression") {
      return null;
    }

    const base = expr.base;
    const arg = expr.arguments && expr.arguments[0];
    if (!arg || arg.type !== "StringLiteral") {
      return null;
    }

    if (
      base.type === "MemberExpression" &&
      base.indexer === "." &&
      isIdentifier(base.base, "game") &&
      base.identifier &&
      base.identifier.name === "GetService"
    ) {
      return arg.value;
    }

    if (
      base.type === "IndexExpression" &&
      isIdentifier(base.base, "game") &&
      base.index &&
      base.index.type === "StringLiteral" &&
      base.index.value === "GetService"
    ) {
      return arg.value;
    }

    return null;
  };

  for (const statement of statements) {
    if (statement.type !== "LocalStatement") {
      continue;
    }

    for (let index = 0; index < statement.variables.length; index += 1) {
      const variable = statement.variables[index];
      const init = statement.init[index];
      if (!isIdentifier(variable) || !init) {
        continue;
      }

      const service = isGetServiceCall(init);
      if (service && definitions.get(variable.name) === 1) {
        const desired = preferName(service);
        if (isValidIdentifierName(desired) && !definedNames.has(desired)) {
          renameMap.set(variable.name, desired);
          serviceNameMap.set(desired, service);
          definedNames.add(desired);
        }
        continue;
      }

      const initExpr = unwrapParentheses(init);
      if (
        initExpr &&
        initExpr.type === "MemberExpression" &&
        initExpr.indexer === "." &&
        initExpr.identifier &&
        initExpr.identifier.name === "LocalPlayer" &&
        initExpr.base &&
        initExpr.base.type === "Identifier"
      ) {
        if (definitions.get(variable.name) !== 1) {
          continue;
        }
        const desired = !definedNames.has("lp") ? "lp" : "LocalPlayer";
        if (isValidIdentifierName(desired) && !definedNames.has(desired)) {
          renameMap.set(variable.name, desired);
          definedNames.add(desired);
        }
      }
    }
  }

  if (renameMap.size === 0) {
    return statements;
  }

  const renamed = transformNode({ type: "Chunk", body: statements, comments: [] }, (node) => {
    if (node.type === "Identifier" && renameMap.has(node.name)) {
      return { ...node, name: renameMap.get(node.name) };
    }
    return node;
  });

  return renamed.body;
}

function getMemberAliasKey(node) {
  if (!node || (node.type !== "MemberExpression" && node.type !== "IndexExpression")) {
    return null;
  }

  const base = node.base;
  if (!isIdentifier(base)) {
    return null;
  }

  if (node.type === "MemberExpression") {
    const memberName = node.identifier && node.identifier.name;
    if (!memberName) {
      return null;
    }
    return `${base.name}.${memberName}`;
  }

  if (node.index && node.index.type === "StringLiteral") {
    return `${base.name}.${node.index.value}`;
  }

  return null;
}

function extractAliasAssignment(statement) {
  if (
    !statement ||
    statement.type !== "AssignmentStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1
  ) {
    return null;
  }

  const target = statement.variables[0];
  const init = statement.init[0];
  if (!target || !init || init.type !== "Identifier") {
    return null;
  }

  const key = getMemberAliasKey(target);
  if (!key) {
    return null;
  }

  const baseName = key.split(".")[0];
  if (!HELPER_IDENTIFIERS.has(baseName)) {
    return null;
  }

  return { key, replacement: init.name };
}

function applyAliasReplacements(node, aliases) {
  if (!aliases || aliases.length === 0) {
    return node;
  }

  return transformNode(node, (child) => {
    const key = getMemberAliasKey(child);
    if (!key) {
      return child;
    }
    const match = aliases.find((alias) => alias.key === key);
    if (!match) {
      return child;
    }
    return { type: "Identifier", name: match.replacement };
  });
}

function fixAliasAssignments(statements, inheritedAliases = []) {
  const output = [];
  const aliases = [...inheritedAliases];

  for (const statement of statements) {
    const alias = extractAliasAssignment(statement);
    if (alias) {
      aliases.push(alias);
      continue;
    }

    if (statement.type === "IfStatement") {
      output.push({
        ...statement,
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          condition: clause.condition ? applyAliasReplacements(clause.condition, aliases) : clause.condition,
          body: fixAliasAssignments(clause.body || [], aliases),
        })),
      });
      continue;
    }

    if (statement.type === "WhileStatement" || statement.type === "DoStatement") {
      output.push({
        ...statement,
        condition: statement.condition ? applyAliasReplacements(statement.condition, aliases) : statement.condition,
        body: fixAliasAssignments(statement.body, aliases),
      });
      continue;
    }

    if (statement.type === "RepeatStatement") {
      output.push({
        ...statement,
        condition: statement.condition ? applyAliasReplacements(statement.condition, aliases) : statement.condition,
        body: fixAliasAssignments(statement.body, aliases),
      });
      continue;
    }

    if (statement.type === "ForNumericStatement") {
      output.push({
        ...statement,
        start: applyAliasReplacements(statement.start, aliases),
        end: applyAliasReplacements(statement.end, aliases),
        step: statement.step ? applyAliasReplacements(statement.step, aliases) : statement.step,
        body: fixAliasAssignments(statement.body, aliases),
      });
      continue;
    }

    if (statement.type === "ForGenericStatement") {
      output.push({
        ...statement,
        iterators: statement.iterators.map((iterator) => applyAliasReplacements(iterator, aliases)),
        body: fixAliasAssignments(statement.body, aliases),
      });
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      output.push({
        ...statement,
        body: fixAliasAssignments(statement.body, aliases),
      });
      continue;
    }

    output.push(applyAliasReplacements(statement, aliases));
  }

  return output;
}

function mergeDeepElse(statements) {
  return statements.map(statement => {
    if (statement.type === "IfStatement") {
      statement.clauses = statement.clauses.map(clause => ({
        ...clause,
        body: mergeDeepElse(clause.body)
      }));

      if (statement.clauses.length === 2 && statement.clauses[0].type === "IfClause" && statement.clauses[1].type === "ElseClause") {
        const [ifClause, elseClause] = statement.clauses;
        if (elseClause.body.length === 1 && elseClause.body[0].type === "IfStatement") {
          const nestedIf = elseClause.body[0];
          statement.clauses = [
            ...statement.clauses.slice(0, 1),
            ...nestedIf.clauses
          ];
        }
      }
    }
    return statement;
  });
}

function transformNode(node, callback) {
  if (!node || typeof node !== "object") return node;
  const transformed = callback(node);
  if (transformed !== node) return transformed;

  if (Array.isArray(node)) {
    return node.map(n => transformNode(n, callback));
  }

  const next = { ...node };
  let changed = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "_skipChildren") continue;
    const nextValue = transformNode(value, callback);
    if (nextValue !== value) {
      next[key] = nextValue;
      changed = true;
    }
  }
  return changed ? next : node;
}

function createIdentifier(name) {
  return {
    type: "Identifier",
    name,
  };
}

function createLocalIdentifier(name) {
  return {
    type: "Identifier",
    name,
    isLocal: true,
  };
}

function createCapturedAliasMap(capturedAliases = []) {
  const map = new Map();
  for (const alias of capturedAliases) {
    if (!alias || !alias.name || !alias.replacement) {
      continue;
    }
    map.set(alias.name, alias.replacement);
  }
  return map;
}

function isNameShadowed(scopeStack, name) {
  for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
    if (scopeStack[index].has(name)) {
      return true;
    }
  }
  return false;
}

function rewriteCapturedAliasExpression(node, aliasMap, scopeStack) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => rewriteCapturedAliasExpression(child, aliasMap, scopeStack));
  }

  if (node.type === "Identifier") {
    if (aliasMap.has(node.name) && !isNameShadowed(scopeStack, node.name)) {
      return createIdentifier(aliasMap.get(node.name));
    }
    return node;
  }

  switch (node.type) {
    case "MemberExpression":
      return {
        ...node,
        base: rewriteCapturedAliasExpression(node.base, aliasMap, scopeStack),
      };
    case "IndexExpression":
      return {
        ...node,
        base: rewriteCapturedAliasExpression(node.base, aliasMap, scopeStack),
        index: rewriteCapturedAliasExpression(node.index, aliasMap, scopeStack),
      };
    case "CallExpression":
      return {
        ...node,
        base: rewriteCapturedAliasExpression(node.base, aliasMap, scopeStack),
        arguments: node.arguments.map((argument) => rewriteCapturedAliasExpression(argument, aliasMap, scopeStack)),
      };
    case "TableCallExpression":
      return {
        ...node,
        base: rewriteCapturedAliasExpression(node.base, aliasMap, scopeStack),
        arguments: rewriteCapturedAliasExpression(node.arguments, aliasMap, scopeStack),
      };
    case "StringCallExpression":
      return {
        ...node,
        base: rewriteCapturedAliasExpression(node.base, aliasMap, scopeStack),
        argument: rewriteCapturedAliasExpression(node.argument, aliasMap, scopeStack),
      };
    case "UnaryExpression":
      return {
        ...node,
        argument: rewriteCapturedAliasExpression(node.argument, aliasMap, scopeStack),
      };
    case "BinaryExpression":
    case "LogicalExpression":
      return {
        ...node,
        left: rewriteCapturedAliasExpression(node.left, aliasMap, scopeStack),
        right: rewriteCapturedAliasExpression(node.right, aliasMap, scopeStack),
      };
    case "ParenthesisExpression":
      return {
        ...node,
        expression: rewriteCapturedAliasExpression(node.expression, aliasMap, scopeStack),
      };
    case "IfExpression":
      return {
        ...node,
        condition: rewriteCapturedAliasExpression(node.condition, aliasMap, scopeStack),
        trueExpression: rewriteCapturedAliasExpression(node.trueExpression, aliasMap, scopeStack),
        falseExpression: rewriteCapturedAliasExpression(node.falseExpression, aliasMap, scopeStack),
      };
    case "TableConstructorExpression":
      return {
        ...node,
        fields: node.fields.map((field) => {
          if (field.type === "TableValue") {
            return {
              ...field,
              value: rewriteCapturedAliasExpression(field.value, aliasMap, scopeStack),
            };
          }
          if (field.type === "TableKey") {
            return {
              ...field,
              key: rewriteCapturedAliasExpression(field.key, aliasMap, scopeStack),
              value: rewriteCapturedAliasExpression(field.value, aliasMap, scopeStack),
            };
          }
          if (field.type === "TableKeyString") {
            return {
              ...field,
              value: rewriteCapturedAliasExpression(field.value, aliasMap, scopeStack),
            };
          }
          return field;
        }),
      };
    case "FunctionDeclaration": {
      const functionScope = new Set();
      if (node.isLocal && isIdentifier(node.identifier)) {
        functionScope.add(node.identifier.name);
      }
      node.parameters.forEach((parameter) => {
        if (parameter.type === "Identifier") {
          functionScope.add(parameter.name);
        }
      });
      return {
        ...node,
        body: rewriteCapturedAliases(node.body, aliasMap, [...scopeStack, functionScope]),
      };
    }
    default: {
      const next = { ...node };
      let changed = false;
      for (const [key, value] of Object.entries(node)) {
        if (key === "scope" || key === "identifier" || key === "parameters" || key === "variables" || key === "variable") {
          continue;
        }
        const nextValue = rewriteCapturedAliasExpression(value, aliasMap, scopeStack);
        if (nextValue !== value) {
          next[key] = nextValue;
          changed = true;
        }
      }
      return changed ? next : node;
    }
  }
}

function rewriteCapturedAliases(statements, aliasMap, inheritedScopes = []) {
  if (!aliasMap || aliasMap.size === 0) {
    return statements;
  }

  const blockScope = new Set();
  const scopeStack = [...inheritedScopes, blockScope];

  return statements.map((statement) => {
    switch (statement.type) {
      case "LocalStatement": {
        const nextStatement = {
          ...statement,
          init: statement.init.map((expression) => rewriteCapturedAliasExpression(expression, aliasMap, scopeStack)),
        };
        statement.variables.forEach((variable) => {
          if (variable.type === "Identifier") {
            blockScope.add(variable.name);
          }
        });
        return nextStatement;
      }
      case "AssignmentStatement":
        return {
          ...statement,
          variables: statement.variables.map((variable) => rewriteCapturedAliasExpression(variable, aliasMap, scopeStack)),
          init: statement.init.map((expression) => rewriteCapturedAliasExpression(expression, aliasMap, scopeStack)),
        };
      case "CallStatement":
        return {
          ...statement,
          expression: rewriteCapturedAliasExpression(statement.expression, aliasMap, scopeStack),
        };
      case "ReturnStatement":
        return {
          ...statement,
          arguments: statement.arguments.map((argument) => rewriteCapturedAliasExpression(argument, aliasMap, scopeStack)),
        };
      case "IfStatement":
        return {
          ...statement,
          clauses: statement.clauses.map((clause) => ({
            ...clause,
            condition: clause.condition ? rewriteCapturedAliasExpression(clause.condition, aliasMap, scopeStack) : clause.condition,
            body: rewriteCapturedAliases(clause.body || [], aliasMap, scopeStack),
          })),
        };
      case "WhileStatement":
        return {
          ...statement,
          condition: rewriteCapturedAliasExpression(statement.condition, aliasMap, scopeStack),
          body: rewriteCapturedAliases(statement.body, aliasMap, scopeStack),
        };
      case "RepeatStatement":
        return {
          ...statement,
          condition: rewriteCapturedAliasExpression(statement.condition, aliasMap, scopeStack),
          body: rewriteCapturedAliases(statement.body, aliasMap, scopeStack),
        };
      case "DoStatement":
        return {
          ...statement,
          body: rewriteCapturedAliases(statement.body, aliasMap, scopeStack),
        };
      case "ForNumericStatement": {
        const loopScope = new Set();
        if (statement.variable && statement.variable.type === "Identifier") {
          loopScope.add(statement.variable.name);
        }
        return {
          ...statement,
          start: rewriteCapturedAliasExpression(statement.start, aliasMap, scopeStack),
          end: rewriteCapturedAliasExpression(statement.end, aliasMap, scopeStack),
          step: statement.step ? rewriteCapturedAliasExpression(statement.step, aliasMap, scopeStack) : statement.step,
          body: rewriteCapturedAliases(statement.body, aliasMap, [...scopeStack, loopScope]),
        };
      }
      case "ForGenericStatement": {
        const loopScope = new Set();
        statement.variables.forEach((variable) => {
          if (variable.type === "Identifier") {
            loopScope.add(variable.name);
          }
        });
        return {
          ...statement,
          iterators: statement.iterators.map((iterator) => rewriteCapturedAliasExpression(iterator, aliasMap, scopeStack)),
          body: rewriteCapturedAliases(statement.body, aliasMap, [...scopeStack, loopScope]),
        };
      }
      case "FunctionDeclaration": {
        if (statement.isLocal && isIdentifier(statement.identifier)) {
          blockScope.add(statement.identifier.name);
        }
        const functionScope = new Set();
        if (statement.isLocal && isIdentifier(statement.identifier)) {
          functionScope.add(statement.identifier.name);
        }
        statement.parameters.forEach((parameter) => {
          if (parameter.type === "Identifier") {
            functionScope.add(parameter.name);
          }
        });
        return {
          ...statement,
          body: rewriteCapturedAliases(statement.body, aliasMap, [...scopeStack, functionScope]),
        };
      }
      default:
        return rewriteCapturedAliasExpression(statement, aliasMap, scopeStack);
    }
  });
}

function isUnpackLikeBase(node, state) {
  const base = unwrapParentheses(node);
  if (!base) {
    return false;
  }

  if (base.type === "Identifier") {
    return base.name === "unpack" || state.unpackAliases.has(base.name);
  }

  if (
    base.type === "MemberExpression" &&
    base.indexer === "." &&
    isIdentifier(base.base, "table") &&
    isIdentifier(base.identifier, "unpack")
  ) {
    return true;
  }

  if (
    base.type === "IndexExpression" &&
    isIdentifier(base.base, "table") &&
    isStringLiteral(base.index, "unpack")
  ) {
    return true;
  }

  return false;
}

function simplifyPackUnpackExpression(node, state) {
  const expression = unwrapParentheses(node);
  if (
    expression &&
    expression.type === "CallExpression" &&
    expression.arguments.length === 1 &&
    isUnpackLikeBase(expression.base, state)
  ) {
    const argument = unwrapParentheses(expression.arguments[0]);
    if (
      argument &&
      argument.type === "TableConstructorExpression" &&
      argument.fields.length === 1 &&
      argument.fields[0].type === "TableValue"
    ) {
      return clone(argument.fields[0].value);
    }
  }

  return node;
}

function rewritePackUnpackStatement(statement, state) {
  if (statement.type === "IfStatement") {
    return transformNode({
      ...statement,
      clauses: statement.clauses.map((clause) => ({
        ...clause,
        body: simplifySingleValuePackUnpack(clause.body || [], state),
      })),
    }, (node) => simplifyPackUnpackExpression(node, state));
  }

  if (statement.type === "WhileStatement" || statement.type === "RepeatStatement" || statement.type === "DoStatement") {
    return transformNode({
      ...statement,
      body: simplifySingleValuePackUnpack(statement.body, state),
    }, (node) => simplifyPackUnpackExpression(node, state));
  }

  if (statement.type === "FunctionDeclaration") {
    return transformNode({
      ...statement,
      body: simplifySingleValuePackUnpack(statement.body, state),
    }, (node) => simplifyPackUnpackExpression(node, state));
  }

  return transformNode(statement, (node) => simplifyPackUnpackExpression(node, state));
}

function getSingleValuePackLocal(statement) {
  if (
    !statement ||
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    !isIdentifier(statement.variables[0])
  ) {
    return null;
  }

  const initializer = unwrapParentheses(statement.init[0]);
  if (
    !initializer ||
    initializer.type !== "TableConstructorExpression" ||
    initializer.fields.length !== 1 ||
    initializer.fields[0].type !== "TableValue"
  ) {
    return null;
  }

  return {
    name: statement.variables[0].name,
    value: initializer.fields[0].value,
  };
}

function rewriteSingleValuePackConsumer(statement, name, value, state) {
  let changed = false;
  const rewritten = transformNode(statement, (node) => {
    const expression = unwrapParentheses(node);
    if (
      expression &&
      expression.type === "CallExpression" &&
      expression.arguments.length === 1 &&
      isUnpackLikeBase(expression.base, state) &&
      isIdentifier(unwrapParentheses(expression.arguments[0]), name)
    ) {
      changed = true;
      return clone(value);
    }
    return simplifyPackUnpackExpression(node, state);
  });

  return {
    changed,
    statement: rewritten,
  };
}

function simplifySingleValuePackUnpack(statements, state) {
  const output = [];

  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index];
    const packLocal = getSingleValuePackLocal(current);
    if (packLocal) {
      const next = statements[index + 1];
      if (next) {
        const rewritten = rewriteSingleValuePackConsumer(next, packLocal.name, packLocal.value, state);
        if (rewritten.changed && !statementReferencesIdentifier(rewritten.statement, packLocal.name)) {
          output.push(rewritePackUnpackStatement(rewritten.statement, state));
          index += 1;
          continue;
        }
      }
    }

    output.push(rewritePackUnpackStatement(current, state));
  }

  return output;
}