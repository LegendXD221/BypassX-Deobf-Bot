/**
 * fengari Luau compatibility patch — GENERALIZED ITERATION (v2.18.2).
 *
 * Luau (Roblox) allows `for k,v in t do` directly on plain tables
 * ("generalized iteration"). Standard Lua 5.3 (fengari) raises
 * "attempt to call a table value" because the table is used as the
 * iterator function. Luraph v14.7 loaders use this in their init
 * (bloxfruits sample died at `for S,l in N do` over a plain table).
 *
 * Patch: fengari's lvm.js OP_TFORCALL — when the iterator slot holds a
 * TABLE with no __call metamethod, drive ltable.luaH_next with Luau
 * semantics instead of calling the table (pairs()-style next(t, ctrl)).
 *
 * Idempotent (marker-checked), applied at install time; wired as the
 * `postinstall` npm script so Render re-applies it on every deploy.
 * If fengari ships a different lvm.js (anchor text not found), this
 * exits non-zero loudly instead of silently skipping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LVM = path.join(ROOT, 'node_modules', 'fengari', 'src', 'lvm.js');

const MARKER = '__BX_LUAU_GENERALIZED_ITER__';

// The exact main-dispatch OP_TFORCALL block shipped by fengari 0.1.5.
// (luaV_finishOp also has a TFORCALL case — that one resumes a call that
// already happened and must stay untouched; this anchor text is unique to
// the dispatch block because of the `/* call base */` comment.)
const ANCHOR = `            case OP_TFORCALL: {
                let cb = ra + 3; /* call base */
                lobject.setobjs2s(L, cb+2, ra+2);
                lobject.setobjs2s(L, cb+1, ra+1);
                lobject.setobjs2s(L, cb, ra);
                ldo.adjust_top(L, cb+3);  /* func. + 2 args (state and index) */
                ldo.luaD_call(L, cb, i.C);`;

const REPLACEMENT = `            case OP_TFORCALL: {
                let cb = ra + 3; /* call base */
                lobject.setobjs2s(L, cb+2, ra+2);
                lobject.setobjs2s(L, cb+1, ra+1);
                lobject.setobjs2s(L, cb, ra);
                ldo.adjust_top(L, cb+3);  /* func. + 2 args (state and index) */
                /* ${MARKER}: Luau \`for k,v in t do\` — plain-table iterators
                   run luaH_next directly (no __call metamethod → standard Lua
                   would raise "attempt to call a table value"). */
                let bxGenIter = false;
                {
                    const itv = L.stack[ra];
                    if (itv.ttistable()) {
                        const tmv = ltm.luaT_gettmbyobj(L, itv, ltm.TMS.TM_CALL);
                        if (!tmv || tmv.ttisnil()) {
                            bxGenIter = true;
                            /* materialize the slot luaH_next writes the value into —
                               adjust_top deletes slots on shrink, so cb+3 may be a hole */
                            ldo.adjust_top(L, cb + 4);
                            const bxt = itv.value; /* table TValue → Table object (no hvalue export) */
                            if (ltable.luaH_next(L, bxt, cb + 2)) {
                                lobject.setobjs2s(L, cb, cb + 2);
                                lobject.setobjs2s(L, cb + 1, cb + 3);
                                for (let bx = 2; bx < i.C; bx++) L.stack[cb + bx].setnilvalue();
                            } else {
                                for (let bx = 0; bx < (i.C > 2 ? i.C : 2); bx++) L.stack[cb + bx].setnilvalue();
                            }
                        }
                    }
                }
                if (!bxGenIter) ldo.luaD_call(L, cb, i.C);`;

const src = fs.readFileSync(LVM, 'utf8');

if (src.includes(MARKER)) {
  console.log('[patch-fengari] already applied — skipping');
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error('[patch-fengari] ANCHOR NOT FOUND — fengari lvm.js shape changed; refusing to patch blindly');
  process.exit(2);
}

if (!src.includes("const ltm     = require('./ltm.js');") || !src.includes("const ltable  = require('./ltable.js');")) {
  console.error('[patch-fengari] ltm/ltable imports missing — cannot patch');
  process.exit(2);
}

fs.writeFileSync(LVM, src.replace(ANCHOR, REPLACEMENT), 'utf8');

// verify
const after = fs.readFileSync(LVM, 'utf8');
if (!after.includes(MARKER)) {
  console.error('[patch-fengari] write-back verification failed');
  process.exit(3);
}
console.log('[patch-fengari] applied: OP_TFORCALL now supports Luau generalized iteration');
