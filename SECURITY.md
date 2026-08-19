# Security Policy

This launcher exposes a local DevSpace MCP server through a public Cloudflare Quick Tunnel. Treat the public URL as an internet-facing application endpoint even though DevSpace and SessionGuard themselves bind only to loopback.

## Trust boundaries

The default data path is:

```text
ChatGPT
  -> Cloudflare Quick Tunnel
  -> SessionGuard on 127.0.0.1:7677
  -> DevSpace on 127.0.0.1:7676
  -> one configured allowedRoot
```

Cloudflare, ChatGPT/OpenAI, DevSpace, Node.js, npm, and the MCP SDK are external dependencies and are outside this repository's implementation boundary.

The launcher does not automate the ChatGPT UI and does not store ChatGPT credentials.

## Launcher invariants

The launcher is designed to preserve these properties:

- `allowedRoots` is replaced with exactly one explicitly selected folder.
- A drive root and the Windows user home directory are rejected as allowed roots.
- DevSpace configuration is written atomically and backed up before root changes.
- A failed root-change flow attempts rollback to the previous configuration.
- Only processes matching the recorded PID, expected executable name, and expected command-line fragments are treated as managed processes.
- The DevSpace CLI path is resolved from the installed npm package metadata rather than a user-specific hard-coded path.
- Quick Tunnel public URLs are validated as `https://*.trycloudflare.com` before use.
- Local listener ownership is checked when managed services start.
- Public OAuth protected-resource metadata is checked after stack changes.
- Launcher mutations are serialized with a named mutex.
- `DEVSPACE_TRUST_PROXY=1` is set for the local Cloudflare -> SessionGuard -> DevSpace proxy chain.

## SessionGuard invariants

SessionGuard is intentionally narrow. It is a compatibility/recovery layer, not a generic retry proxy.

### Network placement

- SessionGuard binds to `127.0.0.1` by default.
- DevSpace continues to bind to its local port.
- The managed Cloudflare Quick Tunnel targets SessionGuard, not DevSpace directly.
- No separate unauthenticated public diagnostics endpoint is added.

### Recovery policy

Automatic MCP recovery is eligible only when all of the following are true:

1. The request is for `/mcp`.
2. The client supplied an external `Mcp-Session-Id`.
3. SessionGuard has a previously captured, sanitized initialize template for that external session.
4. DevSpace returns HTTP 404 for that session-bound request.

When eligible:

- only one recovery flight may run per external session at a time,
- SessionGuard performs at most one downstream reinitialize,
- it sends one `notifications/initialized`,
- it updates the session mapping atomically,
- it retries the original request at most once,
- the external session ID presented back to the client remains stable.

SessionGuard does **not** automatically replay requests after:

- HTTP 401 or 403,
- generic HTTP 400-class errors other than the known-session 404 case above,
- HTTP 500-class errors,
- timeout,
- connection reset,
- ambiguous streaming interruption,
- JSON-RPC application errors.

This avoids duplicating operations when it is unknown whether DevSpace already executed the original request.

### Streaming

Normal HTTP proxying and SSE responses are streamed through. SessionGuard does not intentionally buffer a complete SSE stream before forwarding it.

Only request bodies that could become eligible for the single safe retry are buffered, and they are bounded by a replay-size limit. Oversized MCP request bodies fail rather than silently removing the replay-safety bound.

## Recovery state

`%USERPROFILE%\.devspace\runtime\session-guard-state.json` contains recovery state required to reconstruct a downstream MCP session.

It may contain:

- external and downstream MCP session IDs,
- a sanitized `initialize` request template,
- safe initialize headers such as content type / protocol version / user agent,
- timestamps and protocol metadata.

It must not contain:

- Authorization headers,
- bearer/access/refresh tokens,
- cookies,
- passwords,
- request bodies other than the sanitized initialize template,
- tool arguments.

During recovery, the Authorization value from the **current** incoming request may be forwarded in memory to the downstream initialize handshake. It is not copied into persistent recovery state.

The recovery state is written atomically.

## Diagnostic state and logs

`%USERPROFILE%\.devspace\runtime\session-guard-runtime.json` is deliberately separate from recovery state.

It contains only:

- schema version,
- a random per-process guard instance ID,
- startup / traffic / recovery timestamps,
- aggregate counters.

It must not contain:

- Authorization or cookie material,
- tokens or passwords,
- full MCP session IDs,
- request or response bodies,
- tool names or tool arguments,
- local private filesystem paths,
- the public tunnel URL.

Structured SessionGuard logs use normalized URL **paths** and omit query strings so OAuth codes or other query parameters are not accidentally recorded. Session identifiers in recovery events are shortened rather than logged in full.

The `diagnose` action reads only local managed-process state, listener ownership, the safe runtime file, and OAuth metadata health checks. It does not expose a public diagnostics route.

## Process lifecycle

The normal stop order is:

1. Cloudflare public ingress,
2. SessionGuard,
3. DevSpace.

When only one local layer is missing, `start-devspace.cmd` attempts to restore the smallest missing layer while preserving the existing Quick Tunnel URL when safe.

The launcher also recognizes the pre-SessionGuard managed tunnel command line (`cloudflared -> DevSpace:7676`) during a one-time upgrade so the old process can be positively identified and stopped instead of being orphaned.

## Known security limitations

- Cloudflare Quick Tunnel creates a publicly reachable temporary hostname. DevSpace authentication and authorization remain important.
- SessionGuard does not add an independent authentication system; it transparently forwards DevSpace/OAuth traffic.
- MCP session IDs are persisted in the recovery-state file because they are required for continuity. Treat the `%USERPROFILE%\.devspace\runtime` directory as application runtime data and protect the Windows account accordingly.
- SessionGuard cannot protect against a malicious or compromised DevSpace/npm package.
- SessionGuard cannot repair ChatGPT-side connector/tool binding failures that occur before any request reaches the public endpoint.
- The first migration from the old direct-tunnel layout creates a new Quick Tunnel hostname because the tunnel target changes from DevSpace to SessionGuard.

## Reporting a vulnerability

Please open a GitHub security advisory for vulnerabilities that could cause this launcher to expose a broader local path than selected, stop unrelated processes, persist authentication secrets, unsafely replay ambiguous MCP operations, or bypass the intended SessionGuard/DevSpace trust boundary.
