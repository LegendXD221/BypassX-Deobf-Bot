#!/usr/bin/env bash
# Runs ON the VPS (uploaded to /root/.cutover/ by the workflow). No secrets echoed.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
APP=/opt/lucid-deobf

# merge uses the uploaded copy; keep a copy in the app tree for future reference
if [ -f /root/.cutover/envv.txt ]; then
  node /root/.cutover/vps-env-merge.js /root/.cutover/envv.txt
else
  echo "no overlay file — keeping the existing /opt/lucid-deobf/.env"
fi
mkdir -p "$APP/scripts" && cp /root/.cutover/vps-env-merge.js "$APP/scripts/" 2>/dev/null || true
chmod 600 "$APP/.env"

# engine: idempotent — skips if var/engine/bypassx-deobf is already unpacked
node "$APP/bin/prepare-engine.js" || echo "prepare-engine failed (bot will boot degraded; check ENGINE_URL egress)"

# (re)create the pm2 process so --env-file is guaranteed (Node 22 native env-file support)
pm2 delete lucid-deobf 2>/dev/null || true
pm2 start "$APP/src/index.js" --name lucid-deobf --time --cwd "$APP" --node-args="--env-file=$APP/.env"
pm2 save
sleep 3
pm2 ls
