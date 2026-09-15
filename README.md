# pi-fireflies

Search meetings, read transcripts, and get summaries in [pi](https://pi.dev/) through the [official Fireflies MCP server](https://docs.fireflies.ai/getting-started/mcp-configuration). Supports browser OAuth and API keys.

Requires Node.js 22+ and a current pi release (tested with 0.85.1).

## Install

```sh
pi install git:github.com/dgalarza/pi-fireflies
```

In pi, run `/reload`, then `/fireflies login` and approve access in your browser.

Ask: “Find this week's product meetings and summarize the action items.”

For API-key authentication, set `FIREFLIES_API_KEY` before starting pi and run `/fireflies connect`. Get your key from Fireflies → Settings → Developer Settings. Never paste credentials into chat.

**Remote/SSH users:** Browser OAuth needs a loopback callback to the machine running pi. Forward the port shown in the authorization URL's `redirect_uri`, or use an API key.

## Commands

| Command | Action |
| --- | --- |
| `/fireflies login` | Start browser OAuth, even if an API key is set |
| `/fireflies connect` | Reuse the connection, or use an API key, saved OAuth, then interactive login |
| `/fireflies status` | Show connection state and available tools |
| `/fireflies disconnect` | Cancel login and disconnect; keep saved credentials |
| `/fireflies logout` | Disconnect and delete local OAuth credentials; does not revoke remote access or unset an API key |

Reconnect after restarting or reloading pi. Meeting tools are discovered on connection; available tools depend on your account. Each command also has a `fireflies_mcp_<action>` tool.

## Credentials and safety

- OAuth tokens refresh automatically and are stored in `~/.pi/agent/fireflies/oauth.json` (under `PI_CODING_AGENT_DIR` if set). This is a plaintext file with `0600` permissions, not a keychain. Override it with `FIREFLIES_MCP_AUTH_FILE`; use separate files for concurrent pi processes.
- Mutations and unknown tools require interactive confirmation. Saved OAuth and API keys support headless read-only use. A cancelled or timed-out mutation may still have completed remotely.
- Meeting results enter pi's session history and model context. Output beyond 2,000 lines / 50 KB is saved to a private temporary file; delete it when no longer needed.

## Development

```sh
npm ci
npm run check
npm test
pi -e ./extensions/index.ts
```

Tests run offline without credentials. The package is available through GitHub, not npm.

Inspired by [@feniix/pi-notion](https://pi.dev/packages/@feniix/pi-notion?name=notion).
