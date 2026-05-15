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
  assert.equal(c.accounts.kasse, 1612);
  assert.equal(c.accounts.erloese, 1912);
  assert.equal(c.accounts.ec, 1466);
  assert.equal(c.accounts.kreditkarte, 1466);
  assert.equal(c.accounts.rechnung, 1464);
  assert.equal(c.accounts.ust19, 3800);
  assert.equal(c.accounts.ust7, 3807);
  assert.equal(c.ACCOUNT_EC, 1466);
  assert.equal(c.ACCOUNT_RECHNUNG, 1464);
  assert.equal(c.ACCOUNT_UST_19, 3800);
  assert.equal(c.ACCOUNT_UST_7, 3807);
  assert.equal(c.JOURNAL_KASSE, null);
  assert.equal(c.odoo.journalBank, null);
  assert.equal(c.odoo.journalVerkauf, null);
  assert.ok(!Object.prototype.hasOwnProperty.call(c, 'taxMap'));
  assert.equal(c.syncHour, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(c, 'ODOO_API_KEY'));
  assert.ok(!JSON.stringify(c).toLowerCase().includes('secret'));
});

test('Config Loader: optional JOURNAL_* appear in output when set', () => {
  const env = {
    ...validConfigEnv,
    JOURNAL_KASSE: '11',
    JOURNAL_BANK: '22',
    JOURNAL_VERKAUF: '33',
  };
  const out = runSyncCodeNode('01-config-loader.js', { $env: env });
  const c = out[0].json;
  assert.equal(c.odoo.journalKasse, 11);
  assert.equal(c.odoo.journalBank, 22);
  assert.equal(c.odoo.journalVerkauf, 33);
  assert.equal(c.JOURNAL_KASSE, 11);
  assert.equal(c.JOURNAL_BANK, 22);
  assert.equal(c.JOURNAL_VERKAUF, 33);
});

test('Config Loader: throws when a required env var is missing', () => {
  const bad = { ...validConfigEnv };
  delete bad.HELLOCASH_BASE_URL;
  assert.throws(() => runSyncCodeNode('01-config-loader.js', { $env: bad }), /HELLOCASH_BASE_URL/);
});

test('Config Loader: throws when ACCOUNT_UST_19 missing', () => {
  const bad = { ...validConfigEnv };
  delete bad.ACCOUNT_UST_19;
  assert.throws(() => runSyncCodeNode('01-config-loader.js', { $env: bad }), /ACCOUNT_UST_19/);
});

test('Config Loader: ACCOUNT_RECHNUNG optional — defaults to ACCOUNT_BANK when unset', () => {
  const env = { ...validConfigEnv };
  delete env.ACCOUNT_RECHNUNG;
  const out = runSyncCodeNode('01-config-loader.js', { $env: env });
  assert.equal(out[0].json.accounts.rechnung, 1200);
  assert.equal(out[0].json.ACCOUNT_RECHNUNG, 1200);
});

test('Config Loader: ACCOUNT_UST_7 optional — defaults to ACCOUNT_UST_19 when unset', () => {
  const env = { ...validConfigEnv };
  delete env.ACCOUNT_UST_7;
  const out = runSyncCodeNode('01-config-loader.js', { $env: env });
  assert.equal(out[0].json.accounts.ust19, 3800);
  assert.equal(out[0].json.accounts.ust7, 3800);
  assert.equal(out[0].json.ACCOUNT_UST_7, 3800);
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
