/**
 * Odoo JSON-RPC: account.move create with idempotency (ref) and retries.
 * Uses $env.ODOO_PASSWORD (validated at Config Loader, never stored in config json).
 */

/**
 * Best-effort HTTP status from n8n httpRequest (same pattern as HelloCash fetch).
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

/** @param {unknown} e */
function odooHttpErrorBody(e) {
  let body =
    /** @type {{ response?: { data?: unknown, body?: unknown } }} */ (e)?.response?.data ??
    /** @type {{ response?: { data?: unknown, body?: unknown } }} */ (e)?.response?.body ??
    null;
  if ((body === undefined || body === null || body === '') && e && typeof e === 'object' && 'cause' in e) {
    const c = /** @type {{ cause?: { response?: { data?: unknown, body?: unknown } } }} */ (e).cause;
    body = c?.response?.data ?? c?.response?.body ?? null;
  }
  if (body === undefined || body === null || body === '') {
    return 'no body';
  }
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}

const config = $('Config Loader').first().json;
const pwd = $env.ODOO_PASSWORD?.trim();
if (!pwd) {
  throw new Error('Odoo Post Moves: ODOO_PASSWORD missing for JSON-RPC');
}

const { maxAttempts, intervalMs } = config.retry;
const results = [];

const rpc = async (model, method, args, kwargs = {}) => {
  const url = `${config.odoo.baseUrl}/jsonrpc`;
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        config.odoo.db,
        config.odoo.uid,
        String(pwd).trim(),
        model,
        method,
        args,
        kwargs,
      ],
    },
    id: Date.now(),
  };

  let res;
  try {
    res = await this.helpers.httpRequest({
      method: 'POST',
      url,
      body,
      json: true,
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const status = resolveHttpStatus(e);
    const respBody = odooHttpErrorBody(e);
    const nodeCode =
      e && typeof e === 'object' && 'code' in e ? String(/** @type {{ code?: unknown }} */ (e).code ?? '') : '';
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`Odoo HTTP error — ODOO_URL=${url} (${model}.${method})`, {
      model,
      method,
      url,
      httpStatus: status,
      nodeErrorCode: nodeCode || undefined,
      responseBody: respBody,
      message: errMsg,
    });
    const statusLine =
      status !== 'no-status'
        ? `HTTP ${status}`
        : `HTTP status unknown${nodeCode ? ` (node code ${nodeCode})` : ''} — check ODOO_BASE_URL, TLS, proxy, and that Odoo is reachable`;
    // Lead with ODOO_URL: n8n often surfaces only the first line of error.message in JSON output.
    throw new Error(
      `ODOO_URL=${url} | ${statusLine} calling ${model}.${method}\n` +
        `Message: ${errMsg}\n` +
        `Response: ${typeof respBody === 'string' ? respBody : JSON.stringify(respBody)}`,
    );
  }

  if (res.error) {
    console.error('Odoo RPC error', {
      model,
      method,
      code: res.error.code,
      message: res.error.data?.message ?? res.error.message,
      debug: res.error.data?.debug ?? 'none',
    });
    throw new Error(
      `Odoo RPC error calling ${model}.${method}\n` +
        `Code: ${res.error.code}\n` +
        `Message: ${res.error.data?.message ?? res.error.message}\n` +
        `Debug: ${res.error.data?.debug ?? 'none'}`,
    );
  }

  console.log(`Odoo RPC ok: ${model}.${method}`, {
    resultType: Array.isArray(res.result) ? 'array' : typeof res.result,
    resultLength: Array.isArray(res.result) ? res.result.length : undefined,
  });

  return res.result;
};

for (const item of items) {
  const j = item.json;

  if (j.skipped || j.empty || j.mappedEmpty) {
    results.push({ json: { ...j, odooSkipped: true, reason: 'no_data' } });
    continue;
  }

  if (!j.odooVals?.ref) {
    results.push({ json: { ...j, error: 'Missing odooVals.ref' } });
    continue;
  }

  const { hellocashId, hellocashNumber, invoiceNumber, ref, odooVals, paymentMethod, taxRate } = j;

  console.log(`Processing item ${ref}`, { hellocashId, ref });

  try {
    const existing = await rpc(
      'account.move',
      'search_read',
      [[['ref', '=', ref]]],
      { fields: ['id', 'state', 'name'], limit: 1 },
    );
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`Skipping duplicate: ${ref}`, { odooMoveId: existing[0].id });
      results.push({
        json: {
          hellocashId,
          hellocashNumber,
          invoiceNumber,
          ref,
          odooMoveId: existing[0].id,
          odooState: existing[0].state,
          success: true,
          idempotent: true,
          message: `Already exists as ${existing[0].name || ref}`,
        },
      });
      continue;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`Odoo Post Moves: idempotency check failed for ${ref}: ${msg}`);
  }

  let lastErr;
  let created = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await rpc('account.move', 'create', [[odooVals]]);
      const moveId = Array.isArray(result) ? result[0] : result;
      console.log(`Created Odoo move for ${ref}`, { odooMoveId: moveId });
      results.push({
        json: {
          hellocashId,
          hellocashNumber,
          invoiceNumber,
          ref,
          odooMoveId: moveId,
          paymentMethod,
          taxRate,
          success: true,
          attempt,
        },
      });
      created = true;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  if (!created) {
    throw new Error(
      `Failed to create move ${ref} after ${maxAttempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
}

return results;
