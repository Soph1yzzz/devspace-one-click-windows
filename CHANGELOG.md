# Changelog

All notable changes to DevSpace One-Click for Windows are documented here.

## v1.1.0 — 2026-08-19

### Highlights

v1.1.0 adds **SessionGuard**, a local compatibility/recovery layer between Cloudflare Quick Tunnel and DevSpace. The goal is to keep long-running ChatGPT conversations usable when the downstream DevSpace MCP session disappears after a DevSpace restart, session cleanup, or transport close.

The normal Windows workflow remains the same: `start-devspace.cmd` is still the primary entry point.

### Added

- Added `session-guard.mjs`, listening on loopback port `7677` and proxying to DevSpace on `7676`.
- Added external-to-downstream MCP session mapping so ChatGPT can keep its external session ID while DevSpace receives a replacement internal session.
- Added conservative stale-session recovery: one fresh `initialize`, one `notifications/initialized`, and at most one retry after a known downstream HTTP 404 for an existing MCP session.
- Added per-external-session single-flight recovery to prevent initialize storms when multiple requests encounter the same stale downstream session concurrently.
- Added persistent, sanitized recovery state and separate diagnostic runtime state under `%USERPROFILE%\.devspace\runtime`.
- Added `diagnose` support in `devspace-control.ps1` for process/listener state, request counters, recovery counters, and local/public metadata checks.
- Added behavior tests and a process-level smoke test for SessionGuard.
- Added detailed SessionGuard architecture/security documentation in `docs/SESSIONGUARD.md`.

### Changed

- Cloudflare Quick Tunnel now targets SessionGuard on `127.0.0.1:7677` instead of DevSpace directly on `127.0.0.1:7676`.
- `start-devspace.cmd` still behaves as the normal one-click entry point, but its underlying `ensure` logic now repairs the smallest missing layer whenever possible.
- If the tunnel and SessionGuard are healthy but DevSpace is stopped, only DevSpace is restarted and the public URL is preserved.
- If the tunnel is healthy but SessionGuard is stopped, only SessionGuard is restarted and the public URL is preserved.
- `change-devspace-root.cmd` now prefers to keep both the current tunnel and SessionGuard alive while restarting only DevSpace.
- `status-devspace.cmd` now reports SessionGuard state, last observed MCP traffic, and recovery success/failure counters.
- Launcher settings now support a separate `BridgePort` (default `7677`).
- Security documentation now covers SessionGuard trust boundaries, replay restrictions, secret handling, and diagnostic state.

### Safety and recovery behavior

- Automatic replay is limited to the specific stale-session case where a known session-bound downstream request receives HTTP 404.
- HTTP 401, 403, generic 4xx/5xx responses, timeouts, connection resets, and other ambiguous delivery failures are not automatically replayed.
- Authorization headers, bearer tokens, cookies, passwords, and tool arguments are not persisted in SessionGuard state or diagnostic logs.
- Streaming/SSE responses pass through without full-response buffering.
- SessionGuard does not patch the globally installed DevSpace package.

### Upgrade notes

Older versions routed the Quick Tunnel directly to DevSpace. The first start after upgrading to v1.1.0 performs a one-time migration from:

```text
Cloudflare Quick Tunnel -> DevSpace:7676
```

to:

```text
Cloudflare Quick Tunnel -> SessionGuard:7677 -> DevSpace:7676
```

Because Cloudflare Quick Tunnel hostnames are tied to the tunnel process, this first migration can produce a new temporary public URL. If that happens, update the ChatGPT MCP connection once. After migration, ordinary DevSpace restarts and root changes preserve the existing tunnel URL whenever the tunnel process remains alive.

Quick Tunnel itself is still temporary: if `cloudflared` must create a new Quick Tunnel later, the public hostname can change.

### Validation

The v1.1.0 implementation includes coverage for:

- normal proxying and initialize/session mapping,
- stale downstream session 404 -> reinitialize -> one retry,
- stable external session IDs across recovery,
- repeated simulated DevSpace restarts,
- SessionGuard restart with persisted mapping reload,
- 401/403/500 no-retry behavior,
- connection-reset no-replay behavior,
- recovery failure without loops,
- concurrent 404 single-flight recovery,
- SSE streaming,
- Authorization/secret non-persistence,
- PowerShell/static launcher safety checks.

## Before v1.1.0

The initial public launcher provided the basic Windows one-click workflow: Cloudflare Quick Tunnel lifecycle management, DevSpace start/stop/status, safe allowed-root changes, configuration backup/rollback, managed-process ownership checks, and public MCP URL handling. v1.1.0 builds on that base without changing the normal double-click UX.
