import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionGuard } from '../session-guard.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request({ port, method = 'GET', pathname = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function jsonRequest({ port, method = 'POST', pathname = '/mcp', sessionId, protocolVersion, authorization, json }) {
  const body = JSON.stringify(json);
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  if (authorization) headers.authorization = authorization;
  return request({ port, method, pathname, headers, body });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function createMockDevSpace() {
  const state = {
    nextSession: 1,
    validSessions: new Set(),
    initializeCount: 0,
    initializedCount: 0,
    toolCount: 0,
    resetRequestCount: 0,
    lastToolSession: null,
    lastInitialize: null,
    authorizationValues: [],
    failInitializeStatus: null,
    initializeDelayMs: 0,
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization) state.authorizationValues.push(req.headers.authorization);

    if (req.url?.startsWith('/hello')) {
      res.writeHead(201, { 'x-proxy-test': 'ok', 'content-type': 'text/plain' });
      res.end('hello-through-proxy');
      return;
    }

    if (req.url === '/.well-known/oauth-protected-resource/mcp') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-metadata': 'preserved' });
      res.end(JSON.stringify({ resource: 'https://example.invalid/mcp', authorization_servers: ['https://example.invalid'] }));
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'GET') {
      if (!sessionId || !state.validSessions.has(sessionId)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Unknown MCP session');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'mcp-session-id': sessionId,
      });
      res.write('event: message\ndata: {"step":1}\n\n');
      setTimeout(() => {
        res.write('event: message\ndata: {"step":2}\n\n');
        res.end();
      }, 180);
      return;
    }

    if (req.method === 'DELETE') {
      if (!sessionId || !state.validSessions.has(sessionId)) {
        res.writeHead(404);
        res.end('Unknown MCP session');
        return;
      }
      state.validSessions.delete(sessionId);
      res.writeHead(200);
      res.end('deleted');
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }

    if (message.method === 'initialize' && !sessionId) {
      state.initializeCount += 1;
      state.lastInitialize = message;
      if (state.initializeDelayMs) await new Promise((resolve) => setTimeout(resolve, state.initializeDelayMs));
      if (state.failInitializeStatus) {
        res.writeHead(state.failInitializeStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'initialize failed' }));
        return;
      }
      const newSession = `downstream-${state.nextSession++}`;
      state.validSessions.add(newSession);
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': newSession,
      });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'mock-devspace', version: '1.0.0' },
        },
      }));
      return;
    }

    if (!sessionId || !state.validSessions.has(sessionId)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown MCP session' }));
      return;
    }

    if (message.method === 'notifications/initialized') {
      state.initializedCount += 1;
      res.writeHead(202);
      res.end();
      return;
    }

    if (message.method === 'test/status401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (message.method === 'test/status403') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (message.method === 'test/status500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server error' }));
      return;
    }
    if (message.method === 'test/reset') {
      state.resetRequestCount += 1;
      req.socket.destroy();
      return;
    }

    state.toolCount += 1;
    state.lastToolSession = sessionId;
    res.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true, sessionId } }));
  });

  return { server, state };
}

const PROTOCOL = '2025-06-18';
const AUTH_SECRET = 'Bearer TEST_SECRET_MUST_NOT_PERSIST';
const QUERY_SECRET = 'QUERY_SECRET_MUST_NOT_LOG';
const initializeMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL,
    capabilities: { sampling: {} },
    clientInfo: { name: 'SessionGuard tests', version: '2.0' },
  },
};

test('SessionGuard V2 recovery, observability, security, and streaming', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-guard-test-'));
  const stateFile = path.join(tempDir, 'session-guard-state.json');
  const runtimeFile = path.join(tempDir, 'session-guard-runtime.json');
  const logs = [];
  const mock = createMockDevSpace();
  const upstreamPort = await listen(mock.server);
  let guard = await createSessionGuard({
    listenPort: 0,
    upstreamPort,
    stateFile,
    runtimeFile,
    recoveryTimeoutMs: 2000,
    logger: (entry) => logs.push(entry),
  });
  let guardPort = guard.port;

  t.after(async () => {
    try { await guard.close(); } catch { }
    try { await closeServer(mock.server); } catch { }
    await rm(tempDir, { recursive: true, force: true });
  });

  await t.test('1. startup creates a secret-free diagnostic runtime state', async () => {
    const runtimeText = await readFile(runtimeFile, 'utf8');
    const runtime = JSON.parse(runtimeText);
    assert.equal(runtime.schemaVersion, 1);
    assert.match(runtime.guardInstanceId, /^[0-9a-f-]{36}$/i);
    assert.equal(runtime.counters.httpRequests, 0);
    assert.equal(/authorization|bearer|token|cookie|password/i.test(runtimeText), false);
  });

  await t.test('2. normal HTTP proxy is observable and query secrets are not logged', async () => {
    const response = await request({ port: guardPort, pathname: `/hello?access_token=${QUERY_SECRET}` });
    assert.equal(response.status, 201);
    assert.equal(response.headers['x-proxy-test'], 'ok');
    assert.equal(response.body, 'hello-through-proxy');
    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.httpRequests, 1);
    assert.equal(runtime.counters.mcpRequests, 0);
    assert.ok(runtime.lastInboundAt);
    assert.equal(JSON.stringify(logs).includes(QUERY_SECRET), false);
  });

  await t.test('3. OAuth metadata passes through unchanged', async () => {
    const response = await request({ port: guardPort, pathname: '/.well-known/oauth-protected-resource/mcp' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-oauth-metadata'], 'preserved');
    assert.match(response.body, /authorization_servers/);
  });

  const beforeNoRequest = await readJson(runtimeFile);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterNoRequest = await readJson(runtimeFile);
  assert.deepEqual(afterNoRequest.counters, beforeNoRequest.counters, 'no request means counters do not move');

  let externalSessionId;
  await t.test('4. InitializeRequest records session and diagnostic initialize traffic', async () => {
    const before = mock.state.initializeCount;
    const response = await jsonRequest({ port: guardPort, authorization: AUTH_SECRET, json: initializeMessage });
    assert.equal(response.status, 200);
    assert.equal(mock.state.initializeCount, before + 1);
    externalSessionId = response.headers['mcp-session-id'];
    assert.ok(externalSessionId);

    const persisted = await readJson(stateFile);
    assert.equal(persisted.sessions[externalSessionId].downstreamSessionId, externalSessionId);
    assert.equal(persisted.sessions[externalSessionId].initialize.params.protocolVersion, PROTOCOL);

    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.mcpRequests, 1);
    assert.equal(runtime.counters.initializeRequests, 1);
    assert.ok(runtime.lastMcpAt);
    assert.ok(runtime.lastInitializeAt);
  });

  await t.test('5. normal tool request uses mapped downstream session', async () => {
    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    assert.equal(response.status, 200);
    assert.equal(mock.state.lastToolSession, externalSessionId);
  });

  let firstRecoveredDownstream;
  await t.test('6. downstream 404 reinitializes once, retries once, and keeps external ID stable', async () => {
    mock.state.validSessions.clear();
    const initializeBefore = mock.state.initializeCount;
    const toolBefore = mock.state.toolCount;
    const runtimeBefore = await readJson(runtimeFile);
    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    });
    assert.equal(response.status, 200);
    assert.equal(mock.state.initializeCount, initializeBefore + 1);
    assert.equal(mock.state.toolCount, toolBefore + 1);
    assert.equal(response.headers['mcp-session-id'], externalSessionId);
    firstRecoveredDownstream = mock.state.lastToolSession;
    assert.notEqual(firstRecoveredDownstream, externalSessionId);

    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.downstream404, runtimeBefore.counters.downstream404 + 1);
    assert.equal(runtime.counters.recoveriesStarted, runtimeBefore.counters.recoveriesStarted + 1);
    assert.equal(runtime.counters.recoveriesSucceeded, runtimeBefore.counters.recoveriesSucceeded + 1);
    assert.equal(runtime.counters.recoveriesFailed, runtimeBefore.counters.recoveriesFailed);
    assert.ok(runtime.lastDownstream404At);
    assert.ok(runtime.lastRecoveryStartedAt);
    assert.ok(runtime.lastRecoverySucceededAt);
  });

  await t.test('7. the same external ID continues on the recovered downstream session', async () => {
    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
    });
    assert.equal(response.status, 200);
    assert.equal(mock.state.lastToolSession, firstRecoveredDownstream);
    assert.equal(response.headers['mcp-session-id'], externalSessionId);
  });

  await t.test('8. a second simulated DevSpace restart recovers without resetting diagnostic state', async () => {
    const runtimeBefore = await readJson(runtimeFile);
    mock.state.validSessions.clear();
    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
    });
    assert.equal(response.status, 200);
    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.guardInstanceId, runtimeBefore.guardInstanceId);
    assert.equal(runtime.counters.recoveriesSucceeded, runtimeBefore.counters.recoveriesSucceeded + 1);
  });

  await t.test('9. SessionGuard restart reloads mapping and creates a new guard instance ID', async () => {
    const oldRuntime = await readJson(runtimeFile);
    await guard.close();
    mock.state.validSessions.clear();
    guard = await createSessionGuard({
      listenPort: 0,
      upstreamPort,
      stateFile,
      runtimeFile,
      recoveryTimeoutMs: 2000,
      logger: (entry) => logs.push(entry),
    });
    guardPort = guard.port;
    const freshRuntime = await readJson(runtimeFile);
    assert.notEqual(freshRuntime.guardInstanceId, oldRuntime.guardInstanceId);

    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['mcp-session-id'], externalSessionId);
    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.recoveriesSucceeded, 1);
  });

  await t.test('10. Authorization is transient and neither state, runtime, nor logs persist it', async () => {
    assert.ok(mock.state.authorizationValues.includes(AUTH_SECRET));
    const stateText = await readFile(stateFile, 'utf8');
    const runtimeText = await readFile(runtimeFile, 'utf8');
    const logText = JSON.stringify(logs);
    for (const text of [stateText, runtimeText, logText]) assert.equal(text.includes(AUTH_SECRET), false);
    assert.equal(/authorization|bearer|token|cookie|password/i.test(runtimeText), false);
    assert.equal(/"authorization"|"token"|"password"|"cookie"/i.test(logText), false);
  });

  await t.test('11. 401, 403, and 500 never trigger recovery', async () => {
    for (const [method, expected] of [['test/status401', 401], ['test/status403', 403], ['test/status500', 500]]) {
      const beforeInitialize = mock.state.initializeCount;
      const beforeRuntime = await readJson(runtimeFile);
      const response = await jsonRequest({
        port: guardPort,
        sessionId: externalSessionId,
        protocolVersion: PROTOCOL,
        authorization: AUTH_SECRET,
        json: { jsonrpc: '2.0', id: expected, method, params: {} },
      });
      assert.equal(response.status, expected);
      assert.equal(mock.state.initializeCount, beforeInitialize);
      const afterRuntime = await readJson(runtimeFile);
      assert.equal(afterRuntime.counters.recoveriesStarted, beforeRuntime.counters.recoveriesStarted);
      assert.equal(afterRuntime.counters.downstream404, beforeRuntime.counters.downstream404);
    }
  });

  await t.test('12. connection reset is not replayed automatically', async () => {
    const beforeReset = mock.state.resetRequestCount;
    const beforeInitialize = mock.state.initializeCount;
    const beforeRuntime = await readJson(runtimeFile);
    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 700, method: 'test/reset', params: {} },
    });
    assert.equal(response.status, 502);
    assert.equal(mock.state.resetRequestCount, beforeReset + 1, 'write was delivered only once');
    assert.equal(mock.state.initializeCount, beforeInitialize, 'ambiguous reset does not reinitialize');
    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.recoveriesStarted, beforeRuntime.counters.recoveriesStarted);
  });

  await t.test('13. failed reinitialize has no loop and records one recovery failure', async () => {
    mock.state.validSessions.clear();
    mock.state.failInitializeStatus = 500;
    const beforeInitialize = mock.state.initializeCount;
    const beforeRuntime = await readJson(runtimeFile);
    const response = await jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
    });
    assert.equal(response.status, 404);
    assert.equal(mock.state.initializeCount, beforeInitialize + 1);
    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.recoveriesStarted, beforeRuntime.counters.recoveriesStarted + 1);
    assert.equal(runtime.counters.recoveriesFailed, beforeRuntime.counters.recoveriesFailed + 1);
    mock.state.failInitializeStatus = null;
  });

  await t.test('14. concurrent downstream 404s use one single-flight reinitialize', async () => {
    mock.state.validSessions.clear();
    mock.state.initializeDelayMs = 80;
    const beforeInitialize = mock.state.initializeCount;
    const beforeRuntime = await readJson(runtimeFile);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => jsonRequest({
      port: guardPort,
      sessionId: externalSessionId,
      protocolVersion: PROTOCOL,
      authorization: AUTH_SECRET,
      json: { jsonrpc: '2.0', id: 100 + index, method: 'tools/list', params: {} },
    })));
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(mock.state.initializeCount, beforeInitialize + 1);
    assert.ok(responses.every((response) => response.headers['mcp-session-id'] === externalSessionId));
    const runtime = await readJson(runtimeFile);
    assert.equal(runtime.counters.recoveriesStarted, beforeRuntime.counters.recoveriesStarted + 1);
    assert.equal(runtime.counters.recoveriesSucceeded, beforeRuntime.counters.recoveriesSucceeded + 1);
    assert.equal(runtime.counters.recoveriesFailed, beforeRuntime.counters.recoveriesFailed);
    assert.equal(runtime.counters.downstream404, beforeRuntime.counters.downstream404 + 6);
    mock.state.initializeDelayMs = 0;
  });

  await t.test('15. GET/SSE response streams without full buffering', async () => {
    const startedAt = Date.now();
    const timing = await new Promise((resolve, reject) => {
      let firstDataAt;
      let endAt;
      let body = '';
      const req = http.request({
        host: '127.0.0.1',
        port: guardPort,
        method: 'GET',
        path: '/mcp',
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': externalSessionId,
          'mcp-protocol-version': PROTOCOL,
          authorization: AUTH_SECRET,
        },
      }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.equal(res.headers['mcp-session-id'], externalSessionId);
        res.on('data', (chunk) => {
          if (!firstDataAt) firstDataAt = Date.now();
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          endAt = Date.now();
          resolve({ firstDataAt, endAt, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.match(timing.body, /"step":1/);
    assert.match(timing.body, /"step":2/);
    assert.ok(timing.firstDataAt - startedAt < 120);
    assert.ok(timing.endAt - timing.firstDataAt >= 120);
  });
});
