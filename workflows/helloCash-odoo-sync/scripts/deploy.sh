#!/usr/bin/env sh
# Push build/helloCash-odoo-sync_workflow.json to n8n via REST API.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

N8N_BASE_URL="${N8N_BASE_URL:?N8N_BASE_URL not set}"
N8N_API_KEY="${N8N_API_KEY:?N8N_API_KEY not set}"
N8N_WORKFLOW_ID="${N8N_WORKFLOW_ID:?N8N_WORKFLOW_ID not set}"

ARTIFACT="$ROOT/build/helloCash-odoo-sync_workflow.json"

if [ ! -f "$ARTIFACT" ]; then
  echo "Deploy: artifact not found — run 'npm run build' first."
  echo "Expected: $ARTIFACT"
  exit 1
fi

echo "Deploying $ARTIFACT to $N8N_BASE_URL/api/v1/workflows/$N8N_WORKFLOW_ID ..."

curl -sf \
  -X PUT \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d "@$ARTIFACT" \
  "$N8N_BASE_URL/api/v1/workflows/$N8N_WORKFLOW_ID"

echo "Deploy complete."
