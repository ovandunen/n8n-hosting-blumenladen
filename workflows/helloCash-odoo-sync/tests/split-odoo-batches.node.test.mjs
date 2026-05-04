/**
 * Regression: Split In Batches v3 exposes outputs as ['done', 'loop'] —
 * index 0 is done, index 1 is loop. Odoo must wire to the loop output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtWorkflowPath } from './fixtures.mjs';

test('Split Odoo batches: Odoo Prepare Payload connects to loop output (main[1]), not done (main[0])', () => {
  const wf = JSON.parse(fs.readFileSync(builtWorkflowPath, 'utf8'));
  const split = wf.nodes.find((n) => n.name === 'Split Odoo batches');
  assert.ok(split, 'Split Odoo batches node missing');
  assert.equal(split.type, 'n8n-nodes-base.splitInBatches');

  const conns = wf.connections['Split Odoo batches']?.main;
  assert.ok(Array.isArray(conns) && conns.length >= 2, 'Split must have two outputs');

  const doneOut = conns[0];
  const loopOut = conns[1];
  const odooName = 'Odoo Prepare Payload';

  const doneTargets = Array.isArray(doneOut) ? doneOut.map((c) => c.node) : [];
  const loopTargets = Array.isArray(loopOut) ? loopOut.map((c) => c.node) : [];

  assert.ok(
    !doneTargets.includes(odooName),
    `Done output (index 0) must not connect to ${odooName}; v3 output order is ["done","loop"]`,
  );
  assert.ok(loopTargets.includes(odooName), `Loop output (index 1) must connect to ${odooName}`);
});
