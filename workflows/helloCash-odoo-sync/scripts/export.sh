#!/usr/bin/env sh
# Pull workflow JSON from n8n and write sanitized template to src/workflow-template.json
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N8N_URL="${N8N_BASE_URL:?N8N_BASE_URL not set}"
WF_ID="${N8N_WORKFLOW_ID:?N8N_WORKFLOW_ID not set}"
API_KEY="${N8N_API_KEY:?N8N_API_KEY not set}"

# 1. Pull from n8n API
# 2. Pipe through sanitize-workflow.mjs
# 3. Write to src/workflow-template.json
curl -sf \
  -H "X-N8N-API-KEY: $API_KEY" \
  "$N8N_URL/api/v1/workflows/$WF_ID" \
  | node "$ROOT/scripts/sanitize-workflow.mjs" - \
    "$ROOT/src/workflow-template.json"

echo "Done. Review diff before committing:"
echo "  git diff src/workflow-template.json"
