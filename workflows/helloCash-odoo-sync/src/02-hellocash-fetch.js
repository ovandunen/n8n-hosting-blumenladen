/**
 * HelloCash Business — two-phase fetch (production).
 * Phase 1: GET /api/v1/cashBook (paginated limit/offset).
 * Phase 2: GET /api/v1/invoices per linked invoice number (payment + taxes).
 *
 * Env: HELLOCASH_API_TOKEN (required), HELLOCASH_LIST_PATH (default /api/v1/cashBook),
 * HELLOCASH_INVOICES_PATH (default /api/v1/invoices), HELLOCASH_DAYS_BACK (info only unless query vars set),
 * HELLOCASH_QUERY_FROM / HELLOCASH_QUERY_TO (optional YYYY-MM-DD added to cashbook query if set).
 * Optional: HELLOCASH_IGNORE_SYNC_HOUR=1, SYNC_HOUR gate via Config.
 */

const config = $('Config Loader').first().json;
const token = $env.HELLOCASH_API_TOKEN?.trim();
if (!token) {
  throw new Error('HelloCash Fetch: HELLOCASH_API_TOKEN missing');
}

const ignoreHour =
  $env.HELLOCASH_IGNORE_SYNC_HOUR === '1' ||
  String($env.HELLOCASH_IGNORE_SYNC_HOUR || '').toLowerCase() === 'true';
const hour = new Date().getHours();
if (!ignoreHour && hour !== config.syncHour) {
  return [
    {
      json: {
        skipped: true,
        reason: 'sync_hour',
        syncHour: config.syncHour,
        currentHour: hour,
      },
    },
  ];
}

const baseUrl = config.hellocash.baseUrl.replace(/\/+$/, '');
const listPath = ($env.HELLOCASH_LIST_PATH && String($env.HELLOCASH_LIST_PATH).trim()) || '/api/v1/cashBook';
const invoicesPath =
  ($env.HELLOCASH_INVOICES_PATH && String($env.HELLOCASH_INVOICES_PATH).trim()) || '/api/v1/invoices';
const daysBack = parseInt(String($env.HELLOCASH_DAYS_BACK || '1'), 10);

const cashbookQuery = new URLSearchParams({ limit: '1000', offset: '0' });
const qFrom = $env.HELLOCASH_QUERY_FROM && String($env.HELLOCASH_QUERY_FROM).trim();
const qTo = $env.HELLOCASH_QUERY_TO && String($env.HELLOCASH_QUERY_TO).trim();
if (qFrom) cashbookQuery.set('from', qFrom);
if (qTo) cashbookQuery.set('to', qTo);

const pathNorm = listPath.startsWith('/') ? listPath : `/${listPath}`;
const cashbookUrl = `${baseUrl}${pathNorm}?${cashbookQuery}`;

const invPathNorm = invoicesPath.startsWith('/') ? invoicesPath : `/${invoicesPath}`;
const invoiceBaseUrl = `${baseUrl}${invPathNorm}`;

const { maxAttempts, intervalMs } = config.retry;
/** @type {Record<string, string>} */
const authHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
};

let lastErr;
/** @type {unknown} */
let cashbookResponse;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    cashbookResponse = await this.helpers.httpRequest({
      method: 'GET',
      url: cashbookUrl,
      headers: authHeaders,
      timeout: config.hellocash.timeoutMs,
      json: true,
    });
    lastErr = undefined;
    break;
  } catch (e) {
    lastErr = e;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
}
if (cashbookResponse === undefined) {
  throw lastErr || new Error('Cashbook fetch failed after retries');
}

const rawEntries =
  cashbookResponse && typeof cashbookResponse === 'object' && 'entries' in cashbookResponse
    ? cashbookResponse.entries
    : [];
const entries = Array.isArray(rawEntries) ? rawEntries : [];
if (entries.length === 0) {
  return [{ json: { skipped: false, empty: true, message: 'No cashbook entries' } }];
}

const invoiceNumbers = [
  ...new Set(
    entries
      .filter(
        (e) =>
          e &&
          typeof e === 'object' &&
          e.cashBook_invoice_number &&
          String(e.cashBook_invoice_number) !== '0' &&
          e.cashBook_cancellation !== '1',
      )
      .map((e) => String(/** @type {{ cashBook_invoice_number: string }} */ (e).cashBook_invoice_number)),
  ),
];

const invoicesMap = new Map();

for (const invNum of invoiceNumbers) {
  try {
    const invQuery = new URLSearchParams({ number: invNum, limit: '1', offset: '0' });
    const invResponse = await this.helpers.httpRequest({
      method: 'GET',
      url: `${invoiceBaseUrl}?${invQuery}`,
      headers: authHeaders,
      timeout: config.hellocash.timeoutMs,
      json: true,
    });
    const invList = invResponse?.invoices;
    if (Array.isArray(invList) && invList.length > 0) {
      const inv = invList[0];
      if (inv.invoice_cancellation !== '1') {
        invoicesMap.set(invNum, inv);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`HelloCash Fetch: failed to fetch invoice ${invNum}: ${msg}`);
  }
}

return [
  {
    json: {
      skipped: false,
      hellocashData: {
        entries,
        invoices: Object.fromEntries(invoicesMap),
        meta: {
          fetchedAt: new Date().toISOString(),
          entryCount: entries.length,
          invoiceCount: invoicesMap.size,
          daysBack: Number.isFinite(daysBack) ? daysBack : 1,
        },
      },
    },
  },
];
