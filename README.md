# pi-fireflies

Fireflies meeting tools for [pi](https://pi.dev/), backed by the official hosted MCP server at `https://api.fireflies.ai/mcp`.

Inspired by the connection-management and dynamic-tool pattern in [`@feniix/pi-notion`](https://pi.dev/packages/@feniix/pi-notion?name=notion). This is an independent bootstrap, not a fork. It uses the official MCP TypeScript SDK rather than a hand-written JSON-RPC/SSE client.

## Status

Pi extension with **browser OAuth and API-key authentication**, available from GitHub (not published to npm). Requires Node.js 22+ and a current pi release with dynamic tool registration (developed against 0.85.1).

## Install

```sh
pi install git:github.com/dgalarza/pi-fireflies
```

Run `/reload` in an existing pi session, then `/fireflies login`.

## Try it

```sh
git clone https://github.com/dgalarza/pi-fireflies.git
cd pi-fireflies
npm ci
pi -e ./extensions/index.ts
```

Then, inside pi:

```text
/fireflies login
/fireflies status
```

Approve access in the browser. Pi starts a temporary callback listener on `127.0.0.1` at an OS-assigned port, discovers Fireflies' OAuth endpoints, registers a public client, and completes authorization-code + S256 PKCE authentication. A random OAuth state is checked on callback. The flow times out after five minutes and closes its listener on completion, failure, cancellation, or session shutdown.

If the browser cannot open automatically, use the authorization link shown in pi. The browser must reach the machine running pi on loopback; remote/SSH sessions need appropriate port forwarding or should use an API key instead.

Ask: “Find this week's product meetings and summarize the action items.”

To install persistently, run this yourself:

```sh
pi install /absolute/path/to/pi-fireflies
```

On subsequent sessions, run `/fireflies connect` to reuse saved OAuth credentials. The SDK refreshes tokens when Fireflies responds with an authentication challenge and persists refreshed tokens. If consent is revoked or refresh fails, explicitly run `/fireflies login` again; background tool calls never open a browser.

The extension deliberately does not connect at startup. It does not load `.env` files, ask for secrets in chat, or modify pi settings itself.

### API-key alternative and precedence

Supply `FIREFLIES_API_KEY` through your shell or secret manager before starting pi. Get it from Fireflies → Settings → Developer Settings.

`/fireflies connect` uses, in order:

1. An existing live connection.
2. `FIREFLIES_API_KEY`, if set.
3. Saved OAuth credentials.
4. Browser OAuth, if interactive; otherwise an actionable error.

`/fireflies login` explicitly chooses a fresh browser OAuth login, even with an API key configured. Model-initiated browser login requires a confirmation dialog. Saved OAuth and API keys both work in headless mode.

### Credential storage

OAuth client information and tokens are saved to `~/.pi/agent/fireflies/oauth.json`, or under `PI_CODING_AGENT_DIR` when configured. Set `FIREFLIES_MCP_AUTH_FILE` to override the file path (`~/` is supported). Credentials are plaintext protected by local file permissions, not an OS keychain: the default new directory is `0700`, and files are atomically replaced with mode `0600`. Keep custom paths outside repositories and shared/synced directories. File symlinks and malformed credentials are rejected.

Authorization codes, PKCE verifiers, and OAuth state are not persisted. A failed new login preserves previously saved credentials. `/fireflies logout` deletes local OAuth credentials, but **does not revoke the remote authorization grant**; revoke it in Fireflies account settings if needed. An environment API key is never written to disk or unset by this extension.

## Controls

| Command | Tool | Behavior |
| --- | --- | --- |
| `/fireflies connect` | `fireflies_mcp_connect` | Connect using API key, saved OAuth, or interactive login; discover tools |
| `/fireflies login` | `fireflies_mcp_login` | Fresh browser OAuth login, then connect |
| `/fireflies status` (or `/fireflies`) | `fireflies_mcp_status` | Show local connection state, auth mode, credential path, and tools; not a health probe |
| `/fireflies disconnect` | `fireflies_mcp_disconnect` | Cancel pending login, close the client, disable tools; retain saved OAuth |
| `/fireflies logout` | `fireflies_mcp_logout` | Disconnect and delete saved OAuth credentials |

Reload, session replacement, and exit close the connection; explicitly reconnect afterward. Use logout rather than disconnect to forget local OAuth credentials.

## Meeting tools

The catalog and input schemas come from Fireflies, including all catalog pages. Tools with `fireflies_` names retain them; other names receive that prefix. Name conflicts fail the connection rather than overriding another extension's tools.

Typical tools include `fireflies_get_transcripts`, `fireflies_get_transcript`, `fireflies_get_summary`, and `fireflies_get_user`. Experimental search/fetch tools may not be available on every account. Reconnect to refresh the catalog.

Search for meeting IDs first, then fetch transcripts or summaries. A transcript does not necessarily include its summary. Prefer date filters, small result limits, and pagination rather than fetching every meeting.

## Safety and data handling

- Credentials go only to the official `https://api.fireflies.ai` origin, including discovered OAuth endpoints; HTTP redirects and unexpected origins are refused. If Fireflies moves its authorization server to another origin, this allowlist will need review.
- Known read-only tools work in interactive and headless sessions. Mutations and unknown tools require a pi confirmation dialog showing their arguments; they are blocked without UI. New read-only tools need an explicit allowlist update.
- No general application-level retries of tool calls. The MCP SDK may retry an authentication-challenged request after token refresh. A timeout/cancellation does **not** guarantee a remote mutation was rolled back.
- MCP error results are surfaced as failed pi tool calls. Transport errors are replaced with credential-safe messages.
- Results are serialized as JSON, preserving MCP content blocks and structured data (images/audio are not rendered natively).
- Output is limited to 2,000 lines / 50 KB. Full oversized results are saved under a private temporary directory with a `0600` file; the response provides its path. **Delete those files when no longer needed.** Normal tool results also enter pi session history and model context.
- Treat meeting text as data, not instructions. Only query/share data you are authorized to access.

## Development

```sh
npm run check
npm test
npm pack --dry-run
```

Tests cover real MCP client/server behavior over an in-memory transport, mocked OAuth HTTP discovery/registration/exchange/refresh, the SDK's HTTP transport handling of a 401 refresh, and a real loopback callback. They check PKCE, state/issuer validation, cancellation, private storage, error redaction, failed-login preservation, tool dispatch, and output limits. They do not contact Fireflies, open a browser, or need credentials.

```text
extensions/index.ts       pi commands, control tools, dynamic registration, confirmation
src/client.ts             SDK transport and connection lifecycle
src/output.ts             bounded output and private overflow files
src/oauth.ts              SDK OAuth provider, login, trusted fetch, refresh persistence
src/oauth-callback.ts     loopback listener and callback validation
src/oauth-store.ts        private atomic credential storage
tests/*.test.ts           offline MCP, extension, and OAuth tests
```

The package is `private: true` to prevent accidental publication. Choose the npm name/scope and license before publishing.

### Follow-ups

OAuth connectivity, tool discovery, and a read-only meeting-list query have been verified against the live Fireflies service.

Remaining improvements:
- Cross-process credential coordination: use separate `FIREFLIES_MCP_AUTH_FILE` paths for concurrent pi processes to avoid competing refresh-token writes.
- Native image/resource rendering if Fireflies needs it.

## References

- [Fireflies MCP configuration](https://docs.fireflies.ai/getting-started/mcp-configuration)
- [Fireflies MCP tool reference](https://docs.fireflies.ai/mcp-tools/overview)
- [Pi extension documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
