import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OAuthStore, type SavedOAuth } from "./oauth-store.ts";
import { startCallback } from "./oauth-callback.ts";

export const FIREFLIES_ORIGIN = "https://api.fireflies.ai";
export const MCP_URL = `${FIREFLIES_ORIGIN}/mcp`;

export function trustedUrl(input: string | URL) {
  const url = new URL(input);
  if (url.origin !== FIREFLIES_ORIGIN || url.username || url.password) {
    throw new Error("Refusing an unexpected Fireflies OAuth endpoint.");
  }
  return url;
}

// The published discovery metadata currently places all OAuth endpoints on this origin.
// Do not send refresh tokens/client secrets to arbitrary metadata URLs or redirects.
export function secureFetch(signal?: AbortSignal, fetcher: typeof fetch = fetch): FetchLike {
  return (input, init) => {
    trustedUrl(input instanceof Request ? input.url : String(input));
    return fetcher(input, {
      ...init, redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000), ...(signal ? [signal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  };
}

export class FirefliesOAuthProvider implements OAuthClientProvider {
  private client?: OAuthClientInformationMixed;
  private token?: OAuthTokens;
  private verifier?: string;
  private persist: boolean;
  private disabled = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly redirectUrl: string,
    private readonly store: OAuthStore,
    saved?: SavedOAuth,
    private readonly redirect?: (url: URL) => Promise<void>,
    private readonly oauthState = randomBytes(32).toString("base64url"),
  ) {
    this.client = saved?.client;
    this.token = saved?.tokens;
    this.persist = !!saved;
  }

  get clientMetadata() {
    return {
      client_name: "pi-fireflies", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none", scope: "email profile",
    };
  }
  state() { return this.oauthState; }
  clientInformation() { return this.client; }
  tokens() { return this.token; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.client = value; }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() {
    if (!this.verifier) throw new Error("Missing OAuth PKCE verifier; log in again.");
    return this.verifier;
  }
  async redirectToAuthorization(url: URL) {
    trustedUrl(url);
    if (this.disabled || !this.redirect) throw new Error("Run /fireflies login to authorize again.");
    await this.redirect(url);
  }
  async saveTokens(value: OAuthTokens) {
    if (this.disabled) throw new Error("OAuth provider closed");
    this.token = value;
    if (this.persist) await this.save();
  }
  private save() {
    if (!this.client || !this.token || this.disabled) throw new Error("Missing OAuth credentials");
    const value: SavedOAuth = { version: 1, redirectUrl: this.redirectUrl, client: this.client, tokens: this.token };
    const next = this.writes.then(() => this.store.save(value));
    this.writes = next.catch(() => {});
    return next;
  }
  async commit() {
    await this.save();
    this.persist = true;
    this.verifier = undefined;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "tokens") this.token = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (this.persist && !this.disabled && scope !== "discovery" && scope !== "verifier") {
      const next = this.writes.then(() => this.store.clear());
      this.writes = next.catch(() => {});
      await next;
    }
  }
  async dispose() {
    this.disabled = true;
    await this.writes;
    this.token = undefined;
    this.client = undefined;
    this.verifier = undefined;
  }
}

export async function openBrowser(url: URL, signal?: AbortSignal) {
  trustedUrl(url);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
  await promisify(execFile)(command, args, { signal, timeout: 5000 });
}

export async function browserLogin(
  store: OAuthStore,
  notify: (message: string) => void,
  signal: AbortSignal,
  options: { fetchFn?: FetchLike; open?: typeof openBrowser } = {},
) {
  let callback: Awaited<ReturnType<typeof startCallback>> | undefined;
  let provider: FirefliesOAuthProvider | undefined;
  try {
    // New ephemeral redirect URI + registration per login. Existing credentials are
    // replaced only after successful code exchange; failed login preserves them.
    const state = randomBytes(32).toString("base64url");
    callback = await startCallback(state, signal);
    provider = new FirefliesOAuthProvider(callback.redirectUrl, store, undefined, async url => {
      notify(`Authorize Fireflies in your browser:\n${url}`);
      try { await (options.open ?? openBrowser)(url, signal); }
      catch { notify("Could not open the browser automatically. Open the authorization link above on this machine."); }
    }, state);
    const authOptions = { serverUrl: MCP_URL, fetchFn: options.fetchFn ?? secureFetch(signal) };
    const result = await auth(provider, authOptions);
    if (result !== "REDIRECT") throw new Error("Unexpected OAuth result");
    const authorizationCode = await callback.code;
    signal.throwIfAborted();
    if (await auth(provider, { ...authOptions, authorizationCode }) !== "AUTHORIZED") {
      throw new Error("OAuth token exchange failed");
    }
    signal.throwIfAborted();
    await provider.commit();
    // Return a non-interactive provider: tool calls can refresh, but never launch a browser.
    const saved = await store.load();
    if (!saved) throw new Error("Credentials were not saved");
    return new FirefliesOAuthProvider(saved.redirectUrl, store, saved);
  } catch {
    throw new Error(signal.aborted
      ? "Fireflies OAuth cancelled or timed out. Run /fireflies login to retry."
      : "Fireflies OAuth login failed or was denied. Check browser consent, network, and credential-file permissions, then retry /fireflies login.");
  } finally {
    callback?.close();
    await provider?.dispose();
  }
}
