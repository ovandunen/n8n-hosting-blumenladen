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
    $env: { ODOO_API_KEY: 'secret' },
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
    $env: { ODOO_API_KEY: 'secret' },
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

test('Odoo Post Moves: throws if ODOO_API_KEY missing', async () => {
  await assert.rejects(
    async () =>
      runAsyncCodeNode('04-odoo-post-moves.js', {
        $env: {},
        $: mockConfigLoader$(sampleConfigJson()),
        items: [{ json: { odooVals: { ref: 'x' } } }],
        self: { helpers: { httpRequest: async () => ({}) } },
      }),
    /ODOO_API_KEY/,
  );
});

test('Odoo Post Moves: permanent conflict on create skips item and does not throw batch', async () => {
  const mappedItem = {
    hellocashId: '99',
    hellocashNumber: '10',
    invoiceNumber: null,
    ref: 'HC-PERM-1',
    paymentMethod: 'CASH',
    taxRate: 19,
    odooVals: {
      ref: 'HC-PERM-1',
      move_type: 'entry',
      journal_id: 1,
      date: '2024-01-15',
      line_ids: [
        [0, 0, { account_id: 1000, debit: 10, credit: 0, name: 'x' }],
        [0, 0, { account_id: 8400, debit: 0, credit: 10, name: 'y' }],
      ],
    },
  };

  const out = await runAsyncCodeNode('04-odoo-post-moves.js', {
    $env: { ODOO_API_KEY: 'secret' },
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: mappedItem }],
    self: {
      helpers: {
        httpRequest: async (opts) => {
          const method = opts.body?.params?.args?.[4];
          if (method === 'search_read') return { result: [] };
          if (method === 'create') {
            return {
              error: {
                code: 0,
                message: 'Another model is using the record you are trying to delete.',
                data: {
                  message: 'Another model is using the record you are trying to delete.',
                  debug: '',
                },
              },
            };
          }
          throw new Error(`unexpected RPC ${method}`);
        },
      },
    },
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].json.skipped, true);
  assert.equal(out[0].json.success, false);
  assert.equal(out[0].json.reason, 'odoo_move_locked');
  assert.equal(out[0].json.action, 'requires_manual_reconciliation');
  assert.match(String(out[0].json.error ?? ''), /Another model is using/i);
});

test('Odoo Post Moves: mixed permanent skip and success returns without throw', async () => {
  const good = {
    hellocashId: '1',
    ref: 'HC-OK-1',
    odooVals: {
      ref: 'HC-OK-1',
      move_type: 'entry',
      journal_id: 1,
      date: '2024-01-15',
      line_ids: [
        [0, 0, { account_id: 1000, debit: 5, credit: 0, name: 'a' }],
        [0, 0, { account_id: 8400, debit: 0, credit: 5, name: 'b' }],
      ],
    },
  };
  const bad = {
    hellocashId: '2',
    ref: 'HC-BAD-1',
    odooVals: {
      ref: 'HC-BAD-1',
      move_type: 'entry',
      journal_id: 1,
      date: '2024-01-15',
      line_ids: [
        [0, 0, { account_id: 1000, debit: 7, credit: 0, name: 'c' }],
        [0, 0, { account_id: 8400, debit: 0, credit: 7, name: 'd' }],
      ],
    },
  };

  const out = await runAsyncCodeNode('04-odoo-post-moves.js', {
    $env: { ODOO_API_KEY: 'secret' },
    $: mockConfigLoader$(sampleConfigJson()),
    items: [{ json: good }, { json: bad }],
    self: {
      helpers: {
        httpRequest: async (opts) => {
          const method = opts.body?.params?.args?.[4];
          const innerArgs = opts.body?.params?.args?.[5];
          if (method === 'search_read') return { result: [] };
          if (method === 'create') {
            const vals = innerArgs?.[0]?.[0];
            const ref = vals?.ref;
            if (ref === 'HC-OK-1') return { result: 777 };
            return {
              error: {
                code: 0,
                message: 'Line already reconciled',
                data: { message: 'already reconciled', debug: '' },
              },
            };
          }
          throw new Error(`unexpected ${method}`);
        },
      },
    },
  });

  assert.equal(out.length, 2);
  const okRow = out.find((r) => r.json.ref === 'HC-OK-1');
  const skipRow = out.find((r) => r.json.ref === 'HC-BAD-1');
  assert.equal(okRow?.json.success, true);
  assert.equal(okRow?.json.odooMoveId, 777);
  assert.equal(skipRow?.json.skipped, true);
  assert.equal(skipRow?.json.reason, 'odoo_move_reconciled');
});
