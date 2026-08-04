# Security Policy

## Supported versions

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Do not include secrets, personal paths, access tokens, private repository names, or active MCP URLs in a public Issue.

Report the problem privately through GitHub's security advisory feature when available. Include:

- affected commit or version
- Windows and PowerShell versions
- DevSpace and cloudflared versions
- minimal reproduction steps
- expected and actual behavior
- whether arbitrary files, processes, or network endpoints can be affected

If private reporting is unavailable, open a public Issue containing only a high-level description and request a private contact channel.

## Security model

This tool launches DevSpace and Cloudflare Quick Tunnel on the user's machine. It assumes:

- the Windows user account is trusted
- DevSpace, Node.js, npm, and cloudflared were installed from trusted sources
- the user keeps `allowedRoots` limited to folders they intend to expose
- the generated MCP URL is shared only with intended clients

The launcher does not store ChatGPT credentials and does not automate the ChatGPT settings UI.

## Out of scope

- vulnerabilities in DevSpace, Node.js, npm, Cloudflare Tunnel, Windows, or ChatGPT
- attacks requiring prior administrative control of the user's machine
- availability guarantees for Cloudflare Quick Tunnel
