'use strict';

const SERVICE_MAP = {
  'Players': 'playersService', 'HttpService': 'httpService',
  'TweenService': 'tweenService', 'Lighting': 'lighting',
  'RunService': 'runService', 'UserInputService': 'userInputService',
  'CoreGui': 'coreGui', 'StarterGui': 'starterGui',
  'ReplicatedStorage': 'replicatedStorage', 'Workspace': 'workspace',
  'ServerScriptService': 'serverScriptService', 'MarketplaceService': 'marketplaceService',
  'SoundService': 'soundService', 'DataStoreService': 'dataStoreService',
};

const INSTANCE_MAP = {
  'ScreenGui': 'screenGui', 'Frame': 'frame', 'TextLabel': 'textLabel',
  'TextButton': 'textButton', 'TextBox': 'textBox', 'ImageButton': 'imageButton',
  'ImageLabel': 'imageLabel', 'LocalScript': 'localScript', 'Script': 'script',
  'ModuleScript': 'moduleScript', 'UIStroke': 'uiStroke', 'UICorner': 'uiCorner',
  'UIGradient': 'uiGradient', 'UIScale': 'uiScale', 'BlurEffect': 'blurEffect',
  'UISizeConstraint': 'uiSizeConstraint', 'UITextSizeConstraint': 'uiTextSizeConstraint',
  'UIAspectRatioConstraint': 'uiAspectRatioConstraint', 'Sound': 'sound',
  'Part': 'part', 'Folder': 'folder', 'ScrollingFrame': 'scrollingFrame',
};

const ASSIGN_PATTERNS = [
  { re: /GetService\s*\(\s*"(\w+)"\s*\)/, map: SERVICE_MAP },
  { re: /Instance\.new\s*\(\s*"(\w+)"\s*\)/, map: INSTANCE_MAP },
  { re: /\.Players\.LocalPlayer/, name: 'localPlayer' },
  { re: /loadstring\s*\(/, name: 'loader' },
  { re: /HttpGet\s*\(/, name: 'httpResponse' },
  { re: /WaitForChild\s*\(\s*"(\w+)"\s*\)/, transform: m => lcFirst(m[1]) },
  { re: /FindFirstChild\s*\(\s*"(\w+)"\s*\)/, transform: m => lcFirst(m[1]) },
  { re: /\bpairs\s*\(/, name: 'iterator' },
  { re: /\bstring\.gsub\s*\(/, name: 'decoded' },
  { re: /\bstring\.sub\s*\(/, name: 'substring' },
  { re: /\bstring\.byte\s*\(/, name: 'byteVal' },
  { re: /\bstring\.char\s*\(/, name: 'charVal' },
  { re: /\bstring\.find\s*\(/, name: 'findResult' },
  { re: /\btostring\s*\(/, name: 'strVal' },
  { re: /\btonumber\s*\(/, name: 'numVal' },
  { re: /\bmath\.random\s*\(/, name: 'randomVal' },
  { re: /\bmath\.floor\s*\(/, name: 'floorVal' },
  { re: /\bUDim2\.new\s*\(/, name: 'udim2' },
  { re: /\bColor3\.new\s*\(/, name: 'color' },
  { re: /\bVector2\.new\s*\(/, name: 'vector2' },
  { re: /\bTweenInfo\.new\s*\(/, name: 'tweenInfo' },
  { re: /JSONEncode\s*\(/, name: 'jsonString' },
  { re: /JSONDecode\s*\(/, name: 'jsonData' },
  { re: /\bwritefile\s*\(/, name: 'fileContent' },
  { re: /\breadfile\s*\(/, name: 'fileContent' },
  { re: /\bpcall\s*\(/, name: 'success' },
  { re: /\bspawn\s*\(/, name: 'spawned' },
  { re: /\btask\.spawn\s*\(/, name: 'spawned' },
  { re: /\bgetfenv\s*\(/, name: 'environment' },
  { re: /\bsetmetatable\s*\(/, name: 'metaTable' },
  { re: /\bgetgc\s*\(/, name: 'garbageCollect' },
];

const KEYWORDS = new Set([
  'local', 'function', 'return', 'if', 'then', 'else', 'elseif', 'end',
  'while', 'do', 'for', 'in', 'repeat', 'until', 'break', 'true', 'false',
  'nil', 'not', 'and', 'or', 'self', 'goto',
]);
const BUILTINS = new Set([
  'game', 'Instance', 'task', 'string', 'math', 'table', 'Color3', 'UDim2',
  'UDim', 'Vector2', 'Rect', 'TweenInfo', 'Enum', 'pcall', 'spawn',
  'loadstring', 'getfenv', 'setmetatable', 'getmetatable', 'next', 'print',
  'pairs', 'ipairs', 'select', 'require', 'type', 'typeof', 'tostring',
  'tonumber', 'rawset', 'rawget', 'error', 'assert', 'coroutine', 'newproxy',
  'isfile', 'writefile', 'readfile', 'setclipboard', 'getrenv', 'getgenv',
  'http_request', 'request', 'HttpGet', 'JSONEncode', 'JSONDecode',
  'Wait', 'Clone', 'Destroy', 'Connect', 'FindFirstChild', 'WaitForChild',
  'GetService', 'GetChildren', 'GetAttribute', 'SetAttribute',
]);

function lcFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

function stripStrings(src) {
  let r = src.replace(/--\[\[[\s\S]*?\]\]/g, '');
  r = r.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  r = r.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return r;
}

function uniqueName(base, taken) {
  let name = base;
  let n = 2;
  while (taken.has(name)) { name = base + n; n++; }
  taken.add(name);
  return name;
}

function isGeneric(name) {
  return /^[a-z]\d+$/.test(name) && !KEYWORDS.has(name) && !BUILTINS.has(name);
}

function postprocess(code) {
  const lines = code.split('\n');
  const takenNames = new Set();

  const joined = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.trim().endsWith(',') && i + 1 < lines.length) {
      line = line.trimEnd() + ' ' + lines[i + 1].trim();
      i++;
    }
    joined.push(line);
  }

  const cleaned = [];
  for (let i = 0; i < joined.length; i++) {
    const trimmed = joined[i].trim();
    if (trimmed === 'do') {
      let j = i + 1;
      while (j < joined.length && joined[j].trim() === '') j++;
      if (j < joined.length && joined[j].trim() === 'end') { i = j; continue; }
    }
    cleaned.push(joined[i]);
  }
  const lines2 = cleaned;

  const allGeneric = new Set();
  const varDeclLines = new Map();
  const funcDeclLines = new Map();
  const paramDeclLines = new Map();

  for (let i = 0; i < lines2.length; i++) {
    const t = lines2[i].trim();

    const m = t.match(/^local\s+(.+)/);
    if (m) {
      const rest = m[1];
      const namesPart = rest.split('=')[0].trim();
      const names = namesPart.split(',').map(s => s.trim());
      for (const n of names) {
        if (isGeneric(n)) {
          allGeneric.add(n);
          if (!varDeclLines.has(n)) varDeclLines.set(n, i);
        }
      }
    }

    const fm = t.match(/(?:local\s+)?function\s+([a-z]\w*)\s*\(/);
    if (fm && isGeneric(fm[1])) {
      allGeneric.add(fm[1]);
      funcDeclLines.set(fm[1], i);
    }

    const pm = t.match(/(?:local\s+)?function\s+\w+\s*\(([^)]*)\)/);
    if (pm && pm[1].trim()) {
      for (const p of pm[1].split(',')) {
        const pn = p.trim();
        if (isGeneric(pn)) {
          allGeneric.add(pn);
          paramDeclLines.set(pn, i);
        }
      }
    }
  }

  const strippedLines = lines2.map(l => stripStrings(l));
  const usedGeneric = new Set();

  for (const name of allGeneric) {
    const re = new RegExp('\\b' + name + '\\b');
    for (let i = 0; i < strippedLines.length; i++) {
      if (varDeclLines.has(name) && varDeclLines.get(name) === i) continue;
      if (funcDeclLines.has(name) && funcDeclLines.get(name) === i) continue;
      if (paramDeclLines.has(name) && paramDeclLines.get(name) === i) continue;
      if (re.test(strippedLines[i])) { usedGeneric.add(name); break; }
    }
  }

  const purposeMap = new Map();

  for (let i = 0; i < lines2.length; i++) {
    const t = lines2[i].trim();
    const am = t.match(/(?:local\s+)?([a-z]\w*)\s*=\s*(.+)$/);
    if (am) {
      const varName = am[1];
      if (purposeMap.has(varName)) continue;
      for (const pat of ASSIGN_PATTERNS) {
        const m = rhs => rhs.match(pat.re);
        const match = am[2].match(pat.re);
        if (match) {
          if (pat.name) purposeMap.set(varName, pat.name);
          else if (pat.map && match[1]) purposeMap.set(varName, pat.map[match[1]] || lcFirst(match[1]));
          else if (pat.transform) purposeMap.set(varName, pat.transform(match));
          break;
        }
      }
    }
  }

  for (const [fname, declLine] of funcDeclLines) {
    if (purposeMap.has(fname)) continue;
    let body = '';
    for (let i = declLine; i < Math.min(declLine + 80, lines2.length); i++) {
      body += lines2[i] + '\n';
      if (i > declLine && /\bend\b/.test(lines2[i])) break;
    }
    if (body.includes('return function')) purposeMap.set(fname, 'closureFactory');
    else if (body.includes('HttpGet')) purposeMap.set(fname, 'fetchData');
    else if (body.includes('Instance.new')) {
      const tm = body.match(/Instance\.new\s*\(\s*"(\w+)"\s*\)/);
      purposeMap.set(fname, tm ? 'create' + tm[1] : 'createElement');
    }
    else if (body.includes('.Connect')) purposeMap.set(fname, 'onEvent');
    else if (body.includes('task.wait') || /\bwait\s*\(/.test(body)) purposeMap.set(fname, 'waitLoop');
    else if (body.includes('pairs') || body.includes('ipairs')) purposeMap.set(fname, 'iterate');
    else if (body.includes('string.gsub')) purposeMap.set(fname, 'decodeBase64');
    else if (body.includes('pcall')) purposeMap.set(fname, 'safeCall');
    else if (body.includes('writefile') || body.includes('readfile')) purposeMap.set(fname, 'fileIO');
    else purposeMap.set(fname, 'helper');
  }

  for (const vname of usedGeneric) {
    if (purposeMap.has(vname)) continue;
    const declLine = varDeclLines.get(vname) || 0;
    const ctx = lines2.slice(Math.max(0, declLine - 1), Math.min(lines2.length, declLine + 15)).join('\n');
    const esc = vname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const propMatch = ctx.match(new RegExp(esc + '\\.(\\w+)'));
    const methodMatch = ctx.match(new RegExp(esc + ':(\\w+)'));

    if (propMatch) {
      const p = propMatch[1];
      if (p === 'Text') purposeMap.set(vname, 'label');
      else if (p === 'Parent') purposeMap.set(vname, 'parent');
      else if (p === 'Enabled') purposeMap.set(vname, 'toggle');
      else purposeMap.set(vname, 'element');
    } else if (methodMatch) {
      const m = methodMatch[1];
      if (m === 'Connect') purposeMap.set(vname, 'callback');
      else if (m === 'Play') purposeMap.set(vname, 'tween');
      else if (m === 'Destroy') purposeMap.set(vname, 'target');
      else purposeMap.set(vname, 'object');
    }
  }

  const renameMap = new Map();

  for (const vname of usedGeneric) {
    const purpose = purposeMap.get(vname) || 'val';
    renameMap.set(vname, uniqueName(purpose, takenNames));
  }
  for (const [fname] of funcDeclLines) {
    if (!renameMap.has(fname) && usedGeneric.has(fname)) {
      renameMap.set(fname, uniqueName(purposeMap.get(fname) || 'func', takenNames));
    }
  }
  for (const [pname] of paramDeclLines) {
    if (!renameMap.has(pname) && usedGeneric.has(pname)) {
      renameMap.set(pname, uniqueName('arg', takenNames));
    }
  }

  const finalLines = [];
  for (let i = 0; i < lines2.length; i++) {
    const t = lines2[i].trim();

    const localMatch = t.match(/^local\s+(.+)/);
    if (localMatch && !localMatch[1].includes('=')) {

      const names = localMatch[1].split(',').map(s => s.trim());
      const allGenericNames = names.filter(n => isGeneric(n));
      if (allGenericNames.length > 0) {
        const usedNames = allGenericNames.filter(n => usedGeneric.has(n));
        if (usedNames.length === 0) continue;
        if (usedNames.length < allGenericNames.length) {

          finalLines.push('local ' + usedNames.join(', '));
          continue;
        }
      }
    }

    finalLines.push(lines2[i]);
  }

  let result = finalLines.join('\n');
  const sorted = [...renameMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [old, newName] of sorted) {
    if (old === newName) continue;
    const re = new RegExp('\\b' + old + '\\b', 'g');
    result = result.replace(re, newName);
  }

  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/^\s*do\s*\n\s*end\s*\n/gm, '');
  result = result.replace(/\n+$/, '\n');

  result = result.replace(/\nreturn;?\s*$/, '\n');
  result = result.replace(/\n+$/, '\n');

  return result;
}

module.exports = { postprocess };
