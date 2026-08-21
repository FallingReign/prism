import { describe, expect, it, vi } from "vitest";

import { createPostgresPrismSessionStore, logoutPrismSession } from "./prism-session";
import { hashSecret } from "./slack/oauth-flow";

describe("logoutPrismSession", () => {
  it("deletes only the hash of the current website session", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const database = {
      query,
      transaction: async <T>(callback: (store: never) => Promise<T>) => callback(undefined as never)
    };
    await logoutPrismSession({ store: createPostgresPrismSessionStore(database), sessionToken: "session-token" });

    expect(query).toHaveBeenCalledWith(
      "delete from prism_sessions where session_token_hash = $1",
      [hashSecret("session-token")]
    );
  });

  it("does nothing when there is no local session cookie", async () => {
    const store = { deleteCurrentSession: vi.fn() };
    await logoutPrismSession({ store, sessionToken: undefined });
    expect(store.deleteCurrentSession).not.toHaveBeenCalled();
  });
});
