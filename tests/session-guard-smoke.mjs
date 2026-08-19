import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port; }
function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}
function jsonRequest(port, sessionId, message) {
  const body = JSON.stringify(message);
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    authorization: 'Bearer smoke-only-not-persisted',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
    headers['mcp-protocol-version'] = '2025-06-18';
  }
  return request(port, { method: 'POST', pathname: '/mcp', headers, body });
}
function createMockDevSpace(generation, counters) {
  const sessions = new Set();
  return http.createServer(async (req, res) => {
    if (req.url === '/.well-known/oauth-protected-resource/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: 'smoke' }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const sessionId = req.headers['mcp-session-id'];
    if (message.method === 'initialize' && !sessionId) {
      counters.initialize += 1;
      const id = `generation-${generation}-session-${counters.initialize}`;
      sessions.add(id);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'smoke', version: '1' } } }));
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Unknown MCP session');
      return;
    }
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    counters.tools += 1;
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { generation, sessionId } }));
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const guardScript = path.join(root, 'session-guard.mjs');
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-guard-smoke-'));
const stateFile = path.join(tempDir, 'state.json');
const runtimeFile = path.join(tempDir, 'runtime.json');
const guardPort = await freePort();
const upstreamPort = await freePort();
const counters = { initialize: 0, tools: 0 };
let downstream = createMockDevSpace(1, counters);
await listen(downstream, upstreamPort);

const child = spawn(process.execPath, [
  guardScript,
  '--listen-port', String(guardPort),
  '--upstream-port', String(upstreamPort),
  '--state-file', stateFile,
  '--runtime-file', runtimeFile,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 5000;
  let metadata;
  while (Date.now() < deadline) {
    try {
      metadata = await request(guardPort, { pathname: '/.well-known/oauth-protected-resource/mcp' });
      if (metadata.status === 200) break;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(metadata?.status, 200, `SessionGuard CLI did not become ready. stderr=${stderr}`);
  console.log('A. SessionGuard CLI -> mock DevSpace metadata: OK');

  const init = await jsonRequest(guardPort, undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-client', version: '2' } },
  });
  assert.equal(init.status, 200);
  const externalSession = init.headers['mcp-session-id'];
  assert.ok(externalSession);
  const initialized = await jsonRequest(guardPort, externalSession, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized.status, 202);
  const firstTool = await jsonRequest(guardPort, externalSession, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(firstTool.status, 200);
  assert.equal(JSON.parse(firstTool.body).result.generation, 1);
  console.log('B. Initialize + initialized + tools/list: OK');

  await close(downstream);
  downstream = createMockDevSpace(2, counters);
  await listen(downstream, upstreamPort);
  console.log('C. Downstream DevSpace process restart simulation: OK');

  const initBeforeRecovery = counters.initialize;
  const recoveredTool = await jsonRequest(guardPort, externalSession, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.equal(recoveredTool.status, 200);
  assert.equal(counters.initialize, initBeforeRecovery + 1);
  const recoveredResult = JSON.parse(recoveredTool.body).result;
  assert.equal(recoveredResult.generation, 2);
  assert.notEqual(recoveredResult.sessionId, externalSession);
  assert.equal(recoveredTool.headers['mcp-session-id'], externalSession);
  console.log('D-F. 404 -> one reinitialize -> stable external session -> tool success: OK');

  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  assert.equal(runtime.counters.recoveriesStarted, 1);
  assert.equal(runtime.counters.recoveriesSucceeded, 1);
  assert.equal(runtime.counters.recoveriesFailed, 0);
  assert.ok(runtime.lastMcpAt);
  console.log('G. Diagnostic runtime state records traffic and recovery: OK');

  const persisted = `${await readFile(stateFile, 'utf8')}\n${await readFile(runtimeFile, 'utf8')}\n${stdout}\n${stderr}`;
  assert.equal(persisted.includes('smoke-only-not-persisted'), false);
  console.log('Security smoke. Authorization absent from state and logs: OK');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  try { await close(downstream); } catch { }
  await rm(tempDir, { recursive: true, force: true });
}
