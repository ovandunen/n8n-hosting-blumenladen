#!/usr/bin/env node
/**
 * Builds importable n8n workflow JSON from src/*.js Code node bodies.
 * Run from repo root: node workflows/helloCash-odoo-sync/build-workflow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSrc(name) {
  return fs.readFileSync(path.join(__dirname, 'src', name), 'utf8');
}

const workflow = {
  name: 'HelloCash Business → Odoo sync',
  meta: {
    templateCredsSetupCompleted: false,
    description:
      'HelloCash Business: two-phase GET cashBook + invoices → map to account.move → Odoo JSON-RPC. Triggers: Schedule Hourly OR When clicking Test workflow. Env: HELLOCASH_BASE_URL, HELLOCASH_API_TOKEN, ODOO_* incl. ODOO_PASSWORD (validated in Config, not in output json), TAX_ID_19 (19% USt) and TAX_ID_7, accounts, HELLOCASH_LIST_PATH default /api/v1/cashBook, optional HELLOCASH_QUERY_FROM/TO, HELLOCASH_IGNORE_SYNC_HOUR. REQUIRED after import: n8n Credentials → create SMTP; open node Send Error Email → Credential for SMTP → select it (otherwise NodeOperationError: Node does not have any credentials set). Optional env ERROR_EMAIL_FROM for From address.',
  },
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    executionTimeout: 7200,
  },
  pinData: {},
  nodes: [
    {
      parameters: {
        rule: {
          interval: [
            {
              field: 'hours',
              hoursInterval: 1,
            },
          ],
        },
      },
      id: 'a1000000-0000-4000-8000-000000000001',
      name: 'Schedule Hourly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-600, 0],
    },
    {
      parameters: {},
      id: 'a1000000-0000-4000-8000-000000000007',
      name: "When clicking 'Test workflow'",
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-600, 200],
    },
    {
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: readSrc('01-config-loader.js'),
      },
      id: 'a1000000-0000-4000-8000-000000000002',
      name: 'Config Loader',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-360, 0],
    },
    {
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: readSrc('02-hellocash-fetch.js'),
      },
      id: 'a1000000-0000-4000-8000-000000000003',
      name: 'HelloCash Fetch',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-120, 0],
      onError: 'continueErrorOutput',
    },
    {
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: readSrc('03-map-to-odoo.js'),
      },
      id: 'a1000000-0000-4000-8000-000000000004',
      name: 'Map to Odoo',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [120, 0],
      onError: 'continueErrorOutput',
    },
    {
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: readSrc('04-odoo-post-moves.js'),
      },
      id: 'a1000000-0000-4000-8000-000000000005',
      name: 'Odoo Post Moves',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [360, 0],
      onError: 'continueErrorOutput',
    },
    {
      parameters: {
        fromEmail: "={{ $env.ERROR_EMAIL_FROM || $('Config Loader').first().json.errorEmail }}",
        toEmail: "={{ $('Config Loader').first().json.errorEmail }}",
        subject: 'HelloCash to Odoo sync failure',
        emailFormat: 'text',
        text: '={{ JSON.stringify($json, null, 2) }}',
        options: {},
      },
      id: 'a1000000-0000-4000-8000-000000000006',
      name: 'Send Error Email',
      type: 'n8n-nodes-base.emailSend',
      typeVersion: 2.1,
      position: [120, 220],
    },
  ],
  connections: {
    'Schedule Hourly': {
      main: [[{ node: 'Config Loader', type: 'main', index: 0 }]],
    },
    "When clicking 'Test workflow'": {
      main: [[{ node: 'Config Loader', type: 'main', index: 0 }]],
    },
    'Config Loader': {
      main: [[{ node: 'HelloCash Fetch', type: 'main', index: 0 }]],
    },
    'HelloCash Fetch': {
      main: [[{ node: 'Map to Odoo', type: 'main', index: 0 }]],
      error: [[{ node: 'Send Error Email', type: 'main', index: 0 }]],
    },
    'Map to Odoo': {
      main: [[{ node: 'Odoo Post Moves', type: 'main', index: 0 }]],
      error: [[{ node: 'Send Error Email', type: 'main', index: 0 }]],
    },
    'Odoo Post Moves': {
      main: [[]],
      error: [[{ node: 'Send Error Email', type: 'main', index: 0 }]],
    },
  },
};

const outPath = path.join(__dirname, 'helloCash-odoo-sync.workflow.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Wrote', outPath);
