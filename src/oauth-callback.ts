import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

function sameState(actual: string | null, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startCallback(state: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The browser can return while discovery/registration is still unwinding.
  void code.catch(() => {});
  let redirectUrl = "";
  let settled = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    let url: URL;
    try { url = new URL(req.url || "/", redirectUrl); }
    catch { res.writeHead(400).end("Invalid callback URL."); return; }
    if (req.method !== "GET" || req.headers.host !== new URL(redirectUrl).host || url.origin !== new URL(redirectUrl).origin || url.pathname !== "/callback") {
      res.writeHead(404).end("Not found"); return;
    }
    if (settled || url.searchParams.getAll("state").length !== 1 || !sameState(url.searchParams.get("state"), state)) {
      res.writeHead(400).end("Invalid OAuth state. Retry from the authorization link."); return;
    }
    const issuer = url.searchParams.get("iss");
    if (issuer && issuer !== "https://api.fireflies.ai/") {
      res.writeHead(400).end("Invalid OAuth issuer."); return;
    }
    const value = url.searchParams.get("code");
    settled = true;
    if (url.searchParams.has("error") || !value || url.searchParams.getAll("code").length !== 1) {
      res.writeHead(400).end("Authorization was denied or returned an invalid response. You can close this tab.");
      rejectCode(new Error("Fireflies authorization denied or invalid callback."));
    } else {
      res.end("Fireflies authorization received. Return to pi to finish connecting. You can close this tab.");
      resolveCode(value);
    }
  });
  const abort = () => {
    settled = true;
    rejectCode(new Error("Fireflies OAuth cancelled or timed out."));
    server.close();
    server.closeAllConnections();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.removeListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onAbort = () => { cleanup(); reject(new Error("Fireflies OAuth cancelled.")); };
      server.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      server.listen(0, "127.0.0.1", () => { cleanup(); resolve(); });
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot bind OAuth callback");
    redirectUrl = `http://127.0.0.1:${address.port}/callback`;
    server.on("error", () => rejectCode(new Error("Fireflies OAuth callback failed.")));
    return {
      redirectUrl, code,
      close() {
        signal.removeEventListener("abort", abort);
        server.close();
        server.closeAllConnections();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
    throw error;
  }
}
