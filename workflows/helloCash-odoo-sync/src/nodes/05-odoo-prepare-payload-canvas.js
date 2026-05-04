/**
 * Odoo Prepare Payload — per batch item: validate odooVals, build RPC payloads for
 * dedupe (search_read) and account.move create.
 * Modes: jsonrpc (legacy execute_kw) or json2 (Odoo 19+ External JSON-2, Bearer API key).
 */

const NODE = 'Odoo Prepare Payload';

/**
 * @param {any} vals
 * @returns {string | null} error message or null if ok
 */
function validateMoveVals(vals) {
  if (!vals || typeof vals !== 'object') return 'odooVals must be an object';
  if (!vals.ref || typeof vals.ref !== 'string') return 'odooVals.ref missing (string required)';
  if (!vals.journal_id || !Number.isFinite(parseInt(String(vals.journal_id), 10)))
    return 'odooVals.journal_id missing/invalid';
  if (!vals.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(vals.date))) return 'odooVals.date must be YYYY-MM-DD';
  if (!Array.isArray(vals.line_ids) || vals.line_ids.length < 2) return 'odooVals.line_ids must have >= 2 lines';

  let debitSum = 0;
  let creditSum = 0;
  for (const li of vals.line_ids) {
    if (!Array.isArray(li) || li.length < 3) return 'odooVals.line_ids must contain [0,0,line] entries';
    const line = li[2];
    if (!line || typeof line !== 'object') return 'odooVals.line_ids line payload must be object';
    const acct = line.account_id;
    if (!acct || !Number.isFinite(parseInt(String(acct), 10))) return 'line.account_id missing/invalid';
    const d = parseFloat(String(line.debit ?? '0'));
    const c = parseFloat(String(line.credit ?? '0'));
    if (!Number.isFinite(d) || d < 0) return 'line.debit must be a non-negative number';
    if (!Number.isFinite(c) || c < 0) return 'line.credit must be a non-negative number';
    debitSum += d;
    creditSum += c;
  }
  if (Math.abs(debitSum - creditSum) > 0.0001) {
    return `move not balanced: debit=${debitSum.toFixed(2)} credit=${creditSum.toFixed(2)}`;
  }
  return null;
}

/** Strip INodeExecutionData keys so spreading never copies a nested `json` (must be plain object in n8n). */
function spreadableItemJson(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Date) return {};
  const x = /** @type {Record<string, unknown>} */ (obj);
  const { json: _j, binary: _b, pairedItem: _p, error: _e, index: _i, ...rest } = x;
  return { ...rest };
}

// runOnceForEachItem: task runner exposes $input.item, not items[].
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

/** @param {'jsonrpc' | 'json2'} rpc */
function emptyRpcFields(rpc) {
  return {
    odooRpc: rpc,
    rpcUrl: '',
    dedupeBody: null,
    createBody: null,
    dedupeUrl: '',
    createUrl: '',
    dedupeJson2Body: null,
    createJson2Body: null,
  };
}

const j = currentItemJson();
const config = $('Config Loader').first().json;
const rpc = config?.odoo?.rpc === 'json2' ? 'json2' : 'jsonrpc';

if (rpc === 'jsonrpc') {
  const pwd = ($env.ODOO_PASSWORD ?? '').trim();
  if (!pwd) {
    throw new Error(
      `${NODE}: ODOO_PASSWORD missing for JSON-RPC. Example: ODOO_PASSWORD="…" (never log this value).`,
    );
  }
} else {
  const bearer = String($env.ODOO_API_KEY ?? $env.ODOO_PASSWORD ?? '').trim();
  if (!bearer) {
    throw new Error(
      `${NODE}: ODOO_RPC=json2 requires ODOO_API_KEY or ODOO_PASSWORD (Bearer token for Authorization header).`,
    );
  }
}

const baseSkip = !!(j.skipped || j.empty || j.mappedEmpty);
const validationError = !baseSkip && j.odooVals ? validateMoveVals(j.odooVals) : null;

if (baseSkip) {
  return { json: { ...j, skip: true, ...emptyRpcFields(rpc) } };
}

if (validationError) {
  return {
    json: {
      ...j,
      skip: true,
      ...emptyRpcFields(rpc),
      success: false,
      error: `Invalid journal entry payload: ${validationError}`,
      odooSkipped: true,
      reason: 'invalid_payload',
    },
  };
}

const ref = typeof j.ref === 'string' ? j.ref : String(j.odooVals?.ref ?? '');
const base = String(config.odoo.baseUrl).replace(/\/+$/, '');

if (rpc === 'json2') {
  const dedupeUrl = `${base}/json/2/account.move/search_read`;
  const createUrl = `${base}/json/2/account.move/create`;
  const dedupeJson2Body = {
    domain: [['ref', '=', ref]],
    fields: ['id', 'state', 'name', 'ref'],
    limit: 1,
  };
  const createJson2Body = { vals_list: [j.odooVals] };

  return {
    json: {
      ...j,
      skip: false,
      odooRpc: 'json2',
      rpcUrl: '',
      dedupeBody: null,
      createBody: null,
      dedupeUrl,
      createUrl,
      dedupeJson2Body,
      createJson2Body,
    },
  };
}

const rpcUrl = `${base}/jsonrpc`;

const dedupeBody = {
  jsonrpc: '2.0',
  method: 'call',
  params: {
    service: 'object',
    method: 'execute_kw',
    args: [
      config.odoo.db,
      config.odoo.uid,
      String($env.ODOO_PASSWORD ?? '').trim(),
      'account.move',
      'search_read',
      [['ref', '=', ref]],
      { fields: ['id', 'state', 'name', 'ref'], limit: 1 },
    ],
  },
  id: Date.now(),
};

const createBody = {
  jsonrpc: '2.0',
  method: 'call',
  params: {
    service: 'object',
    method: 'execute_kw',
    args: [
      config.odoo.db,
      config.odoo.uid,
      String($env.ODOO_PASSWORD ?? '').trim(),
      'account.move',
      'create',
      [[j.odooVals]],
      {},
    ],
  },
  id: Date.now() + 1,
};

return {
  json: {
    ...j,
    skip: false,
    odooRpc: 'jsonrpc',
    rpcUrl,
    dedupeBody,
    createBody,
    dedupeUrl: '',
    createUrl: '',
    dedupeJson2Body: null,
    createJson2Body: null,
  },
};
