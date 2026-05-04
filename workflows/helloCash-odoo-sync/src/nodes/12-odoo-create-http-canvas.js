/**
 * Odoo Create Move — account.move create via this.helpers.httpRequest.
 * jsonrpc: POST {base}/jsonrpc (execute_kw). json2: POST {base}/json/2/account.move/create (Bearer).
 */

const NODE = 'Odoo Create Move';

/** Grep: `N8N_ODPO_CREATE_FAIL_JSON` — one JSON line per failure (no credentials). */
function logCreateFailLine(payload) {
  try {
    console.error(`N8N_ODPO_CREATE_FAIL_JSON ${JSON.stringify({ v: 1, node: NODE, ...payload })}`);
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

/** @returns {number} ms for this.helpers.httpRequest timeout */
function odooHttpTimeoutMs() {
  const raw =
    ($env.ODOO_HTTP_TIMEOUT_MS !== undefined && $env.ODOO_HTTP_TIMEOUT_MS !== null && String($env.ODOO_HTTP_TIMEOUT_MS).trim() !== '')
      ? String($env.ODOO_HTTP_TIMEOUT_MS).trim()
      : '90000';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 5000 ? n : 90000;
}

function normalizeJson2CreateResponse(raw, url, row) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { createRpc: { result: raw } };
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      logCreateFailLine({ kind: 'parse', ref: row.ref, rpcUrl: url, message: 'JSON-2 create returned empty array' });
      return { createRpc: { error: { message: 'JSON-2 create returned empty array', code: 502 } } };
    }
    const first = raw[0];
    if (typeof first === 'number' && Number.isFinite(first)) {
      return { createRpc: { result: raw.length === 1 ? first : raw } };
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (typeof o.name === 'string' && o.message !== undefined) {
      logCreateFailLine({
        kind: 'json2_exception_body',
        ref: row.ref,
        rpcUrl: url,
        rpcMessage: String(o.message).slice(0, 1500),
      });
      return {
        createRpc: {
          error: { message: String(o.message), code: 502, data: { name: o.name, arguments: o.arguments, debug: o.debug } },
        },
      };
    }
  }
  logCreateFailLine({ kind: 'parse', ref: row.ref, rpcUrl: url, message: 'unexpected JSON-2 create response' });
  return {
    createRpc: { error: { message: 'unexpected JSON-2 create response shape', code: 502 } },
  };
}

async function run() {
  const dedupeOut = spreadableItemJson($('Odoo Dedupe Check').item.json);
  const cur = currentItemJson();
  const row = { ...dedupeOut, ...cur };
  const cfg = $('Config Loader').first().json;
  const isJson2 = row.odooRpc === 'json2' || cfg?.odoo?.rpc === 'json2';

  const skipCreate =
    isJson2 ? !row.createUrl || row.createJson2Body == null : !row.rpcUrl || !row.createBody;

  if (skipCreate) {
    return {
      json: {
        ...row,
        createRpc: null,
        httpCreateMeta: { statusCode: 204, statusMessage: 'No create' },
      },
    };
  }

  const url = isJson2 ? String(row.createUrl) : String(row.rpcUrl);

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
          body: row.createJson2Body,
          json: true,
          timeout: odooHttpTimeoutMs(),
        }),
      );

      const norm = normalizeJson2CreateResponse(response, url, row);
      return {
        json: {
          ...row,
          createRpc: norm.createRpc,
          httpCreateMeta: { statusCode: 200, statusMessage: 'OK' },
        },
      };
    } catch (e) {
      const status = httpFailureStatus(e);
      const msg = httpFailureBodyText(e);
      logCreateFailLine({
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
          createRpc: {
            error: { message: msg, code: status, data: { debug: httpFailureBodyText(e) } },
          },
          httpCreateMeta: {
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
        body: row.createBody,
        json: true,
        timeout: odooHttpTimeoutMs(),
      }),
    );

    let createRpc = response;
    if (Array.isArray(createRpc)) createRpc = { result: createRpc };
    if (createRpc == null || typeof createRpc !== 'object' || createRpc instanceof Date) {
      createRpc = { error: { message: 'empty or non-object JSON-RPC response', code: 502 } };
      logCreateFailLine({
        kind: 'parse',
        ref: row.ref,
        rpcUrl: url,
        message: String(createRpc.error.message),
      });
    } else if ('error' in createRpc && createRpc.error != null) {
      const err = /** @type {{ message?: unknown; code?: unknown; data?: unknown }} */ (createRpc.error);
      logCreateFailLine({
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
        createRpc,
        httpCreateMeta: { statusCode: 200, statusMessage: 'OK' },
      },
    };
  } catch (e) {
    const status = httpFailureStatus(e);
    const msg = httpFailureBodyText(e);
    logCreateFailLine({
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
        createRpc: {
          error: { message: msg, code: status, data: { debug: e instanceof Error ? e.message : String(e) } },
        },
        httpCreateMeta: {
          statusCode: status,
          statusMessage: e instanceof Error ? e.message : String(e),
        },
      },
    };
  }
}

return run.call(this);
