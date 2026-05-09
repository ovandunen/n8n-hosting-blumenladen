# deploy_env.py

Generates a production `.env` file in a single command by combining three sources:

1. An acceptance-test `.env` as the base template (all non-Odoo variables)
2. Live values queried directly from the Odoo instance (IDs that vary per database)
3. Explicit overrides you pass on the command line (secrets, flags)

No third-party dependencies — standard library only (Python 3.10+).

---

## Why this script exists

The n8n sync stack for the Blumenladen requires a `.env` file that mixes two kinds of values:

- **Stable infrastructure config** — SMTP credentials, n8n encryption keys, Postgres password, HelloCash token. These are the same shape in every environment and live in the acceptance-test `.env`.
- **Odoo database IDs** — journal ID, account IDs, tax IDs. These are internal Odoo record IDs that differ between the test instance and the production instance and cannot be guessed or copied safely by hand.

Without this script, deploying to production means manually logging into Odoo, looking up each ID, and typing them into the `.env` — error-prone and time-consuming. This script does all of that automatically.

---

## What it does, step by step

### Step 1 — Apply static production overrides

A small hardcoded dict at the top of the script (`STATIC_PRODUCTION_OVERRIDES`) sets values that are always different in production regardless of Odoo. Currently:

```
HELLOCASH_IGNORE_SYNC_HOUR=false
```

In acceptance-test this is `true` so syncs run immediately for testing. In production it must be `false` so the sync only runs at `SYNC_HOUR`.

### Step 2 — Authenticate to Odoo and discover IDs

The script connects to Odoo via JSON-RPC 2.0 (`/web/session/authenticate` then `/jsonrpc`) and queries three models:

**`account.journal`** → finds the cash register journal → sets `ODOO_JOURNAL_ID`

If multiple cash journals exist it picks the first and prints a warning. If no cash journal exists it falls back to the first bank journal.

**`account.account`** → looks up accounts by SKR03 code → sets:

| Variable | SKR03 codes tried |
|---|---|
| `ACCOUNT_KASSE` | 1338, 1600 |
| `ACCOUNT_BANK` | 1339, 1800 |
| `ACCOUNT_ERLOESE` | 1200, 8400, 8300, 4400 |
| `ACCOUNT_GUTSCHEIN` | 493, 0493, 3272 |

It indexes accounts by both their raw code and the leading-zero-stripped version so `0493` and `493` both match.

**`account.tax`** → finds active sale taxes at 19% and 7% → sets `TAX_ID_19` and `TAX_ID_7`.

It also sets `ODOO_DB`, `ODOO_UID`, `ODOO_RPC=json2`, and `ODOO_BASE_URL` from the connection arguments.

### Step 3 — Apply `--set` overrides

Any `--set KEY=VALUE` flags you pass are applied last, overriding everything from Steps 1 and 2. This is how secrets (API keys, passwords) are injected without being hardcoded anywhere in the script.

### Step 4 — Merge into the source `.env`

The script reads the acceptance-test `.env` line by line and replaces the value of any key that appears in the overrides dict, preserving the line's position in the file. Comments and blank lines are kept verbatim. Keys from the overrides that do not yet exist in the source file are appended at the bottom in a labelled block.

### Step 5 — Write the production `.env`

Before writing, a timestamped backup of the existing target is created (e.g. `.env.bak_20260508_143012`). Then the merged content is written to the target path.

Finally the script checks that all `REQUIRED_SECRETS` are present and non-empty, and prints a warning for any that are still missing.

---

## Usage

### Minimum required arguments

```bash
python3 deploy_env.py \
  --odoo-url      https://www.artischoke-kunstblumen.de \
  --odoo-db       artischoke-kunstblumen \
  --odoo-user     corinna-hug@gmx.de \
  --odoo-api-key  'e27883e9...' \
  --source  ../n8n-hosting-acceptance-test/.env \
  --target  ../n8n-hosting-production/.env
```

### With secrets passed inline

```bash
python3 deploy_env.py \
  --odoo-url      https://www.artischoke-kunstblumen.de \
  --odoo-db       artischoke-kunstblumen \
  --odoo-user     corinna-hug@gmx.de \
  --odoo-api-key  'e27883e9c9361b9b45185b369ac8555606f80660' \
  --source  ../n8n-hosting-acceptance-test/.env \
  --target  ../n8n-hosting-production/.env \
  --set ODOO_API_KEY=e27883e9c9361b9b45185b369ac8555606f80660 \
  --set N8N_ENCRYPTION_KEY=db063d86-7722-4ccc-bc89-4851035ba990 \
  --set N8N_API_KEY=eyJhbGciOi... \
  --set POSTGRES_PASSWORD=MyProdDbPassword
```

### Recommended: keep secrets out of shell history entirely

Set everything via environment variables before running:

```bash
export ODOO_URL=https://www.artischoke-kunstblumen.de
export ODOO_DB=artischoke-kunstblumen
export ODOO_USER=corinna-hug@gmx.de
export ODOO_API_KEY='e27883e9...'
export SOURCE_ENV=../n8n-hosting-acceptance-test/.env
export TARGET_ENV=../n8n-hosting-production/.env

python3 deploy_env.py \
  --set ODOO_API_KEY=e27883e9... \
  --set N8N_ENCRYPTION_KEY=db063d86... \
  --set POSTGRES_PASSWORD=...
```

### Preview without writing anything

```bash
python3 deploy_env.py [all other args] --dry-run
```

Prints the full merged `.env` to stdout and runs the secrets check, without touching any file.

---

## All flags

| Flag | Env var equivalent | Description |
|---|---|---|
| `--odoo-url` | `ODOO_URL` | Odoo base URL (custom domain or odoo.com) |
| `--odoo-db` | `ODOO_DB` | Odoo database name — find it in Settings → General Settings → Database Name |
| `--odoo-user` | `ODOO_USER` | Odoo login email |
| `--odoo-api-key` | `ODOO_API_KEY` | Odoo API key |
| `--odoo-base-url` | `ODOO_BASE_URL` | Override the URL written as `ODOO_BASE_URL` in the output (defaults to `--odoo-url`) |
| `--source` | `SOURCE_ENV` | Path to the acceptance-test `.env` used as the base template |
| `--target` | `TARGET_ENV` | Path to the production `.env` to write |
| `--set KEY=VALUE` | — | Inline override; repeat for each key; highest priority |
| `--dry-run` | — | Print merged output without writing anything |
| `--no-backup` | — | Skip the timestamped backup before writing |
| `--no-discover` | — | Skip Odoo entirely; apply only `--set` and static overrides |

---

## Override priority (lowest → highest)

```
STATIC_PRODUCTION_OVERRIDES (hardcoded in script)
        ↓
Odoo discovery (live queries)
        ↓
--set KEY=VALUE flags (command line)
```

A `--set` flag always wins. If you pass `--set ODOO_JOURNAL_ID=99`, that value is used regardless of what Odoo returns.

---

## Required secrets

The script checks these keys after merging and warns if any are absent or still set to a placeholder value:

- `ODOO_API_KEY`
- `N8N_API_KEY`
- `N8N_ENCRYPTION_KEY`
- `N8N_PASSWORD`
- `HELLOCASH_API_TOKEN`
- `N8N_SMTP_PASS`
- `POSTGRES_PASSWORD`

None of these are discovered from Odoo — they must be supplied via `--set` or already present in the source `.env`.

---

## How to find your Odoo database name

In the Odoo web interface: **Settings → General Settings → scroll to "Database Name"**.

It is not necessarily the same as the domain name. For the Blumenladen:
- URL: `https://www.artischoke-kunstblumen.de`
- Database name: `artischoke-kunstblumen`

---

## Generating an Odoo API key

An API key can be used instead of a password (required if the account has 2FA enabled):

**Settings → My Profile → API Keys → New**

Copy the key immediately — Odoo only shows it once.

---

## Project layout

```
n8n-hosting-acceptance-test/
└── .env                  ← source template (all non-Odoo variables)

n8n-hosting-production/
├── .env                  ← generated by this script
├── .env.bak_YYYYMMDD_…   ← automatic backup of previous version
└── deploy_env.py         ← this script
```
