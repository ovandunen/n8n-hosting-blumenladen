#!/usr/bin/env sh
# Push build/helloCash-odoo-sync_workflow.json to n8n via the public REST API.
#
# Required environment variables:
#   N8N_BASE_URL   — e.g. https://n8n.example.com (no trailing slash required)
#   N8N_API_KEY    — API key (header X-N8N-API-KEY)
#
# Optional:
#   N8N_WORKFLOW_ID — if set: PUT updates that workflow. If unset: POST creates one.
#
# Load from a file before running, e.g.:
#   set -a && . ./env/.env.local && set +a
#   ./scripts/deploy.sh
#
# This script optionally sources, if they exist (in order):
#   .env then env/.env.local in the package root (same directory as package.json).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

for _deploy_env in "$ROOT/.env" "$ROOT/env/.env.local"; do
  if [ -f "$_deploy_env" ]; then
    echo "[deploy] Loading environment from $_deploy_env"
    set -a
    # shellcheck source=/dev/null
    . "$_deploy_env"
    set +a
  fi
done

N8N_BASE_URL="${N8N_BASE_URL:?[deploy] ERROR: N8N_BASE_URL is not set. Export it or add it to .env / env/.env.local}"
N8N_API_KEY="${N8N_API_KEY:?[deploy] ERROR: N8N_API_KEY is not set. Export it or add it to .env / env/.env.local}"

# Trim one trailing slash from base URL
BASE="${N8N_BASE_URL%/}"

ARTIFACT="$ROOT/build/helloCash-odoo-sync_workflow.json"

if [ ! -f "$ARTIFACT" ]; then
  echo "[deploy] ERROR: Build artifact not found."
  echo "[deploy]        Run: npm run build"
  echo "[deploy]        Expected file: $ARTIFACT"
  exit 1
fi

echo "[deploy] Using artifact: $ARTIFACT"

echo "[deploy] Step 1/4: Preflight — GET $BASE/api/v1/workflows"
PREFLIGHT_CODE="$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$BASE/api/v1/workflows")"

if [ "$PREFLIGHT_CODE" != "200" ]; then
  echo "[deploy] ERROR: Preflight failed. GET /api/v1/workflows returned HTTP $PREFLIGHT_CODE (expected 200)."
  echo "[deploy]        Check N8N_BASE_URL, network, TLS, and that N8N_API_KEY is valid."
  exit 1
fi
echo "[deploy]         Preflight OK (HTTP 200). API is reachable."

TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

if [ -n "${N8N_WORKFLOW_ID:-}" ]; then
  echo "[deploy] Step 2/4: Updating existing workflow id=$N8N_WORKFLOW_ID (PUT $BASE/api/v1/workflows/$N8N_WORKFLOW_ID)"
  HTTP_CODE="$(curl -sS -w "%{http_code}" -o "$TMPFILE" \
    -X PUT \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    -d "@$ARTIFACT" \
    "$BASE/api/v1/workflows/$N8N_WORKFLOW_ID")"

  if [ "$HTTP_CODE" != "200" ]; then
    echo "[deploy] ERROR: PUT failed with HTTP $HTTP_CODE"
    cat "$TMPFILE"
    exit 1
  fi
  WF_ID="$N8N_WORKFLOW_ID"
  echo "[deploy]         Update succeeded (HTTP 200)."
else
  echo "[deploy] Step 2/4: Creating new workflow (POST $BASE/api/v1/workflows)"
  HTTP_CODE="$(curl -sS -w "%{http_code}" -o "$TMPFILE" \
    -X POST \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    -d "@$ARTIFACT" \
    "$BASE/api/v1/workflows")"

  if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
    echo "[deploy] ERROR: POST failed with HTTP $HTTP_CODE"
    cat "$TMPFILE"
    exit 1
  fi

  WF_ID="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).id" "$TMPFILE")"
  if [ -z "$WF_ID" ]; then
    echo "[deploy] ERROR: Create response did not include an id. Raw response:"
    cat "$TMPFILE"
    exit 1
  fi
  echo "[deploy]         Create succeeded (HTTP $HTTP_CODE)."
  echo "[deploy]         *** SAVE THIS WORKFLOW ID for future deploys: N8N_WORKFLOW_ID=$WF_ID ***"
fi

echo "[deploy] Step 3/4: Activating workflow id=$WF_ID (POST $BASE/api/v1/workflows/$WF_ID/activate)"
ACT_CODE="$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$BASE/api/v1/workflows/$WF_ID/activate")"

if [ "$ACT_CODE" != "200" ] && [ "$ACT_CODE" != "201" ] && [ "$ACT_CODE" != "204" ]; then
  echo "[deploy] ERROR: Activate failed with HTTP $ACT_CODE"
  echo "[deploy]        Workflow was created/updated but may still be inactive in n8n."
  exit 1
fi
echo "[deploy]         Activate succeeded (HTTP $ACT_CODE)."

echo "[deploy] Step 4/4: Done. Workflow $WF_ID is deployed and active."
echo "[deploy] Finished successfully."
