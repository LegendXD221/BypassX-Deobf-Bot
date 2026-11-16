/**
 * Analyze probe results → v14.7 ISA behavior classes.
 * Control: real program = ok=true r1=table.
 * Per op (variant 0 = real operands, 1 = patterned 1,2,3):
 *   classify: ok-return / error-arithmetic / error-call / error-index /
 *             error-concat / error-compare / error-assert-ish / killed(spin) / tamper
 */
import fs from 'node:fs';

const lines = fs.readFileSync('/home/z/my-project/download/bypassx-deobf-bot/var/external/bf-v147-probe-results.jsonl', 'utf8').trim().split('\n');
const results = lines.map((l) => JSON.parse(l));

function parseRes(arr) {
  // find the #RES entry
  const res = arr.find((t) => t.startsWith('#RES'));
  if (!res) return { killed: true };
  const m = /^#RES kind=(\w+) a=(\S+) b=(\S+) ok=(\w+) r1=(.*?) r2=(.*?) r3=(.*?)$/.exec(res);
  if (!m) return { raw: res };
  return { ok: m[4] === 'true', r1: m[5], r2: m[6], r3: m[7] };
}

const classify = (r) => {
  if (r.killed) return 'SPIN';
  if (r.ok === true) return 'RETURN';
  if (r.ok === false) {
    const e = (r.r1 || '') + (r.r2 || '');
    if (/attempt to perform arithmetic/.test(e)) return 'ERR-ARITH';
    if (/attempt to call/.test(e)) return 'ERR-CALL';
    if (/attempt to index/.test(e)) return 'ERR-INDEX';
    if (/attempt to concatenate/.test(e)) return 'ERR-CONCAT';
    if (/attempt to compare/.test(e)) return 'ERR-COMPARE';
    if (/buffer access out of bounds/.test(e)) return 'BUFFER-OOB';
    if (/loop truncated/.test(e)) return 'LOOP-ABORT';
    if (/budget exhausted/.test(e)) return 'BUDGET';
    if (/anti-tamper/.test(e)) return 'TAMPER';
    if (/stack overflow/.test(e)) return 'STACK-OVF';
    if (/bad argument/.test(e)) return 'ERR-ARG';
    return 'ERR-OTHER';
  }
  return 'UNKNOWN';
};

const ctrlParsed = { ok: true, r1: 'table', r2: 'nil', r3: 'nil' };
console.log('CTRL (known):', JSON.stringify(ctrlParsed));

const byOp = {};
for (const r of results) {
  const m = /^op:(\d+):(\d+)$/.exec(r.tag);
  if (!m) continue;
  const op = Number(m[1]), variant = Number(m[2]);
  const p = parseRes(r.res);
  (byOp[op] ||= {})[variant] = p;
}

const classes = {};
const rows = [];
for (const [op, variants] of Object.entries(byOp)) {
  const c0 = classify(variants[0] || {});
  const c1 = classify(variants[1] || {});
  const key = `${c0}${c0 === c1 ? '' : '/' + c1}`;
  rows.push({ op: Number(op), c0, c1, v0: variants[0], v1: variants[1] });
  (classes[key] ||= []).push(Number(op));
}
console.log('\nclass distribution:');
for (const [k, ops] of Object.entries(classes).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k}: ${ops.length} ops — ${ops.slice(0, 40).join(',')}${ops.length > 40 ? '…' : ''}`);
}

// RETURN ops: show return values (variant0 vs variant1 deltas)
console.log('\nRETURN ops detail (op: v0r1 v1r1):');
for (const r of rows.filter((x) => x.c0 === 'RETURN' || x.c1 === 'RETURN').slice(0, 40)) {
  console.log(`  op ${r.op}: v0=${(r.v0?.r1 || '').slice(0, 28)} | v1=${(r.v1?.r1 || '').slice(0, 28)}`);
}
fs.writeFileSync('/home/z/my-project/download/bypassx-deobf-bot/var/external/bf-v147-isa-classes.json', JSON.stringify(rows.map(({ op, c0, c1 }) => ({ op, c0, c1 })), null, 1));
console.log('\nsaved → var/external/bf-v147-isa-classes.json');
