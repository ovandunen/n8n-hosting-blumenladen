/**
 * Map HelloCash invoice rows → Odoo account.move payloads.
 * Routes by invoice_payment (API: Bar, Bankomat, Kreditkarte, Kreditrechnung). All lines use tax_ids: [].
 */

const NODE = 'Map to Odoo';

const config = $('Config Loader').first().json;
const input = items[0].json;

if (input.skipped || input.empty) {
  return [{ json: input }];
}

const hc = input.hellocashData;
if (!hc?.entries) {
  return [{ json: { skipped: false, mappedEmpty: true, message: 'Missing hellocashData.entries' } }];
}

const { entries } = hc;

/**
 * @param {unknown} specific Journal id from env (may be null).
 * @param {Record<string, unknown>} odoo
 * @param {string} envName For error messages.
 */
function resolveJournal(specific, odoo, envName) {
  const def = odoo.journalId;
  if (specific !== null && specific !== undefined && Number.isFinite(specific) && parseInt(String(specific), 10) > 0) {
    return parseInt(String(specific), 10);
  }
  const d = def !== null && def !== undefined ? parseInt(String(def), 10) : NaN;
  if (Number.isFinite(d) && d > 0) return d;
  throw new Error(
    `${NODE}: journal resolution failed: set ${envName} or a valid ODOO_JOURNAL_ID (both missing or invalid).`,
  );
}

/**
 * HelloCash invoice_payment → internal route key.
 * @param {unknown} raw
 */
function normalizeInvoicePayment(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === 'bar') return 'BAR';
  if (lower === 'bankomat') return 'BANKOMAT';
  if (lower === 'kreditkarte') return 'KREDITKARTE';
  if (lower === 'kreditrechnung') return 'KREDITRECHNUNG';
  return null;
}

/** @param {Record<string, unknown>} inv */
function isInvoiceCancelled(inv) {
  if (!inv || typeof inv !== 'object') return true;
  const ic = inv.invoice_cancellation;
  if (ic === true || ic === 1 || ic === '1') return true;
  const s = String(ic ?? '')
    .trim()
    .toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'ja') return true;
  const cb = inv.cashBook_cancellation;
  if (cb === true || cb === 1 || cb === '1') return true;
  return false;
}

/**
 * Gross amount: prefer invoice_total; fall back to common API / legacy cashbook fields, EU decimals, then taxes[].tax_gross.
 * @param {Record<string, unknown>} row
 */
function parseInvoiceGross(row) {
  const keys = [
    'invoice_total',
    'invoice_gross_total',
    'invoice_amount',
    'invoice_sum',
    'gross_total',
    'cashBook_total',
  ];
  for (const k of keys) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return Math.abs(v);
    const t = String(v).trim().replace(/\s/g, '');
    if (!t) continue;
    let n = NaN;
    if (/^\d{1,3}(\.\d{3})+,\d{1,4}$/.test(t)) {
      n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
    } else if (/^\d+,\d+$/.test(t)) {
      n = parseFloat(t.replace(',', '.'));
    } else {
      n = parseFloat(t);
    }
    if (Number.isFinite(n) && n !== 0) return Math.abs(n);
  }
  if (Array.isArray(row.taxes)) {
    let sum = 0;
    for (const tx of row.taxes) {
      if (!tx || typeof tx !== 'object') continue;
      const g = /** @type {{ tax_gross?: unknown }} */ (tx).tax_gross;
      if (g === null || g === undefined) continue;
      const t = String(g).trim().replace(/\s/g, '').replace(',', '.');
      const n = parseFloat(t);
      if (Number.isFinite(n)) sum += n;
    }
    if (sum > 0) return Math.abs(sum);
  }
  return NaN;
}

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pickFirstString(row, keys) {
  for (const k of keys) {
    if (!(k in row)) continue;
    const v = row[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/** @param {Record<string, unknown>} row */
function invoiceNumberFrom(row) {
  return pickFirstString(row, [
    'invoice_number',
    'invoiceNumber',
    'invoice_nr',
    'invoiceNr',
    'number',
    'document_number',
    'documentNumber',
    'cashBook_invoice_number',
    'belegnummer',
  ]);
}

/** @param {Record<string, unknown>} row */
function invoiceIdFrom(row) {
  return pickFirstString(row, [
    'invoice_id',
    'invoiceId',
    'invoice_uid',
    'uid',
    'cashBook_id',
    'id',
  ]);
}

/** @param {Record<string, unknown>} row */
function invoicePaymentFrom(row) {
  return pickFirstString(row, [
    'invoice_payment',
    'invoicePayment',
    'payment',
    'payment_type',
    'paymentType',
    'payment_method',
    'paymentMethod',
    'invoice_mode',
    'invoiceMode',
    'mode',
  ]);
}

/** @param {Record<string, unknown>} row */
function invoiceTimestampFrom(row) {
  return pickFirstString(row, [
    'invoice_timestamp',
    'invoiceTimestamp',
    'timestamp',
    'date',
    'created_at',
    'createdAt',
    'cashBook_timestamp',
  ]);
}

/** @param {Record<string, unknown>} row */
function invoiceDescriptionFrom(row) {
  return pickFirstString(row, [
    'invoice_description',
    'invoiceDescription',
    'description',
    'text',
    'cashBook_description',
  ]);
}

/** Stable fingerprint for synthetic ref (sorted keys). */
function rowFingerprint(row) {
  const keys = Object.keys(row).sort();
  const parts = keys.map((k) => `${k}=${JSON.stringify(row[k])}`);
  return parts.join('|').slice(0, 4000);
}

/** Odoo `ref` / idempotency: printable, non-empty, bounded length. */
function sanitizeOdooRef(s) {
  let t = String(s ?? '')
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 200);
  if (!t) t = 'HC';
  return t;
}

/**
 * Prefer invoice / document number, then id. If API omits both, use deterministic HC-<hex> from row + amount.
 * @param {Record<string, unknown>} row
 * @param {number} amount
 */
function invoiceRef(row, amount) {
  const num = invoiceNumberFrom(row);
  if (num && num !== '0') return sanitizeOdooRef(num);
  const idStr = invoiceIdFrom(row);
  if (idStr) return sanitizeOdooRef(idStr);
  let h = 5381;
  const basis = `${rowFingerprint(row)}|${Number.isFinite(amount) ? amount.toFixed(6) : 'na'}`;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return sanitizeOdooRef(`HC-${(h >>> 0).toString(16).padStart(8, '0')}`);
}

if (entries.length === 0) {
  console.warn(`${NODE}: HelloCash returned empty entries`, {
    rawType: typeof hc,
    rawKeys: hc && typeof hc === 'object' ? Object.keys(hc) : [],
    fetchedAt: hc.meta?.fetchedAt ?? input.fetchedAt ?? 'unknown',
  });
  return [
    {
      json: {
        skipped: false,
        mappedEmpty: true,
        message: 'No rows to map from HelloCash payload',
      },
    },
  ];
}

console.log(`${NODE}: HelloCash payload received`, {
  entryCount: entries.length,
  firstEntry: entries[0] ?? null,
  fetchedAt: hc.meta?.fetchedAt ?? input.fetchedAt ?? 'unknown',
});

const out = [];
const ac = /** @type {Record<string, number>} */ (config.accounts || {});
const odoo = /** @type {Record<string, unknown>} */ (config.odoo || {});

const emptyTax = [];

let skippedCancelled = 0;
let skippedAmount = 0;

for (const inv of entries) {
  if (!inv || typeof inv !== 'object') continue;
  if (isInvoiceCancelled(inv)) {
    skippedCancelled++;
    continue;
  }

  const row = /** @type {Record<string, unknown>} */ (inv);
  const idStr = invoiceIdFrom(row);
  const numStr = invoiceNumberFrom(row);
  const amount = parseInvoiceGross(row);
  if (!Number.isFinite(amount) || amount === 0) {
    skippedAmount++;
    continue;
  }

  const paymentRaw = invoicePaymentFrom(row);
  let route = normalizeInvoicePayment(paymentRaw);
  if (!route) {
    console.warn(
      `${NODE}: unknown invoice_payment ${JSON.stringify(paymentRaw)} for invoice ${numStr || idStr || '(no id)'}; falling back to Bar routing`,
    );
    route = 'BAR';
  }

  const tsRaw = invoiceTimestampFrom(row);
  const date = tsRaw.split(' ')[0] || new Date().toISOString().split('T')[0];
  const ref = invoiceRef(row, amount);
  const desc = invoiceDescriptionFrom(row);
  const lineNameBase = `HC ${numStr || idStr || '—'}: ${desc.substring(0, 50)}`;

  let taxRate = 19;
  if (Array.isArray(row.taxes) && row.taxes.length > 0) {
    const tax = row.taxes[0];
    if (tax && typeof tax === 'object' && /** @type {{ tax_taxRate?: unknown }} */ (tax).tax_taxRate !== undefined) {
      taxRate = parseInt(String(/** @type {{ tax_taxRate?: unknown }} */ (tax).tax_taxRate), 10) || 19;
    }
  }

  /** @type {number} */
  let journalId = 0;
  /** @type {number | undefined} */
  let debitAccount;
  const creditAccount = ac.erloese;
  /** @type {Record<string, unknown> | null} */
  let odooExtras = null;

  if (route === 'BAR') {
    journalId = resolveJournal(odoo.journalKasse, odoo, 'JOURNAL_KASSE');
    debitAccount = ac.kasse;
  } else if (route === 'BANKOMAT') {
    journalId = resolveJournal(odoo.journalBank, odoo, 'JOURNAL_BANK');
    debitAccount = ac.ec;
  } else if (route === 'KREDITKARTE') {
    journalId = resolveJournal(odoo.journalBank, odoo, 'JOURNAL_BANK');
    debitAccount = ac.kreditkarte;
  } else {
    journalId = resolveJournal(odoo.journalVerkauf, odoo, 'JOURNAL_VERKAUF');
    debitAccount = ac.rechnung;
    odooExtras = { payment_state: 'not_paid' };
  }

  const lineIds = [
    [0, 0, { account_id: debitAccount, debit: amount, credit: 0, name: lineNameBase, tax_ids: emptyTax }],
    [0, 0, { account_id: creditAccount, debit: 0, credit: amount, name: lineNameBase, tax_ids: emptyTax }],
  ];

  /** @type {Record<string, unknown>} */
  const odooVals = {
    ref,
    move_type: 'entry',
    journal_id: journalId,
    date,
    line_ids: lineIds,
    narration:
      `[n8n:hellocash→odoo] HelloCash Invoice #${numStr || '—'} (ID:${idStr || '—'}), invoice_payment:${paymentRaw || 'n/a'}, Amt:${amount.toFixed(2)}`,
  };
  if (odooExtras) Object.assign(odooVals, odooExtras);

  console.log(`${NODE}: mapped invoice ${idStr || ref}`, {
    ref,
    paymentMethod: route,
    amount,
    taxRate,
  });

  out.push({
    json: {
      hellocashId: idStr || ref,
      hellocashNumber: numStr || null,
      invoiceNumber: numStr || null,
      paymentMethod: route,
      taxRate,
      ref,
      odooVals,
    },
  });
}

if (out.length === 0) {
  const first = entries[0] && typeof entries[0] === 'object' ? /** @type {object} */ (entries[0]) : null;
  const firstKeys = first ? Object.keys(first).slice(0, 50) : [];
  console.warn(`${NODE}: nothing mapped`, {
    entryCount: entries.length,
    skippedCancelled,
    skippedAmount,
    firstEntryKeys: firstKeys,
  });
  return [
    {
      json: {
        skipped: false,
        mappedEmpty: true,
        message:
          'No entries mapped (cancellation, zero/unparseable gross amount, or missing totals). Check invoice_total / taxes[].tax_gross and invoice_cancellation.',
        diagnostic: {
          entryCount: entries.length,
          skippedCancelled,
          skippedAmount,
          firstEntryKeys: firstKeys,
        },
      },
    },
  ];
}

return out;
