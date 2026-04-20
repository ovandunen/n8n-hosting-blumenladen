/**
 * Unit: n8n node "Send Error Email" — SMTP node wired to Config Loader expressions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(__dirname, '..', 'helloCash-odoo-sync.workflow.json');

test('Send Error Email: emailSend node targets errorEmail from Config Loader', () => {
  const wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Send Error Email');
  assert.ok(node);
  assert.ok(node.type.includes('emailSend'));
  assert.ok(String(node.parameters?.toEmail).includes("Config Loader"));
  assert.ok(String(node.parameters?.subject).length > 0);
});
