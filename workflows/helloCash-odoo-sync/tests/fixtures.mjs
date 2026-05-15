import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Built workflow JSON path (run \`npm run build\` first). */
export const builtWorkflowPath = path.join(__dirname, '..', 'build', 'helloCash-odoo-sync_workflow.json');

/** Minimal valid $env for Config Loader */
export const validConfigEnv = {
  HELLOCASH_BASE_URL: 'https://api.hellocash.business',
  ODOO_BASE_URL: 'https://odoo.example.com',
  ODOO_DB: 'testdb',
  ODOO_UID: '2',
  ODOO_API_KEY: 'secret',
  ODOO_JOURNAL_ID: '1',
  ACCOUNT_KASSE: '1612',
  ACCOUNT_BANK: '1200',
  ACCOUNT_ERLOESE: '1912',
  ACCOUNT_GUTSCHEIN: '2800',
  ACCOUNT_EC: '1466',
  ACCOUNT_KREDITKARTE: '1466',
  ACCOUNT_RECHNUNG: '1464',
  ACCOUNT_UST_19: '3800',
  ACCOUNT_UST_7: '3807',
  SYNC_HOUR: '2',
  ERROR_EMAIL: 'ops@example.com',
};

/** Config object shape returned by Config Loader (matches node output .json) */
export function sampleConfigJson() {
  return {
    hellocash: {
      baseUrl: 'https://api.hellocash.business',
      timeoutMs: 30000,
    },
    odoo: {
      baseUrl: 'https://odoo.example.com',
      db: 'testdb',
      uid: 2,
      journalId: 1,
      journalKasse: 101,
      journalBank: 102,
      journalVerkauf: 103,
    },
    accounts: {
      kasse: 1612,
      bank: 1200,
      erloese: 1912,
      gutschein: 2800,
      ec: 1466,
      kreditkarte: 1466,
      rechnung: 1464,
      ust19: 3800,
      ust7: 3807,
    },
    accountMap: {
      CASH: { debit: 1612, credit: 1912 },
      EC: { debit: 1466, credit: 1912 },
      CREDITCARD: { debit: 1466, credit: 1912 },
      VOUCHER: { debit: 2800, credit: 1912 },
    },
    retry: { maxAttempts: 2, intervalMs: 1 },
    syncHour: 2,
    errorEmail: 'ops@example.com',

    ACCOUNT_EC: 1466,
    ACCOUNT_KREDITKARTE: 1466,
    ACCOUNT_RECHNUNG: 1464,
    ACCOUNT_UST_19: 3800,
    ACCOUNT_UST_7: 3807,
    JOURNAL_KASSE: 101,
    JOURNAL_BANK: 102,
    JOURNAL_VERKAUF: 103,
  };
}

/** Same as sampleConfigJson but JOURNAL_BANK omitted (null) for fallback tests. */
export function sampleConfigJsonBankJournalFallback() {
  const base = sampleConfigJson();
  return {
    ...base,
    odoo: {
      ...base.odoo,
      journalBank: null,
    },
    JOURNAL_BANK: null,
  };
}

export function mockConfigLoader$(configJson = sampleConfigJson()) {
  return function mock$(name) {
    if (name === 'Config Loader') {
      return {
        first: () => ({ json: configJson }),
      };
    }
    throw new Error(`Unexpected $('${name}')`);
  };
}
