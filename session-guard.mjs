#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_REPLAY_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000;
const MAX_INTERNAL_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 256 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SAFE_INITIALIZE_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-protocol-version',
  'user-agent',
  'origin',
]);

function nowIso() {
  return new Date().toISOString();
}

function sessionPrefix(value) {
  if (!value) return undefined;
  const text = String(value);
  return text.length <= 8 ? text : `${text.slice(0, 8)}…`;
}

function singleHeader(value) {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function isSuccessfulStatus(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

function normalizedRequestPath(requestUrl) {
  try {
    return new URL(requestUrl ?? '/', 'http://sessionguard.local').pathname;
  } catch {
    return '/';
  }
}

function isMcpPath(requestUrl) {
  const pathname = normalizedRequestPath(requestUrl);
  return pathname === '/mcp' || pathname === '/mcp/';
}

function sanitizeProxyHeaders(inputHeaders) {
  const output = {};
  for (const [name, value] of Object.entries(inputHeaders ?? {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    output[lower] = value;
  }
  return output;
}

function safeInitializeHeaders(inputHeaders) {
  const output = {};
  for (const [name, value] of Object.entries(inputHeaders ?? {})) {
    const lower = name.toLowerCase();
    if (!SAFE_INITIALIZE_HEADERS.has(lower) || value === undefined) continue;
    const normalized = singleHeader(value);
    if (normalized !== undefined) output[lower] = normalized;
  }
  delete output.authorization;
  delete output.cookie;
  delete output['mcp-session-id'];
  return output;
}

function sanitizeInitializeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.method !== 'initialize') return null;
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;

  const sanitizedParams = {};
  if (typeof params.protocolVersion === 'string') sanitizedParams.protocolVersion = params.protocolVersion;
  if (params.capabilities && typeof params.capabilities === 'object' && !Array.isArray(params.capabilities)) {
    sanitizedParams.capabilities = structuredClone(params.capabilities);
  }
  if (params.clientInfo && typeof params.clientInfo === 'object' && !Array.isArray(params.clientInfo)) {
    sanitizedParams.clientInfo = structuredClone(params.clientInfo);
  }

  if (!sanitizedParams.protocolVersion || !sanitizedParams.clientInfo) return null;
  if (!sanitizedParams.capabilities) sanitizedParams.capabilities = {};

  return {
    jsonrpc: '2.0',
    method: 'initialize',
    params: sanitizedParams,
  };
}

function parseInitializeBody(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return sanitizeInitializeMessage(parsed);
  } catch {
    return null;
  }
}

function serializeState(sessions) {
  const serialized = {};
  for (const [externalSessionId, record] of sessions.entries()) {
    serialized[externalSessionId] = {
      downstreamSessionId: record.downstreamSessionId,
      initialize: record.initialize,
      initializeHeaders: record.initializeHeaders,
      protocolVersionHeader: record.protocolVersionHeader,
      updatedAt: record.updatedAt,
    };
  }
  return {
    version: 1,
    sessions: serialized,
  };
}

async function writeJsonAtomically(destination, state) {
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `${path.basename(destination)}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    try { await fs.chmod(temporary, 0o600); } catch { }
    await fs.rename(temporary, destination);
    try { await fs.chmod(destination, 0o600); } catch { }
  } finally {
    try { await fs.rm(temporary, { force: true }); } catch { }
  }
}

async function loadState(stateFile, log) {
  const sessions = new Map();
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('warn', 'session_state_load_failed', { error: error?.code ?? error?.name ?? 'Error' });
    }
    return sessions;
  }

  if (!parsed || parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') {
    log('warn', 'session_state_load_failed', { error: 'unsupported_or_invalid_state' });
    return sessions;
  }

  for (const [externalSessionId, record] of Object.entries(parsed.sessions)) {
    if (!externalSessionId || !record || typeof record !== 'object') continue;
    if (typeof record.downstreamSessionId !== 'string' || !record.downstreamSessionId) continue;
    const initialize = sanitizeInitializeMessage(record.initialize);
    if (!initialize) continue;
    sessions.set(externalSessionId, {
      downstreamSessionId: record.downstreamSessionId,
      initialize,
      initializeHeaders: safeInitializeHeaders(record.initializeHeaders),
      protocolVersionHeader: typeof record.protocolVersionHeader === 'string'
        ? record.protocolVersionHeader
        : undefined,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
    });
  }

  log('info', 'session_state_loaded', { sessions: sessions.size });
  return sessions;
}

async function readIncomingBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) {
      tooLarge = true;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  return { body: tooLarge ? null : Buffer.concat(chunks), tooLarge, totalBytes: total };
}

async function readResponseBody(upstreamResponse, limitBytes) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of upstreamResponse) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buffer.length <= limitBytes) {
      chunks.push(buffer);
    } else {
      const remaining = Math.max(0, limitBytes - total);
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      truncated = true;
    }
    total += buffer.length;
  }
  return { body: Buffer.concat(chunks), truncated, totalBytes: total };
}

function filteredResponseHeaders(headers, externalSessionId) {
  const output = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    if (lower === 'mcp-session-id' && externalSessionId) output[lower] = externalSessionId;
    else output[lower] = value;
  }
  return output;
}

function pipeUpstreamResponse(clientResponse, upstreamResponse, externalSessionId) {
  if (clientResponse.headersSent) {
    upstreamResponse.destroy();
    return;
  }
  const headers = filteredResponseHeaders(upstreamResponse.headers, externalSessionId);
  clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
  upstreamResponse.on('error', (error) => {
    if (!clientResponse.destroyed) clientResponse.destroy(error);
  });
  upstreamResponse.pipe(clientResponse);
}

function sendBufferedResponse(clientResponse, statusCode, statusMessage, headers, body, externalSessionId) {
  if (clientResponse.headersSent) return;
  const safeHeaders = filteredResponseHeaders(headers, externalSessionId);
  delete safeHeaders['transfer-encoding'];
  safeHeaders['content-length'] = String(body.length);
  clientResponse.writeHead(statusCode, statusMessage, safeHeaders);
  clientResponse.end(body);
}

function requestUpstream({ upstreamHost, upstreamPort, method, requestUrl, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const upstreamRequest = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method,
      path: requestUrl,
      headers,
      signal,
    }, (upstreamResponse) => resolve({ upstreamRequest, upstreamResponse }));
    upstreamRequest.on('error', reject);
    if (body && body.length > 0) upstreamRequest.end(body);
    else upstreamRequest.end();
  });
}

function requestUpstreamStreaming({ upstreamHost, upstreamPort, clientRequest, clientResponse, onResponse }) {
  const headers = sanitizeProxyHeaders(clientRequest.headers);
  const upstreamRequest = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: clientRequest.method,
    path: clientRequest.url,
    headers,
  }, (upstreamResponse) => {
    onResponse?.(upstreamResponse.statusCode ?? 502);
    pipeUpstreamResponse(clientResponse, upstreamResponse);
  });

  upstreamRequest.on('error', (error) => {
    onResponse?.(502);
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      clientResponse.end('SessionGuard could not reach DevSpace.');
    } else if (!clientResponse.destroyed) {
      clientResponse.destroy(error);
    }
  });

  clientRequest.on('aborted', () => upstreamRequest.destroy());
  clientRequest.on('error', (error) => upstreamRequest.destroy(error));
  clientRequest.pipe(upstreamRequest);
}

function createRuntimeState() {
  return {
    schemaVersion: 1,
    guardInstanceId: randomUUID(),
    startedAt: nowIso(),
    lastInboundAt: null,
    lastMcpAt: null,
    lastInitializeAt: null,
    lastRecoveryStartedAt: null,
    lastRecoverySucceededAt: null,
    lastDownstream404At: null,
    counters: {
      httpRequests: 0,
      mcpRequests: 0,
      initializeRequests: 0,
      downstream404: 0,
      recoveriesStarted: 0,
      recoveriesSucceeded: 0,
      recoveriesFailed: 0,
    },
  };
}

export async function createSessionGuard(options = {}) {
  const listenHost = options.listenHost ?? '127.0.0.1';
  const listenPort = Number(options.listenPort ?? 7677);
  const upstreamHost = options.upstreamHost ?? '127.0.0.1';
  const upstreamPort = Number(options.upstreamPort ?? 7676);
  const maxReplayBodyBytes = Number(options.maxReplayBodyBytes ?? DEFAULT_MAX_REPLAY_BODY_BYTES);
  const recoveryTimeoutMs = Number(options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS);
  const stateFile = options.stateFile ?? path.join(homedir(), '.devspace', 'runtime', 'session-guard-state.json');
  const runtimeFile = options.runtimeFile ?? path.join(homedir(), '.devspace', 'runtime', 'session-guard-runtime.json');
  const providedLogger = options.logger;

  function log(level, event, fields = {}) {
    const safeFields = { ...fields };
    for (const key of Object.keys(safeFields)) {
      if (/authorization|token|password|cookie/i.test(key)) delete safeFields[key];
    }
    const entry = { timestamp: nowIso(), level, event, ...safeFields };
    if (providedLogger) {
      providedLogger(entry);
      return;
    }
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  const sessions = await loadState(stateFile, log);
  const recoveryFlights = new Map();
  const runtime = createRuntimeState();
  let stateWriteTail = Promise.resolve();
  let runtimeWriteTail = Promise.resolve();

  function persistState() {
    const snapshot = serializeState(sessions);
    const write = stateWriteTail.catch(() => {}).then(() => writeJsonAtomically(stateFile, snapshot));
    stateWriteTail = write;
    return write;
  }

  function persistRuntime() {
    const snapshot = structuredClone(runtime);
    const write = runtimeWriteTail.catch(() => {}).then(() => writeJsonAtomically(runtimeFile, snapshot));
    runtimeWriteTail = write;
    return write;
  }

  async function mutateRuntime(mutator) {
    mutator(runtime);
    try {
      await persistRuntime();
    } catch (error) {
      log('warn', 'runtime_state_write_failed', { error: error?.code ?? error?.name ?? 'Error' });
    }
  }

  await persistRuntime();
  log('info', 'guard_started', { guardInstanceId: runtime.guardInstanceId });

  async function observeRequest(req, isMcp) {
    const timestamp = nowIso();
    await mutateRuntime((state) => {
      state.lastInboundAt = timestamp;
      state.counters.httpRequests += 1;
      if (isMcp) {
        state.lastMcpAt = timestamp;
        state.counters.mcpRequests += 1;
      }
    });
    log('info', 'request_observed', {
      method: (req.method ?? 'GET').toUpperCase(),
      path: normalizedRequestPath(req.url),
      guardInstanceId: runtime.guardInstanceId,
    });
  }

  async function observeInitialize() {
    const timestamp = nowIso();
    await mutateRuntime((state) => {
      state.lastInitializeAt = timestamp;
      state.counters.initializeRequests += 1;
    });
    log('info', 'mcp_initialize_observed', { guardInstanceId: runtime.guardInstanceId });
  }

  async function observeDownstream404(method) {
    const timestamp = nowIso();
    await mutateRuntime((state) => {
      state.lastDownstream404At = timestamp;
      state.counters.downstream404 += 1;
    });
    log('warn', 'downstream_session_404', {
      method,
      path: '/mcp',
      status: 404,
      guardInstanceId: runtime.guardInstanceId,
    });
  }

  async function recoveryStarted() {
    const timestamp = nowIso();
    await mutateRuntime((state) => {
      state.lastRecoveryStartedAt = timestamp;
      state.counters.recoveriesStarted += 1;
    });
  }

  async function recoverySucceeded() {
    const timestamp = nowIso();
    await mutateRuntime((state) => {
      state.lastRecoverySucceededAt = timestamp;
      state.counters.recoveriesSucceeded += 1;
    });
  }

  async function recoveryFailed() {
    await mutateRuntime((state) => {
      state.counters.recoveriesFailed += 1;
    });
  }

  async function recordSession(externalSessionId, downstreamSessionId, initialize, initializeHeaders, protocolVersionHeader) {
    sessions.set(externalSessionId, {
      downstreamSessionId,
      initialize,
      initializeHeaders: safeInitializeHeaders(initializeHeaders),
      protocolVersionHeader: protocolVersionHeader ?? initialize.params.protocolVersion,
      updatedAt: nowIso(),
    });
    await persistState();
  }

  async function updateProtocolHeader(externalSessionId, protocolVersionHeader) {
    if (!protocolVersionHeader) return;
    const record = sessions.get(externalSessionId);
    if (!record || record.protocolVersionHeader === protocolVersionHeader) return;
    record.protocolVersionHeader = protocolVersionHeader;
    record.updatedAt = nowIso();
    try { await persistState(); }
    catch (error) { log('warn', 'session_state_write_failed', { error: error?.code ?? error?.name ?? 'Error' }); }
  }

  async function removeSession(externalSessionId) {
    if (!sessions.delete(externalSessionId)) return;
    try { await persistState(); }
    catch (error) { log('warn', 'session_state_write_failed', { error: error?.code ?? error?.name ?? 'Error' }); }
  }

  async function internalMcpRequest({ bodyObject, sessionId, authorization, record }) {
    const headers = {
      ...safeInitializeHeaders(record.initializeHeaders),
      accept: record.initializeHeaders?.accept ?? 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    delete headers['content-length'];
    delete headers['mcp-session-id'];
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const protocolVersion = record.protocolVersionHeader ?? record.initialize?.params?.protocolVersion;
    if (sessionId && protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    if (authorization) headers.authorization = authorization;

    const body = Buffer.from(JSON.stringify(bodyObject), 'utf8');
    headers['content-length'] = String(body.length);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), recoveryTimeoutMs);
    timeout.unref?.();
    try {
      const { upstreamResponse } = await requestUpstream({
        upstreamHost,
        upstreamPort,
        method: 'POST',
        requestUrl: '/mcp',
        headers,
        body,
        signal: controller.signal,
      });
      const responseBody = await readResponseBody(upstreamResponse, MAX_INTERNAL_RESPONSE_BYTES);
      return {
        statusCode: upstreamResponse.statusCode ?? 502,
        headers: upstreamResponse.headers,
        body: responseBody.body,
        truncated: responseBody.truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function recoverSession(externalSessionId, observedDownstreamSessionId, authorization) {
    const current = sessions.get(externalSessionId);
    if (!current) return null;
    if (current.downstreamSessionId !== observedDownstreamSessionId) return current.downstreamSessionId;

    const existing = recoveryFlights.get(externalSessionId);
    if (existing) return existing;

    const flight = (async () => {
      const startedAt = Date.now();
      const latest = sessions.get(externalSessionId);
      if (!latest) return null;
      if (latest.downstreamSessionId !== observedDownstreamSessionId) return latest.downstreamSessionId;

      await recoveryStarted();
      log('info', 'session_recovery_started', {
        externalSessionPrefix: sessionPrefix(externalSessionId),
        oldDownstreamPrefix: sessionPrefix(observedDownstreamSessionId),
        reason: 'downstream_404',
        guardInstanceId: runtime.guardInstanceId,
      });

      try {
        const initializeRequest = { ...latest.initialize, id: `sessionguard-${randomUUID()}` };
        const initializeResponse = await internalMcpRequest({
          bodyObject: initializeRequest,
          sessionId: undefined,
          authorization,
          record: latest,
        });
        const newDownstreamSessionId = singleHeader(initializeResponse.headers['mcp-session-id']);
        if (!isSuccessfulStatus(initializeResponse.statusCode) || !newDownstreamSessionId) {
          await recoveryFailed();
          log('warn', 'session_recovery_failed', {
            externalSessionPrefix: sessionPrefix(externalSessionId),
            stage: 'initialize',
            status: initializeResponse.statusCode,
            guardInstanceId: runtime.guardInstanceId,
          });
          return null;
        }

        const initializedResponse = await internalMcpRequest({
          bodyObject: { jsonrpc: '2.0', method: 'notifications/initialized' },
          sessionId: newDownstreamSessionId,
          authorization,
          record: latest,
        });
        if (!isSuccessfulStatus(initializedResponse.statusCode)) {
          await recoveryFailed();
          log('warn', 'session_recovery_failed', {
            externalSessionPrefix: sessionPrefix(externalSessionId),
            stage: 'initialized_notification',
            status: initializedResponse.statusCode,
            guardInstanceId: runtime.guardInstanceId,
          });
          return null;
        }

        latest.downstreamSessionId = newDownstreamSessionId;
        latest.updatedAt = nowIso();
        sessions.set(externalSessionId, latest);
        try { await persistState(); }
        catch (error) { log('warn', 'session_state_write_failed', { error: error?.code ?? error?.name ?? 'Error' }); }
        await recoverySucceeded();
        log('info', 'session_recovery_succeeded', {
          externalSessionPrefix: sessionPrefix(externalSessionId),
          newDownstreamPrefix: sessionPrefix(newDownstreamSessionId),
          durationMs: Date.now() - startedAt,
          guardInstanceId: runtime.guardInstanceId,
        });
        return newDownstreamSessionId;
      } catch (error) {
        await recoveryFailed();
        log('warn', 'session_recovery_failed', {
          externalSessionPrefix: sessionPrefix(externalSessionId),
          stage: error?.name === 'AbortError' ? 'timeout' : 'transport',
          error: error?.code ?? error?.name ?? 'Error',
          guardInstanceId: runtime.guardInstanceId,
        });
        return null;
      }
    })().finally(() => recoveryFlights.delete(externalSessionId));

    recoveryFlights.set(externalSessionId, flight);
    return flight;
  }

  async function handleMcpRequest(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    let body = Buffer.alloc(0);
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const incoming = await readIncomingBody(req, maxReplayBodyBytes);
      if (incoming.tooLarge) {
        log('warn', 'session_recovery_skipped', { reason: 'request_body_too_large', bytes: incoming.totalBytes, limitBytes: maxReplayBodyBytes });
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('MCP request body exceeds SessionGuard replay safety limit.');
        return;
      }
      body = incoming.body;
    } else {
      for await (const _chunk of req) { /* drain unexpected request body */ }
    }

    const externalSessionId = singleHeader(req.headers['mcp-session-id']);
    const protocolVersionHeader = singleHeader(req.headers['mcp-protocol-version']);
    if (externalSessionId && protocolVersionHeader) await updateProtocolHeader(externalSessionId, protocolVersionHeader);

    const initialize = method === 'POST' && !externalSessionId ? parseInitializeBody(body) : null;
    if (initialize) await observeInitialize();
    const initialHeaders = initialize ? safeInitializeHeaders(req.headers) : null;
    const authorization = singleHeader(req.headers.authorization);
    const mapped = externalSessionId ? sessions.get(externalSessionId)?.downstreamSessionId : undefined;
    const downstreamSessionId = externalSessionId ? (mapped ?? externalSessionId) : undefined;

    const headers = sanitizeProxyHeaders(req.headers);
    if (downstreamSessionId) headers['mcp-session-id'] = downstreamSessionId;
    else delete headers['mcp-session-id'];
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }

    let first;
    try {
      first = await requestUpstream({ upstreamHost, upstreamPort, method, requestUrl: req.url, headers, body });
    } catch (error) {
      log('warn', 'upstream_request_failed', { path: '/mcp', error: error?.code ?? error?.name ?? 'Error' });
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('SessionGuard could not reach DevSpace.');
      return;
    }

    const firstResponse = first.upstreamResponse;

    if (initialize && isSuccessfulStatus(firstResponse.statusCode ?? 0)) {
      const newDownstreamSessionId = singleHeader(firstResponse.headers['mcp-session-id']);
      if (newDownstreamSessionId) {
        firstResponse.pause();
        try {
          await recordSession(newDownstreamSessionId, newDownstreamSessionId, initialize, initialHeaders, protocolVersionHeader ?? initialize.params.protocolVersion);
        } catch (error) {
          log('warn', 'session_state_write_failed', { error: error?.code ?? error?.name ?? 'Error' });
        }
        pipeUpstreamResponse(res, firstResponse, newDownstreamSessionId);
        firstResponse.resume();
        return;
      }
    }

    if (externalSessionId && firstResponse.statusCode === 404) await observeDownstream404(method);

    const eligibleForRecovery = Boolean(externalSessionId && firstResponse.statusCode === 404 && sessions.has(externalSessionId));
    if (!eligibleForRecovery) {
      pipeUpstreamResponse(res, firstResponse, externalSessionId);
      if (externalSessionId && method === 'DELETE' && isSuccessfulStatus(firstResponse.statusCode ?? 0)) {
        firstResponse.once('end', () => { void removeSession(externalSessionId); });
      }
      return;
    }

    const original404 = await readResponseBody(firstResponse, MAX_ERROR_RESPONSE_BYTES);
    const recoveredDownstreamSessionId = await recoverSession(externalSessionId, downstreamSessionId, authorization);

    if (!recoveredDownstreamSessionId) {
      sendBufferedResponse(res, firstResponse.statusCode ?? 404, firstResponse.statusMessage, firstResponse.headers, original404.body, externalSessionId);
      return;
    }

    const retryHeaders = sanitizeProxyHeaders(req.headers);
    retryHeaders['mcp-session-id'] = recoveredDownstreamSessionId;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      delete retryHeaders['transfer-encoding'];
      retryHeaders['content-length'] = String(body.length);
    }

    try {
      const retry = await requestUpstream({ upstreamHost, upstreamPort, method, requestUrl: req.url, headers: retryHeaders, body });
      pipeUpstreamResponse(res, retry.upstreamResponse, externalSessionId);
      if (method === 'DELETE' && isSuccessfulStatus(retry.upstreamResponse.statusCode ?? 0)) {
        retry.upstreamResponse.once('end', () => { void removeSession(externalSessionId); });
      }
    } catch (error) {
      log('warn', 'upstream_request_failed', { path: '/mcp', stage: 'single_retry', error: error?.code ?? error?.name ?? 'Error' });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('SessionGuard could not reach DevSpace after session recovery.');
      }
    }
  }

  const server = http.createServer((req, res) => {
    const mcp = isMcpPath(req.url);
    void observeRequest(req, mcp).then(() => {
      if (!mcp) {
        requestUpstreamStreaming({
          upstreamHost,
          upstreamPort,
          clientRequest: req,
          clientResponse: res,
          onResponse: (status) => log('info', 'request_completed', {
            method: (req.method ?? 'GET').toUpperCase(),
            path: normalizedRequestPath(req.url),
            status,
            guardInstanceId: runtime.guardInstanceId,
          }),
        });
        return;
      }
      void handleMcpRequest(req, res).catch((error) => {
        log('error', 'session_guard_request_failed', { error: error?.code ?? error?.name ?? 'Error' });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('SessionGuard request handling failed.');
        } else if (!res.destroyed) res.destroy(error);
      });
    }).catch((error) => {
      log('error', 'session_guard_observability_failed', { error: error?.code ?? error?.name ?? 'Error' });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('SessionGuard request handling failed.');
      }
    });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  log('info', 'session_guard_started', {
    listenHost,
    listenPort: typeof address === 'object' && address ? address.port : listenPort,
    upstreamHost,
    upstreamPort,
    guardInstanceId: runtime.guardInstanceId,
  });

  return {
    server,
    stateFile,
    runtimeFile,
    sessions,
    runtime,
    get port() {
      const current = server.address();
      return typeof current === 'object' && current ? current.port : listenPort;
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([stateWriteTail, runtimeWriteTail]);
    },
  };
}

function parseCliArgs(argv) {
  const args = {
    listenHost: '127.0.0.1',
    listenPort: 7677,
    upstreamHost: '127.0.0.1',
    upstreamPort: 7676,
    stateFile: path.join(homedir(), '.devspace', 'runtime', 'session-guard-state.json'),
    runtimeFile: path.join(homedir(), '.devspace', 'runtime', 'session-guard-runtime.json'),
    maxReplayBodyBytes: DEFAULT_MAX_REPLAY_BODY_BYTES,
    recoveryTimeoutMs: DEFAULT_RECOVERY_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    switch (name) {
      case '--listen-host': args.listenHost = value; index += 1; break;
      case '--listen-port': args.listenPort = Number(value); index += 1; break;
      case '--upstream-host': args.upstreamHost = value; index += 1; break;
      case '--upstream-port': args.upstreamPort = Number(value); index += 1; break;
      case '--state-file': args.stateFile = value; index += 1; break;
      case '--runtime-file': args.runtimeFile = value; index += 1; break;
      case '--max-replay-body-bytes': args.maxReplayBodyBytes = Number(value); index += 1; break;
      case '--recovery-timeout-ms': args.recoveryTimeoutMs = Number(value); index += 1; break;
      default: throw new Error(`Unknown or incomplete argument: ${name}`);
    }
  }

  for (const [name, value] of [['listenPort', args.listenPort], ['upstreamPort', args.upstreamPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be between 1 and 65535.`);
  }
  if (!args.stateFile || !args.runtimeFile) throw new Error('stateFile and runtimeFile are required.');
  if (path.resolve(args.stateFile) === path.resolve(args.runtimeFile)) throw new Error('stateFile and runtimeFile must be different files.');
  if (!Number.isInteger(args.maxReplayBodyBytes) || args.maxReplayBodyBytes < 1024) throw new Error('maxReplayBodyBytes must be at least 1024.');
  if (!Number.isInteger(args.recoveryTimeoutMs) || args.recoveryTimeoutMs < 1000) throw new Error('recoveryTimeoutMs must be at least 1000.');
  if (args.listenPort === args.upstreamPort && args.listenHost === args.upstreamHost) {
    throw new Error('SessionGuard listen endpoint must differ from the DevSpace upstream endpoint.');
  }
  return args;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const guard = await createSessionGuard(options);
  const shutdown = async (signal) => {
    process.stdout.write(`${JSON.stringify({ timestamp: nowIso(), level: 'info', event: 'session_guard_stopping', signal })}\n`);
    try {
      await guard.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ timestamp: nowIso(), level: 'error', event: 'session_guard_stop_failed', error: error?.code ?? error?.name ?? 'Error' })}\n`);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ timestamp: nowIso(), level: 'error', event: 'session_guard_start_failed', error: error?.code ?? error?.name ?? 'Error' })}\n`);
    process.exit(1);
  });
}
