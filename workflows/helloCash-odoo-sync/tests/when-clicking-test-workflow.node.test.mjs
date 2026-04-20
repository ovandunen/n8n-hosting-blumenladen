/**
 * Unit: n8n node "When clicking 'Test workflow'" — manual trigger present.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(__dirname, '..', 'helloCash-odoo-sync.workflow.json');

test("When clicking 'Test workflow': manualTrigger node exists", () => {
  const wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const node = wf.nodes.find((n) => n.name === "When clicking 'Test workflow'");
  assert.ok(node);
  assert.ok(node.type.includes('manualTrigger'));
});
