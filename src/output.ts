import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";

/** JSON preserves structured content and all MCP block types without silently dropping data. */
export async function formatResult(value: unknown) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const truncated = truncateHead(text);
  let output = truncated.content;
  let outputPath: string | undefined;
  if (truncated.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-fireflies-"));
    outputPath = join(dir, "result.json");
    await writeFile(outputPath, text, { mode: 0o600 });
    output += `\n\n[Truncated at 2000 lines / 50 KB. Full result: ${outputPath}. This file may contain private meeting data; delete it when no longer needed.]`;
  }
  return {
    content: [{ type: "text" as const, text: output }],
    details: { ...(outputPath ? { outputPath } : {}) },
  };
}
