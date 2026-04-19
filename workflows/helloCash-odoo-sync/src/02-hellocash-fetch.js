/**
 * HelloCash Business — two-phase fetch (production).
 * Phase 1: GET /api/v1/cashBook (paginated limit/offset).
 * Phase 2: GET /api/v1/invoices per linked invoice number (payment + taxes).
 *
 * Env: HELLOCASH_API_TOKEN (required), HELLOCASH_LIST_PATH (default /api/v1/cashBook),
 * HELLOCASH_INVOICES_PATH (default /api/v1/invoices), HELLOCASH_DAYS_BACK (metadata only),
 * HELLOCASH_QUERY_FROM / HELLOCASH_QUERY_TO → cashbook/invoices query dateFrom & dateTo (Apiary style).
 * Cashbook/invoices use: limit, offset, search, dateFrom, dateTo, mode, showDetails (mock-aligned).
 * Optional: HELLOCASH_IGNORE_SYNC_HOUR=1, SYNC_HOUR gate via Config.
 *
 * Note: n8n Code sandbox may not define URLSearchParams — use encodeURIComponent helper below.
 */

/** @param {Record<string, string>} params */
function buildQueryString(params) {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

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

const qFrom = ($env.HELLOCASH_QUERY_FROM && String($env.HELLOCASH_QUERY_FROM).trim()) || '';
const qTo = ($env.HELLOCASH_QUERY_TO && String($env.HELLOCASH_QUERY_TO).trim()) || '';

const cashbookOffset =
  $env.HELLOCASH_CASHBOOK_OFFSET !== undefined && $env.HELLOCASH_CASHBOOK_OFFSET !== null
    ? String($env.HELLOCASH_CASHBOOK_OFFSET)
    : '0';

const cashbookQuery = buildQueryString({
  limit: String($env.HELLOCASH_CASHBOOK_LIMIT || '1000'),
  offset: cashbookOffset,
  search: String($env.HELLOCASH_CASHBOOK_SEARCH || ''),
  dateFrom: qFrom,
  dateTo: qTo,
  mode: String($env.HELLOCASH_CASHBOOK_MODE || ''),
  showDetails: String($env.HELLOCASH_CASHBOOK_SHOW_DETAILS || ''),
});

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
    const invOffset =
      $env.HELLOCASH_INVOICES_OFFSET !== undefined && $env.HELLOCASH_INVOICES_OFFSET !== null
        ? String($env.HELLOCASH_INVOICES_OFFSET)
        : '0';
    const invDateFrom =
      $env.HELLOCASH_INVOICES_DATE_FROM !== undefined && $env.HELLOCASH_INVOICES_DATE_FROM !== null
        ? String($env.HELLOCASH_INVOICES_DATE_FROM)
        : qFrom;
    const invDateTo =
      $env.HELLOCASH_INVOICES_DATE_TO !== undefined && $env.HELLOCASH_INVOICES_DATE_TO !== null
        ? String($env.HELLOCASH_INVOICES_DATE_TO)
        : qTo;

    const invQuery = buildQueryString({
      limit: String($env.HELLOCASH_INVOICES_LIMIT || '1000'),
      offset: invOffset,
      search: invNum,
      dateFrom: invDateFrom,
      dateTo: invDateTo,
      mode: String($env.HELLOCASH_INVOICES_MODE || ''),
      showDetails: String($env.HELLOCASH_INVOICES_SHOW_DETAILS || ''),
    });

    const invResponse = await this.helpers.httpRequest({
      method: 'GET',
      url: `${invoiceBaseUrl}?${invQuery}`,
      headers: authHeaders,
      timeout: config.hellocash.timeoutMs,
      json: true,
    });
    const invList = invResponse?.invoices;
    if (Array.isArray(invList) && invList.length > 0) {
      const inv =
        invList.find((x) => x && String(x.invoice_number) === String(invNum)) ?? invList[0];
      if (inv && inv.invoice_cancellation !== '1') {
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
