# n8n with PostgreSQL

Starts n8n with PostgreSQL as database.

## Start

To start n8n with PostgreSQL simply start docker-compose by executing the following
command in the current folder.

**IMPORTANT:** But before you do that change the default users and passwords in the [`.env`](.env) file!

```
docker-compose up -d
```

To stop it execute:

```
docker-compose stop
```

## Configuration

The default name of the database, user and password for PostgreSQL can be changed in the [`.env`](.env) file in the current directory.

### Environment file name

Docker Compose loads **`.env`** in this folder for `${VAR}` substitution. If you keep variables in a file named `env`, either rename it to `.env` or start with:

```bash
docker compose --env-file env up -d
```

Copy [`.env.example`](.env.example) to `.env` and fill in secrets. For the Blumenladen profile you can use `docker compose --env-file .env-blumenladen up -d` (keep a private backup of any env file that holds secrets).

**Where `ODOO_BASE_URL` is read:** Values under `n8n: environment:` in `docker-compose.yml` use `${ODOO_BASE_URL:?…}` (required — compose fails if unset). Those placeholders are filled from the **host** when Compose parses the file — typically from **`.env` next to `docker-compose.yml`**, or from your shell, or from `--env-file`. They are **not** read from inside the `env` file automatically unless that file is named `.env` or you pass `--env-file env`. Whatever ends up in the container as `ODOO_BASE_URL` is what n8n Code nodes see as `$env.ODOO_BASE_URL`.

**Must be a full URL:** Use `http://host.docker.internal:8069` (or your real Odoo origin). If you set `ODOO_BASE_URL=8069`, the workflow would call `8069/jsonrpc` and fail with `ECONNREFUSED`.

### Odoo + HelloCash workflow (`ECONNREFUSED` on `account.move.create`)

The n8n container **cannot** reach Odoo at `http://localhost:8069` — `localhost` there is the n8n container itself, not your laptop or server.

- Set **`ODOO_BASE_URL=http://host.docker.internal:8069`** (origin only, no `/jsonrpc`; the workflow adds `/jsonrpc`).
- The compose file adds `extra_hosts: host.docker.internal:host-gateway` so this resolves on Linux and Mac/Windows Docker.
- If Odoo runs on another machine, use that host’s URL instead.
- **`ODOO_PASSWORD`** must be the **Odoo user** password for **`ODOO_UID`**, not the PostgreSQL password.

### HelloCash invoice path

`HELLOCASH_INVOICES_PATH` must start with `/` (e.g. `/api/v1/invoices`). A typo like `i/api/...` breaks invoice requests.
