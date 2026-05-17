# n8n-hosting-blumenladen

Official hosting configurations for [n8n](https://n8n.io) -- the workflow automation platform.

## Kubernetes (Helm Chart)

The official n8n Helm chart for production Kubernetes deployments.

```bash
helm install n8n oci://ghcr.io/n8n-io/n8n-helm-chart/n8n --version 1.0.0 -f my-values.yaml
```

See the [chart README](./charts/n8n/README.md) for full documentation and the [examples](./charts/n8n/examples/) directory for common configurations.

## Docker Compose

| Directory | Description |
|---|---|
| [docker-compose/withPostgres](./docker-compose/withPostgres/) | n8n + PostgreSQL |
| [docker-compose/withPostgresAndWorker](./docker-compose/withPostgresAndWorker/) | n8n + PostgreSQL + Redis + worker (queue mode) |
| [docker-compose/subfolderWithSSL](./docker-compose/subfolderWithSSL/) | n8n behind SSL reverse proxy in subfolder |
| [docker-caddy](./docker-caddy/) | n8n with Caddy reverse proxy |

## Kubernetes (Raw Manifests)

See [`kubernetes/`](./kubernetes/) for raw Kubernetes manifest examples used in cloud provider tutorials (AWS, Azure, GCP).

## Documentation

- [n8n docs](https://docs.n8n.io/)
- [Self-hosting guides](https://docs.n8n.io/hosting/)
- [Community forum](https://community.n8n.io/)
- [HelloCash → Odoo workflow changelog](./workflows/helloCash-odoo-sync/README.md#changelog-major-vs-minor) (major/minor behaviour notes)

This repository also includes a **HelloCash Business → Odoo** workflow under `workflows/helloCash-odoo-sync/`.

## Deployment

# 1. On your computer — build the workflow
cd workflows/helloCash-odoo-sync
npm run build

# 2. Push infrastructure changes to git
cd ../../
git push origin main

# 3. On the remote server — pull and restart
ssh user@server
cd n8n-hosting/docker-compose/withPostgres
git pull origin main
docker compose up -d

# 4. Back on your Mac — deploy workflow via API
set -a && source env/.env.local && set +a
cd workflows/helloCash-odoo-sync
npm run deploy



Activate cron job via N8N SYNC:

0. Generate N8N_API_KEY in N8N UI

1. export N8N_API_KEY=[xxxxx] if not set

2. export N8N_BASE_URL=http(s)://[xxxx]

3. set in .env =>  N8N_PUBLIC_API_DISABLED: "false"

4. set workflow ID:  curl -s -X POST \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @helloCash-odoo-sync_workflow.json \
  "$N8N_BASE_URL/api/v1/workflows"
5. Then find the working ID:  
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_BASE_URL/api/v1/workflows" \
  | python3 -c "
import json, sys
for wf in json.load(sys.stdin).get('data', []):
    print(wf['id'], '| active:', wf['active'], '|', wf['name'])
"

6. Select the actual working ID e.g: 
    LTbhhoR0qBDIskeH | active: False | HelloCash Business → Odoo sync
W5Lgf8INT1WHe5Be | active: False | HelloCash Business → Odoo sync
O5oAnyVui41D3foO | active: True | HelloCash Business → Odoo sync

The actual working ID in this example: O5oAnyVui41D3foO

7. Change the hour and minutes in the UI as you need


 
