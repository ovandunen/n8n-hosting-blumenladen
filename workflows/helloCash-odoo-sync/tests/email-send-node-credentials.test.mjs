/**
 * Send Error Email (n8n emailSend v2): workflow must not embed SMTP credential IDs in repo.
 * Operators attach SMTP in each n8n instance after import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtWorkflowPath } from './fixtures.mjs';

test('Send Error Email: workflow export omits SMTP credentials (operator must attach in n8n)', async () => {
  const wf = JSON.parse(fs.readFileSync(builtWorkflowPath, 'utf8'));
  const emailNode = wf.nodes.find((n) => n.type === 'n8n-nodes-base.emailSend');
  assert.ok(emailNode, 'emailSend node present');

  const hasSmtpRef = Boolean(emailNode.credentials?.smtp?.id);

  assert.equal(hasSmtpRef, false, 'Git workflow must not embed SMTP credential IDs');
});
