/**
 * Unit: n8n node "Map to Odoo" — cashbook + invoices → account.move payloads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyncCodeNode } from './harness.mjs';
import { mockConfigLoader$, sampleConfigJson } from './fixtures.mjs';

const depositEntry = {
  cashBook_id: '1234',
  cashBook_number: '284',
  cashBook_type: 'deposit',
  cashBook_total: '10.00',
  cashBook_cancellation: '0',
  cashBook_invoice_number: '2',
  cashBook_timestamp: '2017-09-15 09:59:13',
  cashBook_description: 'Sale',
};

test('Map to Odoo: maps deposit with invoice payment and tax', () => {
  const input = {
    skipped: false,
    hellocashData: {
      entries: [depositEntry],
      invoices: {
        2: {
          invoice_number: '2',
          invoice_payment: 'cash',
          invoice_cancellation: '0',
          taxes: [{ tax_taxRate: '19' }],
        },
      },
      meta: { fetchedAt: '2024-01-01T00:00:00.000Z' },
    },
  };

  const out = runSyncCodeNode('03-map-to-odoo.js', {
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: input }],
  });

  assert.equal(out.length, 1);
  assert.ok(out[0].json.odooVals?.ref?.startsWith('HC-'));
  assert.equal(out[0].json.odooVals.line_ids.length, 2);
  assert.equal(out[0].json.paymentMethod, 'CASH');
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
