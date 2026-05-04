/**
 * Unit tests: Odoo canvas Code nodes (Prepare, Dedupe/Create HTTP, Process Results).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsyncCodeNode, runSyncCodeNode } from './harness.mjs';
import { mockConfigLoader$, sampleConfigJson, validConfigEnv } from './fixtures.mjs';

const validMappedItem = {
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

function mockPrepareItem$(prepareJson, configJson = sampleConfigJson()) {
  return function $(name) {
    if (name === 'Config Loader') return { first: () => ({ json: configJson }) };
    if (name === 'Odoo Prepare Payload') return { item: { json: prepareJson } };
    throw new Error(`Unexpected $('${name}')`);
  };
}

test('Odoo Prepare Payload: builds JSON-RPC bodies when row is active', () => {
  const out = runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
    $env: { ODOO_PASSWORD: 'secret' },
    $: mockConfigLoader$(),
    items: [{ json: validMappedItem }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.skip, false);
  assert.equal(out[0].json.odooRpc, 'jsonrpc');
  assert.match(out[0].json.rpcUrl, /\/jsonrpc$/);
  assert.equal(out[0].json.dedupeBody?.method, 'call');
  assert.equal(out[0].json.createBody?.method, 'call');
  const dedupeArgs = out[0].json.dedupeBody?.params?.args;
  assert.equal(dedupeArgs?.[4], 'search_read');
});

test('Odoo Prepare Payload: builds JSON-2 URLs and bodies when config.odoo.rpc is json2', () => {
  const cfg = {
    ...sampleConfigJson(),
    odoo: { ...sampleConfigJson().odoo, rpc: 'json2', uid: null },
  };
  const out = runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
    $env: { ...validConfigEnv, ODOO_API_KEY: 'bearer-token', ODOO_RPC: 'json2' },
    $: mockConfigLoader$(cfg),
    items: [{ json: validMappedItem }],
  });
  assert.equal(out[0].json.odooRpc, 'json2');
  assert.match(out[0].json.dedupeUrl, /\/json\/2\/account\.move\/search_read$/);
  assert.match(out[0].json.createUrl, /\/json\/2\/account\.move\/create$/);
  assert.deepEqual(out[0].json.dedupeJson2Body?.domain, [['ref', '=', 'HC-10-1']]);
  assert.ok(Array.isArray(out[0].json.createJson2Body?.vals_list));
  assert.equal(out[0].json.rpcUrl, '');
});

test('Odoo Dedupe Check: JSON-2 Bearer request', async () => {
  const cfg = {
    ...sampleConfigJson(),
    odoo: { ...sampleConfigJson().odoo, rpc: 'json2', uid: null },
  };
  const prep = runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
    $env: { ...validConfigEnv, ODOO_API_KEY: 'k2', ODOO_RPC: 'json2' },
    $: mockConfigLoader$(cfg),
    items: [{ json: validMappedItem }],
  })[0].json;

  const out = await runAsyncCodeNode('11-odoo-dedupe-http-canvas.js', {
    $: mockPrepareItem$(prep, cfg),
    items: [{ json: prep }],
    $env: { ODOO_API_KEY: 'k2' },
    self: {
      helpers: {
        httpRequest: async (opts) => {
          assert.match(String(opts.url), /\/json\/2\/account\.move\/search_read$/);
          assert.match(String(opts.headers?.Authorization ?? ''), /^bearer /i);
          assert.equal(opts.headers?.['X-Odoo-Database'], 'testdb');
          return [{ id: 1, name: 'M1', ref: 'HC-10-1', state: 'posted' }];
        },
      },
    },
  });

  assert.ok(out && out.json);
  assert.equal(out.json.dedupeRpc?.result?.length, 1);
});

test('Odoo Prepare Payload: no RPC bodies when mappedEmpty', () => {
  const out = runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
    $env: { ODOO_PASSWORD: 'secret' },
    $: mockConfigLoader$(),
    items: [{ json: { mappedEmpty: true } }],
  });
  assert.equal(out[0].json.skip, true);
  assert.equal(out[0].json.dedupeBody, null);
});

test('Odoo Prepare Payload: throws if ODOO_PASSWORD missing', () => {
  assert.throws(
    () =>
      runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
        $env: {},
        $: mockConfigLoader$(),
        items: [{ json: validMappedItem }],
      }),
    /ODOO_PASSWORD/,
  );
});

test('Odoo Dedupe Check: this.helpers.httpRequest merges RPC with prepare row', async () => {
  const prep = runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
    $env: { ODOO_PASSWORD: 'secret' },
    $: mockConfigLoader$(),
    items: [{ json: validMappedItem }],
  })[0].json;

  const out = await runAsyncCodeNode('11-odoo-dedupe-http-canvas.js', {
    $: mockPrepareItem$(prep),
    items: [{ json: prep }],
    self: {
      helpers: {
        httpRequest: async (opts) => {
          assert.equal(opts.body?.params?.args?.[4], 'search_read');
          return { jsonrpc: '2.0', result: [], id: 1 };
        },
      },
    },
  });

  assert.ok(out && out.json);
  assert.deepEqual(out.json.dedupeRpc, { jsonrpc: '2.0', result: [], id: 1 });
  assert.equal(out.json.ref, 'HC-10-1');
  assert.ok(out.json.createBody);
});

test('Odoo Create Move: this.helpers.httpRequest merges create RPC', async () => {
  const prep = runSyncCodeNode('05-odoo-prepare-payload-canvas.js', {
    $env: { ODOO_PASSWORD: 'secret' },
    $: mockConfigLoader$(),
    items: [{ json: validMappedItem }],
  })[0].json;

  const dedupeRow = {
    ...prep,
    dedupeRpc: { result: [] },
    httpDedupeMeta: { statusCode: 200 },
  };

  function mockDedupe$(name) {
    if (name === 'Config Loader') return { first: () => ({ json: sampleConfigJson() }) };
    if (name === 'Odoo Dedupe Check') return { item: { json: dedupeRow } };
    throw new Error(`Unexpected $('${name}')`);
  }

  const out = await runAsyncCodeNode('12-odoo-create-http-canvas.js', {
    $: mockDedupe$,
    items: [{ json: dedupeRow }],
    self: {
      helpers: {
        httpRequest: async (opts) => {
          assert.equal(opts.body?.params?.args?.[4], 'create');
          return { result: 501 };
        },
      },
    },
  });

  assert.ok(out && out.json);
  assert.equal(out.json.createRpc?.result, 501);
  assert.equal(out.json.ref, 'HC-10-1');
});

test('Odoo Process Results: success when create RPC returns id', () => {
  const row = {
    ...validMappedItem,
    dedupeRpc: { result: [] },
    httpDedupeMeta: {},
    createRpc: { result: 777 },
    httpCreateMeta: {},
  };
  const out = runSyncCodeNode('10-odoo-process-results-canvas.js', {
    $env: {},
    $: mockConfigLoader$(),
    items: [{ json: row }],
  });
  assert.equal(out[0].json.success, true);
  assert.equal(out[0].json.odooMoveId, 777);
});

test('Odoo Process Results: idempotent when dedupe finds existing move', () => {
  const row = {
    ...validMappedItem,
    dedupeRpc: { result: [{ id: 99, state: 'posted', name: 'MISC/2024/0001', ref: 'HC-10-1' }] },
    httpDedupeMeta: {},
  };
  const out = runSyncCodeNode('10-odoo-process-results-canvas.js', {
    $env: {},
    $: mockConfigLoader$(),
    items: [{ json: row }],
  });
  assert.equal(out[0].json.success, true);
  assert.equal(out[0].json.idempotent, true);
  assert.equal(out[0].json.odooMoveId, 99);
});

test('Odoo Process Results: aggregate gate throws a detailed message on create RPC failure', () => {
  const row = {
    ...validMappedItem,
    dedupeRpc: { result: [] },
    httpDedupeMeta: {},
    createRpc: { error: { message: 'Forced create failure for test' } },
    httpCreateMeta: {},
  };

  assert.throws(
    () =>
      runSyncCodeNode('10-odoo-process-results-canvas.js', {
        $env: {},
        $: mockConfigLoader$(),
        items: [{ json: row }],
      }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /HC-10-1/, 'must name the failing ref in the thrown message');
      assert.match(e.message, /Per-move details/i, 'must include an expanded detail section');
      assert.match(e.message, /host=odoo\.example\.com/);
      assert.match(e.message, /tls=1/);
      assert.match(e.message, /N8N_ODPO_AGG_FAIL_JSON/, 'UI message should point at grep-able log line');
      assert.match(e.message, /helpers\.httpRequest|HTTP/i, 'aggregate should mention transport/RPC');
      assert.match(e.message, /jsonrpc/i, 'should mention JSON-RPC path');
      assert.doesNotMatch(e.message, /unknown error/i);
      assert.match(e.message, /Forced create failure for test/);
      return true;
    },
  );
});
