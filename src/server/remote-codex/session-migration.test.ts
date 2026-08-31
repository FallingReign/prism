import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("remote Codex session migration", () => {
  it("stores only a safe catalog projection with one session identity per installation", async () => {
    const sql = (await readFile("db/migrations/0024_remote_codex_sessions.sql", "utf8")).toLowerCase();

    expect(sql).toContain("remote_codex_sessions");
    expect(sql).toContain("unique (installation_id, codex_thread_id)");
    expect(sql).toContain("references remote_codex_installations(id)");
    expect(sql).not.toMatch(/\bcwd\b|preview|prompt|output|diff|transcript/);
  });
});
