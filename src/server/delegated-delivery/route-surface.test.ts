import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("delegated delivery route surface", () => {
  it("contains issuance and consent only, with no execution/status/cancel grant surface", () => {
    const grantsRoot = join(process.cwd(), "app", "v1", "prism", "delegations", "slack-message", "grants");
    expect(existsSync(grantsRoot)).toBe(false);

    const issuanceSources = [
      join(process.cwd(), "src", "server", "delegated-delivery"),
      join(process.cwd(), "app", "v1", "prism", "delegations"),
      join(process.cwd(), "app", "delegations")
    ].flatMap(readFilesRecursively).concat([
      join(process.cwd(), "scripts", "cleanup-delegated-slack-delivery.ts")
    ]).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(issuanceSources).not.toMatch(/SlackWebApiClient|createDefaultSlackWebApiClient|slack\.com\/api|\/v1\/slack\/api/);
    expect(issuanceSources).not.toMatch(/\bfetch\s*\(/);
  });
});

function readFilesRecursively(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? readFilesRecursively(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}
