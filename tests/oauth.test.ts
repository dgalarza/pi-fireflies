import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FirefliesConnection } from "../src/client.ts";
import { OAuthStore, type SavedOAuth } from "../src/oauth-store.ts";
import { browserLogin, FirefliesOAuthProvider, MCP_URL, secureFetch, trustedUrl } from "../src/oauth.ts";
import { startCallback } from "../src/oauth-callback.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

function oauthServer() {
  const requests: { url: string; init?: RequestInit }[] = [];
  let tokenError = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("oauth-protected-resource")) return json({
      resource: MCP_URL, authorization_servers: ["https://api.fireflies.ai/"], scopes_supported: ["email", "profile"],
    });
    if (url.includes("oauth-authorization-server")) return json({
      issuer: "https://api.fireflies.ai/",
      authorization_endpoint: "https://api.fireflies.ai/authorize",
      token_endpoint: "https://api.fireflies.ai/token",
      registration_endpoint: "https://api.fireflies.ai/register",
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    if (url.endsWith("/register")) return json({
      ...JSON.parse(String(init?.body)), client_id: "test-client", client_id_issued_at: 123,
    }, 201);
    if (url.endsWith("/token")) return tokenError
      ? json({ error: "invalid_grant", error_description: "secret-token" }, 400)
      : json({ access_token: "new-access-token", refresh_token: "rotated-refresh-token", token_type: "Bearer", expires_in: 3600 });
    throw new Error(`Unexpected test endpoint ${url}`);
  };
  return { fetcher, requests, failTokens() { tokenError = true; } };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fireflies-oauth-test-"));
  const store = new OAuthStore(join(dir, "private", "oauth.json"));
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const saved: SavedOAuth = {
  version: 1, redirectUrl: "http://127.0.0.1:45678/callback",
  client: { client_id: "saved-client" },
  tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" },
};

test("browser OAuth uses discovery, DCR, PKCE and a real loopback callback; saves private credentials", async () => {
  const f = await fixture();
  const server = oauthServer();
  let authorization: URL | undefined;
  const notices: string[] = [];
  try {
    const provider = await browserLogin(f.store, text => notices.push(text), AbortSignal.timeout(5000), {
      fetchFn: secureFetch(undefined, server.fetcher),
      open: async url => {
        authorization = url;
        assert.equal(url.origin, "https://api.fireflies.ai");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("client_id"), "test-client");
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "test-code");
        callback.searchParams.set("state", "wrong-state");
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("iss", "https://api.fireflies.ai/");
        assert.equal((await fetch(callback)).status, 200);
      },
    });
    const tokenRequest = server.requests.find(request => request.url.endsWith("/token"))!;
    const body = new URLSearchParams(String(tokenRequest.init?.body));
    assert.equal(body.get("code"), "test-code");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization!.searchParams.get("code_challenge"));
    assert.ok(server.requests.every(request => request.init?.redirect === "error"));
    const stored = await f.store.load();
    assert.equal(stored?.tokens.access_token, "new-access-token");
    assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.dir, "private"))).mode & 0o777, 0o700);
    const raw = await readFile(f.store.path, "utf8");
    assert.ok(!raw.includes(body.get("code_verifier")!));
    assert.ok(!raw.includes("test-code"));
    assert.ok(notices.every(text => !text.includes("new-access-token")));
    assert.throws(() => provider.codeVerifier(), /Missing/);
    await assert.rejects(provider.redirectToAuthorization(new URL("https://api.fireflies.ai/authorize")), /login/);
    // Callback is closed after successful authorization.
    await assert.rejects(fetch(authorization!.searchParams.get("redirect_uri")!));
    await provider.dispose();
  } finally { await f.cleanup(); }
});

test("SDK refresh persists rotated tokens without launching a browser", async () => {
  const f = await fixture();
  const server = oauthServer();
  try {
    await f.store.save(saved);
    const provider = new FirefliesOAuthProvider(saved.redirectUrl, f.store, await f.store.load());
    assert.equal(await auth(provider, { serverUrl: MCP_URL, fetchFn: secureFetch(undefined, server.fetcher) }), "AUTHORIZED");
    const request = server.requests.find(request => request.url.endsWith("/token"))!;
    const body = new URLSearchParams(String(request.init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "old-refresh");
    assert.equal((await f.store.load())?.tokens.refresh_token, "rotated-refresh-token");
    assert.ok(!server.requests.some(request => request.url.endsWith("/register")));
    await provider.dispose();
    await assert.rejects(provider.saveTokens(saved.tokens), /closed/);
  } finally { await f.cleanup(); }
});

test("real SDK HTTP transport refreshes on 401 and retries with the new bearer token", async () => {
  const f = await fixture();
  const server = oauthServer();
  const seen: string[] = [];
  await f.store.save(saved);
  const provider = new FirefliesOAuthProvider(saved.redirectUrl, f.store, saved);
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) !== MCP_URL) return server.fetcher(input, init);
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const authorization = new Headers(init?.headers).get("Authorization")!;
    seen.push(authorization);
    if (authorization === "Bearer old-access") return new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer resource_metadata="https://api.fireflies.ai/.well-known/oauth-protected-resource/mcp"' },
    });
    assert.equal(authorization, "Bearer new-access-token");
    const request = JSON.parse(String(init?.body));
    if (!("id" in request)) return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
      : { tools: [] },
    });
  };
  const connection = new FirefliesConnection(() => ({
    client: new Client({ name: "test", version: "1" }),
    transport: new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: secureFetch(undefined, fetcher) }),
  }));
  try {
    await connection.connect(provider);
    assert.equal(connection.connected, true);
    assert.equal(seen[0], "Bearer old-access");
    assert.ok(seen.slice(1).every(header => header === "Bearer new-access-token"));
    assert.equal((await f.store.load())?.tokens.refresh_token, "rotated-refresh-token");
  } finally { await connection.disconnect(); await provider.dispose(); await f.cleanup(); }
});

test("denied login preserves existing credentials and does not reflect callback HTML", async () => {
  const f = await fixture();
  const server = oauthServer();
  try {
    await f.store.save(saved);
    await assert.rejects(browserLogin(f.store, () => {}, AbortSignal.timeout(5000), {
      fetchFn: secureFetch(undefined, server.fetcher),
      open: async url => {
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("error", "<script>secret-token</script>");
        const response = await fetch(callback);
        assert.equal(response.status, 400);
        assert.ok(!(await response.text()).includes("script"));
      },
    }), error => error instanceof Error && !error.message.includes("secret-token") && /denied/.test(error.message));
    assert.deepEqual(await f.store.load(), saved);
  } finally { await f.cleanup(); }
});

test("invalid refresh credentials require explicit login, never browser interaction", async () => {
  const f = await fixture();
  const server = oauthServer();
  server.failTokens();
  try {
    await f.store.save(saved);
    const provider = new FirefliesOAuthProvider(saved.redirectUrl, f.store, saved);
    await assert.rejects(auth(provider, { serverUrl: MCP_URL, fetchFn: secureFetch(undefined, server.fetcher) }), /login/);
    assert.equal(await f.store.load(), undefined);
    await provider.dispose();
  } finally { await f.cleanup(); }
});

test("login cancellation cleans up callback and keeps saved credentials", async () => {
  const f = await fixture();
  const server = oauthServer();
  const abort = new AbortController();
  let callbackUrl: string | undefined;
  try {
    await f.store.save(saved);
    await assert.rejects(browserLogin(f.store, () => {}, abort.signal, {
      fetchFn: secureFetch(abort.signal, server.fetcher),
      open: async url => { callbackUrl = url.searchParams.get("redirect_uri")!; abort.abort(); },
    }), /cancelled/);
    assert.deepEqual(await f.store.load(), saved);
    assert.ok(callbackUrl);
    await assert.rejects(fetch(callbackUrl));
  } finally { await f.cleanup(); }
});

test("callback rejects wrong paths, methods, state, and issuer; timeout closes listener", async () => {
  const abort = new AbortController();
  const callback = await startCallback("expected", abort.signal);
  try {
    assert.equal((await fetch(callback.redirectUrl.replace("/callback", "/other"))).status, 404);
    assert.equal((await fetch(callback.redirectUrl, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${callback.redirectUrl}?state=wrong&code=c`)).status, 400);
    assert.equal((await fetch(`${callback.redirectUrl}?state=expected&code=c&iss=https://evil.example`)).status, 400);
    abort.abort();
    await assert.rejects(callback.code, /cancelled/);
    await assert.rejects(fetch(callback.redirectUrl));
  } finally { callback.close(); }
});

test("cancellation while binding the callback settles promptly", async () => {
  const abort = new AbortController();
  const pending = startCallback("state", abort.signal);
  abort.abort();
  await assert.rejects(pending, /cancel/);
});

test("credential store rejects malformed files and symlinks, and logout deletes the file", async () => {
  const f = await fixture();
  try {
    await f.store.save(saved);
    await writeFile(f.store.path, '{"access_token":"secret"}');
    await assert.rejects(f.store.load(), /Cannot read/);
    await f.store.clear();
    const target = join(f.dir, "target");
    await writeFile(target, JSON.stringify(saved));
    await symlink(target, f.store.path);
    await assert.rejects(f.store.load(), /Cannot read/);
    await f.store.clear();
    assert.equal(await f.store.load(), undefined);
    assert.equal(JSON.parse(await readFile(target, "utf8")).tokens.access_token, "old-access");
  } finally { await f.cleanup(); }
});

test("credential-bearing fetch refuses untrusted endpoints and forces no redirects", async () => {
  let calls = 0;
  const fetcher = secureFetch(undefined, async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return json({});
  });
  for (const url of ["http://api.fireflies.ai/token", "https://evil.example/token", "https://user:pass@api.fireflies.ai/token"]) {
    assert.throws(() => trustedUrl(url), /unexpected/);
    await assert.rejects(async () => fetcher(url), /unexpected/);
  }
  await fetcher("https://api.fireflies.ai/token", { redirect: "follow" });
  assert.equal(calls, 1);
});
