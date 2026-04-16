/**
 * Config Loader — helloCash → Odoo sync.
 * Reads n8n environment variables and emits one structured config item for downstream nodes.
 */

// --- Required environment variables (fail fast with clear errors) ---
const REQUIRED_ENV_VARS = [
  'HELLOCASH_BASE_URL',
  'ODOO_BASE_URL',
  'ODOO_DB',
  'ODOO_UID',
  'ODOO_JOURNAL_ID',
  'ACCOUNT_KASSE',
  'ACCOUNT_BANK',
  'ACCOUNT_ERLOESE',
  'ACCOUNT_GUTSCHEIN',
  'ACCOUNT_UST_19',
  'ACCOUNT_UST_7',
  'TAX_ID_19',
  'TAX_ID_7',
  'SYNC_HOUR',
  'ERROR_EMAIL',
];

for (const name of REQUIRED_ENV_VARS) {
  const raw = $env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error(
      `Config Loader: required environment variable is missing or empty: ${name}. ` +
        'Set it in n8n (Settings → Variables / environment) and ensure this execution can read it.',
    );
  }
}

/**
 * @param {Date} date
 * @returns {string} ISO-like calendar date YYYY-MM-DD (local timezone of the runtime)
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {string} envName
 * @param {string | number} raw
 * @returns {number}
 */
function parseIntEnv(envName, raw) {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Config Loader: ${envName} must be a finite integer (parseInt), got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

const kasse = parseIntEnv('ACCOUNT_KASSE', $env.ACCOUNT_KASSE);
const bank = parseIntEnv('ACCOUNT_BANK', $env.ACCOUNT_BANK);
const erloese = parseIntEnv('ACCOUNT_ERLOESE', $env.ACCOUNT_ERLOESE);
const gutschein = parseIntEnv('ACCOUNT_GUTSCHEIN', $env.ACCOUNT_GUTSCHEIN);
const ust19 = parseIntEnv('ACCOUNT_UST_19', $env.ACCOUNT_UST_19);
const ust7 = parseIntEnv('ACCOUNT_UST_7', $env.ACCOUNT_UST_7);
const taxId19 = parseIntEnv('TAX_ID_19', $env.TAX_ID_19);
const taxId7 = parseIntEnv('TAX_ID_7', $env.TAX_ID_7);

const config = {
  /**
   * HelloCash: base URL and HTTP client timeout (NFR-3: 30s).
   * Used for API calls that fetch sales / receipts from helloCash.
   */
  hellocash: {
    baseUrl: String($env.HELLOCASH_BASE_URL).trim().replace(/\/+$/, ''),
    timeoutMs: 30000,
  },

  /**
   * Odoo: server URL, database, authenticated user, sales journal, and VAT control accounts.
   * journalId targets the journal for posted moves; UST accounts support tax lines if needed downstream.
   */
  odoo: {
    baseUrl: String($env.ODOO_BASE_URL).trim().replace(/\/+$/, ''),
    db: String($env.ODOO_DB).trim(),
    uid: parseIntEnv('ODOO_UID', $env.ODOO_UID),
    journalId: parseIntEnv('ODOO_JOURNAL_ID', $env.ODOO_JOURNAL_ID),
    accountUst19: ust19,
    accountUst7: ust7,
  },

  /**
   * accountMap: per payment method, Odoo account IDs for move lines (debit / credit).
   * CASH → Kasse / Erlöse; EC & card → Bank / Erlöse; VOUCHER → Gutschein / Erlöse.
   */
  accountMap: {
    CASH: { debit: kasse, credit: erloese },
    EC: { debit: bank, credit: erloese },
    CREDITCARD: { debit: bank, credit: erloese },
    VOUCHER: { debit: gutschein, credit: erloese },
  },

  /**
   * taxMap: standard German VAT rates (percent) → Odoo tax record IDs for tax_ids on lines.
   */
  taxMap: {
    19: taxId19,
    7: taxId7,
  },

  /**
   * retry: backoff policy for transient failures (NFR-3: max 3 attempts, 5 min between attempts).
   */
  retry: {
    maxAttempts: 3,
    intervalMs: 300000,
  },

  /**
   * syncHour: preferred hour (0–23) for scheduled sync windows.
   */
  syncHour: parseIntEnv('SYNC_HOUR', $env.SYNC_HOUR),

  /**
   * errorEmail: destination for operational / failure notifications from the workflow.
   */
  errorEmail: String($env.ERROR_EMAIL).trim(),
};

// Expose formatter for any extra logic you add in this same node (not serialized on json output).
void formatDate;

return [{ json: config }];
