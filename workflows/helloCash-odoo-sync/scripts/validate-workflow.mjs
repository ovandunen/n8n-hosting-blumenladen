#!/usr/bin/env node
/**
 * Parse build/helloCash-odoo-sync_workflow.json — does not run n8n.
 * Run `npm run build` first. Usage: node scripts/validate-workflow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfPath = path.join(__dirname, '..', 'build', 'helloCash-odoo-sync_workflow.json');

if (!fs.existsSync(wfPath)) {
  console.error('Missing', wfPath, '— run: npm run build');
  process.exit(1);
}

const raw = fs.readFileSync(wfPath, 'utf8');
const wf = JSON.parse(raw);
if (!Array.isArray(wf.nodes) || typeof wf.connections !== 'object') {
  console.error('Invalid workflow shape: expected nodes[] and connections');
  process.exit(1);
}
console.log('workflow JSON OK:', wfPath);
console.log('  nodes:', wf.nodes.length);
