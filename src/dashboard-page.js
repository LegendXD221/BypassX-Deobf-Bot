/**
 * BypassX Deobf Bot — dashboard single-page UI (v2.3 redesign).
 *
 * Rendered from src/dashboard.js. Everything is inline (CSP: no external
 * assets). The client script lives inside a template literal, so it must not
 * contain backticks or ${, and string escapes are written double
 * (\\n in source ⇒ \n in the served page). Newlines inside client strings use
 * the NL constant to keep the served script parse-safe.
 */

const CSS = `
:root{
  --bg:#06060c; --bg2:#0a0a14; --panel:#0e0e1a; --panel2:#131324; --line:#232338; --line2:#2e2e4a;
  --txt:#e7e9f2; --dim:#8b90a5; --vio:#a78bfa; --vio2:#7c3aed; --cyan:#22d3ee;
  --ok:#4ade80; --warn:#fbbf24; --err:#f87171; --shadow:0 10px 30px rgba(0,0,0,.45);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:radial-gradient(1200px 500px at 80% -10%,rgba(124,58,237,.14),transparent 60%),radial-gradient(900px 420px at -10% 110%,rgba(34,211,238,.08),transparent 55%),var(--bg);color:var(--txt);font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;font-size:14px}
a{color:var(--vio);text-decoration:none}a:hover{text-decoration:underline}
::selection{background:rgba(167,139,250,.35)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#262640;border-radius:8px}::-webkit-scrollbar-track{background:transparent}

/* ---- layout ---- */
.app{display:flex;min-height:100vh}
.side{width:232px;flex:0 0 232px;background:linear-gradient(180deg,rgba(124,58,237,.08),rgba(34,211,238,.04)) ,var(--bg2);border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh;overflow:auto}
.main{flex:1;min-width:0;padding:20px 26px 60px}
@media(max-width:900px){
  .app{flex-direction:column}
  .side{position:static;width:auto;height:auto;flex:none;flex-direction:row;align-items:center;overflow-x:auto;border-right:none;border-bottom:1px solid var(--line);padding:10px 12px;gap:8px}
  .side .label{display:none}
  .main{padding:16px 14px 50px}
}

/* ---- sidebar ---- */
.logo{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;border-bottom:1px solid var(--line);margin-bottom:12px}
.logo .mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--vio2),var(--cyan));display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 18px rgba(124,58,237,.45)}
.logo b{font-size:15px;letter-spacing:.3px}
.logo small{display:block;color:var(--dim);font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase}
.navlabel{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:1.6px;padding:12px 10px 6px}
.navbtn{display:flex;align-items:center;gap:10px;background:transparent;border:1px solid transparent;color:var(--txt);padding:9px 12px;border-radius:10px;cursor:pointer;font-size:13.5px;width:100%;text-align:left}
.navbtn:hover{background:var(--panel2);border-color:var(--line)}
.navbtn.on{background:linear-gradient(90deg,rgba(124,58,237,.28),rgba(124,58,237,.08));border-color:rgba(167,139,250,.5)}
.navbtn .ic{width:18px;text-align:center}
@media(max-width:900px){.navbtn{width:auto;white-space:nowrap;padding:7px 11px}.navlabel{display:none}.logo{border:none;margin:0;padding:0 6px}}
.sidefoot{margin-top:auto;color:var(--dim);font-size:11px;padding:12px 10px 2px;line-height:1.7}
@media(max-width:900px){.sidefoot{display:none}}

/* ---- topbar ---- */
.topbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px}
h1{font-size:19px;margin:0;background:linear-gradient(90deg,#c4b5fd,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700}
.pill{padding:4px 12px;border-radius:99px;font-size:12px;border:1px solid var(--line);background:var(--panel);color:var(--dim);white-space:nowrap}
.pill.up{color:var(--ok);border-color:rgba(74,222,128,.35)}
.pill.down{color:var(--err);border-color:rgba(248,113,113,.35)}
.pill.warn{color:var(--warn);border-color:rgba(251,191,36,.35)}
.dot{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:6px;background:var(--dim)}
.dot.ok{background:var(--ok);box-shadow:0 0 8px rgba(74,222,128,.8)}
.dot.err{background:var(--err);box-shadow:0 0 8px rgba(248,113,113,.8)}
.dot.warn{background:var(--warn)}

/* ---- cards / grids ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.015),transparent),var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:var(--shadow)}
.card h3{margin:0 0 12px;font-size:13px;color:var(--vio);text-transform:uppercase;letter-spacing:1.2px}
.kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.04)}
.kv:last-child{border-bottom:none}
.kv b{color:var(--dim);font-weight:500}
.kv span{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12.5px;text-align:right;word-break:break-all}
.big{font-size:26px;font-weight:700;font-family:ui-monospace,monospace}
.trend{color:var(--dim);font-size:11px;margin-top:2px}

/* ---- tools ---- */
.tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
.tool{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:10px}
.tool:hover{border-color:var(--line2)}
.tool .th{display:flex;align-items:center;gap:10px}
.tool .th .ic{font-size:18px;width:34px;height:34px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center}
.tool .th b{font-size:14px}
.tool .th small{display:block;color:var(--dim);font-size:11.5px;margin-top:1px}
.tool .hint{color:var(--dim);font-size:11.5px;line-height:1.5}
.runrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{background:linear-gradient(135deg,var(--vio2),#5b21b6);border:1px solid rgba(167,139,250,.5);color:#fff;padding:8px 16px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;transition:filter .15s, transform .05s}
.btn:hover{filter:brightness(1.15)}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.sec{background:var(--panel2);border-color:var(--line);color:var(--txt);font-weight:500}
.btn.danger{background:linear-gradient(135deg,#7f1d1d,#991b1b);border-color:rgba(248,113,113,.5)}
.btn.armed{background:var(--err)!important;color:#180404!important;animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.75}}
.out{position:relative}
.out .bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.out .bar small{color:var(--dim)}
.mini{background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:11px;padding:3px 9px;border-radius:7px;cursor:pointer}
.mini:hover{color:var(--txt);border-color:var(--line2)}

/* ---- forms ---- */
input,textarea,select{background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:8px 11px;font-size:13px;width:100%;outline:none}
input:focus,textarea:focus,select:focus{border-color:rgba(167,139,250,.55);box-shadow:0 0 0 3px rgba(124,58,237,.15)}
textarea{min-height:96px;font-family:ui-monospace,monospace;resize:vertical;line-height:1.5}
label.f{display:block;color:var(--dim);font-size:11px;margin:0 0 4px;letter-spacing:.6px;text-transform:uppercase}

/* ---- outputs / tables ---- */
pre{background:#08080f;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:12px;font-family:ui-monospace,SFMono-Regular,monospace;overflow:auto;max-height:380px;white-space:pre-wrap;word-break:break-word;margin:0;color:#c9d2e8}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:1px}
tr:hover td{background:rgba(124,58,237,.05)}
.mut{color:var(--dim);font-size:12px}
.ok{color:var(--ok)}.err{color:var(--err)}.warn{color:var(--warn)}.vio{color:var(--vio)}.cyan{color:var(--cyan)}
.tab{display:none}.tab.on{display:block;animation:fade .18s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.gcard{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px;box-shadow:var(--shadow)}
.ghead{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.ghead img{width:40px;height:40px;border-radius:12px}
.gname{font-weight:700;font-size:14.5px}
.gid{color:var(--dim);font-size:11px;font-family:ui-monospace,monospace}
.tog{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}
.tog button,.rowbtn button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:6px 11px;border-radius:9px;cursor:pointer;font-size:12px}
.tog button.on{background:rgba(74,222,128,.12);border-color:rgba(74,222,128,.5);color:var(--ok)}
.tog button.off{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.45);color:var(--err)}
.rowbtn{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px;align-items:center}
#toast{position:fixed;bottom:20px;right:20px;background:var(--panel2);border:1px solid var(--vio);padding:11px 17px;border-radius:12px;display:none;font-size:13px;max-width:380px;box-shadow:var(--shadow);z-index:99}
.spin{display:inline-block;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.searchbox{max-width:340px}
.chip{display:inline-block;padding:2px 9px;border-radius:99px;font-size:10.5px;border:1px solid var(--line);color:var(--dim);margin-left:6px}
.chip.own{border-color:rgba(251,191,36,.4);color:var(--warn)}
.chip.dgr{border-color:rgba(248,113,113,.4);color:var(--err)}
.cmdrow{display:flex;gap:10px;padding:6px 2px;border-bottom:1px dashed rgba(255,255,255,.05);align-items:baseline}
.cmdrow code{color:var(--cyan);font-size:12.5px;min-width:110px}
`;

export function renderPage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>•</title>
<style>${CSS}</style></head><body>
<div class="app">
<aside class="side">
  <div class="logo"><div class="mark">🧩</div><div><b>BypassX Deobf</b><small>mission control</small></div></div>
  <div class="navlabel">Monitor</div>
  <button class="navbtn on" data-t="ov"><span class="ic">📊</span>Overview</button>
  <button class="navbtn" data-t="lg"><span class="ic">📜</span>Live logs</button>
  <button class="navbtn" data-t="au"><span class="ic">🛡</span>Audit trail</button>
  <div class="navlabel">Operate</div>
  <button class="navbtn" data-t="pt"><span class="ic">⚡</span>Power tools</button>
  <button class="navbtn" data-t="gu"><span class="ic">🏰</span>Guilds</button>
  <button class="navbtn" data-t="db"><span class="ic">🗄</span>Database</button>
  <button class="navbtn" data-t="cm"><span class="ic">🤖</span>Bot commands</button>
  <div class="sidefoot"><span id="sf-ver">…</span><br><span id="sf-up">…</span></div>
</aside>
<main class="main">
  <div class="topbar">
    <h1 id="hd-title">Overview</h1>
    <span class="pill" id="p-disc">…</span><span class="pill" id="p-engine">…</span>
    <span class="pill" id="p-db">…</span><span class="pill" id="p-ver">…</span>
    <span class="pill" id="p-up">…</span><span class="pill" id="p-pin">…</span>
    <span style="flex:1"></span>
    <button class="mini" id="btn-refresh">↻ refresh</button>
  </div>

  <!-- ======================= OVERVIEW ======================= -->
  <div class="tab on" id="t-ov">
    <div class="grid" id="ov-cards"></div>
  </div>

  <!-- ======================= POWER TOOLS ======================= -->
  <div class="tab" id="t-pt">
    <p class="mut" style="margin-top:0">Shared code input — paste code below (or give a URL), then run any analyzer. Every action is audited.</p>
    <div class="tool" style="margin-bottom:14px">
      <div class="th"><div class="ic">📥</div><div><b>Shared code input</b><small>used by deobfuscate · detect · beautify · strings</small></div></div>
      <div><label class="f">Paste code</label><textarea id="ci-code" placeholder="-- paste Lua / JS source here (or leave empty and use URL)"></textarea></div>
      <div class="runrow">
        <div style="flex:1;min-width:200px"><label class="f">…or fetch from URL</label><input id="ci-url" placeholder="https://pastefy.app/xyz / raw link"></div>
        <div style="min-width:150px"><label class="f">filename (optional)</label><input id="ci-name" placeholder="obfuscated.lua"></div>
        <div style="min-width:170px"><label class="f">family hint (deobf only)</label><input id="ci-hint" placeholder="luraph-v15.1 / moonsec-v3 …"></div>
      </div>
    </div>
    <div class="tools" id="pt-grid"></div>
  </div>

  <!-- ======================= GUILDS ======================= -->
  <div class="tab" id="t-gu">
    <p class="mut" style="margin-top:0">Per-guild control: toggles are enforced at dispatch (bot disabled / deobf off / detect off), the custom prefix replaces the global one for prefix commands. DB required for toggles + prefix.</p>
    <div id="guilds"></div>
  </div>

  <!-- ======================= DATABASE ======================= -->
  <div class="tab" id="t-db">
    <div class="tools">
      <div class="tool"><div class="th"><div class="ic">💾</div><div><b>SQL runner</b><small>raw SQL on the Neon database — audited</small></div></div>
        <textarea id="sq-sql" placeholder="SELECT * FROM deobf_history ORDER BY created_at DESC LIMIT 10"></textarea>
        <div class="runrow"><button class="btn" id="sq-go">Run SQL</button><button class="btn sec" id="sq-st">DB status</button></div>
        <div class="out"><pre id="sq-out" style="display:none"></pre></div>
      </div>
      <div class="tool"><div class="th"><div class="ic">📦</div><div><b>Backup</b><small>download every table as JSON (5000 rows/table cap)</small></div></div>
        <div class="hint">Streams a full snapshot: bot_stats, deobf_history, owner_audit, blacklist, guild_settings, dashboard_state.</div>
        <div class="runrow"><button class="btn" id="bk-go">Download backup</button></div>
      </div>
      <div class="tool"><div class="th"><div class="ic">🗒</div><div><b>Recent jobs</b><small>deobf history across all users</small></div></div>
        <div class="runrow"><button class="btn sec" id="hs-go">Load history</button></div>
        <div class="out"><pre id="hs-out" style="display:none"></pre></div>
      </div>
      <div class="tool"><div class="th"><div class="ic">🚫</div><div><b>Blacklist</b><small>block users / guilds bot-wide</small></div></div>
        <div class="runrow"><input id="bl-target" placeholder="discord id" style="max-width:170px"><input id="bl-reason" placeholder="reason" style="max-width:170px"><button class="btn" id="bl-add">Add</button><button class="btn danger" id="bl-del">Remove</button></div>
        <table id="bl-table"><thead><tr><th>target</th><th>kind</th><th>reason</th><th>by</th><th>added</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>

  <!-- ======================= LOGS ======================= -->
  <div class="tab" id="t-lg">
    <div class="runrow" style="margin-bottom:10px">
      <button class="btn sec" id="lg-ref">↻ refresh</button>
      <label style="display:flex;align-items:center;gap:6px" class="mut"><input type="checkbox" id="lg-auto" style="width:auto"> auto (5s)</label>
      <span class="mut" id="lg-info">last 120 lines (newest last)</span>
    </div>
    <pre id="lg-out">loading…</pre>
  </div>

  <!-- ======================= AUDIT ======================= -->
  <div class="tab" id="t-au">
    <p class="mut" style="margin-top:0">Every owner action (Discord + dashboard) with the protection layer that fired. Newest first.</p>
    <div class="runrow" style="margin-bottom:10px"><button class="btn sec" id="au-ref">↻ refresh</button></div>
    <div class="card" style="padding:0"><table id="au-table"><thead><tr><th>time</th><th>cmd</th><th>who</th><th>result</th><th>layer</th></tr></thead><tbody></tbody></table></div>
  </div>

  <!-- ======================= BOT COMMANDS ======================= -->
  <div class="tab" id="t-cm">
    <p class="mut" style="margin-top:0">Every command the bot serves in Discord (prefix + slash). The Power tools tab mirrors the owner subset.</p>
    <div class="runrow" style="margin-bottom:10px"><button class="btn sec" id="cm-ref">↻ load</button><span class="mut" id="cm-count"></span></div>
    <div class="card" id="cm-list" style="padding:14px"></div>
  </div>

  <div id="toast"></div>
</main>
</div>
<script>
'use strict';
var $ = function(s){ return document.querySelector(s); };
var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
var NL = String.fromCharCode(10);
var BASE = location.pathname;
if (BASE.charAt(BASE.length - 1) === '/') BASE = BASE.slice(0, -1);
var STATE = null;
var LOG_TIMER = null;

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function toast(msg, ok){
  var t = $('#toast'); t.textContent = msg;
  t.style.borderColor = ok === false ? 'var(--err)' : (ok === 'warn' ? 'var(--warn)' : 'var(--ok)');
  t.style.display = 'block'; clearTimeout(t._h);
  t._h = setTimeout(function(){ t.style.display = 'none'; }, 3500);
}
function fmtUp(s){ var d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; }
function fmtBytes(n){ if (!n && n !== 0) return '—'; var u = ['B','KB','MB','GB'], i = 0; while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
function nowStr(){ return new Date().toISOString().replace('T',' ').slice(0,16); }

async function api(path, body){
  var opt = body ? { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) } : {};
  var r = await fetch(BASE + '/api/' + path, opt);
  if (r.status === 404) throw new Error('token invalid or rotated — re-open the /dash/<token> URL from the boot log');
  if (r.status === 429) throw new Error('rate limited — slow down (120 req/min)');
  var j = await r.json().catch(function(){ throw new Error('bad JSON response'); });
  return j;
}

/* two-step danger confirm: first click arms, second fires */
function arm(btn, fn){
  var orig = btn.textContent;
  btn.addEventListener('click', function(){
    if (btn.classList.contains('armed')) { btn.classList.remove('armed'); btn.textContent = orig; fn(); }
    else { btn.classList.add('armed'); btn.textContent = '⚠ sure? click again'; setTimeout(function(){ btn.classList.remove('armed'); btn.textContent = orig; }, 4000); }
  });
}

/* output block helper: copy + download + meta line */
function makeOut(rootSel){
  var root = $(rootSel);
  root.innerHTML = '<div class="bar" style="display:none"><small class="o-meta"></small><span><button class="mini o-copy">copy</button> <button class="mini o-dl">download</button></span></div><pre class="o-pre" style="display:none"></pre>';
  var pre = root.querySelector('.o-pre'), meta = root.querySelector('.o-meta'), bar = root.querySelector('.bar');
  var last = { text: '', name: 'output.txt' };
  root.querySelector('.o-copy').addEventListener('click', function(){
    navigator.clipboard.writeText(last.text).then(function(){ toast('copied to clipboard'); }, function(){ toast('clipboard blocked — use download', false); });
  });
  root.querySelector('.o-dl').addEventListener('click', function(){
    var blob = new Blob([last.text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = last.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 5000);
  });
  return {
    show: function(text, metaText, dlName){
      last = { text: String(text == null ? '' : text), name: dlName || 'bypassx-output.txt' };
      pre.textContent = last.text; pre.style.display = 'block'; bar.style.display = 'flex';
      meta.textContent = metaText || '';
    },
    busy: function(msg){ pre.textContent = msg || 'running…'; pre.style.display = 'block'; bar.style.display = 'none'; },
    hide: function(){ pre.style.display = 'none'; bar.style.display = 'none'; }
  };
}

/* shared code input for the analyzer tools */
function codeInput(){
  var url = $('#ci-url').value.trim();
  var code = $('#ci-code').value;
  var name = $('#ci-name').value.trim();
  var body = {};
  if (url) { body.url = url; }
  else if (code.trim()) { body.code = code; if (name) body.filename = name; }
  else throw new Error('paste code (or set a URL) in the shared input first');
  return body;
}
function ciHint(){ return $('#ci-hint').value.trim() || null; }

/* ---- tab switching ---- */
$$('.navbtn').forEach(function(b){
  b.addEventListener('click', function(){
    $$('.navbtn').forEach(function(x){ x.classList.remove('on'); });
    $$('.tab').forEach(function(x){ x.classList.remove('on'); });
    b.classList.add('on');
    var t = b.dataset.t;
    $('#t-' + t).classList.add('on');
    $('#hd-title').textContent = b.textContent.replace(/^[^A-Za-z]+/, '');
    if (t === 'lg') loadLogs();
    if (t === 'au') loadAudit();
    if (t === 'cm') loadCommands();
  });
});
$('#btn-refresh').addEventListener('click', function(){ refresh(); toast('refreshed'); });

/* ---- state poll + render ---- */
async function refresh(){
  try {
    var r = await api('state');
    if (!r.ok) throw new Error('state failed');
    STATE = r.data;
    renderHeader(); renderOverview(); renderGuilds(); renderBlacklist();
  } catch (e) {
    var p = $('#p-disc'); p.textContent = '✗ offline — ' + String(e.message || e).slice(0, 60); p.className = 'pill down';
  }
}
function renderHeader(){
  var s = STATE;
  var disc = $('#p-disc');
  disc.innerHTML = s.discordReady ? '<span class="dot ok"></span>' + esc(s.botTag || 'discord') : '<span class="dot err"></span>connecting';
  disc.className = 'pill ' + (s.discordReady ? 'up' : 'down');
  var eng = $('#p-engine');
  eng.textContent = s.engine && s.engine.available ? '⚙ ' + s.engine.version : '⚙ engine preparing';
  eng.className = 'pill ' + (s.engine && s.engine.available ? 'up' : 'warn');
  var dbp = $('#p-db');
  if (s.db.enabled) {
    var bad = (s.db.breaker && s.db.breaker.open) || !s.db.connected;
    dbp.innerHTML = '<span class="dot ' + (bad ? 'warn' : 'ok') + '"></span>db ' + (bad ? 'degraded' : 'connected');
    dbp.className = 'pill ' + (bad ? 'warn' : 'up');
  } else { dbp.innerHTML = '<span class="dot"></span>db off'; dbp.className = 'pill'; }
  $('#p-ver').textContent = 'v' + s.version;
  $('#p-up').textContent = '⏱ ' + fmtUp(s.uptimeS);
  var pin = $('#p-pin');
  pin.textContent = s.pinArmed ? '🔐 PIN armed' : '🔓 no PIN';
  pin.className = 'pill ' + (s.pinArmed ? 'up' : '');
  $('#sf-ver').textContent = 'BypassX Deobf v' + s.version;
  $('#sf-up').textContent = 'up ' + fmtUp(s.uptimeS) + ' · ' + (s.host ? s.host.node : '');
}
function card(title, rows){
  return '<div class="card"><h3>' + title + '</h3>' + rows.map(function(r){
    return '<div class="kv"><b>' + r[0] + '</b><span>' + r[1] + '</span></div>';
  }).join('') + '</div>';
}
function renderOverview(){
  var s = STATE, g = s.guilds || [], all = s.allTime;
  var jobs = s.jobs || {};
  var dbb = s.db.breaker || {};
  $('#ov-cards').innerHTML =
    card('🤖 Bot', [['Version', 'v' + s.version], ['Uptime', fmtUp(s.uptimeS)], ['Gateway ping', (s.pingMs || 0) + 'ms'], ['Bot id', esc(s.botId || '—')], ['Prefix', esc((s.config && s.config.prefix) || '.')]]) +
    card('⚡ Jobs (this boot)', [['<span class="big vio">' + (jobs.ok || 0) + '</span>', 'ok'], ['<span class="big err">' + (jobs.fail || 0) + '</span>', 'failed'], ['Total', jobs.total || 0]]) +
    card('⚙ Engine', [['Available', s.engine && s.engine.available ? '<span class="ok">yes</span>' : '<span class="warn">preparing</span>'], ['Version', esc((s.engine && s.engine.version) || '—')], ['Timeout', ((s.config && s.config.engineTimeoutS) || '—') + 's'], ['Upload cap', ((s.config && s.config.maxUploadMb) || '—') + ' MB']]) +
    card('🗄 Database', [['Status', s.db.enabled ? (s.db.connected ? '<span class="ok">connected</span>' : '<span class="warn">retrying</span>') : 'off'], ['Host', esc(s.db.host || '—')], ['Latency', (s.db.latencyMs != null ? s.db.latencyMs : '—') + 'ms'], ['Breaker', dbb.open ? '<span class="err">OPEN</span>' : 'closed · trips ' + (dbb.trips || 0) + ' · queue ' + (dbb.queued || 0)], ['All-time', all ? (all.ok + ' ok / ' + all.total) : '—']]) +
    card('🏰 Guilds', [['Count', g.length], ['Members', g.reduce(function(a, x){ return a + (x.memberCount || 0); }, 0)], ['Biggest', g[0] ? esc(g[0].name) : '—'], ['Blacklisted', (s.blacklist || []).length]]) +
    card('🖥 Host', [['Node', esc(s.host ? s.host.node : '—')], ['Platform', esc(s.host ? s.host.platform : '—')], ['CPUs', s.host ? s.host.cpus : '—'], ['Load (1m)', s.host ? Number(s.host.load1).toFixed(2) : '—'], ['RSS / heap', s.memoryMb.toFixed(0) + ' / ' + (s.heapMb || 0).toFixed(0) + ' MB']]) +
    card('🛡 Protection', [['Owner PIN', s.pinArmed ? '<span class="ok">armed</span>' : 'off'], ['DB audit', s.db.enabled ? 'on' : 'off'], ['Dashboard', 'token-gated + locked to this URL'], ['Cooldown', '10s per user']]) +
    card('📈 Stats counters', Object.keys(s.stats || {}).length ? Object.keys(s.stats).slice(0, 8).map(function(k){ return [k, String(s.stats[k])]; }) : [['counters', '— (db off)']]);
}

/* ---- guilds ---- */
function renderGuilds(){
  var s = STATE, g = s.guilds || [];
  $('#guilds').innerHTML = g.map(function(x, i){
    var st = (s.guildSettings || [])[i] || {};
    var chs = (x.channels || []).map(function(c){ return '<option value="' + c.id + '">#' + esc(c.name) + '</option>'; }).join('');
    return '<div class="gcard" data-id="' + x.id + '">' +
      '<div class="ghead">' + (x.icon ? '<img src="' + x.icon + '" alt="">' : '<img alt="" style="background:var(--panel2)">') +
      '<div><div class="gname">' + esc(x.name) + '</div><div class="gid">' + x.id + ' · ' + (x.memberCount == null ? '?' : x.memberCount) + ' members · joined ' + (x.joinedAt || '?') + '</div></div></div>' +
      '<div class="tog">' +
      '<button class="' + (st.disabled ? 'off' : 'on') + '" data-a="disabled">' + (st.disabled ? '⛔ bot DISABLED' : '✅ bot enabled') + '</button>' +
      '<button class="' + (st.deobf_enabled ? 'on' : 'off') + '" data-a="deobf_enabled">' + (st.deobf_enabled ? 'deobf on' : 'deobf off') + '</button>' +
      '<button class="' + (st.detect_enabled ? 'on' : 'off') + '" data-a="detect_enabled">' + (st.detect_enabled ? 'detect on' : 'detect off') + '</button>' +
      '</div>' +
      '<div class="rowbtn"><input class="gp" placeholder="custom prefix" value="' + esc(st.prefix || '') + '" style="max-width:130px"><button data-a="prefix">Save prefix</button></div>' +
      '<div class="rowbtn"><select class="gc">' + chs + '</select><input class="gm" placeholder="message text" style="flex:1;min-width:160px"><button data-a="message">Send</button></div>' +
      '<div class="rowbtn"><button class="danger" data-a="leave">Leave server</button></div>' +
      '</div>';
  }).join('') || '<p class="mut">Not in any guild yet.</p>';
  $$('#guilds .gcard').forEach(function(cardEl){
    var id = cardEl.dataset.id;
    cardEl.querySelectorAll('.tog button, .rowbtn button').forEach(function(b){
      b.addEventListener('click', async function(){
        var a = b.dataset.a;
        try {
          if (a === 'leave') {
            if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = '⚠ sure?'; setTimeout(function(){ b.classList.remove('armed'); b.textContent = 'Leave server'; }, 4000); return; }
            var rl = await api('guild', { id: id, action: 'leave' });
            toast(rl.ok ? 'left ' + rl.data.left : rl.error, rl.ok); refresh(); return;
          }
          if (a === 'message') {
            var cid = cardEl.querySelector('.gc').value, text = cardEl.querySelector('.gm').value;
            var rm = await api('guild', { id: id, action: 'message', channelId: cid, text: text });
            toast(rm.ok ? 'sent' : rm.error, rm.ok); return;
          }
          if (a === 'prefix') {
            var p = cardEl.querySelector('.gp').value;
            var rp = await api('guild', { id: id, action: 'settings', prefix: p });
            toast(rp.ok ? 'prefix saved' : rp.error, rp.ok); refresh(); return;
          }
          var cur = b.classList.contains('off');
          var patch = { id: id, action: 'settings' };
          patch[a] = !cur;
          var rt = await api('guild', patch);
          toast(rt.ok ? 'saved' : rt.error, rt.ok); refresh();
        } catch (e) { toast(String(e.message || e), false); }
      });
    });
  });
}

/* ---- power tools ---- */
var PT = $('#pt-grid');
PT.innerHTML = [
  { ic: '⚡', name: 'Deobfuscate', sub: 'full pipeline — detect → devirtualize → recover source', id: 'deobf', btn: 'Run full deobf', hint: 'Uses the shared code input. Family hint optional (e.g. luraph-v15.1). Big outputs: use download.' },
  { ic: '🔍', name: 'Detect obfuscator', sub: 'identify family + version + confidence', id: 'detect', btn: 'Run detect', hint: 'Read-only scan of the shared input — no execution.' },
  { ic: '✨', name: 'Beautify', sub: 're-indent + format minified/packed code', id: 'beautify', btn: 'Run beautify', hint: 'Works on Lua and JS.' },
  { ic: '🔤', name: 'Extract strings', sub: 'string table recon before a full run', id: 'strings', btn: 'Extract strings', hint: 'Pulls every quoted string (4+ chars, unique, cap 5000).' },
  { ic: '🧠', name: 'Eval — jailed sandbox', sub: 'secret-free child process, 12s kill', id: 'eval', btn: 'Run eval', own: '<div><label class="f">JS expression</label><textarea id="ev-code" placeholder="return 6 * 7;"></textarea></div>' },
  { ic: '🖥', name: 'Host shell', sub: 'bash on the box · 90s cap (append  %% 300  for 300s)', id: 'shell', btn: 'Run shell', own: '<div><label class="f">command</label><textarea id="sh-cmd" placeholder="echo hello && ls -la"></textarea></div>' },
  { ic: '📣', name: 'Broadcast', sub: 'one message to every guild (system channel)', id: 'broadcast', btn: 'Send broadcast', own: '<div><label class="f">message (max 1500)</label><textarea id="bc-text" placeholder="downtime notice, new feature, …"></textarea></div>' },
  { ic: '✉️', name: 'DM a user', sub: 'direct-message any discord user by id', id: 'dm', btn: 'Send DM', own: '<div class="runrow"><div style="flex:1;min-width:150px"><label class="f">user id</label><input id="dm-id" placeholder="123…"></div></div><div><label class="f">text</label><textarea id="dm-text" placeholder="message"></textarea></div>' },
  { ic: '🎭', name: 'Set presence', sub: 'change the bot status text ("Watching …")', id: 'status', btn: 'Set presence', own: '<div><label class="f">status text</label><input id="st-text" placeholder="every obfuscator imaginable"></div>' },
  { ic: '🆔', name: 'ID lookup', sub: 'resolve an id → guild / user / channel + blacklist state', id: 'lookup', btn: 'Look up', own: '<div><label class="f">discord id</label><input id="lk-id" placeholder="123…"></div>' },
  { ic: '🔗', name: 'Invite generator', sub: 'admin-permission invite link for this bot', id: 'invite', btn: 'Generate invite' },
  { ic: '♻️', name: 'Rebuild engine', sub: 're-run bin/prepare-engine.js (fresh deobf engine)', id: 'engine', btn: 'Rebuild engine', danger: true },
  { ic: '🧹', name: 'Reset rate limits', sub: 'clear cooldowns, api buckets + lockouts (fix self-lockout)', id: 'limits', btn: 'Reset limits', danger: true },
  { ic: '⏻', name: 'Process control', sub: 'restart or stop the bot (Render reboots it)', id: 'process', danger: true, hint: 'Two-step confirm on each button.' }
].map(function(t){
  return '<div class="tool" data-tool="' + t.id + '">' +
    '<div class="th"><div class="ic">' + t.ic + '</div><div><b>' + t.name + '</b><small>' + t.sub + '</small></div></div>' +
    (t.own || '') +
    '<div class="hint">' + (t.hint || '') + '</div>' +
    '<div class="runrow">' + (t.btn ? '<button class="btn' + (t.danger ? ' danger' : '') + '" data-run="' + t.id + '">' + t.btn + '</button>' : '') + '<span class="mut t-status"></span></div>' +
    '<div class="out" data-out="' + t.id + '"></div>' +
    '</div>';
}).join('');

var OUTS = {};
['deobf', 'detect', 'beautify', 'strings', 'eval', 'shell', 'broadcast', 'dm', 'status', 'lookup', 'invite', 'engine', 'limits', 'process'].forEach(function(id){ OUTS[id] = makeOut('[data-out="' + id + '"]'); });

function status(id, msg){ var el = document.querySelector('[data-tool="' + id + '"] .t-status'); if (el) el.textContent = msg || ''; }

var RUNNERS = {};
RUNNERS.deobf = async function(){
  var body;
  try { body = codeInput(); } catch (e) { return toast(e.message, false); }
  body.hint = ciHint();
  OUTS.deobf.busy('⚙ running full pipeline — detect → route → devirtualize (can take up to 3 min)…');
  status('deobf', 'running…');
  try {
    var r = await api('deobf', body);
    if (!r.ok) { OUTS.deobf.show('✗ ' + r.error, '', 'error.txt'); status('deobf', 'failed'); return; }
    var d = r.data, det = d.detected || {};
    var head = 'detected: ' + (det.name || 'Unknown') + (det.version ? ' ' + det.version : '') + ' (' + (det.confidence || 0) + '%)' + NL +
      'route stages: ' + (d.stages || []).map(function(x){ return x.name; }).join(' → ') + NL +
      'size: ' + fmtBytes(d.originalSize) + ' → ' + fmtBytes(d.recoveredSize) + ' · ' + d.durationMs + 'ms' + (d.note ? NL + 'note: ' + d.note : '') + (d.clipped ? NL + '[OUTPUT CLIPPED — ' + d.totalChars + ' chars total, use download after re-run with fewer bytes]' : '');
    OUTS.deobf.show(head + NL + NL + (d.output || '(empty)'), head.split(NL)[0], d.codeName || 'deobf.lua');
    status('deobf', 'done in ' + d.durationMs + 'ms');
  } catch (e) { OUTS.deobf.show('✗ ' + (e.message || e), '', 'error.txt'); status('deobf', 'failed'); }
};
RUNNERS.detect = async function(){
  var body;
  try { body = codeInput(); } catch (e) { return toast(e.message, false); }
  OUTS.detect.busy('scanning…');
  try {
    var r = await api('detect', body);
    if (!r.ok) return OUTS.detect.show('✗ ' + r.error);
    var d = r.data, b = d.best;
    var lines = ['file: ' + d.filename + ' · ' + fmtBytes(d.size), 'best: ' + (b ? (b.name + ' ' + (b.version || '') + ' — ' + b.confidence + '% confidence') : 'no family matched'), ''];
    if (b && b.evidence && b.evidence.length) { lines.push('evidence:'); b.evidence.forEach(function(x){ lines.push('  · ' + x); }); }
    if (d.candidates && d.candidates.length) { lines.push('', 'candidates:'); d.candidates.forEach(function(x){ lines.push('  · ' + x.name + ' (' + x.confidence + '%)'); }); }
    OUTS.detect.show(lines.join(NL), b ? b.name + ' ' + (b.confidence || 0) + '%' : 'no match', 'detect-report.txt');
  } catch (e) { OUTS.detect.show('✗ ' + (e.message || e)); }
};
RUNNERS.beautify = async function(){
  var body;
  try { body = codeInput(); } catch (e) { return toast(e.message, false); }
  OUTS.beautify.busy('formatting…');
  try {
    var r = await api('beautify', body);
    if (!r.ok) return OUTS.beautify.show('✗ ' + r.error);
    OUTS.beautify.show(r.data.output + (r.data.clipped ? NL + '[clipped at ' + r.data.totalChars + ' chars]' : ''), fmtBytes(r.data.totalChars), r.data.codeName);
  } catch (e) { OUTS.beautify.show('✗ ' + (e.message || e)); }
};
RUNNERS.strings = async function(){
  var body;
  try { body = codeInput(); } catch (e) { return toast(e.message, false); }
  OUTS.strings.busy('extracting…');
  try {
    var r = await api('strings', body);
    if (!r.ok) return OUTS.strings.show('✗ ' + r.error);
    OUTS.strings.show(r.data.count + ' unique strings' + NL + NL + r.data.output, r.data.count + ' strings', r.data.codeName);
  } catch (e) { OUTS.strings.show('✗ ' + (e.message || e)); }
};
RUNNERS.eval = async function(){
  var code = $('#ev-code').value;
  if (!code.trim()) return toast('eval code empty', false);
  OUTS.eval.busy('running in jail…');
  try {
    var r = await api('eval', { code: code });
    OUTS.eval.show((r.data && r.data.output) || r.error || '(no output)', (r.data && r.data.ms) + 'ms', 'eval-out.txt');
  } catch (e) { OUTS.eval.show('✗ ' + (e.message || e)); }
};
RUNNERS.shell = async function(){
  var cmd = $('#sh-cmd').value;
  if (!cmd.trim()) return toast('command empty', false);
  OUTS.shell.busy('executing…');
  try {
    var r = await api('exec', { cmd: cmd });
    OUTS.shell.show((r.data && r.data.output) || r.error || '(no output)', 'exit ' + (r.data && r.data.exit) + ' · ' + (r.data && r.data.ms) + 'ms', 'shell-out.txt');
  } catch (e) { OUTS.shell.show('✗ ' + (e.message || e)); }
};
RUNNERS.broadcast = async function(){
  var text = $('#bc-text').value.trim();
  if (!text) return toast('broadcast text empty', false);
  OUTS.broadcast.busy('sending…');
  try {
    var r = await api('broadcast', { text: text });
    if (r.ok) OUTS.broadcast.show('delivered ' + r.data.sent + '/' + r.data.total + ' · failed ' + (r.data.failed || 0) + ' · skipped ' + (r.data.skipped || 0), 'broadcast done', 'broadcast.txt');
    else OUTS.broadcast.show('✗ ' + r.error);
  } catch (e) { OUTS.broadcast.show('✗ ' + (e.message || e)); }
};
RUNNERS.dm = async function(){
  var id = $('#dm-id').value.trim(), text = $('#dm-text').value.trim();
  if (!id || !text) return toast('user id + text required', false);
  OUTS.dm.busy('sending…');
  try {
    var r = await api('dm', { userId: id, text: text });
    OUTS.dm.show(r.ok ? 'delivered to ' + r.data.tag : ('✗ ' + r.error), '', 'dm.txt');
  } catch (e) { OUTS.dm.show('✗ ' + (e.message || e)); }
};
RUNNERS.status = async function(){
  var text = $('#st-text').value.trim();
  if (!text) return toast('status text empty', false);
  try {
    var r = await api('status', { text: text });
    toast(r.ok ? 'presence set' : r.error, r.ok);
    OUTS.status.show(r.ok ? ('presence → "Watching ' + r.data.set + '"') : ('✗ ' + r.error), '', 'status.txt');
  } catch (e) { OUTS.status.show('✗ ' + (e.message || e)); }
};
RUNNERS.lookup = async function(){
  var id = $('#lk-id').value.trim();
  if (!id) return toast('id required', false);
  OUTS.lookup.busy('resolving…');
  try {
    var r = await api('lookup', { id: id });
    if (!r.ok) return OUTS.lookup.show('✗ ' + r.error);
    var d = r.data;
    var lines = ['id: ' + d.id, 'blacklisted: ' + (d.blacklisted ? 'YES' : 'no'), ''];
    if (!d.found.length) lines.push('not resolvable from this shard (user not shared, or id unknown)');
    d.found.forEach(function(f){
      if (f.kind === 'guild') lines.push('GUILD: ' + f.name + ' · ' + (f.members == null ? '?' : f.members) + ' members · owner ' + f.owner + ' · created ' + (f.created || '?'));
      if (f.kind === 'user') lines.push('USER: ' + f.tag + (f.bot ? ' (bot)' : '') + ' · created ' + (f.created || '?'));
      if (f.kind === 'channel') lines.push('CHANNEL: #' + f.name + ' · type ' + f.type + (f.guild ? ' · in ' + f.guild : ''));
    });
    OUTS.lookup.show(lines.join(NL), d.found.length + ' match(es)', 'lookup.txt');
  } catch (e) { OUTS.lookup.show('✗ ' + (e.message || e)); }
};
RUNNERS.invite = async function(){
  try {
    var r = await api('invite');
    if (!r.ok) return OUTS.invite.show('✗ ' + (r.error || 'bot not ready'));
    OUTS.invite.show(r.data.url, 'invite link', 'invite-url.txt');
  } catch (e) { OUTS.invite.show('✗ ' + (e.message || e)); }
};
RUNNERS.engine = async function(){
  OUTS.engine.busy('rebuilding engine (up to 5 min)…');
  try {
    var r = await api('engine-rebuild', {});
    OUTS.engine.show((r.data && r.data.output) || r.error || '(no output)', 'exit ' + (r.data && r.data.exit) + ' · ' + (r.data && r.data.ms) + 'ms', 'engine-rebuild.txt');
    refresh();
  } catch (e) { OUTS.engine.show('✗ ' + (e.message || e)); }
};
RUNNERS.limits = async function(){
  try {
    var r = await api('reset-limits', {});
    OUTS.limits.show('cleared: ' + r.data.lockouts + ' lockout(s), ' + r.data.apiBuckets + ' api bucket(s), ' + r.data.cooldowns + ' cooldown(s)', 'limits reset', 'limits.txt');
  } catch (e) { OUTS.limits.show('✗ ' + (e.message || e)); }
};
RUNNERS.process = function(){ /* wired below — two buttons */ };
(function(){
  var out = OUTS.process;
  var row = document.createElement('div');
  row.className = 'runrow';
  row.innerHTML = '<button class="btn danger" id="pw-restart">↻ Restart bot</button><button class="btn danger" id="pw-stop">⏻ Shutdown</button><span class="mut">Render auto-reboots the service.</span>';
  var tool = document.querySelector('[data-tool="process"]');
  tool.insertBefore(row, tool.querySelector('.out'));
  arm($('#pw-restart'), async function(){
    try { await api('power', { action: 'restart' }); out.show('restarting… the page will disconnect and come back after the reboot.', '', 'x.txt'); }
    catch (e) { out.show('✗ ' + (e.message || e)); }
  });
  arm($('#pw-stop'), async function(){
    try { await api('power', { action: 'shutdown' }); out.show('shutting down…', '', 'x.txt'); }
    catch (e) { out.show('✗ ' + (e.message || e)); }
  });
})();

/* ---- database tab ---- */
$('#sq-go').addEventListener('click', async function(){
  var out = $('#sq-out');
  out.style.display = 'block'; out.textContent = 'running…';
  try {
    var r = await api('db', { sql: $('#sq-sql').value });
    if (r.ok && r.data && r.data.rows !== undefined) {
      var f = (r.data.fields || []).join(' | ');
      var rows = (r.data.rows || []).slice(0, 50).map(function(x){ return Object.keys(x).map(function(k){ var v = x[k]; return v === null ? '∅' : String(v instanceof Date ? v.toISOString() : v).slice(0, 80); }).join(' | '); });
      out.textContent = [f].concat(rows).join(NL) + NL + '[' + (r.data.rowCount || 0) + ' rows, ' + r.data.ms + 'ms]';
    } else { out.textContent = r.ok ? JSON.stringify(r.data, null, 1).slice(0, 4000) : ('✗ ' + r.error); }
  } catch (e) { out.textContent = '✗ ' + (e.message || e); }
});
$('#sq-st').addEventListener('click', async function(){
  var out = $('#sq-out');
  out.style.display = 'block'; out.textContent = 'checking…';
  try { var r = await api('db', { sql: 'status' }); out.textContent = r.data ? JSON.stringify(r.data, null, 1).slice(0, 2500) : ('✗ ' + (r.error || 'failed')); }
  catch (e) { out.textContent = '✗ ' + (e.message || e); }
});
$('#bk-go').addEventListener('click', function(){
  var a = document.createElement('a');
  a.href = BASE + '/api/backup'; a.download = 'bypassx-backup.json';
  document.body.appendChild(a); a.click(); a.remove();
  toast('backup downloading…', 'warn');
});
$('#hs-go').addEventListener('click', async function(){
  var out = $('#hs-out'); out.style.display = 'block'; out.textContent = 'loading…';
  try {
    var r = await api('history?n=30');
    var rows = (r.data && r.data.rows) || [];
    if (!rows.length) { out.textContent = r.data && r.data.note ? r.data.note : '(no history yet)'; return; }
    out.textContent = rows.map(function(x){
      return (x.created_at || '').replace('T', ' ').slice(0, 16) + ' | ' + (x.success ? 'OK  ' : 'FAIL') + ' | ' + (x.family || '?') + ' (' + (x.confidence || 0) + '%) | ' + (x.filename || '?') + ' | ' + fmtBytes(x.size) + ' | ' + (x.duration_ms || 0) + 'ms | ' + (x.source || '') + (x.paste_url ? ' | ' + x.paste_url : '');
    }).join(NL);
  } catch (e) { out.textContent = '✗ ' + (e.message || e); }
});
$('#bl-add').addEventListener('click', async function(){
  try {
    var r = await api('blacklist', { action: 'add', target: $('#bl-target').value.trim(), reason: $('#bl-reason').value.trim() });
    toast(r.ok ? 'added' : (r.error || 'failed'), r.ok); refresh();
  } catch (e) { toast(e.message, false); }
});
$('#bl-del').addEventListener('click', async function(){
  try {
    var r = await api('blacklist', { action: 'remove', target: $('#bl-target').value.trim() });
    toast(r.ok ? 'removed' : (r.error || 'failed'), r.ok); refresh();
  } catch (e) { toast(e.message, false); }
});
function renderBlacklist(){
  var rows = (STATE.blacklist || []);
  $('#bl-table tbody').innerHTML = rows.map(function(r){
    return '<tr><td>' + esc(r.target) + '</td><td>' + esc(r.kind) + '</td><td>' + esc(r.reason || '') + '</td><td>' + esc(r.added_by || '') + '</td><td>' + esc((r.created_at || '').slice(0, 10)) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="mut">empty</td></tr>';
}

/* ---- logs tab ---- */
async function loadLogs(){
  try {
    var r = await api('logs?n=120');
    var lines = (r.ok && r.data && r.data.lines) ? r.data.lines : [];
    $('#lg-out').textContent = lines.length ? lines.join(NL) : ('(no logs)' + (r.error ? ' — ' + r.error : ''));
    $('#lg-info').textContent = 'last ' + lines.length + ' lines · ' + nowStr();
  } catch (e) { $('#lg-out').textContent = '✗ ' + (e.message || e); }
}
$('#lg-ref').addEventListener('click', loadLogs);
$('#lg-auto').addEventListener('change', function(){
  if (LOG_TIMER) { clearInterval(LOG_TIMER); LOG_TIMER = null; }
  if ($('#lg-auto').checked) LOG_TIMER = setInterval(loadLogs, 5000);
});

/* ---- audit tab ---- */
async function loadAudit(){
  try {
    var r = await api('audit');
    var rows = (r.ok && r.data && r.data.rows) ? r.data.rows : [];
    $('#au-table tbody').innerHTML = rows.map(function(x){
      return '<tr><td>' + esc((x.created_at || '').replace('T', ' ').slice(0, 16)) + '</td><td>' + esc(x.command) + '</td><td>' + esc(x.username || x.user_id || '') + '</td><td class="' + (x.allowed ? 'ok' : 'err') + '">' + esc(x.result || '') + '</td><td>' + esc(x.layer || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="mut">no audit entries</td></tr>';
  } catch (e) { toast(e.message, false); }
}
$('#au-ref').addEventListener('click', loadAudit);

/* ---- bot commands tab ---- */
async function loadCommands(){
  try {
    var r = await api('commands');
    var rows = (r.data && r.data.rows) || [];
    $('#cm-count').textContent = rows.length + ' commands registered';
    $('#cm-list').innerHTML = rows.map(function(c){
      return '<div class="cmdrow"><code>.' + esc(c.name) + '</code><span>' + esc(c.description || '') + '</span>' +
        (c.danger ? '<span class="chip dgr">danger</span>' : (c.owner ? '<span class="chip own">owner</span>' : '')) + '</div>';
    }).join('') || '<span class="mut">none</span>';
  } catch (e) { $('#cm-list').innerHTML = '<span class="err">✗ ' + esc(e.message || e) + '</span>'; }
}
$('#cm-ref').addEventListener('click', loadCommands);

/* ---- wire tool run buttons (after all runners defined) ---- */
$$('[data-run]').forEach(function(btn){
  var id = btn.dataset.run;
  var handler = RUNNERS[id];
  if (!handler) return;
  if (btn.classList.contains('danger')) arm(btn, handler);
  else btn.addEventListener('click', handler);
});

/* ---- boot ---- */
refresh();
setInterval(function(){ if (!document.hidden) refresh(); }, 20000);

</script></body></html>`;
}
