#!/usr/bin/env python3
"""
deploy_env.py
-------------
Single command to generate a production .env from scratch:
  1. Authenticates to Odoo and discovers all required IDs
  2. Merges them with the acceptance-test .env as base template
  3. Applies any extra --set overrides (secrets, flags)
  4. Writes the production .env with a timestamped backup

Usage:
    python3 deploy_env.py \\
        --odoo-url  https://<your-subdomain>.odoo.com \\
        --odoo-db   <your-subdomain> \\
        --odoo-user <your-email> \\
        --odoo-password '<password-or-api-key>' \\
        --source  ../n8n-hosting-acceptance-test/.env \\
        --target  ../n8n-hosting-production/.env \\
        --odoo-base-url https://<public-odoo-domain-if-different> \\
        --set ODOO_API_KEY=<prod_api_key> \\
        --set ODOO_PASSWORD=<prod_password> \\
        --set N8N_ENCRYPTION_KEY=<prod_n8n_enc_key> \\
        --set N8N_API_KEY=<prod_n8n_api_key> \\
        --set POSTGRES_PASSWORD=<prod_db_pw>

Or fully via env vars (recommended – nothing sensitive in shell history):
    export ODOO_URL=https://<your-subdomain>.odoo.com
    export ODOO_DB=<your-subdomain>                 # optional (auto-derived from ODOO_URL)
    export ODOO_USER=<your-email>
    export ODOO_PASSWORD='<password-or-api-key>'
    export SOURCE_ENV=../n8n-hosting-acceptance-test/.env
    export TARGET_ENV=../n8n-hosting-production/.env
    export ODOO_BASE_URL=https://<public-odoo-domain-if-different>
    python3 deploy_env.py \\
        --set ODOO_API_KEY=<prod_api_key> \\
        --set N8N_ENCRYPTION_KEY=<prod_key> \\
        ...

Flags:
    --dry-run     Print merged result without writing anything
    --no-backup   Skip timestamped backup of existing target
    --no-discover Skip Odoo discovery (use only --set / hardcoded overrides)

No third-party dependencies.
"""

import argparse
import http.cookiejar
import json
import os
import shutil
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Any

_call_id = 0


# ══════════════════════════════════════════════════════════════════════════════
# Hardcoded production overrides
# (everything that differs from acceptance-test and is NOT discovered from Odoo)
# ══════════════════════════════════════════════════════════════════════════════

STATIC_PRODUCTION_OVERRIDES: dict[str, str] = {
    # Sync should respect the schedule in production
    "HELLOCASH_IGNORE_SYNC_HOUR": "false",
}

# Keys that must be supplied via --set or env vars.
# The script will warn if any of these are still placeholder after merging.
REQUIRED_SECRETS = [
    "ODOO_API_KEY",
    "ODOO_PASSWORD",
    "N8N_API_KEY",
    "N8N_ENCRYPTION_KEY",
    "N8N_PASSWORD",
    "HELLOCASH_API_TOKEN",
    "N8N_SMTP_PASS",
    "POSTGRES_PASSWORD",
]


# ══════════════════════════════════════════════════════════════════════════════
# Odoo JSON-RPC helpers  (same approach as odoo_env_discovery.py)
# ══════════════════════════════════════════════════════════════════════════════

def _make_opener() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

OPENER = _make_opener()


def _post(url: str, payload: dict) -> Any:
    global _call_id
    _call_id += 1
    payload.setdefault("id", _call_id)
    payload.setdefault("jsonrpc", "2.0")
    payload.setdefault("method", "call")
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"})
    try:
        with OPENER.open(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.reason}")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error: {exc.reason}")
    if "error" in body:
        msg = (body["error"].get("data") or {}).get("message") or str(body["error"])
        raise RuntimeError(msg)
    return body.get("result")


def odoo_authenticate(base_url: str, db: str, user: str, password: str) -> int:
    try:
        result = _post(
            f"{base_url}/web/session/authenticate",
            {"params": {"db": db, "login": user, "password": password}},
        )
    except RuntimeError as exc:
        sys.exit(
            f"[ERROR] Odoo authentication failed: {exc}\n"
            "  • Check --odoo-url, --odoo-db, email and password\n"
            "  • Use an API key as --odoo-password if 2FA is enabled"
        )
    uid = (result or {}).get("uid")
    if not uid:
        sys.exit(f"[ERROR] Authentication rejected (uid=False). Response: {result}")
    return int(uid)


def odoo_search_read(base_url: str, db: str, uid: int, pw: str,
                     model: str, domain: list, fields: list,
                     limit: int = 200, order: str = "id asc") -> list:
    try:
        return _post(
            f"{base_url}/jsonrpc",
            {"params": {
                "service": "object", "method": "execute_kw",
                "args": [db, uid, pw, model, "search_read",
                         [domain], {"fields": fields, "limit": limit, "order": order}],
            }},
        ) or []
    except RuntimeError as exc:
        print(f"  [WARN] {model}: {exc}")
        return []


# ══════════════════════════════════════════════════════════════════════════════
# Odoo discovery  →  returns dict[env_key, value]
# ══════════════════════════════════════════════════════════════════════════════

def discover_odoo(base_url: str, db: str, uid: int, pw: str) -> dict[str, str]:
    found: dict[str, str] = {
        "ODOO_DB":  db,
        "ODOO_UID": str(uid),
        "ODOO_RPC": "json2",
    }

    # ── Journals ──────────────────────────────────────────────────────────────
    journals = odoo_search_read(base_url, db, uid, pw,
                                "account.journal", [],
                                ["id", "name", "code", "type"],
                                order="type asc, id asc")
    cash = [j for j in journals if j["type"] == "cash"]
    bank = [j for j in journals if j["type"] == "bank"]
    if cash:
        pick = cash[0]
        found["ODOO_JOURNAL_ID"] = str(pick["id"])
        label = f"id={pick['id']} {pick['code']} {pick['name']}"
        if len(cash) > 1:
            others = ", ".join(f"id={j['id']} {j['name']}" for j in cash[1:])
            print(f"  ⚠  Multiple cash journals; picked {label}. Others: {others}")
        else:
            print(f"  ✓  ODOO_JOURNAL_ID={pick['id']}  ({pick['name']})")
    elif bank:
        pick = bank[0]
        found["ODOO_JOURNAL_ID"] = str(pick["id"])
        print(f"  ⚠  No cash journal; using bank id={pick['id']} {pick['name']}")
    else:
        print("  ⚠  No cash/bank journal found – ODOO_JOURNAL_ID not set")

    # ── Accounts ──────────────────────────────────────────────────────────────
    accounts = odoo_search_read(base_url, db, uid, pw,
                                "account.account", [],
                                ["id", "code", "name"],
                                limit=500, order="code asc")
    by_code: dict[str, dict] = {}
    for a in accounts:
        by_code[a["code"]] = a
        stripped = a["code"].lstrip("0") or a["code"]
        by_code[stripped]  = a

    account_targets = {
        "ACCOUNT_KASSE":     ["1338", "1600"],
        "ACCOUNT_BANK":      ["1339", "1800"],
        "ACCOUNT_ERLOESE":   ["1200", "8400", "8300", "4400"],
        "ACCOUNT_GUTSCHEIN": ["493",  "0493", "3272"],
        "ACCOUNT_UST_19":    ["3806", "1776"],   # USt 19% — 3806 confirmed, 1776 SKR03 fallback
        "ACCOUNT_UST_7":     ["3805", "1771"],   # USt 7%  — 3805 likely, 1771 SKR03 fallback
    }
    for var, codes in account_targets.items():
        for code in codes:
            if code in by_code:
                a = by_code[code]
                found[var] = str(a["id"])
                print(f"  ✓  {var}={a['id']}  code={a['code']}  {a['name']}")
                break
        else:
            print(f"  ⚠  {var} – no match for codes {codes}")

    # ── Taxes ─────────────────────────────────────────────────────────────────
    taxes = odoo_search_read(base_url, db, uid, pw,
                             "account.tax",
                             [("type_tax_use", "=", "sale"), ("active", "=", True)],
                             ["id", "name", "amount"],
                             order="amount desc")
    for rate, var in [(19.0, "TAX_ID_19"), (7.0, "TAX_ID_7")]:
        matches = [t for t in taxes if t["amount"] == rate]
        if matches:
            found[var] = str(matches[0]["id"])
            print(f"  ✓  {var}={matches[0]['id']}  {matches[0]['name']}")
            if len(matches) > 1:
                print(f"     ⚠ Multiple {rate:.0f}% taxes; picked first")
        else:
            default = "0"
            found[var] = default
            print(f"  ⚠  {var} – no active {rate:.0f}% sale tax found, defaulting to {default}")

    return found


# ══════════════════════════════════════════════════════════════════════════════
# .env merge / write
# ══════════════════════════════════════════════════════════════════════════════

def read_env(path: Path) -> list[str]:
    if not path.exists():
        sys.exit(f"[ERROR] Source .env not found: {path}")
    return path.read_text(encoding="utf-8").splitlines()


def merge_env(source_lines: list[str], overrides: dict[str, str]) -> list[str]:
    remaining = dict(overrides)
    result: list[str] = []
    for line in source_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            result.append(line)
            continue
        if "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                result.append(f"{key}={remaining.pop(key)}")
                continue
        result.append(line)
    if remaining:
        result.append("")
        result.append("# ── Added by deploy_env.py ──────────────────────────────")
        for k, v in remaining.items():
            result.append(f"{k}={v}")
    return result


def write_env(target: Path, lines: list[str], backup: bool) -> None:
    if target.exists() and backup:
        ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        bak = target.with_name(target.name + f".bak_{ts}")
        shutil.copy2(target, bak)
        print(f"  Backup  → {bak}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  Written → {target.resolve()}")


def check_secrets(lines: list[str]) -> None:
    env = {}
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            k, v = stripped.split("=", 1)
            env[k.strip()] = v.strip()

    missing = [k for k in REQUIRED_SECRETS
               if not env.get(k) or env[k].startswith("<FILL_IN")]
    if missing:
        print("\n⚠  Secrets still missing – fill these in before deploying:")
        for k in missing:
            print(f"     {k}=???")
    else:
        print("\n✓  All required secrets are present.")


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Generate production .env in one command.")

    g = p.add_argument_group("Odoo connection")
    g.add_argument("--odoo-url",      default=os.getenv("ODOO_URL"),
                   help="Odoo base URL, e.g. https://www.example.com")
    g.add_argument("--odoo-db",       default=os.getenv("ODOO_DB"),
                   help="Odoo database name (find it in Settings → General Settings → Database Name)")
    g.add_argument("--odoo-user",     default=os.getenv("ODOO_USER"),
                   help="Odoo login email")
    g.add_argument("--odoo-password", default=os.getenv("ODOO_PASSWORD"),
                   help="Odoo password or API key")
    g.add_argument("--odoo-base-url", default=os.getenv("ODOO_BASE_URL"),
                   help="Public-facing base URL to write as ODOO_BASE_URL. Defaults to --odoo-url.")

    g2 = p.add_argument_group("File paths")
    g2.add_argument("--source", default=os.getenv("SOURCE_ENV"),
                    help="Source (acceptance-test) .env path")
    g2.add_argument("--target", default=os.getenv("TARGET_ENV"),
                    help="Target (production) .env path to write")

    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="Production override; repeat as needed: --set FOO=bar")
    p.add_argument("--no-backup",   action="store_true",
                   help="Skip timestamped backup of existing target")
    p.add_argument("--dry-run",     action="store_true",
                   help="Print merged result without writing")
    p.add_argument("--no-discover", action="store_true",
                   help="Skip Odoo discovery; apply only --set overrides")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # Validate paths
    for flag, val in [("--source / SOURCE_ENV", args.source),
                      ("--target / TARGET_ENV", args.target)]:
        if not val:
            sys.exit(f"[ERROR] Missing required argument: {flag}")

    # ── Step 1: start with static production overrides ────────────────────────
    overrides: dict[str, str] = dict(STATIC_PRODUCTION_OVERRIDES)

    # ── Step 2: discover Odoo values ─────────────────────────────────────────
    if not args.no_discover:
        for flag, val in [
            ("--odoo-url / ODOO_URL",           args.odoo_url),
            ("--odoo-db  / ODOO_DB",            args.odoo_db),
            ("--odoo-user / ODOO_USER",         args.odoo_user),
            ("--odoo-password / ODOO_PASSWORD", args.odoo_password),
        ]:
            if not val:
                sys.exit(f"[ERROR] Missing Odoo argument: {flag}\n"
                         "  (Use --no-discover to skip Odoo discovery)")

        base_url = args.odoo_url.rstrip("/")
        print(f"Connecting to {base_url}  db={args.odoo_db}  user={args.odoo_user} …")
        uid = odoo_authenticate(base_url, args.odoo_db, args.odoo_user, args.odoo_password)
        print(f"✓ Authenticated  uid={uid}\n")
        print("Discovering Odoo values …")
        odoo_values = discover_odoo(base_url, args.odoo_db, uid, args.odoo_password)
        overrides.update(odoo_values)
        # ODOO_BASE_URL is not fixed; default to the Odoo URL unless overridden.
        overrides["ODOO_BASE_URL"] = (args.odoo_base_url or base_url).rstrip("/")

    # ── Step 3: apply --set flags (highest priority) ──────────────────────────
    for item in args.set:
        if "=" not in item:
            sys.exit(f"[ERROR] --set value must be KEY=VALUE, got: {item!r}")
        k, v = item.split("=", 1)
        overrides[k.strip()] = v.strip()

    # ── Step 4: merge into source .env ────────────────────────────────────────
    source_path = Path(args.source)
    target_path = Path(args.target)
    print(f"\nSource : {source_path.resolve()}")
    print(f"Target : {target_path.resolve()}")

    source_lines = read_env(source_path)
    merged_lines = merge_env(source_lines, overrides)

    # ── Step 5: write or dry-run ──────────────────────────────────────────────
    if args.dry_run:
        print("\n── DRY RUN – nothing written ───────────────────────────────────")
        print("\n".join(merged_lines))
        check_secrets(merged_lines)
        return

    print()
    write_env(target_path, merged_lines, backup=not args.no_backup)
    check_secrets(merged_lines)
    print("\nDone.")


if __name__ == "__main__":
    main()
