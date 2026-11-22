'use strict';

const { OP, decode, JUMP_ARG } = require('./cfg.js');
const { OPNAME, ARGCNT } = require('./vmspec.js');

function kRepr(K, i) {
  if (!K || i < 0 || i >= K.length) return 'K[' + i + ']';
  const v = K[i];
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'nil';
  return String(v);
}

function annotate(ins, K) {
  const a = ins.args;
  switch (ins.op) {
    case OP.PUSH_K: return kRepr(K, a[0]);
    case OP.LOAD_G: case OP.STORE_G: return kRepr(K, a[0]);
    case OP.LOAD_L: case OP.STORE_L: return 'L' + a[0];
    case OP.LOAD_UPVAL: case OP.STORE_UPVAL: return 'U' + a[0];
    case OP.CLOSE_UPVAL: return 'L' + a[0];
    case OP.CLOSURE: return 'proto#' + a[0];
    case OP.JMP: case OP.JMP_F: case OP.FORPREP: case OP.FORLOOP: return '-> ' + a[0];
    case OP.TFOR: return a[0] + ', -> ' + a[1];
    case OP.CALL: case OP.TAILCALL: return 'nargs=' + a[0];
    case OP.CALL_MULTI: return 'nargs=' + a[0] + ' nres=' + (a[1] < 0 ? 'all' : a[1]);
    case OP.CALL_DYNAMIC: return 'nres=' + (a[0] < 0 ? 'all' : a[0]);
    case OP.RETURN: return a[0] < 0 ? 'all' : String(a[0]);
    case OP.ITER_PREP: return 'iter=L' + a[0] + ' state=L' + a[1] + ' ctl=L' + a[2];
    case OP.CTX_LOAD: return '?' + a[0];
    default: return a.length ? a.join(', ') : '';
  }
}

function disasm(chunk, opts = {}) {
  const code = chunk.code || [];
  const K = chunk.K || [];
  const dec = decode(code);
  const out = [];
  if (!dec) return '-- <undecodable code stream, length ' + code.length + '>';

  const targets = new Set();
  for (const ins of dec.instrs) {
    const ai = JUMP_ARG[ins.op];
    if (ai !== undefined) targets.add(ins.args[ai]);
  }
  for (const ins of dec.instrs) {
    const label = targets.has(ins.pos) ? '>' : ' ';
    const name = OPNAME[ins.op] || ('OP' + ins.op);
    const ann = annotate(ins, K);
    out.push(
      label + String(ins.pos).padStart(5) + '  ' + name.padEnd(14) +
      (ann ? ' ' + ann : '')
    );
  }
  const head = [];
  head.push('-- nParams=' + (chunk.nParams || 0) +
    ' vararg=' + (chunk.hasVarargs ? 'yes' : 'no') +
    ' K=' + K.length +
    ' protos=' + ((chunk.protos || []).length) +
    ' upvals=' + ((chunk.upvalues || []).length));
  if (opts.consts !== false && K.length) {
    head.push('-- K: ' + K.map((v, i) => i + '=' + kRepr(K, i)).join('  '));
  }
  let s = head.join('\n') + '\n' + out.join('\n');
  if (opts.recurse !== false) {
    (chunk.protos || []).forEach((p, i) => {
      s += '\n\n-- ===== proto#' + (i + 1) + ' =====\n' + disasm(p, opts);
    });
  }
  return s;
}

module.exports = { disasm, annotate, kRepr };
