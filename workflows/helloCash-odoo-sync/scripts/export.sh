#!/usr/bin/env sh
# Pull workflow JSON from n8n and sync Code node bodies back to src/nodes/ (implement as needed).
# Strip credentials IDs before writing; normalize JSON to avoid noisy diffs.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Export stub: export from n8n UI or API, then extract parameters.jsCode into src/nodes/*.js"
exit 1
