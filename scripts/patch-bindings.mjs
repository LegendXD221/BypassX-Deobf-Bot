// Depth-aware sample patcher: rewrite only TOP-LEVEL [N]=expr bindings in the
// outermost table constructor, never inside string literals.
export function patchBindings(source, replaceFn) {
  const out = [];
  let i = 0;
  const n = source.length;
  let depth = 0;
  let inStr = null; // quote char or 'long'
  let longEq = 0;
  let inComment = false;
  const isAlpha = (c) => /[A-Za-z0-9_]/.test(c);

  const scanString = (quote) => {
    // returns index after closing quote; handles \escapes and [[long]]
    if (quote === '[' && source[i + 1] === '[') {
      let j = i + 2;
      let eq = 0;
      while (source[j] === '=') { eq++; j++; }
      if (source[j] === '[') {
        const close = ']' + '='.repeat(eq) + ']';
        const end = source.indexOf(close, j + 1);
        return end === -1 ? n : end + close.length;
      }
      return i + 1; // not a long string
    }
    let j = i + 1;
    while (j < n) {
      const c = source[j];
      if (c === '\\') { j += 2; continue; }
      if (c === quote) return j + 1;
      if (c === '\n') return j + 1; // unterminated (defensive)
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = source[i];
    // comments
    if (!inStr && c === '-' && source[i + 1] === '-') {
      if (source[i + 2] === '[' && source[i + 3] === '[') {
        const end = source.indexOf(']]', i + 3);
        const stop = end === -1 ? n : end + 2;
        out.push(source.slice(i, stop));
        i = stop;
        continue;
      }
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }
    // strings
    if (!inComment && (c === '"' || c === "'")) {
      const end = scanString(c);
      out.push(source.slice(i, end));
      i = end;
      continue;
    }
    if (!inComment && c === '[' && (source[i + 1] === '[' || source[i + 1] === '=')) {
      const end = scanString('[');
      if (end > i + 1) { out.push(source.slice(i, end)); i = end; continue; }
    }
    // track depth
    if (c === '{') depth++;
    else if (c === '}') depth--;
    // candidate binding at depth 1: [digits]=expr
    if (depth === 1 && c === '[') {
      const m = /^\[(\d+)\]=([A-Za-z_][A-Za-z0-9_.]*)/.exec(source.slice(i));
      if (m) {
        const replaced = replaceFn(Number(m[1]), m[2]);
        if (replaced !== null) {
          out.push(replaced);
          i += m[0].length;
          continue;
        }
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}
