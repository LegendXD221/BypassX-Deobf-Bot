#!/bin/bash
# Vendor repo availability sweep (research/ evaluation)
for repo in "Prometheus-DeobfuscatorV2/Prometheus-DeobfuscatorV2" "jte-lua/lua-decompiler" "WhoIsIsGenn/deobfuscator" "Sk8rz/lua-deobf-actions" "caomro2077/Deobfuscator-Luraph-V15"; do
  echo "=== $repo"
  code=$(timeout 20 curl -sL -o /tmp/repo.json -w "%{http_code}" "https://api.github.com/repos/$repo" 2>/dev/null)
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync("/tmp/repo.json", "utf8"));
      if (j.full_name) console.log("EXISTS | lang=" + j.language + " | stars=" + j.stargazers_count + " | pushed=" + j.pushed_at + " | license=" + (j.license && j.license.spdx_id) + " | desc=" + String(j.description || "").slice(0, 90));
      else console.log("MISSING/" + (j.message || "?").slice(0, 60));
    } catch (e) { console.log("parse fail"); }
  '
done
