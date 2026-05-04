/**
 * Odoo Process Results — runOnceForAllItems: interpret dedupe/create RPC + HTTP meta,
 * build per-move results, aggregate-throw on hard failures (same policy as legacy Odoo Post Moves).
 */

const NODE = 'Odoo Process Results';

function safeStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '[unserializable]';
  }
}

/**
 * n8n’s Code-node error UI often strips URL-like fragments.
 * @param {string} s
 */
function scrubHttpTokensForN8nErrorUi(s) {
  return String(s ?? '')
    .replace(/https:\/\//gi, 'TLS443__')
    .replace(/http:\/\//gi, 'PLAIN80__')
    .replace(/https:/gi, 'TLS443_')
    .replace(/http:/gi, 'PLAIN80_');
}

/** @param {string} r */
function reasonLabelForUi(r) {
  const x = String(r ?? '');
  if (x === 'dedupe_check_failed') return 'idempotency-RPC-failed';
  if (x === 'create_failed') return 'create-move-failed';
  if (x === 'invalid_payload') return 'invalid-payload';
  return x.replace(/_/g, '-');
}

/** @param {unknown} err */
function errorToBriefText(err) {
  if (err == null) {
    return 'no error object captured — see console.error lines above for this ref';
  }
  if (typeof err === 'string') {
    const t = err.trim();
    return t ? t : '(empty error string)';
  }
  if (err instanceof Error) {
    return (
      (err.message && String(err.message).trim()) ||
      (err.stack && String(err.stack).split('\n')[0]?.trim()) ||
      err.name ||
      'Error instance without message (check stack in logs)'
    );
  }
  if (typeof err === 'object') {
    try {
      const s = JSON.stringify(err, null, 2);
      return s.length > 12000 ? `${s.slice(0, 12000)}\n…(truncated)` : s;
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** @param {Record<string, unknown> | null | undefined} j */
function describeFailedMoveItem(j) {
  if (!j || typeof j !== 'object') {
    return {
      ref: 'unknown',
      reason: 'invalid_item',
      errorDetail: 'result item had no json object',
      errorOneLine: 'result item had no json object',
    };
  }
  const ov = j.odooVals;
  const ref =
    typeof j.ref === 'string'
      ? j.ref
      : ov && typeof ov === 'object' && typeof /** @type {{ ref?: unknown }} */ (ov).ref === 'string'
        ? String(/** @type {{ ref: string }} */ (ov).ref)
        : 'unknown';
  const reason =
    typeof j.reason === 'string' ? j.reason : j.success === false ? 'success_false_no_reason' : 'unspecified';
  const rawErr = j.error;

  let errorDetail;
  if (rawErr !== undefined && rawErr !== null && String(rawErr).trim() !== '') {
    errorDetail =
      typeof rawErr === 'string' ? rawErr : typeof rawErr === 'object' ? safeStringify(rawErr) : String(rawErr);
  } else {
    errorDetail = [
      `${NODE}: item marked failed without json.error`,
      `success=${JSON.stringify(j.success)}`,
      `odooSkipped=${JSON.stringify(j.odooSkipped)}`,
      `mappedEmpty=${JSON.stringify(j.mappedEmpty)}`,
      `hellocashId=${j.hellocashId ?? 'n/a'}`,
      `hellocashNumber=${j.hellocashNumber ?? 'n/a'}`,
      `message=${typeof j.message === 'string' ? j.message : 'n/a'}`,
      `journalHint ref=${typeof j.odooVals === 'object' && j.odooVals ? JSON.stringify((/** @type {{ journal_id?: unknown }} */ (j.odooVals)).journal_id) : 'n/a'}`,
    ].join(' | ');
  }
  const errorOneLine = String(errorDetail).replace(/\s+/g, ' ').trim();

  return {
    ref,
    reason,
    errorDetail,
    errorOneLine: errorOneLine.length > 2000 ? `${errorOneLine.slice(0, 1997)}…` : errorOneLine,
  };
}

/** @param {string} baseUrlRaw */
function odooEndpointForErrors(baseUrlRaw) {
  const raw = String(baseUrlRaw ?? '').trim();
  if (!raw || raw === 'n/a') {
    return {
      scheme: 'n/a',
      host: 'n/a',
      pathAfterHost: '',
      tlsOn: false,
      rpcHostPathForUi: 'n/a',
      rawSpelled: 'n/a',
    };
  }
  const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
  const m = normalized.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/i);
  if (!m) {
    return {
      scheme: '?',
      host: raw.replace(/^\/+/, ''),
      pathAfterHost: '',
      tlsOn: false,
      rpcHostPathForUi: `UNPARSED_BASE=${raw}`,
      rawSpelled: raw.replace(/:\/\//, ' _COLON__SLASHSLASH_ '),
    };
  }
  const scheme = String(m[1]).toLowerCase();
  const host = String(m[2]);
  const pathAfterHost = String(m[3] || '').replace(/\/+$/, '');
  const tlsOn = scheme === 'https' || scheme === 'wss';
  const rpcHostPathForUi = `HOST=${host} PATH_ON_HOST=${pathAfterHost}/jsonrpc TLS_ON=${tlsOn ? '1' : '0'}`;
  const rawSpelled = raw.includes('://') ? raw.replace(/:\/\//, ' _COLON__SLASHSLASH_ ') : raw;
  return {
    scheme,
    host,
    pathAfterHost,
    tlsOn,
    rpcHostPathForUi,
    rawSpelled,
  };
}

/** @param {any} config @param {{ scheme: string, host: string }} ep */
function odooAggregateWhatToCheck(config, ep) {
  const rpc = config?.odoo?.rpc === 'json2' ? 'json2' : 'jsonrpc';
  const epLine =
    rpc === 'json2'
      ? `Endpoint (JSON-2): POST {base}/json/2/account.move/search_read|create with Authorization: bearer <ODOO_API_KEY|ODOO_PASSWORD> and X-Odoo-Database when needed.\n`
      : `Endpoint (JSON-RPC): Odoo Dedupe Check / Odoo Create Move POST to {base}/jsonrpc. Not /web/jsonrpc; wrong path often returns HTML.\n`;
  return (
    `--- What to check (Odoo + ${rpc} + this.helpers.httpRequest) ---\n` +
    `Target: host=${ep.host} TLS_ON=${ep.tlsOn ? '1' : '0'} | ODOO_DB=${config?.odoo?.db ?? 'n/a'} | ODOO_UID=${config?.odoo?.uid ?? 'n/a'} | ODOO_JOURNAL_ID=${config?.odoo?.journalId ?? 'n/a'}\n` +
    epLine +
    `Transport: TLS/proxy/cert rules apply the same as other server-side calls; errors surface in execution data and Odoo Message/Debug.\n` +
    `Auth: DB/UID/password must match; Odoo usually states access/login problems in RPC Message/Debug.\n` +
    `Data: journal and account_id lines must exist on that company; validation text is in each move's detail above.\n` +
    `If the symptom is “missing arguments” or similar: compare the Odoo Debug trace with the execute_kw envelope — wrong URL/HTML responses are a common cause.\n` +
    `Docker (if enabled): grep N8N_ODPO_DEDUPE_FAIL_JSON | N8N_ODPO_CREATE_FAIL_JSON (per-item) or N8N_ODPO_AGG_FAIL_JSON (aggregate).\n` +
    `Always copy the complete error from the n8n execution log when reporting issues (HTTP status, Response body snippet, Odoo Message/Debug).`
  );
}

function nowIso() {
  return new Date().toISOString();
}

// runOnceForAllItems: prefer items[] (classic); task runner may only provide $input.all().
function allInputItems() {
  if (typeof items !== 'undefined' && Array.isArray(items)) return items;
  if (typeof $input !== 'undefined' && typeof $input.all === 'function') return $input.all();
  return [];
}

const config = $('Config Loader').first().json;
const results = [];

for (const item of allInputItems()) {
  const j = item.json;

  if (j.reason === 'invalid_payload') {
    results.push({
      json: {
        ...j,
        success: false,
        odooSkipped: true,
        reason: 'invalid_payload',
      },
    });
    continue;
  }

  if (j.skipped || j.empty || j.mappedEmpty || j.skip === true) {
    results.push({ json: { ...j, odooSkipped: true, reason: 'no_data' } });
    continue;
  }

  if (!j.odooVals?.ref) {
    results.push({ json: { ...j, error: 'Missing odooVals.ref' } });
    continue;
  }

  const { hellocashId, hellocashNumber, invoiceNumber, ref, odooVals, paymentMethod, taxRate } = j;
  const dr = j.dedupeRpc && typeof j.dedupeRpc === 'object' ? j.dedupeRpc : null;
  const httpDedupe = j.httpDedupeMeta && typeof j.httpDedupeMeta === 'object' ? j.httpDedupeMeta : null;
  const dedupeStatus =
    httpDedupe && typeof httpDedupe.statusCode === 'number' ? httpDedupe.statusCode : undefined;

  if (dedupeStatus !== undefined && dedupeStatus >= 400) {
    results.push({
      json: {
        ...j,
        success: false,
        error:
          `Idempotency check failed — move not created to avoid duplicates. ` +
          `Fix Odoo connectivity and re-run. Details: HTTP ${dedupeStatus} ${httpDedupe?.statusMessage ?? ''}`.trim(),
        odooSkipped: true,
        reason: 'dedupe_check_failed',
      },
    });
    continue;
  }

  if (dr && dr.error) {
    const rpcErr = /** @type {{ message?: unknown, data?: { message?: unknown, debug?: unknown } }} */ (dr.error);
    const msg = errorToBriefText(
      rpcErr?.data?.message ?? rpcErr?.message ?? dr.error,
    );
    results.push({
      json: {
        ...j,
        success: false,
        error:
          `Idempotency check failed — move not created to avoid duplicates. ` +
          `Fix Odoo connectivity and re-run. Details: ${msg}`,
        odooSkipped: true,
        reason: 'dedupe_check_failed',
      },
    });
    continue;
  }

  const existing = Array.isArray(dr?.result) ? dr.result : [];
  if (existing.length > 0) {
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

  const cr = j.createRpc && typeof j.createRpc === 'object' ? j.createRpc : null;
  const httpCreate = j.httpCreateMeta && typeof j.httpCreateMeta === 'object' ? j.httpCreateMeta : null;
  const createStatus =
    httpCreate && typeof httpCreate.statusCode === 'number' ? httpCreate.statusCode : undefined;

  if (createStatus !== undefined && createStatus >= 400) {
    results.push({
      json: {
        ...j,
        success: false,
        error: `Failed to create move: HTTP ${createStatus} ${httpCreate?.statusMessage ?? ''}`.trim(),
        odooSkipped: false,
        reason: 'create_failed',
      },
    });
    continue;
  }

  if (cr && cr.error) {
    const rpcErr = /** @type {{ message?: unknown, data?: { message?: unknown } }} */ (cr.error);
    const msg = errorToBriefText(rpcErr?.data?.message ?? rpcErr?.message ?? cr.error);
    results.push({
      json: {
        ...j,
        success: false,
        error: `Failed to create move: ${msg}`,
        odooSkipped: false,
        reason: 'create_failed',
      },
    });
    continue;
  }

  if (cr && (cr.result !== undefined && cr.result !== null)) {
    const createdId = Array.isArray(cr.result) ? cr.result[0] : cr.result;
    results.push({
      json: {
        hellocashId,
        hellocashNumber,
        invoiceNumber,
        ref,
        odooMoveId: createdId,
        paymentMethod,
        taxRate,
        success: true,
        attempt: 1,
        createdAt: nowIso(),
      },
    });
    continue;
  }

  results.push({
    json: {
      ...j,
      success: false,
      error: 'Unexpected state: no create RPC result after empty dedupe',
      odooSkipped: false,
      reason: 'create_failed',
    },
  });
}

const hardFailures = results.filter(
  (r) =>
    r.json &&
    (r.json.success === false ||
      r.json.reason === 'dedupe_check_failed' ||
      r.json.reason === 'invalid_payload'),
);

if (hardFailures.length > 0) {
  const summary = hardFailures.map((r) => describeFailedMoveItem(r.json));
  let refsReasons = summary.map((s) => `${s.ref}:${reasonLabelForUi(s.reason)}`).join('; ');
  if (refsReasons.length > 3800) {
    refsReasons = `${refsReasons.slice(0, 3790)}… [truncated ${summary.length} ref(s)]`;
  }
  const odooBaseResolved =
    config?.odoo?.baseUrl != null && String(config.odoo.baseUrl).trim() !== ''
      ? String(config.odoo.baseUrl).trim()
      : 'n/a';
  const ep = odooEndpointForErrors(odooBaseResolved);
  const odooRpc = config?.odoo?.rpc === 'json2' ? 'json2' : 'jsonrpc';
  const jsonRpcUrl =
    odooBaseResolved !== 'n/a' ? `${odooBaseResolved.replace(/\/+$/, '')}/jsonrpc` : 'n/a';
  const json2DedupeExample =
    odooBaseResolved !== 'n/a' ? `${odooBaseResolved.replace(/\/+$/, '')}/json/2/account.move/search_read` : 'n/a';

  const headlineOneLine =
    `ODPO_AGG_FAIL ${NODE} movesBad=${hardFailures.length} total=${results.length} host=${ep.host} tls=${ep.tlsOn ? '1' : '0'} ` +
    `db=${config?.odoo?.db ?? 'n/a'} jid=${config?.odoo?.journalId ?? 'n/a'} refs=${refsReasons} ` +
    `FULL_URL_GREP_LOG_LINE_PREFIX=N8N_ODPO_AGG_FAIL_JSON`.replace(/\s+/g, ' ').trim();

  const odooTargetBlock =
    `--- Odoo target (ODOO_BASE_URL via Config Loader) ---\n` +
    `  host=${ep.host}  TLS_ON=${ep.tlsOn ? '1' : '0'}  extraPathOnBase=${ep.pathAfterHost === '' ? '(none)' : ep.pathAfterHost}\n` +
    `  ${ep.rpcHostPathForUi}\n` +
    `  ODOO_DB=${config?.odoo?.db ?? 'n/a'}  ODOO_UID=${config?.odoo?.uid ?? 'n/a'}  ODOO_JOURNAL_ID=${config?.odoo?.journalId ?? 'n/a'}\n` +
    `  raw base spelled: ${ep.rawSpelled}\n` +
    `  ODOO_RPC=${odooRpc} | grep N8N_ODPO_AGG_FAIL_JSON for one-line JSON (includes ${odooRpc === 'json2' ? 'json2 example path' : 'jsonrpc URL'}).`;

  console.error(
    `N8N_ODPO_AGG_FAIL_JSON ${JSON.stringify({
      v: 4,
      odooRpc,
      odooBaseUrl: odooBaseResolved,
      jsonRpcUrl,
      json2DedupeExample,
      host: ep.host,
      scheme: ep.scheme,
      tlsOn: ep.tlsOn,
      db: config?.odoo?.db,
      uid: config?.odoo?.uid,
      journalId: config?.odoo?.journalId,
      movesFailed: hardFailures.length,
      totalProcessed: results.length,
      failures: summary.map((s) => ({
        ref: s.ref,
        reason: s.reason,
        errorOneLine: String(s.errorOneLine || '').slice(0, 1500),
      })),
    })}`,
  );

  console.error(
    `${NODE}: ${hardFailures.length} item(s) failed — throwing so n8n error branch fires error email`,
    {
      at: nowIso(),
      failureCount: hardFailures.length,
      totalItems: results.length,
      odooScheme: ep.scheme,
      odooHost: ep.host,
      odooBaseResolved,
      rpcHostPathForUi: ep.rpcHostPathForUi,
      odooRpc,
      jsonRpcUrlOneLine: jsonRpcUrl,
      json2DedupeExample,
      failures: summary.map((s) => ({ ref: s.ref, reason: s.reason, errorOneLine: s.errorOneLine })),
    },
  );

  const blocks = summary.map(
    (s) =>
      `▼ ref=${s.ref}\n` +
      `  reason: ${reasonLabelForUi(s.reason)}\n` +
      `  detail:\n${String(s.errorDetail)
        .split('\n')
        .map((ln) => `    ${ln}`)
        .join('\n')}`,
  );

  throw new Error(
    scrubHttpTokensForN8nErrorUi(
      `${headlineOneLine}\n\n` +
        `${odooTargetBlock}\n\n` +
        `--- Per-move details (${summary.length}) —\n` +
        `${blocks.join('\n\n')}\n\n` +
        odooAggregateWhatToCheck(config, ep),
    ),
  );
}

return results;
