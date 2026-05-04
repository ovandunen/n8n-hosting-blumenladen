/**
* Odoo JSON-RPC: account.move create with idempotency (ref) and retries.
* Uses $env.ODOO_PASSWORD (validated at Config Loader, never stored in config json).
*
* KORREKTUREN:
* 1. Gesamter Hauptcode in async IIFE gepackt, da await nur innerhalb async erlaubt ist.
* 2. JSON-RPC via this.helpers.httpRequest (gleiches Muster wie HelloCash Fetch, json:true).
* 3. Antwort ist das geparste JSON-RPC-Objekt (result / error).
* 4. Fehlerbehandlung angepasst (statusCode aus Request-Fehlern).
* 5. Rückgabe des Promise von run() an n8n.
*/

const NODE = 'Odoo Post Moves';

function safeStringify(v) {
try {
return JSON.stringify(v, null, 2);
} catch {
return '[unserializable]';
}
}

/**
 * n8n’s Code-node error UI often strips URL-like fragments; the visible error can shrink to a
 * single token (e.g. a reason code). Scrub throws that are meant for the UI so host/db stay readable.
 * Full URLs are still logged via N8N_ODPO_*_JSON console lines (grep those).
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

/** Readable text from caught RPC/errors (avoid empty or “unknown”). */
/** @param {unknown} err */
function errorToBriefText(err) {
if (err == null) {
return 'no error object captured — see console.error RPC lines above for this ref';
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

/**
 * n8n’s error UI often strips "https:" from messages, leaving "//host..." only.
 * Never rely on a single "scheme://host" token in the preview line — split parts and lines.
 * @param {string} baseUrlRaw from config.odoo.baseUrl
 */
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

/** Appended to per-RPC throws (HTTP layer + Odoo RPC error object). */
function odooRpcTroubleshootingAppendix() {
return (
`\n\n--- Odoo JSON-RPC context (${NODE} uses this.helpers.httpRequest in Code, not the HTTP Request node) ---\n` +
`If Odoo looks like it never received service/method/args:\n` +
`  • Wrong ODOO_BASE_URL — config.odoo.baseUrl must be the correct Odoo origin for that database.\n` +
`  • Wrong path — this code POSTs JSON-RPC 2.0 only to {base}/jsonrpc. It is not /web/jsonrpc or the website; HTML/404/login pages mean the URL/path is wrong so execute_kw never runs.\n` +
`  • Authentication — the body sends ODOO_DB, ODOO_UID, and ODOO_PASSWORD into execute_kw; wrong values usually show as access or login errors in Odoo Message/Debug.\n` +
`TLS — helpers.httpRequest uses the same encrypted transport as other server-side calls in n8n. Cert trust, hostname (SNI), or proxy inspection issues show in Message/Response; fix CA (e.g. NODE_EXTRA_CA_CERTS), DNS, or proxy — not specific to the HTTP Request node.\n` +
`For diagnosis: copy the full block from this execution log (this node's console.error lines with redacted body + Odoo Message/Debug above) to tell connection vs auth vs validation vs “missing arguments”.`
);
}

/** Aggregate-failure “what to check” (includes resolved host/scheme). */
/** @param {any} config @param {{ scheme: string, host: string }} ep */
function odooAggregateWhatToCheck(config, ep) {
return (
`--- What to check (Odoo + JSON-RPC + this Code node) ---\n` +
`Target: host=${ep.host} TLS_ON=${ep.tlsOn ? '1' : '0'} | ODOO_DB=${config?.odoo?.db ?? 'n/a'} | ODOO_UID=${config?.odoo?.uid ?? 'n/a'} | ODOO_JOURNAL_ID=${config?.odoo?.journalId ?? 'n/a'}\n` +
`Endpoint: only path .../jsonrpc (JSON-RPC). Not /web/jsonrpc; wrong path often returns HTML so Odoo never parses the JSON-RPC envelope.\n` +
`Transport: ${NODE} uses this.helpers.httpRequest inside a Code node, not the HTTP Request node — TLS/proxy/cert rules still apply; errors surface in Message/Response and server logs.\n` +
`Auth: DB/UID/password must match; Odoo usually states access/login problems in RPC Message/Debug.\n` +
`Data: journal and account_id lines must exist on that company; validation text is in each move's detail above.\n` +
`If the symptom is “missing arguments” or similar: compare the Odoo Debug trace with the redacted execute_kw body in console.error — wrong URL/HTML responses are the most common cause of bizarre RPC errors.\n` +
`Always copy the complete error from the n8n execution log when reporting issues (HTTP status, Response body snippet, Odoo Message/Debug).`
);
}

function isDebugEnabled() {
const v = String($env.ODOO_DEBUG_LOG ?? '').trim().toLowerCase();
return v === '1' || v === 'true' || v === 'yes';
}

function debugLog(label, obj) {
try {
console.debug(`${NODE}: ${label}`, obj);
} catch {
// ignore
}
}

/**
* Redact the password in an execute_kw JSON-RPC body.
* Body shape:
* params.args = [db, uid, password, model, method, args, kwargs]
*/
function redactRpcBody(body) {
try {
const b = body && typeof body === 'object' ? { ...body } : body;
if (!b || typeof b !== 'object') return b;
const params = b.params && typeof b.params === 'object' ? { ...b.params } : null;
if (!params) return b;
const pArgs = Array.isArray(params.args) ? [...params.args] : null;
if (!pArgs) return b;
if (pArgs.length >= 3) pArgs[2] = '***REDACTED***';
b.params = { ...params, args: pArgs };
return b;
} catch {
return { redaction: 'failed' };
}
}

/**
* Best-effort HTTP status aus n8n httpRequest-Fehlern (ähnlich pattern wie zuvor).
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
// Bei httpRequest steckt der Fehler oft in e.response?.data oder e.body
let body =
/** @type {{ response?: { data?: unknown, body?: unknown } }} */ (e)?.response?.data ??
/** @type {{ response?: { data?: unknown, body?: unknown } }} */ (e)?.response?.body ??
/** @type {{ body?: unknown }} */ (e)?.body ??
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

function nowIso() {
return new Date().toISOString();
}

/** Mask secret for logs. */
function maskSecret(s) {
const str = String(s ?? '');
if (!str) return '(empty)';
if (str.length <= 8) return `${str.slice(0, 2)}…(${str.length} chars)`;
return `${str.slice(0, 3)}…${str.slice(-2)} (len=${str.length})`;
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

function createCircuitBreaker({ failureThreshold, cooldownMs }) {
let consecutive = 0;
let openUntil = 0;
return {
assertClosed(op) {
const now = Date.now();
if (openUntil && now < openUntil) {
const remainingMs = openUntil - now;
throw new Error(
`${NODE}: circuit breaker OPEN for ${op} (cooldown ${Math.ceil(remainingMs / 1000)}s remaining). ` +
`Too many consecutive failures; check Odoo availability/config before retrying.`,
);
}
},
success() {
consecutive = 0;
openUntil = 0;
},
failure() {
consecutive++;
if (consecutive >= failureThreshold) openUntil = Date.now() + cooldownMs;
},
};
}

/**
* Validate a move payload so we fail fast before sending bad accounting data.
* @param {any} vals
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
// Allow tiny rounding differences.
if (Math.abs(debitSum - creditSum) > 0.0001) {
return `move not balanced: debit=${debitSum.toFixed(2)} credit=${creditSum.toFixed(2)}`;
}
return null;
}

/**
* Hauptfunktion – wird sofort ausgeführt.
* @returns {Promise<any[]>} Ergebnisse für n8n
*/
async function run() {
const config = $('Config Loader').first().json;
const pwd = $env.ODOO_PASSWORD?.trim();
if (!pwd) {
throw new Error(
`${NODE}: ODOO_PASSWORD missing for JSON-RPC. Example: ODOO_PASSWORD="supersecret" (never log this value).`,
);
}

const { maxAttempts, intervalMs } = config.retry;
const results = [];
const debug = isDebugEnabled();

// Startup diagnostics (no secrets).
console.log(`${NODE}: start`, {
at: nowIso(),
odooBaseUrl: config?.odoo?.baseUrl,
odooDb: config?.odoo?.db,
odooUid: config?.odoo?.uid,
journalId: config?.odoo?.journalId,
password: maskSecret(pwd),
maxAttempts,
intervalMs,
debug,
});

const breaker = createCircuitBreaker({
failureThreshold: parseInt(String($env.ODOO_CB_FAILURE_THRESHOLD || '4'), 10) || 4,
cooldownMs: parseInt(String($env.ODOO_CB_COOLDOWN_MS || '120000'), 10) || 120000,
});

/**
* JSON-RPC via this.helpers.httpRequest (json:true), gleiches Muster wie HelloCash Fetch.
* @param {string} model
* @param {string} method
* @param {any[]} args
* @param {Record<string, any>} kwargs
*/
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

if (debug) {
console.log(`${NODE}: RPC request (redacted)`, {
at: nowIso(),
url,
model,
method,
body: redactRpcBody(body),
});
}

let response;
try {
breaker.assertClosed(`${model}.${method}`);
response = await this.helpers.httpRequest({
method: 'POST',
url,
json: true,
body,
timeout: 60000,
headers: { 'Content-Type': 'application/json' },
});
breaker.success();
} catch (e) {
breaker.failure();
// httpRequest wirft bei Statuscode >= 400 oft axios-ähnlich mit response-Objekt
const status = e.response?.statusCode || e.statusCode || resolveHttpStatus(e);
const respBody = e.response?.body || e.body || odooHttpErrorBody(e);
const errMsg = e.message || String(e);
console.error(`${NODE}: Odoo HTTP error — ODOO_URL=${url} (${model}.${method})`, {
model,
method,
url,
httpStatus: status,
responseBody: respBody,
message: errMsg,
password: maskSecret(pwd),
requestBodyRedacted: redactRpcBody(body),
});
console.error(
`N8N_ODPO_HTTP_FAIL_JSON ${JSON.stringify({
v: 1,
url,
model,
method,
httpStatus: status,
message: String(errMsg || '').slice(0, 2000),
})}`,
);
const statusLine =
status && status !== 'no-status'
? `HTTP ${status}`
: `HTTP status unknown — check ODOO_BASE_URL, TLS, proxy, and that Odoo is reachable`;
throw new Error(
scrubHttpTokensForN8nErrorUi(
`ODOO_URL=${url} | ${statusLine} calling ${model}.${method}\n` +
`Message: ${errMsg}\n` +
`Response: ${typeof respBody === 'string' ? respBody : JSON.stringify(respBody)}` +
` FULL_URL_GREP_LOG_PREFIX=N8N_ODPO_HTTP_FAIL_JSON` +
odooRpcTroubleshootingAppendix(),
),
);
}

const res = response;

if (res.error) {
console.error(`${NODE}: Odoo RPC error`, {
model,
method,
code: res.error.code,
message: res.error.data?.message ?? res.error.message,
debug: res.error.data?.debug ?? 'none',
});
console.error(
`N8N_ODPO_RPC_FAIL_JSON ${JSON.stringify({
v: 1,
model,
method,
code: res.error.code,
message: String(res.error.data?.message ?? res.error.message ?? '').slice(0, 2000),
})}`,
);
throw new Error(
scrubHttpTokensForN8nErrorUi(
`Odoo RPC error calling ${model}.${method}\n` +
`Code: ${res.error.code}\n` +
`Message: ${res.error.data?.message ?? res.error.message}\n` +
`Debug: ${res.error.data?.debug ?? 'none'}` +
odooRpcTroubleshootingAppendix(),
),
);
}

console.log(`${NODE}: Odoo RPC ok: ${model}.${method}`, {
resultType: Array.isArray(res.result) ? 'array' : typeof res.result,
resultLength: Array.isArray(res.result) ? res.result.length : undefined,
});

return res.result;
};

/**
* RPC with retries/backoff.
* @param {string} model
* @param {string} method
* @param {any[]} args
* @param {Record<string, any>} kwargs
* @param {string} op
*/
const rpcWithRetry = async (model, method, args, kwargs, op) => {
let last = null;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
try {
return { ok: true, result: await rpc(model, method, args, kwargs), attempt };
} catch (e) {
last = e;
const error = e instanceof Error ? e : new Error(String(e));
// Fehler mit Stacktrace
console.error(`${NODE}: Fehler`, error.stack);
const msg = e instanceof Error ? e.message : String(e);
console.warn(`${NODE}: ${op} failed (attempt ${attempt}/${maxAttempts}): ${msg}`);
if (attempt < maxAttempts) {
const delay = backoffDelayMs(attempt, intervalMs, 30000);
// Mehrere Werte in einem Objekt
debugLog('Zwischenstand', { ref: kwargs?.ref ?? undefined, attempt, delayMs: delay });
await new Promise((r) => setTimeout(r, delay));
}
}
}
return { ok: false, error: last };
};

// Hauptschleife über alle eingehenden Items
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

console.log(`${NODE}: processing item ${ref}`, { hellocashId, ref, at: nowIso() });

const validationError = validateMoveVals(odooVals);
if (validationError) {
results.push({
json: {
...j,
success: false,
error: `Invalid journal entry payload: ${validationError}`,
odooSkipped: true,
reason: 'invalid_payload',
},
});
continue;
}

// Log what we are about to send (safe summary by default).
const lineCount = Array.isArray(odooVals?.line_ids) ? odooVals.line_ids.length : 0;
let debitSum = 0;
let creditSum = 0;
try {
if (Array.isArray(odooVals?.line_ids)) {
for (const li of odooVals.line_ids) {
const line = Array.isArray(li) ? li[2] : null;
if (!line || typeof line !== 'object') continue;
const d = parseFloat(String(line.debit ?? '0'));
const c = parseFloat(String(line.credit ?? '0'));
if (Number.isFinite(d)) debitSum += d;
if (Number.isFinite(c)) creditSum += c;
}
}
} catch {}

console.log(`${NODE}: odoo payload summary`, {
at: nowIso(),
ref,
date: odooVals?.date,
journal_id: odooVals?.journal_id,
lineCount,
debitSum: Number.isFinite(debitSum) ? Number(debitSum.toFixed(2)) : null,
creditSum: Number.isFinite(creditSum) ? Number(creditSum.toFixed(2)) : null,
});

if (debug) {
console.log(`${NODE}: odoo payload FULL (create)`, {
at: nowIso(),
ref,
odooVals,
});
// Ausgabe von Variablen als lesbares JSON
console.log(`${NODE}: Debug odooVals`, JSON.stringify(odooVals, null, 2));
}

// Idempotency check
const dedupe = await rpcWithRetry(
'account.move',
'search_read',
[[['ref', '=', ref]]],
{ fields: ['id', 'state', 'name', 'ref'], limit: 1 },
`idempotency check ref=${ref}`,
);
if (!dedupe.ok) {
const msg = errorToBriefText(dedupe.error);
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
const existing = dedupe.result;
if (Array.isArray(existing) && existing.length > 0) {
console.log(`${NODE}: skipping duplicate: ${ref}`, { odooMoveId: existing[0].id });
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

const createRes = await rpcWithRetry('account.move', 'create', [[odooVals]], {}, `create ref=${ref}`);
if (!createRes.ok) {
const msg = errorToBriefText(createRes.error);

// Safety net: post‑failure check
const postCheck = await rpcWithRetry(
'account.move',
'search_read',
[[['ref', '=', ref]]],
{ fields: ['id', 'state', 'name'], limit: 1 },
`post-failure dedupe check ref=${ref}`,
);
if (postCheck.ok && Array.isArray(postCheck.result) && postCheck.result.length > 0) {
results.push({
json: {
hellocashId,
hellocashNumber,
invoiceNumber,
ref,
odooMoveId: postCheck.result[0].id,
odooState: postCheck.result[0].state,
success: true,
idempotent: true,
message: `Move appears to have been created despite error; found as ${postCheck.result[0].name || ref}`,
},
});
continue;
}

results.push({
json: {
...j,
success: false,
error: `Failed to create move after ${maxAttempts} attempts: ${msg}`,
odooSkipped: false,
reason: 'create_failed',
},
});
continue;
}

const createdId = Array.isArray(createRes.result) ? createRes.result[0] : createRes.result;
console.log(`${NODE}: created Odoo move for ${ref}`, { odooMoveId: createdId });
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
attempt: createRes.attempt,
createdAt: nowIso(),
},
});
}

// ── Post-loop failure gate ──────────────────────
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
const jsonRpcUrl =
odooBaseResolved !== 'n/a' ? `${odooBaseResolved.replace(/\/+$/, '')}/jsonrpc` : 'n/a';

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
`  Exact odoo_base_url and jsonrpc URL are always printed on one Docker line starting with N8N_ODPO_AGG_FAIL_JSON (grep it).`;

console.error(
`N8N_ODPO_AGG_FAIL_JSON ${JSON.stringify({
v: 3,
odooBaseUrl: odooBaseResolved,
jsonRpcUrl,
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
jsonRpcUrlOneLine: jsonRpcUrl,
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
}

// n8n Code node: return the Promise from run() — must preserve this for this.helpers.httpRequest (same as top-level Code).
return run.call(this);
