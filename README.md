# DevSpace One-Click for Windows

[日本語の簡易ガイド](README.ja.md)

An unofficial Windows companion for running [DevSpace](https://github.com/Waishnav/devspace) with a Cloudflare Quick Tunnel using mostly double-click operations.

- After restarting Windows: double-click `start-devspace.cmd`
- To switch repositories: copy a folder path, double-click `change-devspace-root.cmd`, and paste it
- To stop the stack: double-click `stop-devspace.cmd`
- To view the current status and MCP URL: double-click `status-devspace.cmd`

The launcher automates the DevSpace server lifecycle, Cloudflare Quick Tunnel URL discovery, `publicBaseUrl` updates, external OAuth metadata health checks, safe `allowedRoots` switching, configuration backups, and rollback after failed root changes.

> [!IMPORTANT]
> This is not an official DevSpace project. It does not bundle DevSpace and uses the globally installed `@waishnav/devspace` package.

## Why this exists

Cloudflare Quick Tunnel assigns a temporary URL that normally changes whenever the tunnel is recreated. This launcher automatically discovers the new URL, updates DevSpace's `publicBaseUrl`, starts DevSpace, and verifies that the public OAuth metadata endpoint is reachable.

When you want DevSpace to access a different repository, paste the repository path into the root-switch command. If the existing tunnel is healthy, the launcher keeps it running and restarts only the DevSpace server, so the MCP URL remains unchanged.

The final step of registering or updating the URL in ChatGPT is intentionally left manual. This avoids depending on ChatGPT's frequently changing UI and avoids giving the launcher access to ChatGPT credentials or browser sessions.

## Requirements

- Windows 10 or Windows 11
- Windows PowerShell 5.1 or later
- Node.js and npm
- DevSpace (`@waishnav/devspace`)
- Cloudflare `cloudflared`

Example installation commands:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g @waishnav/devspace
winget install --id Cloudflare.cloudflared
```

Refer to the official DevSpace README for the initial DevSpace setup and ChatGPT MCP registration flow.

## Installation

1. Clone this repository or download and extract its ZIP archive.
2. Optionally copy `launcher.settings.example.json` to `launcher.settings.json` and adjust the defaults.
3. Run `change-devspace-root.cmd` once and enter the folder DevSpace may access.
4. Copy the displayed `https://...trycloudflare.com/mcp` URL into ChatGPT's MCP settings.

```powershell
git clone https://github.com/Soph1yzzz/devspace-one-click-windows.git
cd devspace-one-click-windows
```

## Usage

### Start after a reboot

Double-click `start-devspace.cmd`.

If the managed DevSpace server and tunnel are already running, the launcher keeps the current URL. Otherwise, it creates a new Quick Tunnel, updates DevSpace, starts the server, performs a public connectivity check, and displays the MCP URL.

### Switch the allowed repository

1. Copy the target folder path in File Explorer.
2. Double-click `change-devspace-root.cmd`.
3. Paste the path and press Enter.

You can also provide the path directly from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\change-devspace-root.ps1 -Path "C:\path\to\repository"
```

For safety, drive roots and the entire user home directory are rejected. `allowedRoots` is replaced with exactly one explicitly selected folder.

### Check status

Double-click `status-devspace.cmd`, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 status
```

### Stop DevSpace and the tunnel

Double-click `stop-devspace.cmd`, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 stop
```

## Configuration

Copy `launcher.settings.example.json` to `launcher.settings.json` to override the defaults:

```json
{
  "Port": 7676,
  "StartupTimeoutSeconds": 30,
  "HttpTimeoutSeconds": 20,
  "BackupRetention": 10
}
```

| Setting | Description |
|---|---|
| `Port` | DevSpace listening port. It must match the DevSpace configuration. |
| `StartupTimeoutSeconds` | Maximum time to wait for DevSpace or the tunnel to start. |
| `HttpTimeoutSeconds` | Timeout for the public OAuth metadata health check. |
| `BackupRetention` | Number of pre-change DevSpace configuration backups to retain. |

The personal `launcher.settings.json` file is ignored by Git.

## Safety and reliability design

- Limits `allowedRoots` to one explicit folder
- Rejects drive roots and the entire user home directory
- Writes DevSpace configuration through an atomic temporary-file replacement
- Stores pre-change backups under `%USERPROFILE%\.devspace\backups`
- Attempts automatic rollback after a root-change or restart failure
- Matches PID, process name, and command-line fragments before stopping managed processes
- Resolves the DevSpace CLI dynamically from the installed package's `package.json`
- Validates stored Cloudflare Quick Tunnel URLs
- Confirms that DevSpace owns the configured listening port
- Checks that the public OAuth metadata endpoint returns HTTP 200
- Uses a mutex to prevent overlapping launcher operations
- Does not automate the ChatGPT UI or store ChatGPT credentials

## Runtime files and backups

Runtime state is stored inside DevSpace's existing user directory:

```text
%USERPROFILE%\.devspace\runtime\
%USERPROFILE%\.devspace\backups\
```

Main log files:

- `cloudflared.out.log`
- `cloudflared.err.log`
- `devspace.out.log`
- `devspace.err.log`

## Updating dependencies

The launcher does not assume a hard-coded internal path such as `dist/cli.js`. It reads the installed DevSpace package's `bin` declaration from `package.json`, which makes it more tolerant of future package-layout changes.

Example update commands:

```powershell
npm update -g @waishnav/devspace
winget upgrade --id Cloudflare.cloudflared
```

After updating, run the isolated checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Static.ps1
```

## Troubleshooting

### `cloudflared was not found`

```powershell
winget install --id Cloudflare.cloudflared
```

### `devspace was not found`

```powershell
npm install -g @waishnav/devspace
```

### The configured port is already in use

Inspect the process ID shown in the error. If another DevSpace instance was started manually, stop it first.

```powershell
Get-NetTCPConnection -LocalPort 7676 -State Listen
```

### The Quick Tunnel URL could not be discovered

Check:

```text
%USERPROFILE%\.devspace\runtime\cloudflared.err.log
```

Possible causes include a temporary Cloudflare outage, network restrictions, or security software blocking `cloudflared`.

### The public connectivity check failed

Inspect `devspace.err.log` and `cloudflared.err.log`. If tunnel propagation is slow on your network, increase `HttpTimeoutSeconds` in `launcher.settings.json`.

### A root change failed

The launcher attempts to restore the most recent pre-change configuration and restart the previous setup. Backups are stored under:

```text
%USERPROFILE%\.devspace\backups
```

## Known limitations

- Windows only
- Cloudflare Quick Tunnel provides a temporary URL and no fixed-URL or availability guarantee
- The ChatGPT MCP URL must be updated manually after Windows restarts or the tunnel is recreated
- The launcher deliberately does not automate ChatGPT's settings UI
- Compatibility cannot be guaranteed against every future breaking change in DevSpace or Cloudflare Tunnel
- A full live test stops and recreates the active DevSpace connection; use the static test while an important session is in progress

## Security

Follow [SECURITY.md](SECURITY.md) when reporting a vulnerability. Do not publish secrets, private repository names, personal filesystem paths, active access tokens, or active MCP URLs in a public issue.

A Quick Tunnel URL is not a private key, but it should not be shared unnecessarily. Keep DevSpace authentication and authorization enabled, and keep `allowedRoots` restricted to the smallest required folder.

## License

MIT License. See [LICENSE](LICENSE).
