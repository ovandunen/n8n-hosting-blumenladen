#!/usr/bin/env node
/**
 * Option B build: inject src/nodes/*.js into src/workflow-template.json → build/helloCash-odoo-sync_workflow.json
 * Output is whitelisted for n8n public API POST /api/v1/workflows (no extra top-level or settings keys).
 * Usage (from this package): npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

/** Top-level keys allowed on create/update via n8n public API */
const OUTPUT_TOP_LEVEL_KEYS = ['name', 'nodes', 'connections', 'settings', 'staticData'];

/** settings.* keys accepted by the public API */
const ALLOWED_SETTINGS_KEYS = new Set([
  'executionOrder',
  'saveManualExecutions',
  'callerPolicy',
  'errorWorkflow',
  'timezone',
]);

/** @param {unknown} settings */
function pickAllowedSettings(settings) {
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  const o = /** @type {Record<string, unknown>} */ (settings);
  for (const key of ALLOWED_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      out[key] = o[key];
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} template
 * @returns {Record<string, unknown>}
 */
function assembleApiWorkflow(template) {
  const name = template.name;
  if (typeof name !== 'string' || name.trim() === '') {
    console.error('build: template.name must be a non-empty string');
    process.exit(1);
  }
  if (!Array.isArray(template.nodes)) {
    console.error('build: template.nodes must be an array');
    process.exit(1);
  }
  if (template.connections == null || typeof template.connections !== 'object' || Array.isArray(template.connections)) {
    console.error('build: template.connections must be a non-null object');
    process.exit(1);
  }

  return {
    name,
    nodes: template.nodes,
    connections: template.connections,
    settings: pickAllowedSettings(template.settings),
    staticData: template.staticData !== undefined ? template.staticData : null,
  };
}

/** @type {Record<string, string>} node display name → path under root */
const CODE_MAP = {
  'Config Loader': path.join(root, 'src', 'nodes', '01-config-loader.js'),
  'HelloCash Fetch': path.join(root, 'src', 'nodes', '02-hellocash-fetch.js'),
  'Map to Odoo': path.join(root, 'src', 'nodes', '03-map-to-odoo.js'),
  'Odoo Prepare Payload': path.join(root, 'src', 'nodes', '05-odoo-prepare-payload-canvas.js'),
  'Odoo Pass Through Skipped': path.join(root, 'src', 'nodes', '09-odoo-pass-skipped-canvas.js'),
  'Odoo Dedupe Check': path.join(root, 'src', 'nodes', '11-odoo-dedupe-http-canvas.js'),
  'Odoo Create Move': path.join(root, 'src', 'nodes', '12-odoo-create-http-canvas.js'),
  'Odoo Skip Create Row': path.join(root, 'src', 'nodes', '08-odoo-skip-create-row-canvas.js'),
  'Odoo Process Results': path.join(root, 'src', 'nodes', '10-odoo-process-results-canvas.js'),
};

const templatePath = path.join(root, 'src', 'workflow-template.json');
const outDir = path.join(root, 'build');
const outPath = path.join(outDir, 'helloCash-odoo-sync_workflow.json');

const template = /** @type {Record<string, unknown>} */ (JSON.parse(fs.readFileSync(templatePath, 'utf8')));
if (!Array.isArray(template.nodes)) {
  console.error('Invalid template: missing nodes[]');
  process.exit(1);
}

const unknownTop = Object.keys(template).filter((k) => !OUTPUT_TOP_LEVEL_KEYS.includes(k));
if (unknownTop.length > 0) {
  console.error(
    `build: workflow-template.json has keys that are not used in API output (remove or they are ignored): ${unknownTop.join(', ')}`,
  );
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
    new AsyncFunction('$env', '$', 'items', '$http', '$input', jsCode);
  } catch (e) {
    console.error(`Syntax error in ${path.relative(root, filePath)}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  node.parameters = node.parameters || {};
  node.parameters.mode = node.parameters.mode || 'runOnceForAllItems';
  node.parameters.language = node.parameters.language || 'javaScript';
  node.parameters.jsCode = jsCode;
}

const output = assembleApiWorkflow(template);

const outKeys = Object.keys(output);
const extraOut = outKeys.filter((k) => !OUTPUT_TOP_LEVEL_KEYS.includes(k));
if (extraOut.length > 0) {
  console.error(`build: internal error: output has unexpected keys: ${extraOut.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log('Built →', path.relative(process.cwd(), outPath));
