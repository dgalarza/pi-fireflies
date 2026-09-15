import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface SavedOAuth {
  version: 1;
  redirectUrl: string;
  client: OAuthClientInformationMixed;
  tokens: OAuthTokens;
}

export function authFilePath() {
  const path = process.env.FIREFLIES_MCP_AUTH_FILE;
  if (path) return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "fireflies", "oauth.json");
}

export function validRedirect(value: string) {
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port
    && url.pathname === "/callback" && !url.search && !url.hash && !url.username && !url.password;
}

export class OAuthStore {
  constructor(readonly path = authFilePath()) {}

  async load(): Promise<SavedOAuth | undefined> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 64 * 1024) throw new Error("Invalid credential file");
        // Correct overly broad permissions on existing files without following symlinks.
        await file.chmod(0o600);
        const value = JSON.parse(await file.readFile("utf8"));
        if (value.version !== 1 || !validRedirect(value.redirectUrl)) throw new Error("Invalid credentials");
        return {
          version: 1, redirectUrl: value.redirectUrl,
          client: OAuthClientInformationSchema.parse(value.client),
          tokens: OAuthTokensSchema.parse(value.tokens),
        };
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read Fireflies OAuth credentials. Check the auth file permissions, or run /fireflies logout and log in again.");
    }
  }

  async save(value: SavedOAuth) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  async clear() { await rm(this.path, { force: true }); }
}
