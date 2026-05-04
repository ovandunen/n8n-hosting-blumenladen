#!/usr/bin/env node
/**
 * Convert Odoo Dedupe/Create from HTTP Request to Code nodes; remove merge helper nodes.
 * Run from package root: node scripts/patch-template-odoo-code-http.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const templatePath = path.join(root, 'src', 'workflow-template.json');

const t = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
if (!Array.isArray(t.nodes)) {
  console.error('invalid template');
  process.exit(1);
}

t.nodes = t.nodes.filter((n) => !['Odoo Merge Dedupe Response', 'Odoo Merge Create Response'].includes(n.name));

for (const n of t.nodes) {
  if (n.name === 'Odoo Dedupe Check' || n.name === 'Odoo Create Move') {
    n.type = 'n8n-nodes-base.code';
    n.typeVersion = 2;
    n.parameters = { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: '' };
    n.onError = 'continueErrorOutput';
    delete n.credentials;
    delete n.webhookId;
  }
}

t.connections['Odoo Dedupe Check'] = {
  main: [[{ node: 'Odoo Need Create Move?', type: 'main', index: 0 }]],
};
delete t.connections['Odoo Merge Dedupe Response'];

t.connections['Odoo Create Move'] = {
  main: [[{ node: 'Odoo Process Results', type: 'main', index: 0 }]],
};
delete t.connections['Odoo Merge Create Response'];

fs.writeFileSync(templatePath, JSON.stringify(t, null, 2) + '\n', 'utf8');
console.log('Patched', path.relative(root, templatePath));
