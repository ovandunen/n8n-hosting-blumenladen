/**
 * HelloCash Business — bulk fetch (production).
 * Primary: GET `/api/v1/invoices` (invoice documents with `taxes[]` / rates when the API provides them), paginated with limit/offset and optional dateFrom/dateTo.
 * Response rows are `.invoices` and/or `.entries` (same extraction for both). Skips cancelled rows. Output: hellocashData.entries + hellocashData.invoices index by invoice number.
 *
 * Kassenbuch (`/api/v1/cashBook`) does not carry VAT breakdown; this node does not use it as the primary source so tax-aware posting matches the invoices API.
 *
 * Env: HELLOCASH_API_TOKEN (required). Paths are fixed in this node (not env).
 * HELLOCASH_BASE_URL may be origin-only or include /api/v1 — overlapping path segments are merged.
 * HELLOCASH_QUERY_FROM / HELLOCASH_QUERY_TO → dateFrom & dateTo.
 * Pagination: HELLOCASH_CASHBOOK_LIMIT / HELLOCASH_CASHBOOK_OFFSET / HELLOCASH_CASHBOOK_MAX_PAGES (legacy names; same as invoice list).
 * Optional: HELLOCASH_IGNORE_SYNC_HOUR=1, SYNC_HOUR gate via Config.
 */

const NODE = 'HelloCash Fetch';

/**
 * Only include query keys that are actually set (not null/undefined; strings non-empty after trim).
 * @param {unknown} v
 */
function queryParamHasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/** @param {Record<string, string | number | boolean>} params */
function buildQueryString(params) {
  return Object.keys(params)
    .filter((k) => queryParamHasValue(params[k]))
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

/**
 * Merge HELLOCASH_BASE_URL with an absolute path without duplicating shared segments.
 * e.g. base https://host/api/v1 + path /api/v1/invoices → https://host/api/v1/invoices
 * Protocol-relative bases (//host/...) are normalized to https://host/...
 *
 * @param {string} baseUrlRaw
 * @param {string} pathRaw absolute path, e.g. /api/v1/invoices
 */
function joinBaseUrlAndPath(baseUrlRaw, pathRaw) {
  let baseStr = String(baseUrlRaw || '').trim();
  if (baseStr.startsWith('//')) baseStr = `https:${baseStr}`;
  baseStr = baseStr.replace(/\/+$/, '');

  const relPath = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;

  // n8n Code nodes run in a sandbox where global URL may be undefined.
  // Parse scheme/host/path conservatively using regex.
  const m = baseStr.match(/^(https?:\/\/[^\/?#]+)(\/[^?#]*)?$/i);
  if (!m) {
    return `${baseStr}${relPath}`;
  }
  const origin = m[1];
  const basePath = String(m[2] || '').replace(/\/+$/, '');
  const baseSegs = basePath.split('/').filter(Boolean);
  const pathSegs = relPath.split('/').filter(Boolean);

  let overlap = 0;
  const max = Math.min(baseSegs.length, pathSegs.length);
  for (let k = max; k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (baseSegs[baseSegs.length - k + i] !== pathSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      overlap = k;
      break;
    }
  }

  const remainder = pathSegs.slice(overlap);
  const mergedSegs = [...baseSegs, ...remainder];
  return `${origin}/${mergedSegs.join('/')}`.replace(/\/+$/, '');
}

/**
 * n8n httpRequest: omit null/undefined options (some versions reject explicit nulls).
 * @param {Record<string, unknown>} opts
 */
function httpRequestOpts(opts) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Drop null/undefined and empty strings from nested objects for logs (avoid "parameters" with no value).
 * @param {unknown} value
 */
function compactForDisplay(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const arr = value.map(compactForDisplay).filter((x) => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactForDisplay(v);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/**
 * One or two sentences an operator can act on (not only raw status/body).
 * @param {string|number} status
 * @param {{ name?: string, code?: string, httpCode?: string, message?: string, description?: string }} hint
 * @param {string} bodyStr
 */
function deriveFailureExplanation(status, hint, bodyStr) {
  const code = String(hint?.code ?? '');
  const msg = String(hint?.message ?? hint?.description ?? '');
  const statusNum = typeof status === 'number' ? status : parseInt(String(status), 10);
  const body = String(bodyStr ?? '');
  const combined = `${msg} ${code} ${body}`.toLowerCase();

  const parts = [];

  if (Number.isFinite(statusNum)) {
    if (statusNum === 401 || statusNum === 403) {
      parts.push(
        'The API rejected authentication/authorization — verify HELLOCASH_API_TOKEN and that HELLOCASH_BASE_URL matches the environment where that token is valid.',
      );
    } else if (statusNum === 404) {
      parts.push(
        'The server returned 404 — check HELLOCASH_BASE_URL (HelloCash paths are /api/v1/cashBook and /api/v1/invoices).',
      );
    } else if (statusNum === 400 || statusNum === 422) {
      parts.push(
        'The server rejected the request parameters — review date/search/limit/offset env vars against the API contract.',
      );
    } else if (statusNum === 429) {
      parts.push('Rate limited (429) — retry later or reduce call volume.');
    } else if (statusNum >= 500 && statusNum < 600) {
      parts.push(
        `Server error (${statusNum}) — HelloCash may be unavailable; retry later or check their service status.`,
      );
    } else if (statusNum >= 200 && statusNum < 300) {
      parts.push(
        'HTTP status looks successful but the client still failed — the body may not be JSON while json:true is set, or the client threw for another reason.',
      );
    }
  }

  if (status === 'no-status' || !Number.isFinite(statusNum)) {
    if (/enotfound|getaddrinfo|eai_again/i.test(combined) || code === 'ENOTFOUND') {
      parts.push('DNS or hostname resolution failed — check HELLOCASH_BASE_URL and network/DNS.');
    }
    if (/econnrefused/i.test(combined) || code === 'ECONNREFUSED') {
      parts.push('Connection refused — wrong host/port, service not listening, or firewall.');
    }
    if (/etimedout|esockettimedout|timeout/i.test(combined) || /timeout/i.test(code)) {
      parts.push('Request timed out — increase HelloCash timeout in config, or check network/API availability.');
    }
    if (/cert|ssl|tls|unable_to_verify/i.test(combined)) {
      parts.push('TLS/certificate error — check HTTPS URL, proxy, or corporate TLS inspection.');
    }
  }

  if (/unexpected token|not valid json|invalid json|json parse/i.test(combined)) {
    parts.push('Response was not valid JSON — wrong URL often returns HTML or an error page instead of the API.');
  }
  if (/<!doctype html|<html/i.test(body)) {
    parts.push('Body looks like HTML — usually wrong API URL, redirect to a web login, or a gateway error page.');
  }

  if (parts.length === 0) {
    parts.push(
      'Could not infer a specific cause from status/body — use HTTP status, hint fields, and response snippet below.',
    );
  }

  return parts.join(' ');
}

/**
 * Best-effort HTTP status from n8n httpRequest / axios / nested cause chain.
 * @param {unknown} e
 */
function resolveHttpStatus(e) {
  /** @param {unknown} x */
  const asStatus = (x) => {
    if (x === undefined || x === null || x === '') return undefined;
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    const n = parseInt(String(x), 10);
    if (Number.isFinite(n)) return n;
    if (typeof x === 'string') return x.trim() || undefined;
    return undefined;
  };

  let cur = e;
  for (let d = 0; d < 6 && cur != null; d++) {
    if (typeof cur !== 'object') break;
    const o = /** @type {Record<string, unknown>} */ (cur);
    const u =
      asStatus(o.response?.status) ??
      asStatus(o.response?.statusCode) ??
      asStatus(
        o.error && typeof o.error === 'object'
          ? /** @type {{ status?: unknown, statusCode?: unknown }} */ (o.error).status ??
              /** @type {{ status?: unknown, statusCode?: unknown }} */ (o.error).statusCode ??
              undefined
          : undefined,
      ) ??
      asStatus(o.httpCode) ??
      asStatus(o.statusCode) ??
      asStatus(o.status);
    if (u !== undefined) return u;
    cur = o.cause;
  }

  const msg = String(
    (typeof e === 'object' && e && 'message' in e && /** @type {{ message: unknown }} */ (e).message) || '',
  );
  const m =
    msg.match(/\bstatus code\s+(\d{3})\b/i) ??
    msg.match(/\bHTTP\s+(\d{3})\b/) ??
    msg.match(/^\s*(\d{3})\s/);
  if (m) return parseInt(m[1], 10);

  return 'no-status';
}

/**
 * n8n httpRequest errors are often NodeApiError / wrapped request errors — not always axios-shaped (e.response).
 */
function extractHttpFailureDetails(e) {
  const status = resolveHttpStatus(e);

  let body =
    e?.response?.data ??
    e?.response?.body ??
    e?.error ??
    e?.description ??
    (Array.isArray(e?.messages) ? e.messages.join('; ') : e?.messages);

  if ((body === undefined || body === null || body === '') && e?.cause) {
    const c = e.cause;
    body =
      c?.response?.data ??
      c?.response?.body ??
      c?.message ??
      (typeof c === 'string' ? c : undefined);
  }

  let bodyStr = 'no body';
  if (body !== undefined && body !== null && body !== '') {
    bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  }

  const hint = {
    name: e?.name,
    code: e?.code,
    httpCode: e?.httpCode,
    description: e?.description,
    message: e?.message,
    stack: typeof e?.stack === 'string' ? e.stack : undefined,
    errorKeys: e && typeof e === 'object' ? Object.keys(e) : [],
  };

  /** @param {unknown} err @param {number} depth */
  function shallowDump(err, depth) {
    if (err == null) return null;
    if (typeof err !== 'object') return String(err);
    const o = {};
    try {
      for (const k of Object.getOwnPropertyNames(err)) {
        try {
          let v = /** @type {object} */ (err)[k];
          if (v && typeof v === 'object' && depth < 2) {
            v = shallowDump(v, depth + 1);
          }
          if (typeof v === 'string' && v.length > 4000) v = v.slice(0, 4000) + '…';
          o[k] = v;
        } catch {
          o[k] = '[unreadable]';
        }
      }
    } catch {
      return '[dump failed]';
    }
    return o;
  }

  const rawDump = shallowDump(e, 0);
  let causeChain = [];
  let c = e?.cause;
  let depth = 0;
  while (c != null && depth < 5) {
    causeChain.push({
      depth,
      message: c?.message ?? String(c),
      name: c?.name,
      stack: typeof c?.stack === 'string' ? c.stack.slice(0, 2000) : undefined,
    });
    c = c?.cause;
    depth++;
  }

  return { status, bodyStr, hint, rawDump, causeChain };
}

/** Mask secret for logs (never log full token). */
function maskToken(t) {
  const s = String(t || '');
  if (!s) return '(empty)';
  if (s.length <= 8) return `${s.slice(0, 2)}…(${s.length} chars)`;
  return `${s.slice(0, 4)}…${s.slice(-2)} (len=${s.length})`;
}

function safeJson(obj, space) {
  try {
    return JSON.stringify(obj, null, space);
  } catch {
    return '[JSON.stringify failed — possibly circular]';
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Exponential backoff with jitter.
 * @param {number} attempt 1..n
 * @param {number} baseMs
 * @param {number} maxMs
 */
function backoffDelayMs(attempt, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(250, exp * 0.1));
  return exp + jitter;
}

/**
 * Simple circuit breaker: after N consecutive failures, stop for cooldownMs.
 */
function createCircuitBreaker({ failureThreshold, cooldownMs }) {
  let consecutive = 0;
  let openUntil = 0;
  return {
    /** @param {string} op */
    assertClosed(op) {
      const now = Date.now();
      if (openUntil && now < openUntil) {
        const remainingMs = openUntil - now;
        throw new Error(
          `${NODE}: circuit breaker OPEN for ${op} (cooldown ${Math.ceil(remainingMs / 1000)}s remaining). ` +
            `Too many consecutive failures; check HelloCash availability and configuration before retrying.`,
        );
      }
    },
    success() {
      consecutive = 0;
      openUntil = 0;
    },
    failure() {
      consecutive++;
      if (consecutive >= failureThreshold) {
        openUntil = Date.now() + cooldownMs;
      }
    },
  };
}

const config = $('Config Loader').first().json;
const token = $env.HELLOCASH_API_TOKEN?.trim();
if (!token) {
  throw new Error(
    `${NODE}: HELLOCASH_API_TOKEN missing. Example: HELLOCASH_API_TOKEN="eyJhbGciOi..." (do not paste into logs).`,
  );
}

const ignoreHour =
  $env.HELLOCASH_IGNORE_SYNC_HOUR === '1' ||
  String($env.HELLOCASH_IGNORE_SYNC_HOUR || '').toLowerCase() === 'true';
const hour = new Date().getHours();
const syncHour = parseInt(String(config.syncHour), 10);
if (!Number.isFinite(syncHour)) {
  throw new Error(`${NODE}: config.syncHour is invalid (expected integer), got: ${JSON.stringify(config.syncHour)}`);
}
if (!ignoreHour && hour !== syncHour) {
  return [
    {
      json: {
        skipped: true,
        reason: 'sync_hour',
        syncHour,
        currentHour: hour,
      },
    },
  ];
}

let baseUrl = String(config.hellocash.baseUrl || '')
  .trim()
  .replace(/\/+$/, '');
if (baseUrl.startsWith('//')) baseUrl = `https:${baseUrl}`;

/** HelloCash Business API paths (fixed; join with HELLOCASH_BASE_URL). */
const HELLOCASH_PATH_CASHBOOK = '/api/v1/cashBook';
const HELLOCASH_PATH_INVOICES = '/api/v1/invoices';

const daysBack = parseInt(String($env.HELLOCASH_DAYS_BACK || '1'), 10);

function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const today = new Date();
const fromDate = new Date(today);
fromDate.setDate(today.getDate() - daysBack);

const qFromRaw = $env.HELLOCASH_QUERY_FROM && String($env.HELLOCASH_QUERY_FROM).trim();
const qFrom = qFromRaw ? qFromRaw : toDateString(fromDate);

const qToRaw = $env.HELLOCASH_QUERY_TO && String($env.HELLOCASH_QUERY_TO).trim();
const qTo = qToRaw ? qToRaw : toDateString(today);

const listOffsetRaw =
  $env.HELLOCASH_CASHBOOK_OFFSET !== undefined && $env.HELLOCASH_CASHBOOK_OFFSET !== null
    ? String($env.HELLOCASH_CASHBOOK_OFFSET)
    : $env.HELLOCASH_INVOICES_OFFSET !== undefined && $env.HELLOCASH_INVOICES_OFFSET !== null
      ? String($env.HELLOCASH_INVOICES_OFFSET)
      : '0';

const listUrlNoQuery = joinBaseUrlAndPath(baseUrl, HELLOCASH_PATH_INVOICES);

if (!String(baseUrl || '').trim()) {
  throw new Error(
    'HelloCash Fetch: config.hellocash.baseUrl is empty. Re-run Config Loader and set HELLOCASH_BASE_URL (non-empty).',
  );
}

const { maxAttempts, intervalMs } = config.retry;
/** @type {Record<string, string>} */
const authHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
};

/**
 * Invoice list from GET …/invoices: Apiary/docs use `invoices`; live responses may use `entries` for the same array.
 * @param {unknown} res
 */
function invoiceListFromResponse(res) {
  if (!res || typeof res !== 'object') return [];
  const o = /** @type {Record<string, unknown>} */ (res);
  if (Array.isArray(o.invoices)) return o.invoices;
  if (Array.isArray(o.entries)) return o.entries;
  const data = o.data;
  if (data && typeof data === 'object') {
    const d = /** @type {Record<string, unknown>} */ (data);
    if (Array.isArray(d.invoices)) return d.invoices;
    if (Array.isArray(d.entries)) return d.entries;
  }
  return [];
}

/** @param {unknown} inv */
function looksLikeCashBookRow(inv) {
  if (!inv || typeof inv !== 'object') return false;
  const o = /** @type {Record<string, unknown>} */ (inv);
  return 'cashBook_total' in o || 'cashBook_id' in o || 'cashBook_invoice_number' in o;
}

/** @param {unknown} inv */
function hasUsableTaxBreakdown(inv) {
  if (!inv || typeof inv !== 'object') return false;
  const o = /** @type {Record<string, unknown>} */ (inv);
  if (!Array.isArray(o.taxes) || o.taxes.length === 0) return false;
  for (const tx of o.taxes) {
    if (!tx || typeof tx !== 'object') continue;
    const t = /** @type {Record<string, unknown>} */ (tx);
    const net = t.tax_net;
    const tax = t.tax_tax;
    if (net !== null && net !== undefined && String(net).trim() !== '') return true;
    if (tax !== null && tax !== undefined && String(tax).trim() !== '') return true;
  }
  return false;
}

/** Stable key for hellocashData.invoices (number preferred, else id). */
function invoiceRecordKey(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const o = /** @type {Record<string, unknown>} */ (inv);
  const num = String(
    o.invoice_number ??
      o.invoiceNumber ??
      o.number ??
      o.document_number ??
      o.documentNumber ??
      o.cashBook_invoice_number ??
      '',
  ).trim();
  if (num && num !== '0') return num;
  const id = String(
    o.invoice_id ?? o.invoiceId ?? o.invoice_uid ?? o.uid ?? o.cashBook_id ?? o.id ?? '',
  ).trim();
  return id;
}

/** @param {unknown} inv */
function skipCancelledListRow(inv) {
  if (!inv || typeof inv !== 'object') return true;
  const o = /** @type {Record<string, unknown>} */ (inv);
  if (o.invoice_cancellation === '1') return true;
  if (o.cashBook_cancellation === '1') return true;
  return false;
}

const breaker = createCircuitBreaker({
  failureThreshold: parseInt(String($env.HELLOCASH_CB_FAILURE_THRESHOLD || '4'), 10) || 4,
  cooldownMs: parseInt(String($env.HELLOCASH_CB_COOLDOWN_MS || '120000'), 10) || 120000,
});

/**
 * HTTP GET with retry/backoff and circuit breaker.
 * @param {{ url: string, timeoutMs: number, op: string }} p
 */
const getJsonWithRetry = async ({ url, timeoutMs, op }) => {
  let lastError = null;
  /** @type {object[]} */
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = nowIso();
    try {
      breaker.assertClosed(op);
      const res = await this.helpers.httpRequest(
        httpRequestOpts({
          method: 'GET',
          url,
          headers: authHeaders,
          timeout: timeoutMs,
          json: true,
        }),
      );
      breaker.success();
      return { ok: true, res, attempts };
    } catch (e) {
      breaker.failure();
      const { status, bodyStr, hint, rawDump, causeChain } = extractHttpFailureDetails(e);
      const hintCompact = compactForDisplay(hint) ?? {};
      const failureExplanation = deriveFailureExplanation(status, hint, bodyStr);
      attempts.push({
        attempt,
        of: maxAttempts,
        at: startedAt,
        op,
        httpStatus: status,
        failureExplanation,
        url,
        request: {
          method: 'GET',
          timeoutMs,
          accept: authHeaders.Accept,
          authorization: `Bearer ${maskToken(token)}`,
        },
        responseBody: bodyStr,
        hint: hintCompact,
        rawDump,
        causeChain,
      });
      lastError = e;
      console.error(`${NODE}: ${op} failed — attempt detail`, attempts[attempts.length - 1]);
      if (attempt < maxAttempts) {
        const delay = backoffDelayMs(attempt, intervalMs, 30000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return { ok: false, res: null, attempts, lastError };
};

let lastErr;
/** @type {unknown} */
let listResponse;
/** @type {object[]} */
const listAttemptHistory = [];

const listLimit = Math.max(1, parseInt(String($env.HELLOCASH_CASHBOOK_LIMIT || $env.HELLOCASH_INVOICES_LIMIT || '1000'), 10) || 1000);
const listOffsetStart = Math.max(0, parseInt(String(listOffsetRaw || '0'), 10) || 0);
const maxListPages = Math.max(
  1,
  parseInt(String($env.HELLOCASH_CASHBOOK_MAX_PAGES || $env.HELLOCASH_INVOICES_MAX_PAGES || '50'), 10) || 50,
);

/** @type {object[]} */
const allInvoices = [];
let pageOffset = listOffsetStart;
for (let page = 1; page <= maxListPages; page++) {
  const pageQuery = buildQueryString({
    limit: String(listLimit),
    offset: String(pageOffset),
    dateFrom: qFrom,
    dateTo: qTo,
  });
  const pageUrl = pageQuery ? `${listUrlNoQuery}?${pageQuery}` : listUrlNoQuery;

  const { ok, res, attempts, lastError } = await getJsonWithRetry({
    url: pageUrl,
    timeoutMs: config.hellocash.timeoutMs,
    op: `invoices GET page=${page} offset=${pageOffset} limit=${listLimit}`,
  });
  listAttemptHistory.push(...attempts);
  if (!ok) {
    lastErr = lastError instanceof Error ? lastError : new Error(String(lastError || 'unknown error'));
    listResponse = undefined;
    break;
  }

  listResponse = res;
  const pageInvoices = invoiceListFromResponse(res);
  if (pageInvoices.length === 0) break;

  for (const inv of pageInvoices) {
    if (!inv || typeof inv !== 'object') continue;
    if (skipCancelledListRow(inv)) continue;
    allInvoices.push(inv);
  }

  if (pageInvoices.length < listLimit) break;
  pageOffset += listLimit;
}

if (listResponse === undefined) {
  const lastAtt =
    listAttemptHistory.length > 0 ? listAttemptHistory[listAttemptHistory.length - 1] : {};

  const lastHttp = lastAtt.httpStatus ?? lastAtt.status ?? 'no-status';

  const bodyOneLine = String(lastAtt.responseBody ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const hintMsg = lastAtt.hint?.message ?? lastAtt.hint?.description ?? 'n/a';
  const hintCode = lastAtt.hint?.code ?? lastAtt.hint?.httpCode ?? 'n/a';
  const failureExplanation =
    lastAtt.failureExplanation ?? deriveFailureExplanation(lastHttp, lastAtt.hint ?? {}, bodyOneLine);

  const diagnostic = {
    phase: 'invoices GET',
    httpStatus: lastHttp,
    nodeErrorCode: hintCode,
    failureExplanation,
    failedAfterAttempts: maxAttempts,
    retryIntervalMs: intervalMs,
    clock: { hour, syncHour: config.syncHour, ignoreSyncHour: ignoreHour },
    token: maskToken(token),
    listUrl: listUrlNoQuery,
    apiPaths: {
      cashBook: HELLOCASH_PATH_CASHBOOK,
      invoices: HELLOCASH_PATH_INVOICES,
    },
    attemptHistory: listAttemptHistory,
    lastErrorMessage: lastErr?.message ?? 'unknown',
    lastErrorStack: lastErr?.stack ?? 'no stack',
  };

  const diagnosticJson = safeJson(diagnostic, 2);

  console.error('HelloCash invoices — FINAL FAILURE (all attempts exhausted)', {
    httpStatus: lastHttp,
    nodeErrorCode: hintCode,
    ...diagnostic,
  });

  const explainOneLine = String(failureExplanation).replace(/\s+/g, ' ').trim().slice(0, 280);

  const httpStatusStr =
    lastHttp !== undefined && lastHttp !== null && lastHttp !== 'no-status'
      ? `HTTP ${lastHttp}`
      : 'HTTP status unknown (no response — network/DNS/TLS/wrong URL?)';

  const errorFirstLine =
    `${httpStatusStr} | nodeErrorCode=${hintCode} | HelloCash invoices GET failed | ${explainOneLine} | ${hintMsg} | URL=${listUrlNoQuery} | body=${bodyOneLine || '(empty)'}`;

  const msg =
    `${errorFirstLine}\n` +
    `\n` +
    `--- CONTEXT ---\n` +
    `httpStatus: ${lastHttp}  nodeErrorCode: ${hintCode}\n` +
    `listUrl: ${listUrlNoQuery}\n` +
    `timeoutMs: ${config.hellocash.timeoutMs}  retryIntervalMs: ${intervalMs}\n` +
    `token (masked): ${maskToken(token)}\n` +
    `syncHour: ${config.syncHour}  currentHour: ${hour}  ignoreSyncHour: ${ignoreHour}\n` +
    `--- DIAGNOSTIC JSON ---\n` +
    diagnosticJson;

  const err = new Error(msg);
  err.diagnostic = diagnostic;
  err.attemptHistory = listAttemptHistory;
  throw err;
}

const entries = allInvoices;
if (entries.length === 0) {
  return [{ json: { skipped: false, empty: true, message: 'No HelloCash entries (after filtering cancellations)' } }];
}

/** @type {Record<string, object>} */
const invoicesRecord = {};
for (const inv of entries) {
  if (!inv || typeof inv !== 'object') continue;
  if (looksLikeCashBookRow(inv) && !hasUsableTaxBreakdown(inv)) continue;
  const n = invoiceRecordKey(inv);
  if (n) invoicesRecord[n] = /** @type {object} */ (inv);
}

const entryShape =
  entries[0] && typeof entries[0] === 'object' && looksLikeCashBookRow(entries[0]) ? 'cashbook' : 'invoice';
const metaSource = entryShape === 'cashbook' ? 'cashbook' : 'invoices';

return [
  {
    json: {
      skipped: false,
      hellocashData: {
        entries,
        invoices: invoicesRecord,
        meta: {
          fetchedAt: nowIso(),
          entryCount: entries.length,
          invoiceCount: Object.keys(invoicesRecord).length,
          daysBack: Number.isFinite(daysBack) ? daysBack : 1,
          syncHour: syncHour,
          source: metaSource,
          entryShape,
          apiPaths: {
            cashBook: HELLOCASH_PATH_CASHBOOK,
            invoices: HELLOCASH_PATH_INVOICES,
          },
          invoiceEnrich: {
            enabled: false,
          },
        },
      },
    },
  },
];
