const luaparse = require("luaparse");

function isNameStart(char) {
  return /[A-Za-z_]/.test(char);
}

function isNameChar(char) {
  return /[A-Za-z0-9_]/.test(char);
}

function skipWhitespaceForward(source, index) {
  let nextIndex = index;
  while (nextIndex < source.length && /\s/.test(source[nextIndex])) {
    nextIndex += 1;
  }
  return nextIndex;
}

function skipWhitespaceBackward(source, index) {
  let nextIndex = index;
  while (nextIndex >= 0 && /\s/.test(source[nextIndex])) {
    nextIndex -= 1;
  }
  return nextIndex;
}

function scanQuotedString(source, startIndex) {
  const quote = source[startIndex];
  let index = startIndex + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  throw new Error(`Unterminated ${quote} string`);
}

function encodeUtf8Bytes(codepoint) {
  if (codepoint <= 0x7f) return [codepoint];
  if (codepoint <= 0x7ff) return [0xc0 | (codepoint >> 6), 0x80 | (codepoint & 0x3f)];
  if (codepoint <= 0xffff) return [0xe0 | (codepoint >> 12), 0x80 | ((codepoint >> 6) & 0x3f), 0x80 | (codepoint & 0x3f)];
  return [0xf0 | (codepoint >> 18), 0x80 | ((codepoint >> 12) & 0x3f), 0x80 | ((codepoint >> 6) & 0x3f), 0x80 | (codepoint & 0x3f)];
}

function readLongBracket(source, startIndex) {
  if (source[startIndex] !== "[") return null;
  let index = startIndex + 1;
  while (index < source.length && source[index] === "=") {
    index += 1;
  }
  if (source[index] !== "[") return null;
  return { equalsCount: index - startIndex - 1, end: index + 1 };
}

function scanLongBracket(source, startIndex, equalsCount) {
  const closing = `]${"=".repeat(equalsCount)}]`;
  const endIndex = source.indexOf(closing, startIndex);
  if (endIndex === -1) throw new Error("Unterminated long bracket");
  return endIndex + closing.length;
}

const CONTINUE_LABEL_PREFIX = "__loveya_continue_";

function readNameToken(source, startIndex) {
  if (!isNameStart(source[startIndex])) return null;
  let endIndex = startIndex + 1;
  while (endIndex < source.length && isNameChar(source[endIndex])) {
    endIndex += 1;
  }
  return { name: source.slice(startIndex, endIndex), end: endIndex };
}

function needsNormalization(source) {
  if (source.includes("`")) return true;
  if (/[+\-*/%^]=/.test(source)) return true;
  if (/\blocal\b[^;]*:[^=]/.test(source)) return true;
  if (/\bcontinue\b/.test(source)) return true;
  return false;
}

function normalizeBacktickStrings(source) {
  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source.startsWith("--", index)) {
      const longComment = readLongBracket(source, index + 2);
      if (longComment) {
        output += source.slice(index, scanLongBracket(source, longComment.end, longComment.equalsCount));
        index = scanLongBracket(source, longComment.end, longComment.equalsCount);
        continue;
      }
      const lineEnd = source.indexOf("\n", index);
      if (lineEnd === -1) { output += source.slice(index); break; }
      output += source.slice(index, lineEnd);
      index = lineEnd;
      continue;
    }

    const longBracket = readLongBracket(source, index);
    if (longBracket) {
      const endIndex = scanLongBracket(source, longBracket.end, longBracket.equalsCount);
      output += source.slice(index, endIndex);
      index = endIndex;
      continue;
    }

    const char = source[index];
    if (char === '"' || char === "'") {
      const endIndex = scanQuotedString(source, index);
      output += source.slice(index, endIndex);
      index = endIndex;
      continue;
    }

    if (char === "`") {
      let endIndex = index + 1;
      while (endIndex < source.length && source[endIndex] !== "`") {
        endIndex += 1;
      }
      if (endIndex >= source.length) throw new Error("Unterminated backtick string");
      output += JSON.stringify(source.slice(index + 1, endIndex));
      index = endIndex + 1;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function normalizeContinueStatements(source) {
  let output = "";
  let index = 0;
  let loopCounter = 0;
  let pendingLoopDo = 0;
  const blockStack = [];

  const ensureLoopLabel = (block) => {
    if (!block.label) block.label = `${CONTINUE_LABEL_PREFIX}${++loopCounter}`;
    return block.label;
  };

  const findActiveLoopBlock = () => {
    for (let cursor = blockStack.length - 1; cursor >= 0; cursor -= 1) {
      const block = blockStack[cursor];
      if (block.type === "function") break;
      if (block.type === "while" || block.type === "for" || block.type === "repeat") return block;
    }
    return null;
  };

  while (index < source.length) {
    if (source.startsWith("--", index)) {
      const longComment = readLongBracket(source, index + 2);
      if (longComment) {
        const endIndex = scanLongBracket(source, longComment.end, longComment.equalsCount);
        output += source.slice(index, endIndex);
        index = endIndex;
        continue;
      }
      const lineEnd = source.indexOf("\n", index);
      if (lineEnd === -1) { output += source.slice(index); break; }
      output += source.slice(index, lineEnd);
      index = lineEnd;
      continue;
    }

    const longBracket = readLongBracket(source, index);
    if (longBracket) {
      const endIndex = scanLongBracket(source, longBracket.end, longBracket.equalsCount);
      output += source.slice(index, endIndex);
      index = endIndex;
      continue;
    }

    const char = source[index];
    if (char === "\"" || char === "'") {
      const endIndex = scanQuotedString(source, index);
      output += source.slice(index, endIndex);
      index = endIndex;
      continue;
    }

    const token = readNameToken(source, index);
    if (!token) {
      output += char;
      index += 1;
      continue;
    }

    switch (token.name) {
      case "while":
        blockStack.push({ type: "while", label: null });
        pendingLoopDo += 1;
        output += token.name;
        break;
      case "for":
        blockStack.push({ type: "for", label: null });
        pendingLoopDo += 1;
        output += token.name;
        break;
      case "repeat":
        blockStack.push({ type: "repeat", label: null });
        output += token.name;
        break;
      case "function":
        blockStack.push({ type: "function" });
        output += token.name;
        break;
      case "if":
        blockStack.push({ type: "if" });
        output += token.name;
        break;
      case "do":
        if (pendingLoopDo > 0) {
          pendingLoopDo -= 1;
        } else {
          blockStack.push({ type: "do" });
        }
        output += token.name;
        break;
      case "end": {
        const block = blockStack.pop();
        if (block && (block.type === "while" || block.type === "for") && block.label) {
          output += `; ::${block.label}:: ${token.name}`;
        } else {
          output += token.name;
        }
        break;
      }
      case "until": {
        const block = blockStack[blockStack.length - 1];
        if (block && block.type === "repeat" && block.label) {
          blockStack.pop();
          output += `; ::${block.label}:: ${token.name}`;
        } else if (block && block.type === "repeat") {
          blockStack.pop();
          output += token.name;
        } else {
          output += token.name;
        }
        break;
      }
      case "continue": {
        const loopBlock = findActiveLoopBlock();
        output += loopBlock ? `; goto ${ensureLoopLabel(loopBlock)}` : token.name;
        break;
      }
      default:
        output += token.name;
        break;
    }

    index = token.end;
  }

  return output;
}

function normalizeUnicodeStringLiterals(source) {
  let output = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char !== "\"" && char !== "'") {
      output += char;
      index += 1;
      continue;
    }

    const quote = char;
    const endIndex = scanQuotedString(source, index);
    const raw = source.slice(index + 1, endIndex - 1);
    let normalized = "";

    for (let offset = 0; offset < raw.length; offset += 1) {
      const current = raw[offset];
      if (current === "\\") {
        normalized += current;
        if (offset + 1 >= raw.length) break;
        const next = raw[offset + 1];
        normalized += next;
        offset += 1;

        if (next === "x") {
          if (offset + 2 <= raw.length) { normalized += raw.slice(offset + 1, offset + 3); offset += 2; }
          continue;
        }

        if (next === "u" && raw[offset + 1] === "{") {
          let cursor = offset + 2;
          while (cursor < raw.length) {
            normalized += raw[cursor];
            if (raw[cursor] === "}") { offset = cursor; break; }
            cursor += 1;
          }
          continue;
        }

        if (/\d/.test(next)) {
          let cursor = offset + 1;
          let digits = "";
          while (cursor < raw.length && digits.length < 2 && /\d/.test(raw[cursor])) {
            digits += raw[cursor];
            cursor += 1;
          }
          normalized += digits;
          offset += digits.length;
        }
        continue;
      }

      const codepoint = raw.codePointAt(offset);
      if (codepoint > 0xff) {
        const bytes = encodeUtf8Bytes(codepoint);
        normalized += bytes.map((value) => `\\${value}`).join("");
        if (codepoint > 0xffff) offset += 1;
        continue;
      }

      normalized += current;
    }

    output += quote + normalized + quote;
    index = endIndex;
  }

  return output;
}

function findMatchingBackward(source, closeIndex, openChar, closeChar) {
  let depth = 1;
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    if (source[index] === closeChar) { depth += 1; continue; }
    if (source[index] === openChar) { depth -= 1; if (depth === 0) return index; }
  }
  throw new Error(`Unmatched ${closeChar}`);
}

function extractCompoundAssignmentLhs(output) {
  let index = skipWhitespaceBackward(output, output.length - 1);
  const endIndex = index + 1;
  let startIndex = endIndex;

  while (index >= 0) {
    const char = output[index];
    if (char === "]") {
      startIndex = findMatchingBackward(output, index, "[", "]");
      index = skipWhitespaceBackward(output, startIndex - 1);
      continue;
    }
    if (char === ")") {
      startIndex = findMatchingBackward(output, index, "(", ")");
      index = skipWhitespaceBackward(output, startIndex - 1);
      continue;
    }
    if (isNameChar(char)) {
      let segmentStart = index;
      while (segmentStart >= 0 && isNameChar(output[segmentStart])) segmentStart -= 1;
      const nameStart = segmentStart + 1;
      if (!isNameStart(output[nameStart])) break;
      startIndex = nameStart;
      index = skipWhitespaceBackward(output, segmentStart);
      if (index >= 0 && output[index] === ".") { startIndex = index; index = skipWhitespaceBackward(output, index - 1); continue; }
      break;
    }
    break;
  }

  return output.slice(startIndex, endIndex);
}

function nextTokenStartsStatement(source, index) {
  const startIndex = skipWhitespaceForward(source, index);
  const char = source[startIndex];
  if (!char) return false;
  return char === ";" || char === "(" || isNameStart(char);
}

function findCompoundAssignmentRhsEnd(source, startIndex) {
  let index = skipWhitespaceForward(source, startIndex);
  let parenDepth = 0, bracketDepth = 0, braceDepth = 0;
  let lastSignificantChar = "";

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const endIndex = scanQuotedString(source, index);
      lastSignificantChar = source[endIndex - 1];
      index = endIndex;
      continue;
    }
    const longBracket = readLongBracket(source, index);
    if (longBracket) {
      const endIndex = scanLongBracket(source, longBracket.end, longBracket.equalsCount);
      lastSignificantChar = "]";
      index = endIndex;
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && lastSignificantChar && isNameStart(char) && (index === 0 || !isNameChar(source[index - 1])) && !/[+\-*/%^#<>=~.,:({[]/.test(lastSignificantChar)) {
      const token = readNameToken(source, index);
      if (token && token.name !== "and" && token.name !== "or") return index;
    }

    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;

    if (/\s/.test(char) && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const nextIndex = skipWhitespaceForward(source, index);
      if (nextIndex > index && nextTokenStartsStatement(source, nextIndex) && !/[+\-*/%^#<>=~.,:({[]/.test(lastSignificantChar)) {
        return index;
      }
    }

    if (!/\s/.test(char)) lastSignificantChar = char;
    index += 1;
  }

  return source.length;
}

function normalizeCompoundAssignments(source) {
  const operators = new Map([
    ["+=", "+"], ["-=", "-"], ["*=", "*"], ["/=", "/"], ["%=", "%"], ["^=", "^"],
  ]);

  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source.startsWith("--", index)) {
      const longComment = readLongBracket(source, index + 2);
      if (longComment) {
        const endIndex = scanLongBracket(source, longComment.end, longComment.equalsCount);
        output += source.slice(index, endIndex);
        index = endIndex;
        continue;
      }
      const lineEnd = source.indexOf("\n", index);
      if (lineEnd === -1) { output += source.slice(index); break; }
      output += source.slice(index, lineEnd);
      index = lineEnd;
      continue;
    }

    const longBracket = readLongBracket(source, index);
    if (longBracket) {
      const endIndex = scanLongBracket(source, longBracket.end, longBracket.equalsCount);
      output += source.slice(index, endIndex);
      index = endIndex;
      continue;
    }

    const char = source[index];
    if (char === '"' || char === "'") {
      const endIndex = scanQuotedString(source, index);
      output += source.slice(index, endIndex);
      index = endIndex;
      continue;
    }

    const operator = source.slice(index, index + 2);
    if (operators.has(operator)) {
      const lhs = extractCompoundAssignmentLhs(output);
      const rhsEnd = findCompoundAssignmentRhsEnd(source, index + 2);
      const rhs = source.slice(index + 2, rhsEnd).trim();
      output += ` = ${lhs} ${operators.get(operator)} ${rhs};`;
      index = rhsEnd;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function stripTypeAnnotations(source) {
  let output = "";
  let index = 0;
  let inLocalDecl = false;
  let pendingFunction = false;
  let paramDepth = 0;
  let pendingReturnType = false;
  let expectTypeAnnotation = false;

  const skipTypeExpression = (startIndex) => {
    let cursor = skipWhitespaceForward(source, startIndex);
    let parenDepth = 0, bracketDepth = 0, braceDepth = 0, angleDepth = 0;

    while (cursor < source.length) {
      if (source.startsWith("--", cursor)) {
        const longComment = readLongBracket(source, cursor + 2);
        if (longComment) { cursor = scanLongBracket(source, longComment.end, longComment.equalsCount); continue; }
        const lineEnd = source.indexOf("\n", cursor);
        return lineEnd === -1 ? source.length : lineEnd;
      }
      if (source[cursor] === "\"" || source[cursor] === "'") { cursor = scanQuotedString(source, cursor); continue; }
      const longBracket = readLongBracket(source, cursor);
      if (longBracket) { cursor = scanLongBracket(source, longBracket.end, longBracket.equalsCount); continue; }

      const ch = source[cursor];
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") { if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) break; parenDepth = Math.max(0, parenDepth - 1); }
      else if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "<") angleDepth += 1;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0 && (ch === "," || ch === ")" || ch === "=" || ch === "\n" || ch === ";")) break;
      cursor += 1;
    }
    return cursor;
  };

  while (index < source.length) {
    const pendingChar = source[index];
    if (pendingReturnType) {
      if (pendingChar === "\n") { pendingReturnType = false; output += pendingChar; index += 1; continue; }
      if (!/\s/.test(pendingChar) && pendingChar !== ":") pendingReturnType = false;
    }

    if (source.startsWith("--", index)) {
      const longComment = readLongBracket(source, index + 2);
      if (longComment) { output += source.slice(index, scanLongBracket(source, longComment.end, longComment.equalsCount)); index = scanLongBracket(source, longComment.end, longComment.equalsCount); continue; }
      const lineEnd = source.indexOf("\n", index);
      if (lineEnd === -1) { output += source.slice(index); break; }
      output += source.slice(index, lineEnd);
      index = lineEnd;
      continue;
    }

    const longBracket = readLongBracket(source, index);
    if (longBracket) { output += source.slice(index, scanLongBracket(source, longBracket.end, longBracket.equalsCount)); index = scanLongBracket(source, longBracket.end, longBracket.equalsCount); continue; }

    const char = source[index];
    if (char === "\"" || char === "'") { const endIndex = scanQuotedString(source, index); output += source.slice(index, endIndex); index = endIndex; continue; }

    if (isNameStart(char)) {
      let endIndex = index + 1;
      while (endIndex < source.length && isNameChar(source[endIndex])) endIndex += 1;
      const name = source.slice(index, endIndex);
      output += name;
      if (name === "local") { inLocalDecl = true; pendingFunction = false; pendingReturnType = false; expectTypeAnnotation = false; }
      else if (name === "function") { pendingFunction = true; inLocalDecl = false; pendingReturnType = false; expectTypeAnnotation = false; }
      else if (inLocalDecl || paramDepth > 0) expectTypeAnnotation = true;
      index = endIndex;
      continue;
    }

    if (char === "(") {
      output += char; index += 1;
      if (pendingFunction) { pendingFunction = false; paramDepth = 1; }
      else if (paramDepth > 0) paramDepth += 1;
      continue;
    }

    if (char === ")") {
      output += char; index += 1;
      if (paramDepth > 0) { paramDepth -= 1; if (paramDepth === 0) pendingReturnType = true; }
      expectTypeAnnotation = false;
      continue;
    }

    if (char === ":" && (pendingReturnType || expectTypeAnnotation)) {
      index = skipTypeExpression(index + 1);
      pendingReturnType = false;
      expectTypeAnnotation = false;
      continue;
    }

    if (char === "=") { output += char; index += 1; inLocalDecl = false; pendingReturnType = false; expectTypeAnnotation = false; continue; }
    if (char === ";") { output += char; index += 1; inLocalDecl = false; pendingReturnType = false; expectTypeAnnotation = false; continue; }
    if (char === "\n") { output += char; index += 1; inLocalDecl = false; pendingReturnType = false; expectTypeAnnotation = false; continue; }
    if (char === "," && (inLocalDecl || paramDepth > 0)) { output += char; index += 1; expectTypeAnnotation = false; continue; }
    if (inLocalDecl && !/\s/.test(char) && char !== "," && char !== ":" && char !== "=") { inLocalDecl = false; expectTypeAnnotation = false; }

    output += char;
    index += 1;
  }

  return output;
}

function isContinuePlaceholderName(name) {
  return typeof name === "string" && name.startsWith(CONTINUE_LABEL_PREFIX);
}

function rewriteContinuePlaceholderBody(statements) {
  const rewritten = [];
  for (const statement of statements) {
    if (!statement || typeof statement !== "object") { rewritten.push(statement); continue; }
    if (statement.type === "LabelStatement" && isContinuePlaceholderName(statement.label && statement.label.name)) continue;
    if (statement.type === "GotoStatement" && isContinuePlaceholderName(statement.label && statement.label.name)) {
      rewritten.push({ type: "ContinueStatement", range: statement.range });
      continue;
    }
    rewritten.push(rewriteContinuePlaceholders(statement));
  }
  return rewritten;
}

function rewriteContinuePlaceholders(node) {
  if (!node || typeof node !== "object") return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "scope") continue;
    if (Array.isArray(value)) {
      if (key === "body") { node[key] = rewriteContinuePlaceholderBody(value); }
      else { node[key] = value.map((item) => rewriteContinuePlaceholders(item)); }
      continue;
    }
    if (value && typeof value === "object") node[key] = rewriteContinuePlaceholders(value);
  }
  return node;
}

function normalizeExtendedLuaSyntax(source) {
  let result = normalizeBacktickStrings(source);
  result = normalizeContinueStatements(result);
  result = normalizeUnicodeStringLiterals(result);
  result = stripTypeAnnotations(result);
  result = normalizeCompoundAssignments(result);
  return result;
}

function parseLua(source) {
  const needsExtended = needsNormalization(source);
  const normalized = needsExtended ? normalizeExtendedLuaSyntax(source) : source;

  const baseOptions = {
    comments: true,
    encodingMode: "pseudo-latin1",
    locations: false,
    ranges: true,
    scope: true,
  };

  const versions = normalized.includes(CONTINUE_LABEL_PREFIX)
    ? ["5.2", "5.3", "5.1"]
    : ["5.1", "5.2", "5.3"];

  let lastError = null;
  let firstError = null;
  for (const luaVersion of versions) {
    try {
      const ast = luaparse.parse(normalized, { ...baseOptions, luaVersion });
      return rewriteContinuePlaceholders(ast);
    } catch (error) {
      if (!firstError) firstError = error;
      lastError = error;
    }
  }

  throw versions[0] === "5.1" ? lastError : (firstError || lastError);
}

module.exports = {
  parseLua,
};