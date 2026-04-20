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
  ODOO_PASSWORD: 'secret',
  ODOO_JOURNAL_ID: '1',
  ACCOUNT_KASSE: '1000',
  ACCOUNT_BANK: '1200',
  ACCOUNT_ERLOESE: '8400',
  ACCOUNT_GUTSCHEIN: '2800',
  TAX_ID_19: '19',
  TAX_ID_7: '7',
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
    },
    accountMap: {
      CASH: { debit: 1000, credit: 8400 },
      EC: { debit: 1200, credit: 8400 },
      CREDITCARD: { debit: 1200, credit: 8400 },
      VOUCHER: { debit: 2800, credit: 8400 },
    },
    taxMap: { 7: 7, 19: 19 },
    retry: { maxAttempts: 2, intervalMs: 1 },
    syncHour: 2,
    errorEmail: 'ops@example.com',
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
