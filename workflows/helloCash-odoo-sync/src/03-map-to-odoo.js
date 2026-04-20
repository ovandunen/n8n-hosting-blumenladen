/**
 * Map HelloCash cashbook entries (+ linked invoices) → Odoo account.move payloads.
 * Skips cancelled cashbook rows; tax on revenue (credit) line for deposits only.
 */

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

if (entries.length === 0) {
  console.warn('Map to Odoo: HelloCash returned empty entries', {
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

console.log('HelloCash payload received', {
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

  let paymentMethod = 'CASH';
  if (invoice && typeof invoice === 'object' && invoice.invoice_payment) {
    const p = String(invoice.invoice_payment).toLowerCase();
    if (p.includes('ec') || p.includes('card') || p.includes('debit')) {
      paymentMethod = 'EC';
    } else if (p.includes('credit')) {
      paymentMethod = 'CREDITCARD';
    } else if (p.includes('voucher') || p.includes('gutschein') || p.includes('gut')) {
      paymentMethod = 'VOUCHER';
    } else if (p.includes('bar') || p.includes('cash')) {
      paymentMethod = 'CASH';
    }
  }

  let taxRate = 19;
  if (invoice && typeof invoice === 'object' && Array.isArray(invoice.taxes) && invoice.taxes.length > 0) {
    const tax = invoice.taxes[0];
    if (tax && typeof tax === 'object' && tax.tax_taxRate !== undefined) {
      taxRate = parseInt(String(tax.tax_taxRate), 10) || 19;
    }
  }

  const am = config.accountMap[paymentMethod];
  if (!am) {
    throw new Error(`Map: unknown payment method "${paymentMethod}" for entry ${id}`);
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

  let lineDebit;
  let lineCredit;

  if (isDeposit) {
    lineDebit = {
      account_id: am.debit,
      debit: amount,
      credit: 0,
      name: `HC ${number}: ${description.substring(0, 50)}`,
    };
    lineCredit = {
      account_id: am.credit,
      debit: 0,
      credit: amount,
      name: `HC ${number}: ${description.substring(0, 50)}`,
    };
    if (taxId) {
      lineCredit.tax_ids = [[6, 0, [taxId]]];
    }
  } else if (isWithdrawal) {
    lineDebit = {
      account_id: am.credit,
      debit: amount,
      credit: 0,
      name: `HC ${number} [${type}]: ${description.substring(0, 50)}`,
    };
    lineCredit = {
      account_id: am.debit,
      debit: 0,
      credit: amount,
      name: `HC ${number} [${type}]: ${description.substring(0, 50)}`,
    };
  } else {
    console.warn(`Map: unknown cashBook_type "${type}" for entry ${id}, skipping`);
    continue;
  }

  console.log(`Mapped entry ${id}`, {
    ref,
    paymentMethod,
    amount,
    taxRate,
    debitAccount: am.debit,
    creditAccount: am.credit,
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
        line_ids: [
          [0, 0, lineDebit],
          [0, 0, lineCredit],
        ],
        narration: `HelloCash Entry #${number} (ID:${id}), Type:${type}, Inv:${invoiceNumber || 'n/a'}, Pay:${paymentMethod}, Tax:${taxRate}%, Amt:${amount.toFixed(2)}`,
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
