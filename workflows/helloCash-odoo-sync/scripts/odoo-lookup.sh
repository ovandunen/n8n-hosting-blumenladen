#!/bin/bash
# odoo-lookup.sh
# Zweck: Alle Odoo-IDs ermitteln die der helloCash→Odoo n8n Workflow benötigt

ODOO_URL="https://DEINE-ODOO-URL"
ODOO_DB="DEINE-DB"
ODOO_EMAIL="DEINE-EMAIL"
ODOO_API_KEY="DEIN-API-KEY"

# UID ermitteln
ODOO_UID=$(curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"common\",\"method\":\"authenticate\",\"args\":[\"$ODOO_DB\",\"$ODOO_EMAIL\",\"$ODOO_API_KEY\",{}]}}" \
  | jq '.result')

echo "========================================"
echo " helloCash → Odoo Workflow: ID Lookup"
echo "========================================"
echo ""
echo "ODOO_UID: $ODOO_UID"
echo ""

# ── JOURNALE ─────────────────────────────────
echo "=== JOURNALE (JOURNAL_KASSE / JOURNAL_BANK / JOURNAL_VERKAUF) ==="
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"object\",\"method\":\"execute_kw\",\"args\":[\"$ODOO_DB\",$ODOO_UID,\"$ODOO_API_KEY\",\"account.journal\",\"search_read\",[[]],{\"fields\":[\"id\",\"name\",\"type\",\"code\"],\"order\":\"id asc\"}]}}" \
  | jq '.result[] | {id, name, type, code}'
echo ""

# ── KASSENKONTEN (1600er) ─────────────────────
echo "=== KASSE → ACCOUNT_KASSE (erwartet: 1610, ID 1612) ==="
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"object\",\"method\":\"execute_kw\",\"args\":[\"$ODOO_DB\",$ODOO_UID,\"$ODOO_API_KEY\",\"account.account\",\"search_read\",[[[\"code\",\">=\",\"1600\"],[\"code\",\"<=\",\"1699\"]]],{\"fields\":[\"id\",\"code\",\"name\",\"account_type\"],\"order\":\"code asc\"}]}}" \
  | jq '.result[] | {id, code, name}'
echo ""

# ── FORDERUNGSKONTEN FÜR EC / KREDITKARTE / RECHNUNG ─────────────────────
echo "=== FORDERUNGEN → ACCOUNT_EC / ACCOUNT_KREDITKARTE / ACCOUNT_RECHNUNG ==="
echo "    (erwartet: 1206=ID 1466 für EC/Kreditkarte, 1200=ID 1464 für Rechnung)"
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"object\",\"method\":\"execute_kw\",\"args\":[\"$ODOO_DB\",$ODOO_UID,\"$ODOO_API_KEY\",\"account.account\",\"search_read\",[[[\"code\",\"in\",[\"1200\",\"1205\",\"1206\",\"1210\"]]]],{\"fields\":[\"id\",\"code\",\"name\",\"account_type\"],\"order\":\"code asc\"}]}}" \
  | jq '.result[] | {id, code, name}'
echo ""

# ── ERLÖSKONTEN ───────────────────────────────
echo "=== ERLÖSE → ACCOUNT_ERLOESE (erwartet: 4400=ID 1912 für 19% MwSt) ==="
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"object\",\"method\":\"execute_kw\",\"args\":[\"$ODOO_DB\",$ODOO_UID,\"$ODOO_API_KEY\",\"account.account\",\"search_read\",[[[\"code\",\"in\",[\"4200\",\"4300\",\"4400\"]]]],{\"fields\":[\"id\",\"code\",\"name\",\"account_type\"],\"order\":\"code asc\"}]}}" \
  | jq '.result[] | {id, code, name}'
echo ""

# ── ZUSAMMENFASSUNG FÜR .env ──────────────────
echo "========================================"
echo " Vor
