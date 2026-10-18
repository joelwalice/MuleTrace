#!/usr/bin/env bash
# Demo day on a Mac: dev tunnel (Copilot), API and dashboard on this laptop's network address, so judges' phones can open /send.
#   ./demo-mac.sh [-i 192.168.0.101] [--skip-build]
# Secrets live in .demo.env (git-ignored), one KEY=value per line:
#   PUBLIC_URL=https://<id>-8000.<region>.devtunnels.ms     # Copilot Studio calls the API here (/mcp)
#   PLAYBOOK_WEBHOOK=https://…                              # Power Automate trigger URL; it contains a key
#   TUNNEL=muletrace-mac                                    # optional: this laptop's own dev tunnel (one host per tunnel)
#   FOUNDRY_SCORING_URL=… FOUNDRY_KEY=…                     # optional
# The Copilot URL is baked into the dashboard from web/.env.local (NEXT_PUBLIC_COPILOT_URL), so rebuild after changing it.
# Uses the production build: the Next dev server blocks its own scripts for hosts other than localhost.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
ip="" build=1
while [ $# -gt 0 ]; do
  case "$1" in
    -i|--ip) ip="$2"; shift 2 ;;
    --skip-build) build=0; shift ;;
    *) echo "usage: $0 [-i <address>] [--skip-build]"; exit 1 ;;
  esac
done
[ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
[ -n "$ip" ] || { echo "No Wi-Fi IPv4 address found. Pass one: -i <address>"; exit 1; }

if [ -f "$root/.demo.env" ]; then set -a; . "$root/.demo.env"; set +a; fi
[ -n "${PLAYBOOK_WEBHOOK:-}" ] || echo "Note: PLAYBOOK_WEBHOOK not set; Dismantle won't call Power Automate."
export NEXT_PUBLIC_API="http://$ip:8000" CORS_ORIGINS="http://$ip:3000,http://localhost:3000" DASHBOARD_URL="http://$ip:3000"

if lsof -tiTCP:8000 -sTCP:LISTEN >/dev/null || lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null; then
  echo "Port 8000 or 3000 is already in use. Stop the running API/dashboard first."; exit 1
fi
if [ "$build" = 1 ]; then (cd "$root/web" && npm run build); fi

pids=()
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
if [ -n "${TUNNEL:-}" ] && command -v devtunnel >/dev/null; then
  devtunnel host "$TUNNEL" >"$root/.devtunnel.log" 2>&1 & pids+=($!)
fi
(cd "$root" && .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000) & pids+=($!)

echo
echo "Dashboard: http://$ip:3000    Judge phones: http://$ip:3000/send    API: http://$ip:8000/docs"
[ -n "${PUBLIC_URL:-}" ] && echo "Copilot tools: $PUBLIC_URL/mcp"
echo "macOS may ask to accept incoming connections for Python and Node: allow them. Ctrl+C stops everything."
echo
cd "$root/web" && npx next start -H 0.0.0.0 -p 3000
