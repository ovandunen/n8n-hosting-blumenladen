#!/usr/bin/env node
/**
 * Parse helloCash-odoo-sync.workflow.json — does not run n8n.
 * Usage: node scripts/validate-workflow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfPath = path.join(__dirname, '..', 'helloCash-odoo-sync.workflow.json');

const raw = fs.readFileSync(wfPath, 'utf8');
const wf = JSON.parse(raw);
if (!Array.isArray(wf.nodes) || typeof wf.connections !== 'object') {
  console.error('Invalid workflow shape: expected nodes[] and connections');
  process.exit(1);
}
console.log('workflow JSON OK:', wfPath);
console.log('  nodes:', wf.nodes.length);
