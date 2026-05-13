/**
 * Unit: n8n node "HelloCash Fetch" — invoices bulk HTTP fetch with mocked httpRequest.
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

test('HelloCash Fetch: fetches invoices and returns entries + invoices map', async () => {
  const calls = [];
  const invoicePayload = {
    count: 2,
    limit: 1000,
    offset: 0,
    invoices: [
      {
        invoice_id: '1',
        invoice_number: '455',
        invoice_timestamp: '2017-09-15 09:59:13',
        invoice_payment: 'Bar',
        invoice_total: '2.00',
        invoice_cancellation: '0',
        taxes: [{ tax_taxRate: '19' }],
      },
      {
        invoice_id: '2',
        invoice_number: '456',
        invoice_cancellation: '1',
        invoice_total: '9.00',
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
          return invoicePayload;
        },
      },
    },
  });

  assert.equal(out[0].json.skipped, false);
  assert.equal(out[0].json.hellocashData.entries.length, 1);
  assert.equal(out[0].json.hellocashData.entries[0].invoice_number, '455');
  assert.ok(out[0].json.hellocashData.invoices['455']);
  assert.equal(out[0].json.hellocashData.meta.source, 'invoices');
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0]).includes('/invoices'), calls[0]);
});

test('HelloCash Fetch: accepts API body with entries array when invoices key absent', async () => {
  const payload = {
    count: 1,
    limit: 1000,
    offset: 0,
    entries: [
      {
        invoice_id: '9',
        invoice_number: '999',
        invoice_timestamp: '2026-05-10 10:00:00',
        invoice_payment: 'Bar',
        invoice_total: '1.00',
        invoice_cancellation: '0',
        taxes: [],
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
        httpRequest: async () => payload,
      },
    },
  });

  assert.equal(out[0].json.hellocashData.entries.length, 1);
  assert.equal(out[0].json.hellocashData.entries[0].invoice_number, '999');
  assert.ok(out[0].json.hellocashData.invoices['999']);
});

test('HelloCash Fetch: when HELLOCASH_QUERY_FROM/TO unset, URL dateFrom/dateTo match local today minus daysBack', async () => {
  function toDateString(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const daysBack = 7;
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - daysBack);
  const expectedFrom = toDateString(fromDate);
  const expectedTo = toDateString(today);

  const calls = [];
  await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '1',
      HELLOCASH_DAYS_BACK: String(daysBack),
    },
    $: mockConfigLoader$(sampleConfigJson()),
    self: {
      helpers: {
        httpRequest: async (opts) => {
          calls.push(opts.url);
          return { invoices: [] };
        },
      },
    },
  });
  const invUrl = calls.find((u) => String(u).includes('/invoices'));
  assert.ok(invUrl, 'expected an invoices request');
  const u = new URL(invUrl);
  assert.equal(u.searchParams.get('dateFrom'), expectedFrom);
  assert.equal(u.searchParams.get('dateTo'), expectedTo);
  assert.ok(String(invUrl).includes('limit='), 'limit should be present');
  assert.ok(String(invUrl).includes('offset='), 'offset should be present');
});

test('HelloCash Fetch: includes dateFrom and dateTo when HELLOCASH_QUERY_* set', async () => {
  const calls = [];
  await runAsyncCodeNode('02-hellocash-fetch.js', {
    $env: {
      HELLOCASH_API_TOKEN: 'tok',
      HELLOCASH_IGNORE_SYNC_HOUR: '1',
      HELLOCASH_QUERY_FROM: '2024-01-01',
      HELLOCASH_QUERY_TO: '2024-01-31',
    },
    $: mockConfigLoader$(sampleConfigJson()),
    self: {
      helpers: {
        httpRequest: async (opts) => {
          calls.push(opts.url);
          return { invoices: [] };
        },
      },
    },
  });
  const invUrl = calls[0];
  assert.ok(String(invUrl).includes('dateFrom='), invUrl);
  assert.ok(String(invUrl).includes('dateTo='), invUrl);
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
          return { invoices: [] };
        },
      },
    },
  });

  const invUrl = calls.find((u) => String(u).includes('/invoices'));
  assert.ok(invUrl, 'expected invoices request');
  assert.ok(
    String(invUrl).includes('/api/v1/invoices'),
    `expected single /api/v1 segment before invoices, got: ${invUrl}`,
  );
  assert.ok(!String(invUrl).includes('/api/v1/api/v1'), `must not duplicate /api/v1, got: ${invUrl}`);
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
          return { invoices: [] };
        },
      },
    },
  });

  const invUrl = calls.find((u) => String(u).includes('/invoices'));
  assert.ok(invUrl, 'expected invoices request');
  assert.ok(String(invUrl).startsWith('https://api.hellocash.business/'), invUrl);
  assert.ok(!String(invUrl).includes('/api/v1/api/v1'), invUrl);
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
      e instanceof Error &&
        'diagnostic' in e &&
        /** @type {{ diagnostic: { httpStatus?: number } }} */ (e).diagnostic.httpStatus === 401,
    );
  }
});
