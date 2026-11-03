// Isolated real-kernel/browser acceptance. Test clients report agent activity; no live AI is started.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startBridge } from '../src/bridge/server.ts';
import { SqliteStore } from '../src/bridge/sqlite-store.ts';
import { emptyDocument } from '../src/cad/document.ts';
import { CONTRACT_FINGERPRINT } from '../src/bridge/fingerprint.ts';
import { LEGACY_PROJECT_ID } from '../src/shared/protocol.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'vibeworks-agent-views-'));
const out = join(root, 'output/playwright/agent-views');
await mkdir(out, { recursive: true });
const otherProject = crypto.randomUUID();
const store = new SqliteStore(join(dir, 'workspace.db'));
await store.operation({ action: 'project', project: { projectId: otherProject, name: 'Other project', version: 1 }, expectedVersion: null });
const documents = Array.from({ length: 6 }, (_, i) => ({ ...emptyDocument(), projectId: i === 5 ? otherProject : LEGACY_PROJECT_ID,
  name: i === 5 ? 'Private other part' : `Part ${i + 1}`, features: [{ id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [30 + i * 8, 20 + i * 4, 12 + i * 3] }, appearance: { material: 'aluminum', color: ['#be6746', '#487a9a', '#b49b48', '#72916d', '#8c6ca1', '#486060'][i] } }] }));
for (const document of documents) await store.put(document, null);
store.close();
process.env.VIBEWORKS_WEB_PORT = '45194';
process.env.VIBEWORKS_BRIDGE_PORT = '44349';
let bridge, server, browser, heartbeat;
try {
  bridge = await startBridge({ port: 44349, databasePath: join(dir, 'workspace.db'), connectionFile: join(dir, 'connection.json'), webOrigins: ['http://127.0.0.1:45194'] });
  await bridge.ready();
  const connection = JSON.parse(await readFile(join(dir, 'connection.json'), 'utf8'));
  const call = async (type, params, sessionId) => {
    const response = await fetch(connection.httpUrl + '/command', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json', 'X-Vibeworks-Fingerprint': CONTRACT_FINGERPRINT }, body: JSON.stringify({ requestId: crypto.randomUUID(), command: { type, params }, ...(sessionId ? { sessionId } : {}) }) });
    const result = await response.json();
    assert.equal(result.status, 'success', JSON.stringify(result.error));
    return result;
  };
  const sessions = [], names = [], agentIds = [];
  for (let i = 0; i < 5; i++) {
    const index = i === 4 ? 5 : i + 1;
    const joined = await call('agent_session', { action: 'join', agent: `Test agent ${i + 1}`, client: 'acceptance', projectIds: i === 4 ? [otherProject] : [LEGACY_PROJECT_ID, otherProject], focus: { projectId: documents[index].projectId, documentId: documents[index].documentId } });
    sessions.push(joined.session.sessionId); names.push(joined.agent.name.replaceAll('_', ' ')); agentIds.push(joined.agent.agentId);
  }
  heartbeat = setInterval(() => { for (const sessionId of sessions) void call('agent_session', { action: 'heartbeat' }, sessionId); }, 10000);
  server = await createServer({ root, configFile: join(root, 'vite.config.ts') });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [], observations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/view-command')) { const body = request.postDataJSON(); if (body.passive && body.command.type === 'inspect_model' && !body.command.params.definitionsOnly) observations.push(body.command.params.documentId); } });
  await page.goto('http://127.0.0.1:45194');
  await page.evaluate(() => window.__cad.ready);
  await page.locator('.picker-project').filter({ hasText: 'My project' }).click();
  await page.locator('.picker-document').filter({ hasText: 'Part 1' }).click();
  await page.getByRole('tab', { name: /^Agents/ }).click();
  await page.getByRole('button', { name: `Add live view for ${names[0]}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /^Work/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: `Add live view for ${names[4]}`, exact: true }).count(), 0, 'Agents from another project must not appear');
  for (let i = 1; i <= 3; i++) await page.getByRole('button', { name: `Add live view for ${names[i - 1]}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.agent-view canvas').length === 4);
  assert.equal(await page.getByRole('button', { name: `Add live view for ${names[3]}`, exact: true }).isDisabled(), true);
  const main = page.getByRole('article', { name: 'Your main view' });
  assert.equal(await main.getAttribute('data-document-id'), documents[0].documentId);
  const follower = index => page.locator(`[data-agent-id="${agentIds[index - 1]}"]`);
  assert.equal(await follower(1).getAttribute('data-document-id'), documents[1].documentId);
  await page.mouse.move(1100, 70);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(out, 'desktop-grid.png') });
  // Dragging and keyboard resizing change space, without replacing the pane canvases.
  await page.locator('.agent-view canvas').first().evaluate(canvas => { window.__originalMainCanvas = canvas; });
  const separator = page.getByRole('separator', { name: 'Resize main view', exact: true });
  const initialWidth = (await main.boundingBox()).width;
  const separatorBox = await separator.boundingBox();
  await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 50);
  await page.mouse.down(); await page.mouse.move(separatorBox.x - 120, separatorBox.y + 50, { steps: 5 }); await page.mouse.up();
  assert.ok((await main.boundingBox()).width < initialWidth - 60);
  await separator.focus(); await page.keyboard.press('ArrowRight');
  for (const layout of ['rows', 'columns', 'grid']) {
    await page.getByRole('combobox', { name: 'View layout' }).selectOption(layout);
    assert.equal(await page.evaluate(() => document.querySelector('.agent-view canvas') === window.__originalMainCanvas), true, 'Layout changes retain the main camera and canvas');
  }
  await page.getByRole('button', { name: `Expand ${names[0]}`, exact: true }).click();
  assert.equal(await page.locator('.agent-view-slot:visible').count(), 1);
  await page.getByRole('button', { name: `Restore grid for ${names[0]}`, exact: true }).click();
  assert.equal(await page.locator('.agent-view-slot:visible').count(), 4);
  // A real edit updates Node tessellation in the follower without navigating the main view.
  await call('apply_edits', { documentId: documents[1].documentId, expectedRevision: 0, edits: [{ op: 'update', feature: { ...documents[1].features[0], params: { origin: [0, 0, 0], size: [80, 24, 15] } } }] }, sessions[0]);
  await page.waitForFunction(id => document.querySelector(`[data-document-id="${id}"].agent-view`)?.dataset.revision === '1', documents[1].documentId);
  assert.equal(await main.getAttribute('data-document-id'), documents[0].documentId);
  // The personal pane follows human document navigation while followers stay attached to their agents.
  await page.evaluate(async id => { await window.__cad.execute({ type: 'documents', params: { action: 'open', documentId: id } }); }, documents[4].documentId);
  await page.waitForFunction(id => document.querySelector('.agent-main-view')?.dataset.documentId === id, documents[4].documentId);
  assert.equal(await follower(1).getAttribute('data-document-id'), documents[1].documentId);
  await call('inspect_model', { documentId: documents[4].documentId }, sessions[0]);
  await page.waitForFunction(({id,agent}) => document.querySelector(`[data-agent-id="${agent}"]`)?.dataset.documentId === id, { id: documents[4].documentId, agent: agentIds[0] });
  await follower(1).locator('canvas').waitFor();
  await call('inspect_model', { documentId: documents[5].documentId }, sessions[0]);
  await page.getByText('This agent is focused outside this project.', { exact: true }).waitFor();
  assert.equal(await follower(1).locator('canvas').count(), 0);
  assert.equal(observations.includes(documents[5].documentId), false, 'A follower must never display a target outside this project');
  await call('inspect_model', { documentId: documents[1].documentId }, sessions[0]);
  await follower(1).locator('canvas').waitFor();
  // Mobile uses a scrollable stack, retaining access to all four views and their controls.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(out, 'mobile-stack.png') });
  assert.equal(await page.locator('.agent-view-slot:visible').count(), 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const slots = await page.locator('.agent-view-slot').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  assert.ok(slots.every(slot => slot.width > 300 && slot.height >= 260));
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Project changes drop the whole follower set. Returning never restores the old project's selection.
  await page.getByRole('button', { name: 'Project: My project', exact: true }).click();
  await page.getByRole('menuitem', { name: /Other project/ }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-views'));
  await page.getByRole('button', { name: 'Project: Other project', exact: true }).click();
  await page.getByRole('menuitem', { name: /My project/ }).click();
  await page.waitForFunction(() => window.__cad.inspect().document.projectId === '00000000-0000-4000-8000-000000000001');
  assert.equal(await page.locator('.agent-views').count(), 0);
  assert.deepEqual(errors, []);
  console.log('AGENT_VIEWS_ACCEPTANCE', JSON.stringify({ panes: 4, followers: 3, layouts: 3, projectIsolation: true, mainNavigation: true, agentTargetChanges: true, realCommittedEdit: true, browserErrors: errors, screenshots: out }));
} finally {
  clearInterval(heartbeat);
  await browser?.close(); await server?.close(); await bridge?.close();
  await rm(dir, { recursive: true, force: true });
}
