#!/usr/bin/env bash
# Starts the backend server in the background; it restarts on reboot.
#   ./start.sh                   reachable from your LAN on port 8085
#   BIND=127.0.0.1 ./start.sh    only this machine
#   ./stop.sh                    stop
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p cache
if ! grep -qE '^(GOOGLE_API_KEY|ROUTER_MODULE)=.+' .env 2>/dev/null; then
  echo "WARNING: no GOOGLE_API_KEY or ROUTER_MODULE in server/.env (copy .env.example to .env). Routing will not work until one is set."
fi
docker compose up -d --force-recreate

echo -n "Waiting for the server"
for _ in $(seq 1 30); do
  if curl -sf -m 3 http://127.0.0.1:8085/health | grep -q '"ok":true'; then echo " ready."; break; fi
  echo -n "."; sleep 1
done
curl -s http://127.0.0.1:8085/health; echo

BIND=${BIND:-0.0.0.0}
echo "Server URL for the extension:"
if [ "$BIND" = "0.0.0.0" ]; then
  ip -4 -o addr show scope global | awk '{split($4,a,"/"); print "  http://" a[1] ":8085   (" $2 ")"}'
else
  echo "  http://$BIND:8085"
fi
