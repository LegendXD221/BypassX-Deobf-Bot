// Extract the inner-VM opcode semantics from the [49] interpreter factory AST.
import fs from 'node:fs';

const ast49 = JSON.parse(fs.readFileSync('/tmp/ast49.json', 'utf8'));
const sample = fs.readFileSync('/home/z/my-project/download/bypassx-deobf-bot/test/fixtures/luraph-v15.1-real-sample.lua', 'utf8');
const line2 = sample.slice(sample.indexOf('\n') + 1);

function loc(node) {
  const [a, b] = node.location.split(' - ');
  return [Number(a.split(',')[1]), Number(b.split(',')[1])];
}
function text(node) {
  const [c1, c2] = loc(node);
  return line2.slice(c1 - 1, c2);
}
const localName = (e) => (e && e.type === 'AstExprLocal') ? (e.local ? e.local.name : e.name) : null;

// collect all while-true loops with a `local X = k[I]` head
const loops = [];
const walk = (node, depth) => {
  if (!node || typeof node !== 'object' || depth > 30) return;
  if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
  if (node.type === 'AstStatWhile' && node.condition && node.condition.type === 'AstExprConstantBool') {
    const body = node.body && node.body.body;
    if (body && body[0] && body[0].type === 'AstStatLocal' && /\[\s*I\s*\]/.test(text(body[0]))) loops.push(node);
  }
  for (const k of Object.keys(node)) walk(node[k], depth + 1);
};
walk(ast49, 0);
console.log('dispatch loops:', loops.length, loops.map(l => localName(l.body.body[0].vars[0])).join(','));

const OPS = {
  CompareLt: (a, b) => a < b, CompareLe: (a, b) => a <= b,
  CompareGt: (a, b) => a > b, CompareGe: (a, b) => a >= b,
  CompareEq: (a, b) => a === b, CompareNe: (a, b) => a !== b,
};
const FLIP = { CompareLt: 'CompareGt', CompareLe: 'CompareGe', CompareGt: 'CompareLt', CompareGe: 'CompareLe', CompareEq: 'CompareEq', CompareNe: 'CompareNe' };
function evalCond(cond, varName, value) {
  if (cond.type !== 'AstExprBinary' || !(cond.op in OPS)) return null;
  const l = cond.left, r = cond.right;
  if (localName(l) === varName && r.type === 'AstExprConstantNumber') return OPS[cond.op](value, r.value);
  if (localName(r) === varName && l.type === 'AstExprConstantNumber') return OPS[FLIP[cond.op]](value, l.value);
  return null;
}
function resolve(node, varName, value) {
  while (true) {
    if (!node) return null;
    if (node.type === 'AstStatIf') {
      const r = evalCond(node.condition, varName, value);
      if (r === null) return node;
      if (r) node = node.thenbody;
      else { if (!node.elsebody) return null; node = node.elsebody; }
      continue;
    }
    if (node.type === 'AstStatBlock') {
      if (node.body && node.body.length >= 1 && node.body[0].type === 'AstStatIf' && evalCond(node.body[0].condition, varName, value) !== null) { node = node.body[0]; continue; }
      return node;
    }
    return node;
  }
}

const out = [];
loops.forEach((loop, li) => {
  const v0 = loop.body.body[0].vars[0];
  const varName = v0.name || (v0.local && v0.local.name);
  const tree = loop.body.body.find(s => s && s.type === 'AstStatIf');
  if (!tree) { out.push('## LOOP ' + li + ' (' + varName + '): no if-tree'); return; }
  if (!tree) { out.push(`## loop ${li} (${varName}): no if-tree`); return; }
  out.push(`## LOOP ${li} dispatch var: ${varName}`);
  const seen = new Map();
  for (let op = 0; op <= 255; op++) {
    const blk = resolve(tree, varName, op);
    if (!blk) continue;
    const [c1, c2] = loc(blk);
    const key = c1 + ':' + c2;
    if (!seen.has(key)) seen.set(key, { op, text: text(blk) });
  }
  for (const [key, v] of [...seen.entries()].sort((a, b) => a[1].op - b[1].op)) {
    out.push(`---- ${varName}=${v.op} (loc ${key}) ----\n${v.text.slice(0, 500)}\n`);
  }
});
fs.writeFileSync('/home/z/my-project/download/bypassx-deobf-bot/research/luraph49-opcodes.txt', out.join('\n'));
console.log('written research/luraph49-opcodes.txt,', out.length, 'sections');
