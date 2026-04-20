/**
 * Unit: n8n node "Config Loader" — validates env and returns [{ json: config }].
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyncCodeNode } from './harness.mjs';
import { validConfigEnv } from './fixtures.mjs';

test('Config Loader: returns config with expected sections', () => {
  const out = runSyncCodeNode('01-config-loader.js', { $env: validConfigEnv });
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  const c = out[0].json;
  assert.ok(c.hellocash?.baseUrl?.includes('hellocash'));
  assert.ok(c.odoo?.db);
  assert.ok(c.accountMap?.CASH);
  assert.equal(c.taxMap[19], 19);
  assert.equal(c.taxMap[7], 7);
  assert.equal(c.syncHour, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(c, 'ODOO_PASSWORD'));
  assert.ok(!JSON.stringify(c).toLowerCase().includes('secret'));
});

test('Config Loader: throws when a required env var is missing', () => {
  const bad = { ...validConfigEnv };
  delete bad.HELLOCASH_BASE_URL;
  assert.throws(() => runSyncCodeNode('01-config-loader.js', { $env: bad }), /HELLOCASH_BASE_URL/);
});
