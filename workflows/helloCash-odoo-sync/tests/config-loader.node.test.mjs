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
  assert.equal(c.odoo?.rpc, 'jsonrpc');
  assert.ok(!Object.prototype.hasOwnProperty.call(c, 'ODOO_PASSWORD'));
  assert.ok(!JSON.stringify(c).toLowerCase().includes('secret'));
});

test('Config Loader: ODOO_RPC=json2 accepts ODOO_API_KEY without ODOO_UID', () => {
  const env = { ...validConfigEnv };
  delete env.ODOO_UID;
  delete env.ODOO_PASSWORD;
  env.ODOO_RPC = 'json2';
  env.ODOO_API_KEY = 'api-key-value';
  const out = runSyncCodeNode('01-config-loader.js', { $env: env });
  assert.equal(out[0].json.odoo.rpc, 'json2');
  assert.equal(out[0].json.odoo.uid, null);
});

test('Config Loader: ODOO_USE_JSON2=1 selects json2', () => {
  const env = { ...validConfigEnv };
  delete env.ODOO_UID;
  delete env.ODOO_PASSWORD;
  env.ODOO_USE_JSON2 = '1';
  env.ODOO_API_KEY = 'k';
  const out = runSyncCodeNode('01-config-loader.js', { $env: env });
  assert.equal(out[0].json.odoo.rpc, 'json2');
});

test('Config Loader: json2 throws when neither ODOO_API_KEY nor ODOO_PASSWORD', () => {
  const env = { ...validConfigEnv };
  delete env.ODOO_UID;
  delete env.ODOO_PASSWORD;
  env.ODOO_RPC = 'json2';
  assert.throws(() => runSyncCodeNode('01-config-loader.js', { $env: env }), /ODOO_API_KEY or ODOO_PASSWORD/);
});

test('Config Loader: throws when a required env var is missing', () => {
  const bad = { ...validConfigEnv };
  delete bad.HELLOCASH_BASE_URL;
  assert.throws(() => runSyncCodeNode('01-config-loader.js', { $env: bad }), /HELLOCASH_BASE_URL/);
});

test('Config Loader: strips trailing /jsonrpc from ODOO_BASE_URL', () => {
  const env = { ...validConfigEnv, ODOO_BASE_URL: 'http://host.docker.internal:8069/jsonrpc' };
  const out = runSyncCodeNode('01-config-loader.js', { $env: env });
  assert.equal(out[0].json.odoo.baseUrl, 'http://host.docker.internal:8069');
});

test('Config Loader: rejects ODOO_BASE_URL that is only a port (would become 8069/jsonrpc)', () => {
  const env = { ...validConfigEnv, ODOO_BASE_URL: '8069' };
  assert.throws(() => runSyncCodeNode('01-config-loader.js', { $env: env }), /ODOO_BASE_URL must be a full URL/);
});
