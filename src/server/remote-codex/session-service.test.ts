import { describe, expect, it, vi } from "vitest";

import { syncSessionCatalog, type SessionCatalogStore } from "./session-service";

describe("remote Codex session catalog", () => {
  it("accepts only the bounded safe projection needed by Prism and Slack", async () => {
    const store: SessionCatalogStore = { replaceCatalog: vi.fn(async () => undefined) };
    const result = await syncSessionCatalog({
      store,
      installationId: "rc_install_1",
      body: {
        catalogVersion: "catalog_1",
        sessions: [
          {
            threadId: "thread_1",
            title: "Ship the companion",
            projectLabel: "remote-codex",
            status: "ready",
            lastActivity: 1788145200
          }
        ]
      },
      now: new Date("2026-08-31T07:00:00.000Z")
    });

    expect(result).toEqual({ kind: "synced", count: 1 });
    expect(store.replaceCatalog).toHaveBeenCalledWith({
      installationId: "rc_install_1",
      catalogVersion: "catalog_1",
      sessions: [
        {
          threadId: "thread_1",
          title: "Ship the companion",
          projectLabel: "remote-codex",
          status: "ready",
          lastActivity: new Date(1788145200 * 1000)
        }
      ],
      now: new Date("2026-08-31T07:00:00.000Z")
    });
  });

  it("rejects paths, previews, unknown fields, unsafe labels, and oversized catalogs", async () => {
    const store: SessionCatalogStore = { replaceCatalog: vi.fn(async () => undefined) };
    const base = { threadId: "thread_1", title: "Title", projectLabel: "project", status: "ready", lastActivity: 1788145200 };

    for (const session of [
      { ...base, cwd: "C:\\private\\project" },
      { ...base, preview: "sensitive prompt" },
      { ...base, title: "bad\nlabel" },
      { ...base, status: "unknown-new-status" }
    ]) {
      await expect(syncSessionCatalog({ store, installationId: "rc_install_1", body: { catalogVersion: "catalog_1", sessions: [session] } })).resolves.toEqual({
        kind: "invalid"
      });
    }
    await expect(
      syncSessionCatalog({ store, installationId: "rc_install_1", body: { catalogVersion: "catalog_1", sessions: Array(51).fill(base) } })
    ).resolves.toEqual({ kind: "invalid" });
    expect(store.replaceCatalog).not.toHaveBeenCalled();
  });
});
