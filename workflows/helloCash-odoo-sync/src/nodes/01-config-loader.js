/**
 * Config Loader — HelloCash Business → Odoo accounting sync.
 * Validates env; returns config for $('Config Loader').first().json.
 * ODOO_API_KEY is required here but never included in output json.
 */

const NODE = 'Config Loader';

const REQUIRED = [
  'HELLOCASH_BASE_URL',
  'ODOO_BASE_URL',
  'ODOO_DB',
  'ODOO_UID',
  'ODOO_API_KEY',
  'ODOO_JOURNAL_ID',
  'ACCOUNT_KASSE',
  'ACCOUNT_BANK',
  'ACCOUNT_ERLOESE',
  'ACCOUNT_GUTSCHEIN',
  'SYNC_HOUR',
  'ERROR_EMAIL',
];

for (const name of REQUIRED) {
  const val = $env[name];
  if (val === undefined || val === null || String(val).trim() === '') {
    throw new Error(
      `${NODE}: required environment variable is missing or empty: ${name}. ` +
        'Set it in n8n (Settings → Variables / environment) and ensure this execution can read it.',
    );
  }
}

/** @param {string} label @param {string} urlRaw */
function validateBaseUrl(label, urlRaw) {
  const raw = String(urlRaw ?? '').trim();
  const normalized = raw.replace(/\/+$/, '');

  if (/^\d{2,5}$/.test(normalized)) {
    throw new Error(
      `${NODE}: ${label} must be a full URL, not just a port (got ${JSON.stringify(raw)}). ` +
        `Example: https://api.hellocash.com or http://host.docker.internal:8069`,
    );
  }

  const forSchemeCheck = normalized.replace(/\/jsonrpc\/?$/i, '');
  if (!/^https?:\/\//i.test(forSchemeCheck) && !forSchemeCheck.startsWith('//')) {
    throw new Error(
      `${NODE}: ${label} must start with http:// or https:// (current value: ${JSON.stringify(raw)}). ` +
        `Example (Docker → host): http://host.docker.internal:8069`,
    );
  }

  const candidate = forSchemeCheck.startsWith('//') ? `https:${forSchemeCheck}` : forSchemeCheck;
  const m = candidate.match(/^https?:\/\/([^\/?#]+)(\/|$)/i);
  const host = m ? m[1] : '';
  if (!host) {
    throw new Error(`${NODE}: ${label} is not a valid URL (got ${JSON.stringify(raw)}). Missing hostname.`);
  }

  return normalized;
}

validateBaseUrl('HELLOCASH_BASE_URL', String($env.HELLOCASH_BASE_URL));

const odooBaseRaw = String($env.ODOO_BASE_URL).trim();
const odooBaseForSchemeCheck = odooBaseRaw.replace(/\/jsonrpc\/?$/i, '').replace(/\/+$/, '');
if (!/^https?:\/\//i.test(odooBaseForSchemeCheck)) {
  throw new Error(
    `${NODE}: ODOO_BASE_URL must be a full URL starting with http:// or https:// (current value: ${JSON.stringify(odooBaseRaw)}). ` +
      'A port alone (e.g. 8069) is invalid. Example when n8n runs in Docker and Odoo is on the host: http://host.docker.internal:8069. ' +
      'If you use docker-compose, set ODOO_BASE_URL in a .env file next to docker-compose.yml (or pass --env-file), not only a bare port.',
  );
}

/** @param {string} envName @param {string | number} raw */
function parseIntEnv(envName, raw) {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${NODE}: ${envName} must be a finite integer, got: ${JSON.stringify(raw)}. ` +
        `Example: ${envName}="123"`,
    );
  }
  return n;
}

/** Optional account id: empty env → fallbackInt (e.g. ACCOUNT_BANK). */
function parseIntEnvOrFallback(envName, fallbackInt) {
  const raw = $env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallbackInt;
  return parseIntEnv(envName, raw);
}

/** Optional Odoo journal id (empty env → null; mapping node falls back to ODOO_JOURNAL_ID). */
function parseJournalIdOptional(envName) {
  const raw = $env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return parseIntEnv(envName, raw);
}

/** Optional env: integer ≥ min; ignores empty/missing env. */
function optionalIntGe(envName, defaultVal, min) {
  const raw = $env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultVal;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < min) return defaultVal;
  return n;
}

const kasse = parseIntEnv('ACCOUNT_KASSE', $env.ACCOUNT_KASSE);
const bank = parseIntEnv('ACCOUNT_BANK', $env.ACCOUNT_BANK);
const erloese = parseIntEnv('ACCOUNT_ERLOESE', $env.ACCOUNT_ERLOESE);
const gutschein = parseIntEnv('ACCOUNT_GUTSCHEIN', $env.ACCOUNT_GUTSCHEIN);
const accountEc = parseIntEnvOrFallback('ACCOUNT_EC', bank);
const accountKreditkarte = parseIntEnvOrFallback('ACCOUNT_KREDITKARTE', bank);
const accountRechnung = parseIntEnvOrFallback('ACCOUNT_RECHNUNG', bank);

const journalDefault = parseIntEnv('ODOO_JOURNAL_ID', $env.ODOO_JOURNAL_ID);
const journalKasse = parseJournalIdOptional('JOURNAL_KASSE');
const journalBank = parseJournalIdOptional('JOURNAL_BANK');
const journalVerkauf = parseJournalIdOptional('JOURNAL_VERKAUF');

/** @type {Record<string, unknown>} */
const config = {
  hellocash: {
    baseUrl: String($env.HELLOCASH_BASE_URL).trim().replace(/\/+$/, ''),
    timeoutMs: 30000,
  },

  odoo: {
    baseUrl: (() => {
      let u = String($env.ODOO_BASE_URL).trim().replace(/\/+$/, '');
      if (u.endsWith('/jsonrpc')) u = u.replace(/\/jsonrpc$/, '');
      return u;
    })(),
    db: String($env.ODOO_DB).trim(),
    uid: parseIntEnv('ODOO_UID', $env.ODOO_UID),
    journalId: journalDefault,
    /** Type-specific journals; null when unset — Map to Odoo falls back to journalId. */
    journalKasse,
    journalBank,
    journalVerkauf,
  },

  /** Odoo account.account ids for HelloCash payment routing (legacy + new). */
  accounts: {
    kasse,
    bank,
    erloese,
    gutschein,
    ec: accountEc,
    kreditkarte: accountKreditkarte,
    rechnung: accountRechnung,
  },

  /**
   * Legacy bucket map (withdrawals / tooling). Revenue posting routes by invoice_payment in Map to Odoo.
   */
  accountMap: {
    CASH: { debit: kasse, credit: erloese },
    EC: { debit: accountEc, credit: erloese },
    CREDITCARD: { debit: accountKreditkarte, credit: erloese },
    VOUCHER: { debit: gutschein, credit: erloese },
  },

  retry: {
    maxAttempts: optionalIntGe('SYNC_RPC_MAX_ATTEMPTS', 2, 1),
    intervalMs: optionalIntGe('SYNC_RPC_RETRY_INTERVAL_MS', 2500, 250),
  },

  syncHour: parseIntEnv('SYNC_HOUR', $env.SYNC_HOUR),

  errorEmail: String($env.ERROR_EMAIL).trim(),

  /** Flat copies for operators / downstream (same values as accounts.* / odoo.journal*). */
  ACCOUNT_EC: accountEc,
  ACCOUNT_KREDITKARTE: accountKreditkarte,
  ACCOUNT_RECHNUNG: accountRechnung,
  JOURNAL_KASSE: journalKasse,
  JOURNAL_BANK: journalBank,
  JOURNAL_VERKAUF: journalVerkauf,
};

return [{ json: config }];
