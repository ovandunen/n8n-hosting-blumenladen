/**
 * Unit: n8n node "HelloCash Fetch" — two-phase HTTP fetch with mocked httpRequest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsyncCodeNode } from './harness.mjs';
import { mockConfigLoader$, sampleConfigJson } from './fixtures.mjs';

test('HelloCash Fetch: returns skipped when sync hour mismatches and ignore flag off', async () => {
  const config = sampleConfigJson();
  config.syncHour = 99;
  const $ = mockConfigLoader$(config);
  const out = await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '',
    },
    $,
    self: {
      helpers: {
        httpRequest: async () => {
          throw new Error('should not call HTTP when skipped by hour');
        },
      },
    },
  });
  assert.equal(out[0].json.skipped, true);
  assert.equal(out[0].json.reason, 'sync_hour');
});

test('HelloCash Fetch: fetches cashbook and returns entries + invoices map', async () => {
  const calls = [];
  const cashbookPayload = {
    entries: [
      {
        cashBook_id: '1234',
        cashBook_number: '284',
        cashBook_type: 'deposit',
        cashBook_total: '2.00',
        cashBook_cancellation: '0',
        cashBook_invoice_number: '455',
        cashBook_timestamp: '2017-09-15 09:59:13',
        cashBook_description: 'Test',
      },
    ],
  };
  const invoicePayload = {
    invoices: [
      {
        invoice_number: '455',
        invoice_payment: 'cash',
        invoice_cancellation: '0',
        taxes: [{ tax_taxRate: '19' }],
      },
    ],
  };

  const out = await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '1',
    },
    $: mockConfigLoader$(sampleConfigJson()),
    self: {
      helpers: {
        httpRequest: async (opts) => {
          calls.push(opts.url);
          if (String(opts.url).includes('/cashBook') || String(opts.url).includes('cashBook')) {
            return cashbookPayload;
          }
          return invoicePayload;
        },
      },
    },
  });

  assert.equal(out[0].json.skipped, false);
  assert.ok(out[0].json.hellocashData.entries.length >= 1);
  assert.ok(out[0].json.hellocashData.invoices['455']);
  assert.ok(calls.length >= 2);
});

test('HelloCash Fetch: cashbook URL omits unset/empty query params', async () => {
  const calls = [];
  await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '1',
    },
    $: mockConfigLoader$(sampleConfigJson()),
    self: {
      helpers: {
        httpRequest: async (opts) => {
          calls.push(opts.url);
          if (String(opts.url).includes('/cashBook') || String(opts.url).includes('cashBook')) {
            return { entries: [] };
          }
          return { invoices: [] };
        },
      },
    },
  });
  const cashUrl = calls.find((u) => String(u).includes('cashBook'));
  assert.ok(cashUrl, 'expected a cashBook request');
  assert.ok(!String(cashUrl).includes('search='), 'empty search should be omitted');
  assert.ok(!String(cashUrl).includes('dateFrom='), 'empty dateFrom should be omitted');
  assert.ok(!String(cashUrl).includes('dateTo='), 'empty dateTo should be omitted');
  assert.ok(String(cashUrl).includes('limit='), 'limit should be present');
  assert.ok(String(cashUrl).includes('offset='), 'offset should be present');
});

test('HelloCash Fetch: merges base URL path with list path (no duplicate /api/v1)', async () => {
  const calls = [];
  const cfg = sampleConfigJson();
  cfg.hellocash.baseUrl = 'https://api.hellocash.business/api/v1';

  await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '1',
    },
    $: mockConfigLoader$(cfg),
    self: {
      helpers: {
        httpRequest: async (opts) => {
          calls.push(opts.url);
          if (String(opts.url).includes('cashBook')) {
            return { entries: [] };
          }
          return { invoices: [] };
        },
      },
    },
  });

  const cashUrl = calls.find((u) => String(u).includes('cashBook'));
  assert.ok(cashUrl, 'expected cashBook request');
  assert.ok(
    String(cashUrl).includes('/api/v1/cashBook'),
    `expected single /api/v1 segment before cashBook, got: ${cashUrl}`,
  );
  assert.ok(
    !String(cashUrl).includes('/api/v1/api/v1'),
    `must not duplicate /api/v1, got: ${cashUrl}`,
  );
});

test('HelloCash Fetch: protocol-relative base //host is normalized to https', async () => {
  const calls = [];
  const cfg = sampleConfigJson();
  cfg.hellocash.baseUrl = '//api.hellocash.business/api/v1';

  await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '1',
    },
    $: mockConfigLoader$(cfg),
    self: {
      helpers: {
        httpRequest: async (opts) => {
          calls.push(opts.url);
          if (String(opts.url).includes('cashBook')) {
            return { entries: [] };
          }
          return { invoices: [] };
        },
      },
    },
  });

  const cashUrl = calls.find((u) => String(u).includes('cashBook'));
  assert.ok(cashUrl, 'expected cashBook request');
  assert.ok(String(cashUrl).startsWith('https://api.hellocash.business/'), cashUrl);
  assert.ok(!String(cashUrl).includes('/api/v1/api/v1'), cashUrl);
});

test('HelloCash Fetch: thrown error first line includes HTTP status when request fails', async () => {
  const cfg = sampleConfigJson();
  cfg.retry = { maxAttempts: 1, intervalMs: 1 };

  try {
    await runAsyncCodeNode('02-hellocash-fetch.js', {
      $env: {
        HELLOCASH_API_TOKEN: 'tok',
        HELLOCASH_IGNORE_SYNC_HOUR: '1',
      },
      $: mockConfigLoader$(cfg),
      self: {
        helpers: {
          httpRequest: async () => {
            const err = new Error('Request failed with status code 401');
            err.statusCode = 401;
            throw err;
          },
        },
      },
    });
    assert.fail('expected throw');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, /^HTTP 401 \|/m, msg.slice(0, 200));
    assert.ok(
      e instanceof Error && 'diagnostic' in e && /** @type {{ diagnostic: { httpStatus?: number } }} */ (e).diagnostic.httpStatus === 401,
    );
  }
});
