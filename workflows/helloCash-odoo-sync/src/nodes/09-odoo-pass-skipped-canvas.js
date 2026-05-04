/**
 * Rows with no RPC work (skipped / empty / mappedEmpty) bypass Dedupe/Create and go straight to Process Results.
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

return { json: { ...currentItemJson() } };
