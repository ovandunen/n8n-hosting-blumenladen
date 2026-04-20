/**
 * Runtime check: Send Error Email (n8n emailSend v2) requires SMTP credentials bound in n8n UI.
 * Workflow JSON exports do not include credential secrets; self-hosted must attach SMTP after import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(__dirname, '..', 'helloCash-odoo-sync.workflow.json');

// #region agent log
function agentLog(payload) {
  fetch('http://127.0.0.1:7330/ingest/4ce32461-1d4a-4b58-abe6-33a0afb413fd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '4797c1' },
    body: JSON.stringify({ sessionId: '4797c1', timestamp: Date.now(), ...payload }),
  }).catch(() => {});
}
// #endregion

test('Send Error Email: workflow export omits SMTP credentials (operator must attach in n8n)', async () => {
  const wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const emailNode = wf.nodes.find((n) => n.type === 'n8n-nodes-base.emailSend');
  assert.ok(emailNode, 'emailSend node present');

  const hasCredsObject = emailNode.credentials && typeof emailNode.credentials === 'object';
  const hasSmtpRef = Boolean(emailNode.credentials?.smtp?.id);

  // #region agent log
  agentLog({
    runId: 'workflow-export-scan',
    hypothesisId: 'H1',
    location: 'email-send-node-credentials.test.mjs:scan',
    message: 'Workflow JSON credential binding on emailSend',
    data: {
      nodeName: emailNode.name,
      typeVersion: emailNode.typeVersion,
      hasCredentialsKey: hasCredsObject,
      hasSmtpCredentialId: hasSmtpRef,
      H1_exportOmitsOrUnbound: !hasSmtpRef,
    },
  });
  // #endregion

  // #region agent log
  agentLog({
    runId: 'workflow-export-scan',
    hypothesisId: 'H2',
    location: 'email-send-node-credentials.test.mjs:n8n-behavior',
    message: 'n8n EmailSend v2 execute path requires getCredentials',
    data: {
      H2_matchesUserStackTrace:
        'NodeOperationError: Node does not have any credentials set at ExecuteContext._getCredentials',
      note: 'If hasSmtpCredentialId is false after import, UI must assign SMTP credential to this node.',
    },
  });
  // #endregion

  assert.equal(hasSmtpRef, false, 'Git workflow must not embed SMTP credential IDs');
});
