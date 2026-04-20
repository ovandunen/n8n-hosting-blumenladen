/**
 * Unit: n8n node "Odoo Post Moves" — JSON-RPC with mocked httpRequest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsyncCodeNode } from './harness.mjs';
import { mockConfigLoader$, sampleConfigJson } from './fixtures.mjs';

test('Odoo Post Moves: creates move when search_read returns empty', async () => {
  const mappedItem = {
    hellocashId: '1',
    hellocashNumber: '10',
    invoiceNumber: null,
    ref: 'HC-10-1',
    paymentMethod: 'CASH',
    taxRate: 19,
    odooVals: {
      ref: 'HC-10-1',
      move_type: 'entry',
      journal_id: 1,
      date: '2024-01-15',
      line_ids: [
        [0, 0, { account_id: 1000, debit: 10, credit: 0, name: 'x' }],
        [0, 0, { account_id: 8400, debit: 0, credit: 10, name: 'y' }],
      ],
    },
  };

  let searchCalls = 0;
  let createCalls = 0;

  const out = await runAsyncCodeNode('04-odoo-post-moves.js', {
    $env: { ODOO_PASSWORD: 'secret' },
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: mappedItem }],
    self: {
      helpers: {
        httpRequest: async (opts) => {
          const body = opts.body;
          const method = body?.params?.args?.[4];
          if (method === 'search_read') {
            searchCalls++;
            return { result: [] };
          }
          if (method === 'create') {
            createCalls++;
            return { result: 501 };
          }
          throw new Error(`unexpected RPC ${method}`);
        },
      },
    },
  });

  assert.equal(searchCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(out[0].json.success, true);
  assert.equal(out[0].json.odooMoveId, 501);
});

test('Odoo Post Moves: skips when mappedEmpty', async () => {
  const out = await runAsyncCodeNode('04-odoo-post-moves.js', {
    $env: { ODOO_PASSWORD: 'secret' },
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: { mappedEmpty: true } }],
    self: {
      helpers: {
        httpRequest: async () => {
          throw new Error('should not HTTP');
        },
      },
    },
  });
  assert.equal(out[0].json.odooSkipped, true);
});

test('Odoo Post Moves: throws if ODOO_PASSWORD missing', async () => {
  await assert.rejects(
    async () =>
      runAsyncCodeNode('04-odoo-post-moves.js', {
        $env: {},
        $: mockConfigLoader$(sampleConfigJson()),
        items: [{ json: { odooVals: { ref: 'x' } } }],
        self: { helpers: { httpRequest: async () => ({}) } },
      }),
    /ODOO_PASSWORD/,
  );
});
