/**
 * Odoo Dedupe Check — account.move search_read via this.helpers.httpRequest.
 * jsonrpc: POST {base}/jsonrpc (execute_kw). json2: POST {base}/json/2/account.move/search_read (Bearer).
 */

const NODE = 'Odoo Dedupe Check';

/** Grep: `N8N_ODPO_DEDUPE_FAIL_JSON` — one JSON line per failure (no credentials). */
function logDedupeFailLine(payload) {
  try {
    console.error(`N8N_ODPO_DEDUPE_FAIL_JSON ${JSON.stringify({ v: 1, node: NODE, ...payload })}`);
  } catch {
    /* ignore */
  }
}

function spreadableItemJson(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Date) return {};
  const x = /** @type {Record<string, unknown>} */ (obj);
  const { json: _j, binary: _b, pairedItem: _p, error: _e, index: _i, ...rest } = x;
  return { ...rest };
}

function currentItemJson() {
  let raw;
  if (typeof $input !== 'undefined' && $input?.item?.json !== undefined && $input.item.json !== null) {
    raw = $input.item.json;
  } else if (typeof items !== 'undefined' && Array.isArray(items) && items[0]?.json !== undefined) {
    raw = items[0].json;
  } else {
    raw = {};
  }
  return spreadableItemJson(raw);
}

/** @param {Record<string, unknown>} opts */
function httpRequestOpts(opts) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** @param {unknown} e */
function httpFailureStatus(e) {
  if (e == null || typeof e !== 'object') return 500;
  const o = /** @type {Record<string, unknown>} */ (e);
  const r = o.response && typeof o.response === 'object' ? /** @type {Record<string, unknown>} */ (o.response) : {};
  const s =
    (typeof r.statusCode === 'number' && r.statusCode) ||
    (typeof r.status === 'number' && r.status) ||
    (typeof o.statusCode === 'number' && o.statusCode) ||
    (typeof o.httpCode === 'number' && o.httpCode);
  return typeof s === 'number' && Number.isFinite(s) ? s : 500;
}

/** @param {unknown} e */
function httpFailureBodyText(e) {
  if (e == null) return 'unknown error';
  if (typeof e !== 'object') return String(e);
  const o = /** @type {Record<string, unknown>} */ (e);
  const r = o.response && typeof o.response === 'object' ? /** @type {Record<string, unknown>} */ (o.response) : {};
  const body = r.data ?? r.body ?? o.body ?? (e instanceof Error ? e.message : o.message);
  if (body === undefined || body === null) return String(o.message ?? e);
  return typeof body === 'string' ? body : JSON.stringify(body).slice(0, 4000);
}

/**
 * SaaS Odoo occasionally exceeds 30s on create when taxes / automation run.
 * @returns {number} ms for this.helpers.httpRequest timeout
 */
function odooHttpTimeoutMs() {
  const raw =
    ($env.ODOO_HTTP_TIMEOUT_MS !== undefined && $env.ODOO_HTTP_TIMEOUT_MS !== null && String($env.ODOO_HTTP_TIMEOUT_MS).trim() !== '')
      ? String($env.ODOO_HTTP_TIMEOUT_MS).trim()
      : '90000';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 5000 ? n : 90000;
}

/** JSON-2 success is a record list; errors may still be HTTP 200 with Odoo exception JSON. */
function normalizeJson2DedupeResponse(raw, url, row) {
  if (Array.isArray(raw)) {
    return { dedupeRpc: { result: raw } };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (typeof o.name === 'string' && o.message !== undefined) {
      const errObj = {
        error: {
          message: String(o.message),
          code: 502,
          data: { name: o.name, arguments: o.arguments, debug: o.debug },
        },
      };
      logDedupeFailLine({
        kind: 'json2_exception_body',
        ref: row.ref,
        rpcUrl: url,
        rpcMessage: String(o.message).slice(0, 1500),
      });
      return { dedupeRpc: errObj };
    }
  }
  logDedupeFailLine({ kind: 'parse', ref: row.ref, rpcUrl: url, message: 'unexpected JSON-2 dedupe response' });
  return {
    dedupeRpc: { error: { message: 'unexpected JSON-2 dedupe response shape', code: 502 } },
  };
}

async function run() {
  const prep = spreadableItemJson($('Odoo Prepare Payload').item.json);
  const cur = currentItemJson();
  const row = { ...prep, ...cur };
  const cfg = $('Config Loader').first().json;
  const isJson2 = row.odooRpc === 'json2' || cfg?.odoo?.rpc === 'json2';

  const skipDedupe =
    row.skip ||
    (isJson2 ? !row.dedupeUrl || row.dedupeJson2Body == null : !row.rpcUrl || !row.dedupeBody);

  if (skipDedupe) {
    return {
      json: {
        ...row,
        dedupeRpc: null,
        httpDedupeMeta: { statusCode: 204, statusMessage: 'No RPC' },
      },
    };
  }

  const url = isJson2 ? String(row.dedupeUrl) : String(row.rpcUrl);

  if (isJson2) {
    const token = String($env.ODOO_API_KEY ?? $env.ODOO_PASSWORD ?? '').trim();
    if (!token) {
      throw new Error(`${NODE}: ODOO_API_KEY or ODOO_PASSWORD required for JSON-2 Bearer auth.`);
    }
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `bearer ${token}`,
      'User-Agent': 'n8n-helloCash-odoo-sync',
    };
    const db = cfg?.odoo?.db != null ? String(cfg.odoo.db).trim() : '';
    if (db) headers['X-Odoo-Database'] = db;

    try {
      const response = await this.helpers.httpRequest(
        httpRequestOpts({
          method: 'POST',
          url,
          headers,
          body: row.dedupeJson2Body,
          json: true,
          timeout: odooHttpTimeoutMs(),
        }),
      );

      const norm = normalizeJson2DedupeResponse(response, url, row);
      return {
        json: {
          ...row,
          dedupeRpc: norm.dedupeRpc,
          httpDedupeMeta: { statusCode: 200, statusMessage: 'OK' },
        },
      };
    } catch (e) {
      const status = httpFailureStatus(e);
      const msg = httpFailureBodyText(e);
      logDedupeFailLine({
        kind: 'http',
        ref: row.ref,
        rpcUrl: url,
        httpStatus: status,
        message: String(msg).slice(0, 2000),
      });
      console.error(`${NODE}: HTTP failed`, { ref: row.ref, status, snippet: String(msg).slice(0, 500) });
      return {
        json: {
          ...row,
          dedupeRpc: {
            error: { message: msg, code: status, data: { debug: httpFailureBodyText(e) } },
          },
          httpDedupeMeta: {
            statusCode: status,
            statusMessage: e instanceof Error ? e.message : String(e),
          },
        },
      };
    }
  }

  try {
    const response = await this.helpers.httpRequest(
      httpRequestOpts({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: row.dedupeBody,
        json: true,
        timeout: odooHttpTimeoutMs(),
      }),
    );

    let dedupeRpc = response;
    if (Array.isArray(dedupeRpc)) dedupeRpc = { result: dedupeRpc };
    if (dedupeRpc == null || typeof dedupeRpc !== 'object' || dedupeRpc instanceof Date) {
      dedupeRpc = { error: { message: 'empty or non-object JSON-RPC response', code: 502 } };
      logDedupeFailLine({
        kind: 'parse',
        ref: row.ref,
        rpcUrl: url,
        message: String(dedupeRpc.error.message),
      });
    } else if ('error' in dedupeRpc && dedupeRpc.error != null) {
      const err = /** @type {{ message?: unknown; code?: unknown; data?: unknown }} */ (dedupeRpc.error);
      logDedupeFailLine({
        kind: 'rpc_body',
        ref: row.ref,
        rpcUrl: url,
        rpcCode: err.code,
        rpcMessage: typeof err.message === 'string' ? err.message.slice(0, 1500) : String(err.message ?? ''),
      });
    }

    return {
      json: {
        ...row,
        dedupeRpc,
        httpDedupeMeta: { statusCode: 200, statusMessage: 'OK' },
      },
    };
  } catch (e) {
    const status = httpFailureStatus(e);
    const msg = httpFailureBodyText(e);
    logDedupeFailLine({
      kind: 'http',
      ref: row.ref,
      rpcUrl: url,
      httpStatus: status,
      message: String(msg).slice(0, 2000),
    });
    console.error(`${NODE}: HTTP failed`, { ref: row.ref, status, snippet: String(msg).slice(0, 500) });
    return {
      json: {
        ...row,
        dedupeRpc: {
          error: { message: msg, code: status, data: { debug: e instanceof Error ? e.message : String(e) } },
        },
        httpDedupeMeta: {
          statusCode: status,
          statusMessage: e instanceof Error ? e.message : String(e),
        },
      },
    };
  }
}

return run.call(this);
