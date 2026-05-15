#!/bin/bash
# odoo-lookup.sh
# Zweck: Alle Odoo-IDs ermitteln die der helloCash→Odoo n8n Workflow benötigt


# UID ermitteln
ODOO_UID=$(curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"common\",\"method\":\"authenticate\",\"args\":[\"$ODOO_DB\",\"$ODOO_LOGIN\",\"$ODOO_API_KEY\",{}]}}" \
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

# ── USt-KONTEN: ROBUSTE SUCHE (3 Strategien) ─────────────────────────────
echo "========================================"
echo "=== UST → ACCOUNT_UST_19: Robuste Suche ==="
echo ""

# Strategie 1: account_type = 'liability_current' UND name enthält 'Umsatz' oder 'MwSt' oder 'USt'
echo "--- Strategie 1: account_type=liability_current + Namensfilter (MwSt/USt/Umsatzsteuer) ---"
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"call\",
    \"params\": {
      \"service\": \"object\",
      \"method\": \"execute_kw\",
      \"args\": [
        \"$ODOO_DB\", $ODOO_UID, \"$ODOO_API_KEY\",
        \"account.account\",
        \"search_read\",
        [[[\"account_type\", \"=\", \"liability_current\"],
          \"|\", \"|\",
          [\"name\", \"ilike\", \"Umsatzsteuer\"],
          [\"name\", \"ilike\", \"MwSt\"],
          [\"name\", \"ilike\", \"USt\"]]],
        {\"fields\": [\"id\", \"code\", \"name\", \"account_type\"], \"order\": \"code asc\"}
      ]
    }
  }" \
  | jq '.result[] | {id, code, name, account_type}'
echo ""

# Strategie 2: Gesamter SKR03-USt-Bereich 3800–3849 (deckt 3800, 3801, 3805, 3806, 3830 etc. ab)
echo "--- Strategie 2: SKR03 USt-Bereich 3800–3849 (alle vorhandenen Codes) ---"
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"call\",
    \"params\": {
      \"service\": \"object\",
      \"method\": \"execute_kw\",
      \"args\": [
        \"$ODOO_DB\", $ODOO_UID, \"$ODOO_API_KEY\",
        \"account.account\",
        \"search_read\",
        [[[\"code\", \">=\", \"3800\"], [\"code\", \"<=\", \"3849\"]]],
        {\"fields\": [\"id\", \"code\", \"name\", \"account_type\"], \"order\": \"code asc\"}
      ]
    }
  }" \
  | jq '.result[] | {id, code, name, account_type}'
echo ""

# Strategie 3: tax_ids über account.tax — findet den account direkt über die 19%-Steuer
echo "--- Strategie 3: account.tax → 19% MwSt → verknüpfte Steuerkonten ---"
curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"call\",
    \"params\": {
      \"service\": \"object\",
      \"method\": \"execute_kw\",
      \"args\": [
        \"$ODOO_DB\", $ODOO_UID, \"$ODOO_API_KEY\",
        \"account.tax\",
        \"search_read\",
        [[[\"amount\", \"=\", 19], [\"type_tax_use\", \"in\", [\"sale\", \"all\"]]]],
        {\"fields\": [\"id\", \"name\", \"amount\", \"invoice_repartition_line_ids\", \"refund_repartition_line_ids\"]}
      ]
    }
  }" \
  | jq '.result[] | {tax_id: .id, tax_name: .name, amount: .amount, invoice_lines: .invoice_repartition_line_ids}'
echo ""

# Strategie 3b: Repartition Lines der gefundenen Steuer auflösen → account_id
echo "--- Strategie 3b: Repartition Lines → account_id für 19% Steuer ---"
TAX_IDS=$(curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"call\",
    \"params\": {
      \"service\": \"object\",
      \"method\": \"execute_kw\",
      \"args\": [
        \"$ODOO_DB\", $ODOO_UID, \"$ODOO_API_KEY\",
        \"account.tax\",
        \"search\",
        [[[\"amount\", \"=\", 19], [\"type_tax_use\", \"in\", [\"sale\", \"all\"]]]]
      ]
    }
  }" | jq '.result | @json')

curl -s -X POST "$ODOO_URL/jsonrpc" \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"call\",
    \"params\": {
      \"service\": \"object\",
      \"method\": \"execute_kw\",
      \"args\": [
        \"$ODOO_DB\", $ODOO_UID, \"$ODOO_API_KEY\",
        \"account.tax.repartition.line\",
        \"search_read\",
        [[[\"tax_id\", \"in\", $TAX_IDS], [\"repartition_type\", \"=\", \"tax\"], [\"account_id\", \"!=\", false]]],
        {\"fields\": [\"id\", \"tax_id\", \"account_id\", \"factor_percent\", \"repartition_type\"]}
      ]
    }
  }" \
  | jq '.result[] | {repartition_line_id: .id, tax: .tax_id, account: .account_id, factor_percent: .factor_percent}'
echo ""

echo "========================================"
echo " → Trage die ID aus Strategie 1 oder 3b als ACCOUNT_UST_19 in deine .env ein"
echo "========================================"
