import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("delegated delivery route surface", () => {
  it("keeps Slack execution out of issuance, consent, and cleanup surfaces", () => {
    const grantsRoot = join(process.cwd(), "app", "v1", "prism", "delegations", "slack-message", "grants");
    expect(existsSync(grantsRoot)).toBe(false);

    const serverSources = readFilesRecursively(
      join(process.cwd(), "src", "server", "delegated-delivery")
    ).filter((path) => !path.endsWith("execution.ts"));
    const browserSources = readFilesRecursively(
      join(process.cwd(), "app", "v1", "prism", "delegations")
    ).filter((path) => !path.includes(join("slack-message", "execute")));
    const issuanceSources = serverSources.concat(
      browserSources,
      readFilesRecursively(join(process.cwd(), "app", "delegations")),
      [
        join(process.cwd(), "scripts", "cleanup-delegated-slack-delivery.ts")
      ]
    ).map((path) => readFileSync(path, "utf8")).join("\n");
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
