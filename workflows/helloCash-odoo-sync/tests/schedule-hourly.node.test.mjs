/**
 * Unit: n8n node "Schedule Hourly" — workflow contains trigger with hourly rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(__dirname, '..', 'helloCash-odoo-sync.workflow.json');

test('Schedule Hourly: node present and is scheduleTrigger with hourly interval', () => {
  const wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Schedule Hourly');
  assert.ok(node, 'Schedule Hourly node missing');
  assert.ok(node.type.includes('scheduleTrigger'));
  const interval = node.parameters?.rule?.interval?.[0];
  assert.equal(interval?.field, 'hours');
  assert.equal(interval?.hoursInterval, 1);
});
