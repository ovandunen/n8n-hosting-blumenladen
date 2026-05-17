#!/usr/bin/env python3
"""
odoo_env_discovery.py
---------------------
Queries Odoo and writes (or updates) a .env file with all discovered values.
Non-Odoo variables already present in the file are preserved unchanged.
A timestamped backup is created before any write.

Usage (single line):
    python3 odoo_env_discovery.py \\
        --url https://<your-subdomain>.odoo.com \\
        --db <your-subdomain> \\
        --user <your-email> \\
        --api-key '<odoo-api-key>' \\
        --env .env

Or via env vars:
    export ODOO_URL=https://<your-subdomain>.odoo.com
    export ODOO_DB=<your-subdomain>                 # optional (auto-derived from ODOO_URL)
    export ODOO_USER=<your-email>
    export ODOO_API_KEY='<odoo-api-key>'
    python3 odoo_env_discovery.py --env .env

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


# ──────────────────────────────────────────────────────────────────────────────
# HTTP session with cookie support
# ──────────────────────────────────────────────────────────────────────────────

def make_opener() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

OPENER = make_opener()


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
        raise RuntimeError(f"HTTP {exc.code} from {url}: {exc.reason}")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error: {exc.reason}")

    if "error" in body:
        err = body["error"]
        msg = (err.get("data") or {}).get("message") or str(err)
        raise RuntimeError(msg)

    return body.get("result")


# ──────────────────────────────────────────────────────────────────────────────
# Auth + data access
# ──────────────────────────────────────────────────────────────────────────────

def authenticate(base_url: str, db: str, user: str, api_key: str) -> int:
    try:
        result = _post(
            f"{base_url}/web/session/authenticate",
            {"params": {"db": db, "login": user, "password": api_key}},
        )
    except RuntimeError as exc:
        sys.exit(
            f"[ERROR] Authentication failed: {exc}\n"
            "  • --url should typically be https://<subdomain>.odoo.com\n"
            "  • --db  is the Odoo database name (often the subdomain)\n"
            "  • Check email/API key; for 2FA use an API key as --api-key"
        )
    uid = (result or {}).get("uid")
    if not uid:
        sys.exit(
            "[ERROR] uid=False – wrong email/API key or --db mismatch.\n"
            f"  Server response: {result}"
        )
    return int(uid)


def search_read(base_url: str, db: str, uid: int, api_key: str,
                model: str, domain: list, fields: list,
                limit: int = 200, order: str = "id asc") -> list:
    try:
        return _post(
            f"{base_url}/jsonrpc",
            {"params": {
                "service": "object",
                "method":  "execute_kw",
                "args":    [db, uid, api_key, model, "search_read",
                            [domain], {"fields": fields, "limit": limit, "order": order}],
            }},
        ) or []
    except RuntimeError as exc:
        print(f"  [WARN] {model}: {exc}")
        return []


# ──────────────────────────────────────────────────────────────────────────────
# Odoo discovery  →  returns dict of env-key: value
# ──────────────────────────────────────────────────────────────────────────────

def discover_all(base_url: str, db: str, uid: int, api_key: str) -> dict[str, str]:
    discovered: dict[str, str] = {}

    # ── base connection vars ──────────────────────────────────────────────────
    discovered["ODOO_BASE_URL"] = base_url
    discovered["ODOO_DB"]       = db
    discovered["ODOO_UID"]      = str(uid)

    # ── journals ─────────────────────────────────────────────────────────────
    journals = search_read(base_url, db, uid, api_key,
                           "account.journal", [],
                           ["id", "name", "code", "type"],
                           order="type asc, id asc")
    print(f"\n  Journals found: {len(journals)}")
    cash = [j for j in journals if j["type"] == "cash"]
    bank = [j for j in journals if j["type"] == "bank"]

    if len(cash) == 1:
        discovered["ODOO_JOURNAL_ID"] = str(cash[0]["id"])
        print(f"  ✓ ODOO_JOURNAL_ID={cash[0]['id']}  ({cash[0]['name']})")
    elif len(cash) > 1:
        print("  ⚠ Multiple cash journals – picking first. Edit .env if wrong:")
        for j in cash:
            print(f"     id={j['id']}  {j['code']}  {j['name']}")
        discovered["ODOO_JOURNAL_ID"] = str(cash[0]["id"])
    elif bank:
        discovered["ODOO_JOURNAL_ID"] = str(bank[0]["id"])
        print(f"  ⚠ No cash journal found, using bank: id={bank[0]['id']}  {bank[0]['name']}")
    else:
        print("  ⚠ No cash or bank journal found – ODOO_JOURNAL_ID left empty")

    # ── accounts ─────────────────────────────────────────────────────────────
    accounts = search_read(base_url, db, uid, api_key,
                           "account.account", [],
                           ["id", "code", "name", "account_type"],
                           limit=500, order="code asc")
    print(f"\n  Accounts found: {len(accounts)}")

    # map: normalised code → record
    by_code: dict[str, dict] = {}
    for a in accounts:
        by_code[a["code"]]                = a   # original
        by_code[a["code"].lstrip("0") or a["code"]] = a   # stripped

    targets = {
        "ACCOUNT_KASSE":     ["1338", "1600"],
        "ACCOUNT_BANK":      ["1339", "1800"],
        "ACCOUNT_ERLOESE":   ["1200", "8400", "8300", "4400"],
        "ACCOUNT_GUTSCHEIN": ["493",  "0493", "3272"],
    }
    for var, codes in targets.items():
        for code in codes:
            if code in by_code:
                a = by_code[code]
                discovered[var] = str(a["id"])
                print(f"  ✓ {var}={a['id']}  code={a['code']}  {a['name']}")
                break
        else:
            print(f"  ⚠ {var} – no matching account found (tried {codes})")

    # ── taxes ─────────────────────────────────────────────────────────────────
    taxes = search_read(base_url, db, uid, api_key,
                        "account.tax",
                        [("type_tax_use", "=", "sale"), ("active", "=", True)],
                        ["id", "name", "amount"],
                        order="amount desc")
    print(f"\n  Sale taxes found: {len(taxes)}")

    for rate, var in [(19.0, "TAX_ID_19"), (7.0, "TAX_ID_7")]:
        matches = [t for t in taxes if t["amount"] == rate]
        if len(matches) == 1:
            discovered[var] = str(matches[0]["id"])
            print(f"  ✓ {var}={matches[0]['id']}  {matches[0]['name']}")
        elif len(matches) > 1:
            print(f"  ⚠ Multiple {rate:.0f}% taxes – picking first. Edit .env if wrong:")
            for t in matches:
                print(f"     id={t['id']}  {t['name']}")
            discovered[var] = str(matches[0]["id"])
        else:
            print(f"  ⚠ {var} – no active {rate:.0f}% sale tax found")

    return discovered


# ──────────────────────────────────────────────────────────────────────────────
# .env read / write
# ──────────────────────────────────────────────────────────────────────────────

def read_env(path: Path) -> list[str]:
    """Return raw lines from an existing .env, or empty list if file absent."""
    if path.exists():
        return path.read_text(encoding="utf-8").splitlines()
    return []


def merge_env(lines: list[str], updates: dict[str, str]) -> list[str]:
    """
    Merge `updates` into the existing lines:
      - Lines whose key is in `updates` are replaced with the new value.
      - Keys in `updates` not yet present are appended in a new section.
      - Comments, blank lines, and unknown keys are preserved as-is.
    """
    remaining = dict(updates)   # keys we still need to write
    result    = []

    for line in lines:
        stripped = line.strip()
        # Skip comment and blank lines unchanged
        if not stripped or stripped.startswith("#"):
            result.append(line)
            continue
        # Parse key=value (ignore inline comments for key matching)
        if "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                result.append(f"{key}={remaining.pop(key)}")
                continue
        result.append(line)

    # Append any keys that weren't already in the file
    if remaining:
        result.append("")
        result.append("# Auto-discovered Odoo values")
        for key, val in remaining.items():
            result.append(f"{key}={val}")

    return result


def write_env(path: Path, lines: list[str], backup: bool = True) -> None:
    if path.exists() and backup:
        ts      = datetime.now().strftime("%Y%m%d_%H%M%S")
        bak     = path.with_suffix(f".env.bak_{ts}")
        shutil.copy2(path, bak)
        print(f"\n  Backup written → {bak}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  .env written  → {path.resolve()}")


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Discover Odoo IDs and write them into a .env file.")
    p.add_argument("--url",      default=os.getenv("ODOO_URL"),
                   help="Odoo base URL, e.g. https://<subdomain>.odoo.com")
    p.add_argument("--db",       default=os.getenv("ODOO_DB"),
                   help="Odoo database name (often the subdomain). Optional if it can be derived from --url.")
    p.add_argument("--user",     default=os.getenv("ODOO_USER"),
                   help="Odoo login email")
    p.add_argument("--api-key", default=os.getenv("ODOO_API_KEY"),
                   help="Odoo API key")
    p.add_argument("--env",      default=os.getenv("ENV_FILE", ".env"),
                   help="Path to .env file to write/update (default: .env)")
    p.add_argument("--no-backup", action="store_true",
                   help="Skip creating a timestamped backup before writing")
    p.add_argument("--dry-run",   action="store_true",
                   help="Print what would be written without touching the file")
    return p.parse_args()


def derive_odoo_db_from_url(odoo_url: str) -> str | None:
    """
    Best-effort DB name inference from an Odoo SaaS URL like:
      https://<subdomain>.odoo.com  -> <subdomain>
    Returns None if it can't be inferred safely.
    """
    try:
        from urllib.parse import urlparse
        host = (urlparse(odoo_url).hostname or "").lower()
    except Exception:
        return None
    if host.endswith(".odoo.com") and host.count(".") >= 2:
        return host.split(".", 1)[0]
    return None


def main() -> None:
    args = parse_args()
    if not args.db and args.url:
        inferred = derive_odoo_db_from_url(args.url)
        if inferred:
            args.db = inferred
    missing = [k for k, v in [
        ("--url / ODOO_URL",           args.url),
        ("--db  / ODOO_DB",            args.db),
        ("--user / ODOO_USER",         args.user),
        ("--api-key / ODOO_API_KEY",    args.api_key),
    ] if not v]
    if missing:
        sys.exit(f"[ERROR] Missing required arguments: {', '.join(missing)}")

    base_url = args.url.rstrip("/")
    env_path = Path(args.env)

    print(f"Connecting to {base_url}  db={args.db}  user={args.user} …")
    uid = authenticate(base_url, args.db, args.user, args.api_key)
    print(f"✓ Authenticated  uid={uid}")

    print("\nDiscovering Odoo values …")
    discovered = discover_all(base_url, args.db, uid, args.api_key)

    existing_lines = read_env(env_path)
    merged_lines   = merge_env(existing_lines, discovered)

    if args.dry_run:
        print("\n── DRY RUN – nothing written. Merged .env would be: ────────────")
        print("\n".join(merged_lines))
        return

    print()
    write_env(env_path, merged_lines, backup=not args.no_backup)

    print("\n── Summary of values written ───────────────────────────────────────")
    for k, v in discovered.items():
        print(f"  {k}={v}")
    print()
    print("Done. Review .env and fill in any remaining <placeholder> values.")


if __name__ == "__main__":
    main()
