#!/usr/bin/env bash
# railway-setup.sh — configure and deploy the Twitter posting service on Railway.
#
#   bash railway-setup.sh              # flags + volume + deploy (safe default)
#   bash railway-setup.sh --secrets    # ALSO overwrite TWITTER_*/ANTHROPIC_API_KEY from .env
#
# --secrets is opt-in on purpose. The credentials living on Railway are the working
# @manhwaxcomics set; the ones in the local .env are stale and dead. Pushing .env over
# them would break a working service. Only pass --secrets after refreshing .env.
#
# Auth: Railway's `login` needs a TTY, so an automated shell uses an account token —
# create one at railway.com/account/tokens (scope it to the workspace, not "No
# workspace") and save it as .railway-token, one line. Gitignored.

set -euo pipefail
cd "$(dirname "$0")"

PUSH_SECRETS=false
[ "${1:-}" = "--secrets" ] && PUSH_SECRETS=true

if [ -f .railway-token ]; then
  RAILWAY_API_TOKEN="$(tr -d '\r\n' < .railway-token)"
  export RAILWAY_API_TOKEN
fi

# Git Bash rewrites leading-slash arguments into Windows paths, which corrupts the
# volume mount path. Off for every railway call.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# The API returns transient failures while Railway is having an incident, so a single
# failed status check does not mean the project is unlinked. Retry before giving up.
linked=false
for attempt in 1 2 3; do
  if railway status >/dev/null 2>&1; then linked=true; break; fi
  echo "    status check $attempt failed, retrying..."
done

if [ "$linked" != true ]; then
  echo "Could not reach the linked project after 3 tries. Either Railway is down, or"
  echo "the link entry is missing from ~/.railway/config.json. A workspace token cannot"
  echo "run 'railway link', so write the entry directly:"
  echo "  project     f78bb6d4-26ff-4b05-a19b-5bbc62bfe6a5   (hearty-reprieve)"
  echo "  environment f4ae0b6b-4aa7-47b7-94a9-b54e5b1e1622   (production)"
  echo "  service     3fdb5320-4aa7-44b8-8312-d61db3bb49e0   (my-projects)"
  exit 1
fi

echo "==> Target"
railway status

echo "==> Flags"
# STATE_DIR points at the persistent volume so the tweet queue and fired-slot record
# survive redeploys instead of restarting from the top.
for pair in "PLATFORM=twitter" "DRY_RUN=false" "ENABLE_ENGAGEMENT=false" "STATE_DIR=/data" "TZ=UTC"; do
  railway variables --set "$pair" --skip-deploys >/dev/null
  echo "    set $pair"
done

if [ "$PUSH_SECRETS" = true ]; then
  echo "==> Secrets (from .env)"
  envval() { grep -m1 "^$1=" .env | cut -d= -f2- ; }
  for key in TWITTER_API_KEY TWITTER_API_SECRET TWITTER_ACCESS_TOKEN TWITTER_ACCESS_SECRET ANTHROPIC_API_KEY; do
    value="$(envval "$key" || true)"
    [ -n "$value" ] || { echo "    MISSING $key in .env — aborting."; exit 1; }
    railway variables --set "$key=$value" --skip-deploys >/dev/null
    echo "    set $key (hidden)"
  done
else
  echo "==> Secrets: skipped (pass --secrets to overwrite from .env)"
fi

echo "==> Volume"
if railway volume list 2>/dev/null | grep -q "my-projects-volume"; then
  echo "    volume already exists (verify mount path is /data in the dashboard)"
else
  railway volume add -m /data
fi

echo "==> Deploy"
railway up -d

echo
echo "Done. Logs:  railway logs"
