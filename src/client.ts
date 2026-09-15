import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { MCP_URL, secureFetch } from "./oauth.ts";
export { MCP_URL } from "./oauth.ts";

export type Credentials = string | OAuthClientProvider;
type ClientFactory = (credentials: Credentials) => { client: Client; transport: Transport };
const TIMEOUT_MS = 30_000;

export function createClient(credentials: Credentials) {
  const client = new Client({ name: "pi-fireflies", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    ...(typeof credentials === "string"
      ? { requestInit: { headers: { Authorization: `Bearer ${credentials}` }, redirect: "error" as const } }
      : { authProvider: credentials }),
    fetch: secureFetch(),
  });
  return { client, transport };
}

export class FirefliesConnection {
  private client?: Client;
  private pending?: Promise<Tool[]>;
  private controller?: AbortController;
  private closing?: Promise<void>;
  private tools: Tool[] = [];

  constructor(private readonly factory: ClientFactory = createClient) {}

  get connected() { return this.client !== undefined; }
  get catalog(): readonly Tool[] { return this.tools; }

  async connect(credentials: Credentials | undefined, signal?: AbortSignal): Promise<Tool[]> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Fireflies is disconnecting; try again shortly.");
    if (this.client) return this.tools;
    if (this.pending) return this.pending;
    if (!credentials || (typeof credentials === "string" && !credentials.trim())) {
      throw new Error("Run /fireflies login for browser OAuth, or set FIREFLIES_API_KEY in your environment. Do not paste credentials into chat.");
    }
    this.controller = new AbortController();
    const combined = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    this.pending = this.open(typeof credentials === "string" ? credentials.trim() : credentials, combined);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
      this.controller = undefined;
    }
  }

  private async open(credentials: Credentials, signal: AbortSignal): Promise<Tool[]> {
    const { client, transport } = this.factory(credentials);
    try {
      await client.connect(transport, { signal, timeout: TIMEOUT_MS });
      const tools: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated catalog cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      signal.throwIfAborted();
      this.tools = tools;
      this.client = client;
      client.onclose = () => {
        if (this.client === client) {
          this.client = undefined;
          this.tools = [];
        }
      };
      return tools;
    } catch {
      await client.close().catch(() => {});
      // Never include transport errors: servers may echo credentials or headers.
      throw new Error(signal.aborted
        ? "Fireflies connection cancelled or timed out."
        : "Fireflies connection failed. Check account access and network; retry /fireflies connect, or /fireflies login to reauthorize OAuth.");
    }
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.client || !this.tools.some(tool => tool.name === name)) {
      throw new Error("Fireflies tool unavailable. Run /fireflies connect.");
    }
    try {
      return await this.client.callTool({ name, arguments: args }, undefined, {
        signal, timeout: TIMEOUT_MS,
      });
    } catch {
      throw new Error(signal?.aborted
        ? "Fireflies request cancelled."
        : "Fireflies request failed or timed out. Check the connection. Do not automatically retry mutations: the server may have completed them.");
    }
  }

  async disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.close();
    try { await this.closing; } finally { this.closing = undefined; }
  }

  private async close() {
    this.controller?.abort();
    await this.pending?.catch(() => {});
    const client = this.client;
    this.client = undefined;
    this.tools = [];
    await client?.close();
  }
}
