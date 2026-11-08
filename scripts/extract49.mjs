import fs from 'node:fs';
const ast = JSON.parse(fs.readFileSync('/tmp/sample-ast.json', 'utf8'));
let found = null;
const walk = (node, depth) => {
  if (found || depth > 40 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
  if (node.type === 'AstExprTable' && Array.isArray(node.items)) {
    for (const it of node.items) {
      if (it.key && it.key.type === 'AstExprConstantNumber' && it.key.value === 49) { found = node; return; }
    }
  }
  for (const k of Object.keys(node)) walk(node[k], depth + 1);
};
walk(ast, 0);
if (!found) { console.error('table with [49] not found'); process.exit(1); }
console.log('table items:', found.items.length);
for (const it of found.items) {
  if (it.key && it.key.type === 'AstExprConstantNumber' && it.key.value === 49) {
    fs.writeFileSync('/tmp/ast49.json', JSON.stringify(it.value, null, 1));
    console.log('[49] ->', it.value.type, 'saved; json size', JSON.stringify(it.value).length);
    console.log('location:', it.value.location);
  }
}
