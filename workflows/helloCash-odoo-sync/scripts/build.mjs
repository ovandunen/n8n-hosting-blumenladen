#!/usr/bin/env node
/**
 * Option B build: inject src/nodes/*.js into src/workflow-template.json → build/helloCash-odoo-sync_workflow.json
 * Usage (from this package): npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

/** @type {Record<string, string>} node display name → path under root */
const CODE_MAP = {
  'Config Loader': path.join(root, 'src', 'nodes', '01-config-loader.js'),
  'HelloCash Fetch': path.join(root, 'src', 'nodes', '02-hellocash-fetch.js'),
  'Map to Odoo': path.join(root, 'src', 'nodes', '03-map-to-odoo.js'),
  'Odoo Post Moves': path.join(root, 'src', 'nodes', '04-odoo-post-moves.js'),
};

const templatePath = path.join(root, 'src', 'workflow-template.json');
const outDir = path.join(root, 'build');
const outPath = path.join(outDir, 'helloCash-odoo-sync_workflow.json');

const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
if (!Array.isArray(template.nodes)) {
  console.error('Invalid template: missing nodes[]');
  process.exit(1);
}

const namesInTemplate = new Set(template.nodes.map((n) => n.name));
for (const name of Object.keys(CODE_MAP)) {
  if (!namesInTemplate.has(name)) {
    console.error(`build: CODE_MAP names node "${name}" but template has no such node`);
    process.exit(1);
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

for (const node of template.nodes) {
  const filePath = CODE_MAP[node.name];
  if (!filePath) continue;
  if (node.type !== 'n8n-nodes-base.code') {
    console.error(`build: expected Code node for "${node.name}"`);
    process.exit(1);
  }
  const jsCode = fs.readFileSync(filePath, 'utf8');
  try {
    new AsyncFunction('$env', '$', 'items', jsCode);
  } catch (e) {
    console.error(`Syntax error in ${path.relative(root, filePath)}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  node.parameters = node.parameters || {};
  node.parameters.mode = node.parameters.mode || 'runOnceForAllItems';
  node.parameters.language = node.parameters.language || 'javaScript';
  node.parameters.jsCode = jsCode;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
console.log('Built →', path.relative(process.cwd(), outPath));
