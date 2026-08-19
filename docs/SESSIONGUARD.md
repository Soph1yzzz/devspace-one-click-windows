# SessionGuard design notes

SessionGuard is the compatibility layer used by this launcher to preserve MCP session continuity across DevSpace process/session loss without changing the normal Windows workflow.

## Design goal

The practical goal is not to make MCP sessions immortal. It is to make the common stale-session failure recover transparently while refusing to replay operations when delivery is ambiguous.

The design also distinguishes a local/downstream session failure from a ChatGPT-side connector/tool-binding failure that occurs before the request reaches this machine.

## Why the guard exists

The installed DevSpace server uses a stateful MCP Streamable HTTP transport. A request with an `Mcp-Session-Id` is routed to an in-memory transport registry. If the identifier is unknown, DevSpace returns HTTP 404. A fresh `initialize` creates a new transport and a new random session ID.

During the 2026-08-18 implementation review, the local installed DevSpace was `1.0.6`, while upstream `Waishnav/devspace` `main` identified itself as `1.0.7`. That upstream source still returns HTTP 404 for an unknown session and also explicitly closes sessions idle for 24 hours on a five-minute cleanup interval. The exact timeout is upstream policy and may change, but it confirms that stale client session IDs can arise from normal lifecycle cleanup as well as process restart.

The MCP TypeScript SDK documents the same session model: one transport instance owns one stateful session, later requests route by `Mcp-Session-Id`, and an unknown session receives HTTP 404 so the client can start a new session.

Relevant upstream material:

- `modelcontextprotocol/typescript-sdk#1708`: client-side stale-session 404 handling discussion.
- `modelcontextprotocol/typescript-sdk/docs/serving/sessions-state-scaling.md`: stateful transport/session routing model.
- `modelcontextprotocol/typescript-sdk/examples/legacy-routing/server.ts`: unknown session -> HTTP 404 routing example.

## Architecture

```text
                         public internet
                               |
                               v
ChatGPT ---------------- Cloudflare Quick Tunnel
                               |
                               v
                    127.0.0.1:BridgePort
                         SessionGuard
                               |
                               v
                    127.0.0.1:Port
                           DevSpace
                               |
                               v
                         allowedRoot
```

Default ports:

- DevSpace: `7676`
- SessionGuard bridge: `7677`

Cloudflare never intentionally points directly at DevSpace in SessionGuard mode.

## External-session continuity

On the first successful client `initialize`, SessionGuard records:

```text
externalSessionId -> downstreamSessionId
```

Initially both values are the same DevSpace-issued ID.

If DevSpace later forgets that downstream session and returns HTTP 404, SessionGuard creates a new downstream session while keeping the old external ID stable:

```text
externalSessionId -> newDownstreamSessionId
```

The client therefore does not need to learn a new MCP session ID for that recovery.

## Recovery algorithm

A request is recovery-eligible only for a known external session and a downstream HTTP 404 on `/mcp`.

Pseudo-flow:

```text
receive /mcp request
  -> map external session to current downstream session
  -> forward once
  -> response != 404
       -> pass through
  -> response == 404 and mapping/template exists
       -> acquire per-external-session single-flight
       -> initialize downstream once
       -> notifications/initialized once
       -> atomically persist new mapping
       -> retry original request once
       -> rewrite response Mcp-Session-Id back to external ID
```

Concurrent requests that all observe the stale downstream ID share the same recovery flight. After the first recovery updates the mapping, later waiters use the resulting downstream session rather than launching more initializes.

## Replay boundary

The following are intentionally **not** automatic recovery triggers:

| Failure | Automatic replay | Reason |
|---|---:|---|
| Known session + downstream HTTP 404 | Yes, one recovery + one retry | MCP defines unknown/expired session as requiring a fresh session |
| HTTP 401 | No | Authentication state, not session continuity |
| HTTP 403 | No | Authorization/scope state |
| Generic HTTP 400 | No | Malformed request or protocol problem |
| HTTP 5xx | No | Original operation may already have executed |
| Timeout | No | Delivery/execution is ambiguous |
| Connection reset | No | Delivery/execution is ambiguous |
| Interrupted SSE/stream | No generic replay | Streaming position/execution is ambiguous |
| JSON-RPC application error | No | Application-level result, not transport-session loss |

This boundary is the most important safety property of SessionGuard.

## Initialize template

SessionGuard must be able to create a protocol-compatible replacement session. It therefore stores a sanitized template of the client's original `initialize` message:

- `protocolVersion`
- `capabilities`
- `clientInfo`

Only a small safe allow-list of initialize headers is retained. Authentication material is explicitly excluded.

During a recovery handshake, the Authorization header from the **current incoming request** may be forwarded in memory to DevSpace. It is never copied into the recovery-state file.

## Files

### `session-guard-state.json`

Purpose: recovery continuity.

Contains full external/downstream session IDs because the mapping cannot work without them, plus the sanitized initialize template and protocol metadata.

### `session-guard-runtime.json`

Purpose: failure classification and status display.

Schema version 1 contains:

```json
{
  "schemaVersion": 1,
  "guardInstanceId": "random UUID",
  "startedAt": "ISO timestamp",
  "lastInboundAt": "ISO timestamp or null",
  "lastMcpAt": "ISO timestamp or null",
  "lastInitializeAt": "ISO timestamp or null",
  "lastRecoveryStartedAt": "ISO timestamp or null",
  "lastRecoverySucceededAt": "ISO timestamp or null",
  "lastDownstream404At": "ISO timestamp or null",
  "counters": {
    "httpRequests": 0,
    "mcpRequests": 0,
    "initializeRequests": 0,
    "downstream404": 0,
    "recoveriesStarted": 0,
    "recoveriesSucceeded": 0,
    "recoveriesFailed": 0
  }
}
```

The diagnostic file deliberately contains no session IDs, request bodies, tool names/arguments, query strings, credentials, filesystem paths, or public tunnel URL.

Both state files are written atomically.

## Failure classification

### 1. `DOWNSTREAM_STALE_SESSION`

Evidence pattern:

```text
ChatGPT request reaches SessionGuard
  -> Last MCP seen advances
  -> DevSpace returns session-bound HTTP 404
  -> downstream404 increments
  -> recovery succeeds/fails visibly
```

SessionGuard can usually repair this automatically if it captured the initialize template earlier.

### 2. `CAPABILITY_BINDING_DESYNC`

Observed handoff pattern from an affected long-running ChatGPT conversation:

```text
list_resources -> DevSpace tools are discoverable
open_workspace/direct tool invocation -> Resource not found before local execution
list_resources again -> tools still discoverable
same direct invocation -> still fails
```

A fresh conversation using the same installed DevSpace connector can successfully discover and invoke `open_workspace`.

This strongly distinguishes the failure from a dead local DevSpace server, while not proving the exact private ChatGPT implementation detail.

Operational signature with SessionGuard:

```text
ChatGPT reports invocation failure
all three local processes healthy
Last MCP seen does not advance
```

That means SessionGuard saw no MCP traffic for the failed invocation. It cannot repair a call that never reached the network endpoint.

### 3. Other local/network failures

Use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 diagnose
```

The command checks managed processes, local listeners, runtime counters, local metadata through SessionGuard, and public metadata through Cloudflare.

## Launcher lifecycle

### Normal `start-devspace.cmd`

The script calls the controller's `ensure` action rather than blindly rebuilding the stack.

Repair priorities:

1. Keep a healthy Quick Tunnel URL whenever possible.
2. Keep a healthy SessionGuard process/mapping whenever possible.
3. Restart only DevSpace when only DevSpace is missing.
4. Restart only SessionGuard when only SessionGuard is missing.
5. Create a new tunnel only when public ingress is absent/unusable.

### Root change

When Tunnel + SessionGuard + DevSpace are all managed and healthy, root change restarts only DevSpace. The stable SessionGuard process receives the next stale-session 404 and remaps the existing external session automatically.

### Stop

Ingress is removed first:

```text
Cloudflare -> SessionGuard -> DevSpace
    1             2            3
```

### Upgrade from the old direct tunnel

The pre-SessionGuard launcher used:

```text
cloudflared --url http://127.0.0.1:7676
```

The new launcher uses:

```text
cloudflared --url http://127.0.0.1:7677
```

The controller recognizes both command lines while stopping a managed tunnel. This prevents the old process from being orphaned when the same PID file is reused during the one-time migration.

The migration necessarily recreates a Quick Tunnel once, so its temporary public hostname changes once.

## Testing strategy

`tests/session-guard.test.mjs` uses an isolated mock DevSpace and verifies:

- runtime state creation,
- normal HTTP proxying,
- OAuth metadata passthrough,
- initialize capture,
- normal mapped tool call,
- stale-session 404 recovery,
- stable external session ID,
- repeated simulated DevSpace restart,
- SessionGuard restart + persisted mapping reload,
- new guard instance ID after guard restart,
- Authorization non-persistence,
- no recovery for 401/403/500,
- no replay after connection reset,
- failed recovery has no loop,
- concurrent 404 single-flight,
- SSE streaming without full buffering,
- query string is not written to structured logs.

`tests/session-guard-smoke.mjs` launches SessionGuard as a real child process and simulates replacing the downstream DevSpace process on the same port.

`tests/Test-Static.ps1` validates PowerShell parsing, CMD script-relative behavior, port configuration, Node syntax, DevSpace CLI discovery, atomic JSON writes, runtime-state parsing, secret scans, and user-specific absolute-path scans.

## Non-goals

SessionGuard intentionally does not:

- patch the installed DevSpace npm package,
- change DevSpace tool schemas or tool names,
- automate ChatGPT UI reconnects,
- expose a public diagnostics API,
- replay arbitrary failed MCP operations,
- turn Quick Tunnel into a stable hostname service,
- claim to repair ChatGPT-internal connector binding state.
