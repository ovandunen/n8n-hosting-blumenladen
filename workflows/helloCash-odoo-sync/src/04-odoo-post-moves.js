/**
 * Odoo JSON-RPC: account.move create with idempotency (ref) and retries.
 * Uses $env.ODOO_PASSWORD (validated at Config Loader, never stored in config json).
 */

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
      args: [config.odoo.db, config.odoo.uid, pwd, model, method, args, kwargs],
    },
    id: Date.now(),
  };
  const res = await this.helpers.httpRequest({
    method: 'POST',
    url,
    body,
    json: true,
    timeout: 120000,
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.error) {
    throw new Error(`Odoo RPC error: ${JSON.stringify(res.error)}`);
  }
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

  try {
    const existing = await rpc(
      'account.move',
      'search_read',
      [[['ref', '=', ref]]],
      { fields: ['id', 'state', 'name'], limit: 1 },
    );
    if (existing?.length > 0) {
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
