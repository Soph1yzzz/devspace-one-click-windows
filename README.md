# DevSpace One-Click for Windows

A small, unofficial Windows launcher for running [DevSpace](https://github.com/Waishnav/devspace) behind a Cloudflare Quick Tunnel with a nearly double-click-only workflow.

**Current release: v1.1.0 (2026-08-19)** — SessionGuard, minimal-repair startup, stronger diagnostics, and safer long-running ChatGPT session recovery. See [CHANGELOG.md](CHANGELOG.md) for the release history.

The launcher keeps DevSpace restricted to one approved local folder, discovers the installed DevSpace CLI dynamically, manages only processes it can positively identify, and now includes **SessionGuard** to make long-running ChatGPT conversations much more resilient to DevSpace MCP session loss.

> This project is not affiliated with DevSpace, Cloudflare, or OpenAI.

## What SessionGuard fixes

DevSpace uses stateful MCP Streamable HTTP sessions. A ChatGPT conversation can keep an `Mcp-Session-Id` after the corresponding server-side transport has disappeared, for example after a DevSpace process restart or session cleanup. DevSpace correctly answers an unknown session with HTTP 404. Some clients can remain stuck sending the stale session instead of transparently starting a new one.

SessionGuard sits between Cloudflare and DevSpace:

```text
ChatGPT
   |
   v
Cloudflare Quick Tunnel
   |
   v
SessionGuard 127.0.0.1:7677
   |
   v
DevSpace     127.0.0.1:7676
```

For a session previously initialized through SessionGuard, a session-bound `/mcp` request that receives a downstream HTTP 404 is handled conservatively:

1. SessionGuard performs one fresh MCP `initialize` against DevSpace.
2. It sends `notifications/initialized` once.
3. It updates the old external-session -> new downstream-session mapping atomically.
4. It retries the original request **once**.
5. ChatGPT continues seeing the same external `Mcp-Session-Id`.

There is no retry loop. HTTP 401, 403, generic 4xx/5xx responses, timeouts, connection resets, and other ambiguous failures are **not** replayed automatically.

This follows the MCP session model: an unknown/expired session is represented by HTTP 404 and signals that a new session is required. See the upstream MCP TypeScript SDK discussion in issue `modelcontextprotocol/typescript-sdk#1708` and the SDK session/state documentation.

## What SessionGuard cannot fix

A different failure can happen entirely inside the ChatGPT connector/tool binding layer: discovery may still list the DevSpace tools while a direct tool invocation fails before any HTTP request reaches this machine.

A local reverse proxy cannot repair a request that was never sent. SessionGuard therefore adds **traffic observability** so the two failure classes can be distinguished instead of guessed at.

`status-devspace.cmd` now shows:

```text
cloudflared:  running (...)
SessionGuard: running (...)
DevSpace:     running (...)
MCP URL:      https://...trycloudflare.com/mcp
Last MCP seen: ...
Recovery:      2 succeeded, 0 failed
```

If ChatGPT reports a DevSpace invocation failure while all three processes are healthy and `Last MCP seen` does not advance, that is evidence that the failure occurred upstream of SessionGuard.

For deeper local diagnostics, without adding another normal-user CMD entry point:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 diagnose
```

The diagnostic command reports process/listener state, safe SessionGuard counters, local metadata through SessionGuard, and public metadata through the tunnel. It does not print tokens or full MCP session IDs.

## Normal usage

### Start / repair

Double-click:

```text
start-devspace.cmd
```

That remains the normal entry point.

The launcher now repairs the smallest missing layer whenever it safely can:

- Tunnel + SessionGuard alive, DevSpace stopped -> restart only DevSpace and preserve the public URL.
- Tunnel + DevSpace alive, SessionGuard stopped -> restart only SessionGuard and preserve the public URL.
- All three alive -> keep everything as-is and validate the endpoint.
- Tunnel stopped -> a new Quick Tunnel URL is unavoidable; SessionGuard is kept alive when possible so its mappings survive.

This reduces avoidable public-endpoint churn, which is especially important for long-running ChatGPT conversations.

### Change the allowed folder

Double-click:

```text
change-devspace-root.cmd
```

When the full stack is healthy, changing the root updates the DevSpace configuration atomically and restarts **only DevSpace**. SessionGuard and the existing Quick Tunnel stay alive, so the public MCP URL does not change.

### Status

Double-click:

```text
status-devspace.cmd
```

### Stop

Double-click:

```text
stop-devspace.cmd
```

Public ingress is stopped first, then SessionGuard, then DevSpace.

## First upgrade from the pre-SessionGuard launcher

Older releases pointed Cloudflare directly at DevSpace on port 7676. SessionGuard uses a separate bridge port, so the launcher explicitly recognizes the old managed tunnel instead of leaking or double-starting `cloudflared`.

The **first** start after upgrading performs a one-time migration:

```text
Cloudflare -> DevSpace:7676
```

becomes:

```text
Cloudflare -> SessionGuard:7677 -> DevSpace:7676
```

Because a Cloudflare Quick Tunnel URL is tied to the tunnel process, this one-time migration creates a new temporary URL. Update the ChatGPT MCP connection to that new URL once. After migration, routine DevSpace restarts and root changes preserve the tunnel URL whenever the tunnel process remains alive.

If the earlier SessionGuard V1 trial is already running behind an existing bridge tunnel, the launcher recognizes that process separately and replaces only the guard with V2, preserving the running tunnel URL.

A Quick Tunnel process restart can still change the public URL by design. SessionGuard cannot make a temporary Cloudflare hostname permanent.

## Configuration

Optional launcher overrides belong in `launcher.settings.json` beside the scripts. Start from `launcher.settings.example.json`:

```json
{
  "Port": 7676,
  "BridgePort": 7677,
  "StartupTimeoutSeconds": 30,
  "HttpTimeoutSeconds": 20,
  "BackupRetention": 10
}
```

`Port` is the DevSpace listener. `BridgePort` is the local SessionGuard listener and must be different.

## Runtime files

Launcher runtime files are stored under:

```text
%USERPROFILE%\.devspace\runtime
```

Important files include:

- `cloudflared.pid`
- `session-guard.pid`
- `devspace.pid`
- `public-url.txt`
- `session-guard-state.json` - recovery mapping and sanitized initialize template
- `session-guard-runtime.json` - safe diagnostic counters/timestamps
- process stdout/stderr logs

### Recovery state

`session-guard-state.json` stores only what is needed to rebuild a downstream MCP session:

- external and downstream MCP session IDs,
- the sanitized MCP initialize message,
- safe initialize headers,
- protocol version metadata.

It does **not** persist Authorization headers, bearer tokens, cookies, passwords, or tool arguments.

The current request's Authorization header may be forwarded **in memory only** during the one recovery handshake, because DevSpace still needs to authenticate that internal initialize request.

### Diagnostic state

`session-guard-runtime.json` is separate from recovery state. It contains only a random guard instance ID, timestamps, and counters such as:

- total HTTP and MCP requests seen,
- initialize requests seen,
- downstream session 404s,
- recovery attempts / successes / failures.

It intentionally does not store request bodies, tool arguments, full request URLs/query strings, authentication material, full filesystem paths, or the public tunnel URL.

## Security model

The original launcher safety properties remain in place:

- only one explicitly selected `allowedRoot`,
- drive roots and the Windows home directory are rejected,
- DevSpace JSON updates are atomic,
- configuration backups are retained,
- rollback is attempted if a root change fails,
- process stop/reuse requires PID + process name + expected command-line fragments,
- DevSpace CLI location is resolved from the installed npm package metadata instead of a user-specific hard-coded path,
- Quick Tunnel hostnames are validated,
- local ports must be owned by the expected managed process,
- OAuth protected-resource metadata is checked through the public path,
- launcher operations are serialized with a mutex,
- `DEVSPACE_TRUST_PROXY=1` is set for the local Cloudflare -> SessionGuard -> DevSpace proxy chain.

SessionGuard adds these invariants:

- binds to loopback only by default,
- Cloudflare targets SessionGuard rather than DevSpace directly,
- only known session-bound `/mcp` HTTP 404 responses are eligible for automatic recovery,
- at most one reinitialize is in flight per external session,
- at most one retry of the original operation,
- ambiguous transport failures are never replayed,
- SSE/streaming responses are passed through rather than fully buffered,
- no global DevSpace/npm package patching,
- no unauthenticated public diagnostics endpoint,
- diagnostic logs use normalized URL paths and omit query strings.

See [SECURITY.md](SECURITY.md) and [docs/SESSIONGUARD.md](docs/SESSIONGUARD.md) for details.

## Tests

Run the Node behavior suite:

```powershell
node --test tests/session-guard.test.mjs
```

Run the CLI/process smoke test:

```powershell
node tests/session-guard-smoke.mjs
```

Run the Windows static/isolated launcher checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Static.ps1
```

The behavior suite covers recovery across simulated DevSpace restarts, persisted mapping reload, single-flight concurrent 404 handling, no retry on 401/403/500 or connection reset, diagnostic counters, secret non-persistence, query-string redaction, and SSE streaming.

## Known limitations

- Cloudflare Quick Tunnel URLs are temporary. If the tunnel process is recreated, the public hostname can change.
- SessionGuard can recover only sessions that were initialized through it and for which a sanitized initialize template was captured.
- SessionGuard cannot repair a ChatGPT-side tool/capability binding failure that occurs before the request reaches the local endpoint.
- The first upgrade from the old direct-tunnel layout requires one tunnel recreation and therefore one ChatGPT MCP URL update.
- This project does not automate the ChatGPT UI or store ChatGPT credentials.

## License

MIT. See [LICENSE](LICENSE).
