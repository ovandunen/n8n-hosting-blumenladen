/**
 * Map HelloCash cashbook entries (+ linked invoices) → Odoo account.move payloads.
 * Skips cancelled cashbook rows; tax on revenue (credit) line for deposits only.
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

const { entries, invoices } = hc;
/** @type {Record<string, unknown>} */
const invByNumber = invoices && typeof invoices === 'object' ? invoices : {};

function nowIso() {
  return new Date().toISOString();
}

/** @param {unknown} v */
function asFiniteNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

/** Normalize HelloCash payment descriptions → config.accountMap keys. */
function normalizePaymentMethod(raw) {
  const p = String(raw ?? '').toLowerCase().trim();
  if (!p) return 'CASH';

  // Voucher / Gutschein
  if (p.includes('voucher') || p.includes('gutschein') || p.includes('gift') || p.includes('gut')) return 'VOUCHER';

  // Cash
  if (p.includes('bar') || p.includes('cash') || p.includes('bargeld')) return 'CASH';

  // Card / EC / debit (German + common networks)
  if (
    p.includes('ec') ||
    p.includes('giro') ||
    p.includes('bankomat') ||
    p.includes('maestro') ||
    p.includes('debit') ||
    p.includes('karte') ||
    p.includes('card')
  )
    return 'EC';

  // Credit card (explicit)
  if (p.includes('credit') || p.includes('visa') || p.includes('mastercard') || p.includes('amex')) return 'CREDITCARD';

  // Online methods (treat as bank/EC unless you add a dedicated account bucket)
  if (p.includes('paypal') || p.includes('sofort') || p.includes('klarna') || p.includes('stripe')) return 'EC';

  return 'CASH';
}

/**
 * Extract split payment info from invoice if present.
 * Returns array of { method, amount } in the currency of the invoice/entry.
 * Falls back to single payment method when details are missing.
 *
 * Supports multiple possible shapes:
 * - invoice.payments: [{ payment_method, payment_amount }, ...]
 * - invoice.invoice_payments: [...]
 * - invoice.invoice_payment: "EC" (single)
 *
 * @param {unknown} invoice
 * @param {number} fallbackAmount
 */
function extractPayments(invoice, fallbackAmount) {
  if (!invoice || typeof invoice !== 'object') {
    return [{ method: 'CASH', amount: fallbackAmount }];
  }
  const inv = /** @type {Record<string, unknown>} */ (invoice);

  const candidates = inv.payments ?? inv.invoice_payments ?? inv.invoicePayments ?? null;
  if (Array.isArray(candidates) && candidates.length > 0) {
    /** @type {{ method: string, amount: number }[]} */
    const out = [];
    for (const p of candidates) {
      if (!p || typeof p !== 'object') continue;
      const po = /** @type {Record<string, unknown>} */ (p);
      const methodRaw = po.payment_method ?? po.method ?? po.type ?? po.name ?? inv.invoice_payment ?? '';
      const amountRaw = po.payment_amount ?? po.amount ?? po.total ?? null;
      const amount = asFiniteNumber(amountRaw);
      if (!amount || amount <= 0) continue;
      out.push({ method: normalizePaymentMethod(methodRaw), amount });
    }
    if (out.length > 0) return out;
  }

  return [{ method: normalizePaymentMethod(inv.invoice_payment ?? inv.payment ?? 'CASH'), amount: fallbackAmount }];
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

for (const entry of entries) {
  if (!entry || typeof entry !== 'object') continue;
  if (entry.cashBook_cancellation === '1') continue;

  const id = entry.cashBook_id;
  const number = entry.cashBook_number;
  const type = String(entry.cashBook_type || '').toLowerCase();
  const amount = Math.abs(parseFloat(String(entry.cashBook_total ?? '0')));
  if (!Number.isFinite(amount) || amount === 0) continue;

  const description = String(entry.cashBook_description || '');
  const invoiceNumber = entry.cashBook_invoice_number
    ? String(entry.cashBook_invoice_number)
    : '';

  const timestamp = String(entry.cashBook_timestamp || '');
  const date = timestamp.split(' ')[0] || new Date().toISOString().split('T')[0];

  const invoice = invoiceNumber && invByNumber[invoiceNumber] ? invByNumber[invoiceNumber] : null;

  const payments = extractPayments(invoice, amount);
  const paymentMethod = payments.length === 1 ? payments[0].method : 'SPLIT';

  let taxRate = 19;
  if (invoice && typeof invoice === 'object' && Array.isArray(invoice.taxes) && invoice.taxes.length > 0) {
    const tax = invoice.taxes[0];
    if (tax && typeof tax === 'object' && tax.tax_taxRate !== undefined) {
      taxRate = parseInt(String(tax.tax_taxRate), 10) || 19;
    }
  }

  // Only 7% and 19% Odoo taxes (TAX_ID_7 / TAX_ID_19). HelloCash may send 20 (AT); map to 19% tax id.
  const taxLookupKey = taxRate === 20 ? 19 : taxRate;
  const taxId = config.taxMap[taxLookupKey] ?? config.taxMap[19];

  const isDeposit =
    type === 'deposit' || type === 'income' || type === 'sale' || type === 'einnahme';
  const isWithdrawal =
    type === 'withdrawal' ||
    type === 'payout' ||
    type === 'expense' ||
    type === 'refund' ||
    type === 'ausgabe';

  const ref = `HC-${number}-${id}`;

  /** @type {any[]} */
  const lineIds = [];
  const lineNameBase = `HC ${number}: ${description.substring(0, 50)}`;

  if (isDeposit) {
    // Debit: one line per payment method (supports split payments).
    let debitSum = 0;
    for (const p of payments) {
      const am = config.accountMap[p.method];
      if (!am || !Number.isFinite(parseInt(String(am.debit), 10)) || !Number.isFinite(parseInt(String(am.credit), 10))) {
        console.warn(`${NODE}: unknown/invalid payment method mapping, skipping entry`, {
          at: nowIso(),
          hellocashId: id,
          ref,
          invoiceNumber: invoiceNumber || null,
          paymentMethod: p.method,
          availableMethods: Object.keys(config.accountMap || {}),
        });
        debitSum = null;
        break;
      }
      const amt = Math.abs(asFiniteNumber(p.amount) ?? 0);
      if (!amt) continue;
      debitSum += amt;
      lineIds.push([
        0,
        0,
        {
          account_id: am.debit,
          debit: amt,
          credit: 0,
          name: payments.length > 1 ? `${lineNameBase} [${p.method}]` : lineNameBase,
        },
      ]);
    }
    if (debitSum === null || lineIds.length === 0) continue;

    // Credit: revenue line (single) for total amount.
    const amForCredit = config.accountMap[payments[0]?.method || 'CASH'] || config.accountMap.CASH;
    if (!amForCredit) {
      console.warn(`${NODE}: missing accountMap.CASH and no payment mapping for credit line; skipping`, { ref, id });
      continue;
    }
    const creditLine = {
      account_id: amForCredit.credit,
      debit: 0,
      credit: amount,
      name: lineNameBase,
    };
    if (taxId) creditLine.tax_ids = [[6, 0, [taxId]]];
    lineIds.push([0, 0, creditLine]);
  } else if (isWithdrawal) {
    // Withdrawals are treated as reverse of deposits; split withdrawals are rare — keep single bucket based on invoice payment.
    const bucket = payments[0]?.method || 'CASH';
    const am = config.accountMap[bucket];
    if (!am) {
      console.warn(`${NODE}: unknown payment method "${bucket}" for withdrawal, skipping`, { ref, id });
      continue;
    }
    lineIds.push([
      0,
      0,
      {
        account_id: am.credit,
        debit: amount,
        credit: 0,
        name: `HC ${number} [${type}]: ${description.substring(0, 50)}`,
      },
    ]);
    lineIds.push([
      0,
      0,
      {
        account_id: am.debit,
        debit: 0,
        credit: amount,
        name: `HC ${number} [${type}]: ${description.substring(0, 50)}`,
      },
    ]);
  } else {
    console.warn(`${NODE}: unknown cashBook_type "${type}" for entry ${id}, skipping`);
    continue;
  }

  console.log(`${NODE}: mapped entry ${id}`, {
    ref,
    paymentMethod,
    amount,
    taxRate,
    splitPaymentCount: payments.length,
  });

  out.push({
    json: {
      hellocashId: id,
      hellocashNumber: number,
      invoiceNumber: invoiceNumber || null,
      paymentMethod,
      taxRate,
      ref,
      odooVals: {
        ref,
        move_type: 'entry',
        journal_id: config.odoo.journalId,
        date,
        line_ids: lineIds,
        // Marker helps operators & downstream dedupe tooling.
        narration:
          `[n8n:hellocash→odoo] HelloCash Entry #${number} (ID:${id}), Type:${type}, Inv:${invoiceNumber || 'n/a'}, ` +
          `Pay:${paymentMethod}${payments.length > 1 ? `(${payments.length} lines)` : ''}, Tax:${taxRate}%, Amt:${amount.toFixed(2)}`,
      },
    },
  });
}

if (out.length === 0) {
  return [
    {
      json: {
        skipped: false,
        mappedEmpty: true,
        message: 'No entries mapped (all cancelled or unknown type)',
      },
    },
  ];
}

return out;
