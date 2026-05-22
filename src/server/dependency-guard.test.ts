import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";

const forbiddenDependencyPatterns = [/supabase/i, /postgrest/i, /postgrest-js/i];

describe("Prism substrate dependencies", () => {
  it("does not introduce Supabase/Auth/PostgREST dependencies", () => {
    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    });

    expect(dependencyNames.filter((name) => forbiddenDependencyPatterns.some((pattern) => pattern.test(name)))).toEqual([]);
  });

  it("keeps Slack credential custody modules server-only", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/server/credentials/encryption.ts",
      "src/server/credentials/factory.ts",
      "src/server/slack/oauth-flow.ts",
      "src/server/slack/postgres-store.ts",
      "src/server/slack/refresh.ts",
      "src/server/slack/oauth-client.ts",
      "src/server/slack/mock-oauth-client.ts"
    ];

    for (const file of files) {
      await expect(readFile(file, "utf8")).resolves.toMatch(/^import "server-only";/);
    }
  });

  it("keeps Local-tool token verification and Method registry modules server-only", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/server/slack/method-registry.ts",
      "src/server/token-profiles/developer-token.ts",
      "src/server/token-profiles/local-tool-status.ts",
      "src/server/token-profiles/method-policy.ts",
      "src/server/token-profiles/presets.ts",
      "src/server/token-profiles/service.ts",
      "src/server/token-profiles/store.ts"
    ];

    for (const file of files) {
      await expect(readFile(file, "utf8")).resolves.toMatch(/^import "server-only";/);
    }
  });
});
