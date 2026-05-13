/**
 * Unit: n8n node "Map to Odoo" — invoice_payment → account.move payloads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyncCodeNode } from './harness.mjs';
import { mockConfigLoader$, sampleConfigJson, sampleConfigJsonBankJournalFallback } from './fixtures.mjs';

function baseInvoice(overrides) {
  return {
    invoice_id: '77',
    invoice_number: '100',
    invoice_total: '42.50',
    invoice_cancellation: '0',
    invoice_timestamp: '2024-06-01 12:00:00',
    invoice_description: 'Test line',
    ...overrides,
  };
}

function taxIdsOk(line) {
  return Array.isArray(line.tax_ids) && line.tax_ids.length === 0;
}

test('Map to Odoo: Bar — Kasse journal, debit Kasse, credit Erlöse, ref from invoice_number', () => {
  const inv = baseInvoice({
    invoice_payment: 'Bar',
    invoice_number: 'INV-500',
  });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.odooVals.journal_id, 101);
  assert.equal(out[0].json.odooVals.ref, 'INV-500');
  assert.equal(out[0].json.paymentMethod, 'BAR');
  const d0 = out[0].json.odooVals.line_ids[0][2];
  const d1 = out[0].json.odooVals.line_ids[1][2];
  assert.equal(d0.account_id, 1612);
  assert.equal(d0.debit, 42.5);
  assert.ok(taxIdsOk(d0));
  assert.equal(d1.account_id, 1912);
  assert.equal(d1.credit, 42.5);
  assert.ok(taxIdsOk(d1));
  assert.ok(!Object.prototype.hasOwnProperty.call(out[0].json.odooVals, 'payment_state'));
});

test('Map to Odoo: ref uses number and id when invoice_number / invoice_id absent', () => {
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [
      {
        json: {
          skipped: false,
          hellocashData: {
            entries: [
              {
                id: 'api-442',
                number: 'RN-9',
                payment: 'Bar',
                invoice_timestamp: '2024-01-01 00:00:00',
                invoice_total: '10.00',
                invoice_cancellation: '0',
              },
            ],
            invoices: {},
          },
        },
      },
    ],
  });
  assert.equal(out[0].json.ref, 'RN-9');
  assert.equal(out[0].json.odooVals.ref, 'RN-9');
  assert.equal(out[0].json.invoiceNumber, 'RN-9');
});

test('Map to Odoo: non-empty synthetic ref when number and id absent', () => {
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [
      {
        json: {
          skipped: false,
          hellocashData: {
            entries: [
              {
                payment: 'Bar',
                date: '2026-05-13',
                taxes: [{ tax_gross: '12.00' }],
                row_uid: 'unique-a',
                invoice_cancellation: '0',
              },
            ],
            invoices: {},
          },
        },
      },
    ],
  });
  assert.match(out[0].json.ref, /^HC-[0-9a-f]{8}$/);
  assert.equal(out[0].json.odooVals.ref, out[0].json.ref);
});

test('Map to Odoo: ref falls back to invoice_id when invoice_number empty', () => {
  const inv = baseInvoice({
    invoice_payment: 'Bar',
    invoice_number: '',
    invoice_id: '99901',
  });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.ref, '99901');
});

test('Map to Odoo: Bankomat — Bank journal, debit ACCOUNT_EC, credit Erlöse', () => {
  const inv = baseInvoice({ invoice_payment: 'Bankomat', invoice_number: 'EC-1' });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.journal_id, 102);
  assert.equal(out[0].json.paymentMethod, 'BANKOMAT');
  const d0 = out[0].json.odooVals.line_ids[0][2];
  const d1 = out[0].json.odooVals.line_ids[1][2];
  assert.equal(d0.account_id, 1466);
  assert.equal(d1.account_id, 1912);
  assert.ok(taxIdsOk(d0) && taxIdsOk(d1));
});

test('Map to Odoo: Kreditkarte — Bank journal, debit ACCOUNT_KREDITKARTE, credit Erlöse', () => {
  const inv = baseInvoice({ invoice_payment: 'Kreditkarte', invoice_number: 'KK-9' });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.journal_id, 102);
  assert.equal(out[0].json.paymentMethod, 'KREDITKARTE');
  const d0 = out[0].json.odooVals.line_ids[0][2];
  const d1 = out[0].json.odooVals.line_ids[1][2];
  assert.equal(d0.account_id, 1466);
  assert.equal(d1.account_id, 1912);
  assert.ok(taxIdsOk(d0) && taxIdsOk(d1));
});

test('Map to Odoo: Kreditrechnung — Verkauf journal, debit ACCOUNT_RECHNUNG, credit Erlöse, payment_state not_paid', () => {
  const inv = baseInvoice({ invoice_payment: 'Kreditrechnung', invoice_number: 'R-7' });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.journal_id, 103);
  assert.equal(out[0].json.paymentMethod, 'KREDITRECHNUNG');
  const d0 = out[0].json.odooVals.line_ids[0][2];
  const d1 = out[0].json.odooVals.line_ids[1][2];
  assert.equal(d0.account_id, 1464);
  assert.equal(d1.account_id, 1912);
  assert.ok(taxIdsOk(d0) && taxIdsOk(d1));
  assert.equal(out[0].json.odooVals.payment_state, 'not_paid');
});

test('Map to Odoo: Bankomat uses ODOO_JOURNAL_ID when JOURNAL_BANK is unset', () => {
  const inv = baseInvoice({ invoice_payment: 'Bankomat', invoice_number: 'EC-FB' });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJsonBankJournalFallback()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.journal_id, 1);
});

test('Map to Odoo: skips invoice_cancellation', () => {
  const inv = baseInvoice({ invoice_payment: 'Bar', invoice_cancellation: '1' });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.mappedEmpty, true);
  assert.equal(out[0].json.diagnostic?.skippedCancelled, 1);
  assert.equal(out[0].json.diagnostic?.skippedAmount, 0);
});

test('Map to Odoo: skips numeric invoice_cancellation 1', () => {
  const inv = baseInvoice({ invoice_payment: 'Bar', invoice_cancellation: 1 });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.mappedEmpty, true);
});

test('Map to Odoo: gross from taxes[].tax_gross when invoice_total missing', () => {
  const inv = baseInvoice({
    invoice_payment: 'Bar',
    invoice_number: 'T-1',
    invoice_total: undefined,
    taxes: [{ tax_gross: '10.00' }, { tax_gross: '5.50' }],
  });
  delete inv.invoice_total;
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.line_ids[0][2].debit, 15.5);
});

test('Map to Odoo: parses EU decimal comma on invoice_total', () => {
  const inv = baseInvoice({
    invoice_payment: 'Bar',
    invoice_number: 'EU-1',
    invoice_total: '42,50',
  });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.line_ids[0][2].debit, 42.5);
});

test('Map to Odoo: falls back to cashBook_total when invoice totals missing', () => {
  const inv = baseInvoice({
    invoice_payment: 'Bar',
    invoice_number: 'CB-1',
    cashBook_total: '99.00',
  });
  delete inv.invoice_total;
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.line_ids[0][2].debit, 99);
});

test('Map to Odoo: unknown invoice_payment falls back to Bar routing', () => {
  const inv = baseInvoice({ invoice_payment: 'Mystery', invoice_number: 'U-1' });
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: false, hellocashData: { entries: [inv], invoices: {} } } }],
  });
  assert.equal(out[0].json.odooVals.journal_id, 101);
  assert.equal(out[0].json.paymentMethod, 'BAR');
  assert.equal(out[0].json.odooVals.ref, 'U-1');
  const d0 = out[0].json.odooVals.line_ids[0][2];
  assert.equal(d0.account_id, 1612);
  assert.ok(taxIdsOk(d0));
});

test('Map to Odoo: Bankomat throws when JOURNAL_BANK empty and ODOO_JOURNAL_ID invalid', () => {
  const cfg = sampleConfigJson();
  cfg.odoo = { ...cfg.odoo, journalBank: null, journalId: 0 };
  assert.throws(
    () =>
      runSyncCodeNode('03-map-to-odoo.js', {
        $: mockConfigLoader$(cfg),
        items: [
          {
            json: {
              skipped: false,
              hellocashData: { entries: [baseInvoice({ invoice_payment: 'Bankomat' })], invoices: {} },
            },
          },
        ],
      }),
    /JOURNAL_BANK/,
  );
});

test('Map to Odoo: passes through skipped input', () => {
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { skipped: true, reason: 'sync_hour' } }],
  });
  assert.equal(out[0].json.skipped, true);
});

test('Map to Odoo: mappedEmpty when no entries', () => {
  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [
      {
        json: {
          skipped: false,
          hellocashData: { entries: [], invoices: {} },
        },
      },
    ],
  });
  assert.equal(out[0].json.mappedEmpty, true);
});
