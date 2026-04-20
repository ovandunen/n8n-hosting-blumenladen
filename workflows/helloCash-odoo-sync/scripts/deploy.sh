#!/usr/bin/env sh
# Push build/helloCash-odoo-sync_workflow.json to n8n (implement for your instance).
# Typical: REST API POST/PATCH /api/v1/workflows with N8N_API_KEY and base URL from env.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Deploy stub: import manually or extend this script to call n8n API."
echo "Artifact: $ROOT/build/helloCash-odoo-sync_workflow.json"
exit 1
