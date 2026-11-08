// Inject decrypt-event logging at EVERY xorshift block-decrypt loop in the sample.
// Detects the signature, extracts roles, inserts a log line before the `for`.
import fs from 'node:fs';

const sample = fs.readFileSync('/home/z/my-project/download/bypassx-deobf-bot/test/fixtures/luraph-v15.1-real-sample.lua', 'utf8');
const line2 = sample.slice(sample.indexOf('\n') + 1);

const SIG = 'H=P(Q(H,(w(H,13))),536870911);H=Q(H,(U(H,13)));H=P(Q(H,(w(H,14))),536870911);';
const sites = [];
let pos = 0;
while ((pos = line2.indexOf(SIG, pos)) !== -1) { sites.push(pos); pos += 1; }
console.log(`xorshift sites: ${sites.length}`);

// for each site, find the enclosing for-loop start (search backward for 'for ') and
// extract the role mapping from the body (which array XORs which bit group)
let out = line2;
let injected = 0;
for (let si = sites.length - 1; si >= 0; si--) {
  const at = sites[si];
  // find the 'for ' before the signature (within 400 chars)
  const back = out.lastIndexOf(' for ', at);
  const back2 = out.lastIndexOf(';for ', at);
  const forAt = Math.max(back, back2);
  if (forAt < 0 || at - forAt > 500) { console.error(`site ${si}: for-loop not found`); continue; }
  // find the end of the for body: 'end;' after the signature — the loop body ends with 'm=m+1;end;'
  const endAt = out.indexOf('m=m+1;end;', at);
  if (endAt < 0) { console.error(`site ${si}: loop end not found`); continue; }
  const initAt0 = Math.max(0, forAt - 400);
  const pre = out.slice(initAt0, forAt);
  const initIdx = pre.lastIndexOf('H,m=');
  const bodyStart = initIdx >= 0 ? initAt0 + initIdx : forAt;
  const body = out.slice(bodyStart, endAt + 10);
  // roles: L[m]=Q(L[m],(P(U(H,0),127))) etc
  const roles = {};
  const roleRe = /(s|L|O|k|Y|c|r)\[m\]=Q\(\1\[m\],\(P\(U\(H,(\d+)\),127\)\)\)/g;
  let rm;
  while ((rm = roleRe.exec(body))) roles[rm[1]] = Number(rm[2]);
  // count expr (the for bound) and init (H,m=...)
  const initM = /H,m=([^;]+);/.exec(body);
  const countM = /for \w+=1,([A-Za-z_\[\]I+0-9]+),1 do/.exec(body);
  // key register used in the seed: J or B or none
  const seedReg = /P\(Q\((J|B|D),/.test(body.slice(0, 200)) || /\(Q\((s|O)\[I\],\(P\(Q\((J|B|D)/.exec(body)?.[2];
  const id = injected;
  const logLine = `;__BX_DLOG[#__BX_DLOG+1]={${id},I,${initM ? initM[1] : "0"},${countM ? countM[1] : "0"},B,J,D}`;
  out = out.slice(0, forAt) + logLine + out.slice(forAt);
  injected++;
  console.log(`site ${si} → id ${id}: roles=${JSON.stringify(roles)} init=${initM ? initM[1].slice(0, 40) : '?'} count=${countM ? countM[1] : '?'} seedReg=${seedReg || 'none'}`);
  fs.writeFileSync(`/tmp/decrypt-role-${id}.txt`, body.slice(0, 1200));
}
console.log(`injected logging at ${injected} sites`);

// write the roles table for the JS side
const rolesOut = [];
for (let i = 0; i < injected; i++) {
  const body = fs.existsSync(`/tmp/decrypt-role-${i}.txt`) ? fs.readFileSync(`/tmp/decrypt-role-${i}.txt`, 'utf8') : '';
  const roles = {};
  const roleRe = /(s|L|O|k|Y|c|r)\[m\]=Q\(\1\[m\],\(P\(U\(H,(\d+)\),127\)\)\)/g;
  let rm;
  while ((rm = roleRe.exec(body))) roles[rm[1]] = Number(rm[2]);
  const initM = /H,m=([^;]+);/.exec(body);
  const countM = /for \w+=1,([A-Za-z_\[\]I+0-9]+),1 do/.exec(body);
  const selfMod = /k\[I\]=(\d+)/.exec(body);
  rolesOut.push({ id: i, roles, init: initM ? initM[1] : null, count: countM ? countM[1] : null, selfMod: selfMod ? Number(selfMod[1]) : null });
}
// ---- const-op logging: inject before each const-decrypt site ----
const constShapes = [
  'local K,T,h=s[I],L[I],y[5]',
  'local T,Rq,Fq=O[I],s[I],y[5]',
  'local K,B,T=s[I],L[I],y[5]',
];
let cid = 100;
for (const shape of constShapes) {
  let p2 = 0;
  while ((p2 = out.indexOf(shape, p2)) !== -1) {
    out = out.slice(0, p2) + '__BX_DLOG[#__BX_DLOG+1]={' + cid + ',I,s[I],L[I],O[I],B,J,D};' + out.slice(p2);
    cid++;
    p2 += shape.length + 60;
  }
}
// h=57 style: 'local T,Rq,Fq=s[I],Q(O[I],' with y[5] later — find by the y[5] anchor
{
  const anchor = ',y[5];local Yq=Q(Fq[T],535359694)';
  let p3 = 0;
  while ((p3 = out.indexOf(anchor, p3)) !== -1) {
    // find the start of this local statement: search back for 'local '
    const lAt = out.lastIndexOf('local ', p3);
    if (lAt >= 0 && p3 - lAt < 120) {
      out = out.slice(0, lAt) + '__BX_DLOG[#__BX_DLOG+1]={' + cid + ',I,s[I],L[I],O[I],B,J,D};' + out.slice(lAt);
      cid++;
      p3 += 80;
    } else p3 += anchor.length;
  }
}
console.log('const-op logging injected:', cid - 100, 'sites');
fs.writeFileSync('/home/z/my-project/download/bypassx-deobf-bot/research/decrypt-roles.json', JSON.stringify(rolesOut, null, 1));
fs.writeFileSync('/tmp/sample-dlogged.lua', out);
console.log('written /tmp/sample-dlogged.lua + research/decrypt-roles.json');
