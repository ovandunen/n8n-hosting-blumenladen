/**
 * Config Loader — HelloCash Business → Odoo accounting sync.
 * Validates env; returns config for $('Config Loader').first().json.
 * ODOO_PASSWORD is required here but never included in output json.
 */

const NODE = 'Config Loader';

const REQUIRED = [
  'HELLOCASH_BASE_URL',
  'ODOO_BASE_URL',
  'ODOO_DB',
  'ODOO_UID',
  'ODOO_PASSWORD',
  'ODOO_JOURNAL_ID',
  'ACCOUNT_KASSE',
  'ACCOUNT_BANK',
  'ACCOUNT_ERLOESE',
  'ACCOUNT_GUTSCHEIN',
  'TAX_ID_19',
  'TAX_ID_7',
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

  // Reject bare ports like "8069" or "3000".
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

  // n8n Code nodes run in a sandbox where global URL may be undefined.
  // Validate with a conservative regex instead of relying on URL parsing.
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

const kasse = parseIntEnv('ACCOUNT_KASSE', $env.ACCOUNT_KASSE);
const bank = parseIntEnv('ACCOUNT_BANK', $env.ACCOUNT_BANK);
const erloese = parseIntEnv('ACCOUNT_ERLOESE', $env.ACCOUNT_ERLOESE);
const gutschein = parseIntEnv('ACCOUNT_GUTSCHEIN', $env.ACCOUNT_GUTSCHEIN);
/** Odoo tax record for 19% USt (standard); not the Austrian 20% MwSt record. */
const taxId19 = parseIntEnv('TAX_ID_19', $env.TAX_ID_19);
const taxId7 = parseIntEnv('TAX_ID_7', $env.TAX_ID_7);

/** @type {Record<string, unknown>} */
const config = {
  /** HelloCash Business API base URL and HTTP timeout (NFR-3). */
  hellocash: {
    baseUrl: String($env.HELLOCASH_BASE_URL).trim().replace(/\/+$/, ''),
    timeoutMs: 30000,
  },

  /** Odoo JSON-RPC target (password stays in $env.ODOO_PASSWORD only). */
  odoo: {
    baseUrl: (() => {
      let u = String($env.ODOO_BASE_URL).trim().replace(/\/+$/, '');
      if (u.endsWith('/jsonrpc')) u = u.replace(/\/jsonrpc$/, '');
      return u;
    })(),
    db: String($env.ODOO_DB).trim(),
    uid: parseIntEnv('ODOO_UID', $env.ODOO_UID),
    journalId: parseIntEnv('ODOO_JOURNAL_ID', $env.ODOO_JOURNAL_ID),
  },

  /** Payment bucket → { debit, credit } for Kasse/Bank/Gutschein → Erlöse. */
  accountMap: {
    CASH: { debit: kasse, credit: erloese },
    EC: { debit: bank, credit: erloese },
    CREDITCARD: { debit: bank, credit: erloese },
    VOUCHER: { debit: gutschein, credit: erloese },
  },

  /** VAT % → Odoo tax id on revenue line: 7% and 19% only (TAX_ID_7, TAX_ID_19). */
  taxMap: {
    7: taxId7,
    19: taxId19,
  },

  /** Retry policy for HTTP / RPC (NFR-3). */
  retry: {
    maxAttempts: 3,
    intervalMs: 5000,
  },

  syncHour: parseIntEnv('SYNC_HOUR', $env.SYNC_HOUR),

  errorEmail: String($env.ERROR_EMAIL).trim(),
};

return [{ json: config }];
