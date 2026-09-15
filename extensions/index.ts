import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FirefliesConnection, MCP_URL, type Credentials } from "../src/client.ts";
import { browserLogin, FirefliesOAuthProvider } from "../src/oauth.ts";
import { OAuthStore } from "../src/oauth-store.ts";
import { formatResult } from "../src/output.ts";

// Explicit allowlist, not name heuristics or untrusted server annotations.
export const READ_ONLY_TOOLS = new Set([
  "fireflies_search", "fireflies_fetch", "fireflies_get_transcripts",
  "fireflies_get_transcript", "fireflies_get_summary", "fireflies_get_active_meetings",
  "fireflies_get_analytics", "fireflies_list_channels", "fireflies_get_channel",
  "fireflies_get_soundbites", "fireflies_get_user", "fireflies_get_usergroups",
  "fireflies_get_user_contacts", "fireflies_get_rule_executions",
]);

export default function firefliesExtension(pi: ExtensionAPI) {
  registerFireflies(pi, new FirefliesConnection());
}

export function registerFireflies(pi: ExtensionAPI, connection: FirefliesConnection, store = new OAuthStore()) {
  const owned = new Set<string>();
  let provider: FirefliesOAuthProvider | undefined;
  let authSource: "oauth" | "api-key" | undefined;
  let pending: Promise<unknown> | undefined;
  let operationAbort: AbortController | undefined;
  let stopped = false;

  function deactivate() {
    pi.setActiveTools(pi.getActiveTools().filter(name => !owned.has(name)));
  }

  async function disconnect() {
    deactivate();
    try { await connection.disconnect(); }
    finally {
      await provider?.dispose();
      provider = undefined;
      authSource = undefined;
    }
  }

  async function connect(credentials: Credentials, signal?: AbortSignal) {
    const tools = await connection.connect(credentials, signal);
    const names = tools.map(tool => tool.name.startsWith("fireflies_") ? tool.name : `fireflies_${tool.name}`);
    try {
      const existing = new Set(pi.getAllTools().map(tool => tool.name));
      for (const name of names) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || (existing.has(name) && !owned.has(name))) {
          throw new Error(`Cannot register Fireflies tool: invalid or conflicting name ${name}.`);
        }
      }
      if (new Set(names).size !== names.length) throw new Error("Duplicate Fireflies tool names.");
      for (const [index, tool] of tools.entries()) {
        const name = names[index];
        pi.registerTool({
          name,
          label: `Fireflies: ${tool.name}`,
          description: `${tool.description ?? tool.name}\nOutput is JSON, limited to 2000 lines / 50 KB; larger results are saved to a private temporary file. Non-read-only tools require interactive confirmation.`,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
          async execute(_id, args, signal, _onUpdate, ctx) {
            if (!connection.connected) throw new Error("Not connected. Run /fireflies connect.");
            if (!READ_ONLY_TOOLS.has(tool.name)) {
              if (!ctx.hasUI) throw new Error("Fireflies mutations and unknown tools require interactive confirmation.");
              const confirmed = await ctx.ui.confirm(
                `Allow ${name}?`,
                `This may modify or share meeting data.\n${JSON.stringify(args, null, 2)}`,
                { signal },
              );
              if (!confirmed) throw new Error("Fireflies operation declined.");
            }
            const result = await connection.call(tool.name, args, signal);
            const formatted = await formatResult(result);
            if (result.isError) throw new Error(formatted.content[0].text);
            return formatted;
          },
        });
        owned.add(name);
      }
      pi.setActiveTools([...new Set([
        ...pi.getActiveTools().filter(name => !owned.has(name)), ...names,
      ])]);
    } catch (error) {
      await disconnect();
      throw error;
    }
    return status();
  }

  function status() {
    return {
      connected: connection.connected,
      endpoint: MCP_URL,
      auth: connection.connected ? authSource : "disconnected",
      apiKeyConfigured: !!process.env.FIREFLIES_API_KEY?.trim(),
      oauthCredentialFile: store.path,
      tools: connection.catalog.map(tool => tool.name.startsWith("fireflies_") ? tool.name : `fireflies_${tool.name}`),
    };
  }

  async function perform(action: string, ctx: ExtensionContext, signal: AbortSignal, fromTool: boolean) {
    if (action === "disconnect" || action === "logout") {
      await disconnect();
      if (action === "logout") await store.clear();
      return status();
    }
    const forceOAuth = action === "login";
    if (connection.connected && !forceOAuth) return status();
    // Close stale providers and settle any token writes before reading credentials.
    await disconnect();
    const apiKey = !forceOAuth && process.env.FIREFLIES_API_KEY?.trim();
    if (apiKey) {
      authSource = "api-key";
      return connect(apiKey, signal);
    }
    const saved = !forceOAuth ? await store.load() : undefined;
    if (saved) provider = new FirefliesOAuthProvider(saved.redirectUrl, store, saved);
    else {
      if (!ctx.hasUI) throw new Error("Browser login requires an interactive session. Run /fireflies login first, or configure FIREFLIES_API_KEY.");
      if (fromTool && !await ctx.ui.confirm("Connect Fireflies with browser OAuth?", "This opens the Fireflies authorization page and saves credentials locally.", { signal })) {
        throw new Error("Fireflies browser login declined.");
      }
      provider = await browserLogin(store, text => notify(ctx, text), signal);
    }
    authSource = "oauth";
    return connect(provider, signal);
  }

  async function control(action: string, ctx: ExtensionContext, signal?: AbortSignal, fromTool = false) {
    if (action === "status") return status();
    if (stopped) throw new Error("Fireflies extension is shutting down.");
    if (action === "disconnect" || action === "logout") {
      operationAbort?.abort();
      await pending?.catch(() => {});
    }
    if (pending) throw new Error("A Fireflies connection operation is already in progress. Use /fireflies disconnect to cancel it.");
    operationAbort = new AbortController();
    const combined = AbortSignal.any([
      operationAbort.signal, AbortSignal.timeout(5 * 60_000), ...(signal ? [signal] : []),
    ]);
    pending = perform(action, ctx, combined, fromTool);
    try { return await pending; }
    finally { pending = undefined; operationAbort = undefined; }
  }

  for (const action of ["connect", "disconnect", "status", "login", "logout"] as const) {
    pi.registerTool({
      name: `fireflies_mcp_${action}`,
      label: `Fireflies MCP ${action}`,
      description: {
        connect: "Connect Fireflies using FIREFLIES_API_KEY, saved OAuth, or browser login (in that order), and discover meeting tools. Never pass credentials in chat.",
        disconnect: "Disconnect Fireflies and disable meeting tools. Retains saved OAuth credentials; cancels pending login.",
        status: "Show local Fireflies connection status and available tools. Does not expose credentials or perform a health probe.",
        login: "Explicitly authorize Fireflies in a browser using OAuth, even if an API key is set. Requires user confirmation and saves credentials locally.",
        logout: "Disconnect Fireflies and delete saved OAuth credentials. Does not revoke the remote grant or unset FIREFLIES_API_KEY.",
      }[action],
      parameters: Type.Object({}),
      async execute(_id, _args, signal, _onUpdate, ctx) {
        return formatResult(await control(action, ctx, signal, true));
      },
    });
  }

  pi.registerCommand("fireflies", {
    description: "Fireflies MCP: connect, login (browser OAuth), status, disconnect, or logout",
    async handler(args, ctx) {
      if (!ctx.isIdle() && !["disconnect", "logout", "status"].includes(args.trim())) {
        notify(ctx, "Wait for the current turn to finish before changing the Fireflies connection.", "warning");
        return;
      }
      try {
        const action = args.trim() || "status";
        if (!["connect", "login", "status", "disconnect", "logout"].includes(action)) {
          notify(ctx, "Usage: /fireflies [connect|login|status|disconnect|logout]", "warning"); return;
        }
        notify(ctx, JSON.stringify(await control(action, ctx), null, 2));
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : "Fireflies operation failed.", "error");
      }
    },
  });

  // No network I/O at extension load or startup. Explicit connect works in all modes.
  pi.on("session_shutdown", async () => {
    stopped = true;
    operationAbort?.abort();
    await pending?.catch(() => {});
    await connection.disconnect();
    await provider?.dispose();
  });
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(text, level);
}
