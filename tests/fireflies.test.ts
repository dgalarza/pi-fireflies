import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FirefliesConnection } from "../src/client.ts";
import { formatResult } from "../src/output.ts";
import { registerFireflies } from "../extensions/index.ts";
import { OAuthStore } from "../src/oauth-store.ts";

async function fixture(options: { fail?: boolean; repeatedCursor?: boolean } = {}) {
  const server = new Server({ name: "test-fireflies", version: "1" }, { capabilities: { tools: {} } });
  const calls: unknown[] = [];
  const tools = ["fireflies_get_transcripts", "fireflies_share_meeting"].map(name => ({
    name, description: name, inputSchema: { type: "object" as const, properties: {} },
  }));
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    if (options.fail) throw new Error("secret-key must not leak");
    return request.params?.cursor
      ? { tools: [tools[1]], ...(options.repeatedCursor ? { nextCursor: "page2" } : {}) }
      : { tools: [tools[0]], nextCursor: "page2" };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params);
    return { content: [{ type: "text", text: "meeting data" }], structuredContent: { meeting: 123 } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  let created = 0;
  const connection = new FirefliesConnection(() => {
    created++;
    return { client: new Client({ name: "test", version: "1" }), transport: clientTransport };
  });
  return { connection, calls, created: () => created, server };
}

test("connect discovers all pages, coalesces parallel connects, and calls tools unchanged", async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([f.connection.connect("key"), f.connection.connect("key")]);
    assert.equal(f.created(), 1);
    assert.equal(first, second);
    assert.equal(first.length, 2);
    const args = { keyword: "00123", participants: ["person@example.com"] };
    const result = await f.connection.call("fireflies_get_transcripts", args);
    assert.deepEqual(result.structuredContent, { meeting: 123 });
    assert.deepEqual(f.calls, [{ name: "fireflies_get_transcripts", arguments: args }]);
    await f.connection.disconnect();
    assert.equal(f.connection.connected, false);
    await assert.rejects(f.connection.call("fireflies_get_transcripts", {}), /unavailable/);
    await f.connection.disconnect();
  } finally { await f.server.close(); }
});

test("missing credentials and pre-cancelled connections never open a transport", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connection.connect(undefined), /FIREFLIES_API_KEY/);
    await assert.rejects(f.connection.connect("key", AbortSignal.abort()));
    assert.equal(f.created(), 0);
  } finally { await f.server.close(); }
});

for (const options of [{ fail: true }, { repeatedCursor: true }]) {
  test(`failed discovery cleans up and redacts errors: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(f.connection.connect("secret-key"), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /connection failed/);
        assert.ok(!error.message.includes("secret-key"));
        return true;
      });
      assert.equal(f.connection.connected, false);
      assert.deepEqual(f.connection.catalog, []);
    } finally { await f.server.close(); }
  });
}

test("aborted tool calls are not sent", async () => {
  const f = await fixture();
  try {
    await f.connection.connect("key");
    await assert.rejects(f.connection.call("fireflies_get_transcripts", {}, AbortSignal.abort()));
    assert.equal(f.calls.length, 0);
  } finally { await f.connection.disconnect(); await f.server.close(); }
});

test("large output is bounded, recoverable, and private", async () => {
  const original = { content: [{ type: "text", text: "private meeting\n".repeat(10_000) }] };
  const result = await formatResult(original);
  const path = result.details.outputPath;
  assert.ok(path);
  try {
    assert.match(result.content[0].text, /Truncated/);
    assert.ok(Buffer.byteLength(result.content[0].text) < 52_000);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(dirname(path), { recursive: true }); }
});

test("saved OAuth connects headlessly; logout clears credentials and future browser login requires UI", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "fireflies-control-test-"));
  const store = new OAuthStore(join(dir, "oauth.json"));
  await store.save({
    version: 1, redirectUrl: "http://127.0.0.1:45678/callback",
    client: { client_id: "test" }, tokens: { access_token: "secret", token_type: "Bearer" },
  });
  const definitions = new Map<string, ToolDefinition>();
  let active: string[] = [];
  const api = {
    registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool); active.push(tool.name); },
    getAllTools: () => [...definitions.values()], getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; }, registerCommand() {}, on() {},
  } as unknown as ExtensionAPI;
  const priorKey = process.env.FIREFLIES_API_KEY;
  delete process.env.FIREFLIES_API_KEY;
  const run = (name: string) => definitions.get(name)!.execute("id", {}, undefined, undefined,
    { hasUI: false } as Parameters<ToolDefinition["execute"]>[4]);
  try {
    registerFireflies(api, f.connection, store);
    const result = await run("fireflies_mcp_connect");
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).auth, "oauth");
    assert.ok(!JSON.stringify(result).includes("secret"));
    await run("fireflies_mcp_disconnect");
    assert.ok(await store.load());
    await run("fireflies_mcp_logout");
    assert.equal(await store.load(), undefined);
    await assert.rejects(run("fireflies_mcp_connect"), /interactive session/);
    await assert.rejects(run("fireflies_mcp_login"), /interactive session/);
    assert.equal(f.created(), 1);
  } finally {
    if (priorKey === undefined) delete process.env.FIREFLIES_API_KEY;
    else process.env.FIREFLIES_API_KEY = priorKey;
    await f.connection.disconnect(); await f.server.close(); await rm(dir, { recursive: true });
  }
});

test("extension registers tools lazily, preserves others, gates writes, and disables on disconnect", async () => {
  const f = await fixture();
  const definitions = new Map<string, ToolDefinition>();
  let active = ["read", "unrelated"];
  const api = {
    registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool); active.push(tool.name); },
    getAllTools: () => [...definitions.values()],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    registerCommand() {}, on() {},
  } as unknown as ExtensionAPI;
  const priorKey = process.env.FIREFLIES_API_KEY;
  process.env.FIREFLIES_API_KEY = "key";
  // Tool invocation boundary is deliberately minimal; the SDK fixture supplies actual MCP behavior.
  const run = (name: string, ctx = { hasUI: false }) => definitions.get(name)!.execute(
    "id", {}, undefined, undefined, ctx as Parameters<ToolDefinition["execute"]>[4],
  );
  try {
    registerFireflies(api, f.connection);
    assert.equal(definitions.size, 5);
    assert.equal(f.created(), 0);
    await run("fireflies_mcp_connect");
    assert.ok(active.includes("fireflies_get_transcripts"));
    assert.ok(active.includes("unrelated"));
    await run("fireflies_get_transcripts");
    await assert.rejects(run("fireflies_share_meeting"), /interactive confirmation/);
    await assert.rejects(run("fireflies_share_meeting", {
      hasUI: true, ui: { confirm: async () => false },
    } as unknown as { hasUI: boolean }), /declined/);
    assert.equal(f.calls.length, 1);
    await run("fireflies_mcp_disconnect");
    assert.ok(!active.includes("fireflies_get_transcripts"));
    assert.ok(active.includes("read"));
    assert.ok(active.includes("fireflies_mcp_connect"));
    await assert.rejects(run("fireflies_get_transcripts"), /Not connected/);
  } finally {
    if (priorKey === undefined) delete process.env.FIREFLIES_API_KEY;
    else process.env.FIREFLIES_API_KEY = priorKey;
    await f.connection.disconnect(); await f.server.close();
  }
});
