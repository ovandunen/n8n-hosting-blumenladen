/**
 * IF-branch when no create is needed (duplicate, dedupe RPC error, or HTTP layer issue on dedupe).
 * Normalizes shape for Odoo Process Results.
 */

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

const base = currentItemJson();
const dr = base.dedupeRpc && typeof base.dedupeRpc === 'object' ? base.dedupeRpc : null;
const httpMeta = base.httpDedupeMeta && typeof base.httpDedupeMeta === 'object' ? base.httpDedupeMeta : null;
const sc = httpMeta && typeof httpMeta.statusCode === 'number' ? httpMeta.statusCode : undefined;

let postCreatePath = 'duplicate_or_skip';
if (dr && typeof dr === 'object' && dr.error) postCreatePath = 'dedupe_rpc_error';
else if (sc !== undefined && sc >= 400) postCreatePath = 'dedupe_http_error';

return { json: { ...base, createRpc: null, skipCreate: true, postCreatePath } };
