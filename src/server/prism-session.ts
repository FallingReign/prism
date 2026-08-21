import "server-only";

import type { Database } from "./db";
import { hashSecret } from "./slack/oauth-flow";

export type PrismSessionStore = {
  deleteCurrentSession(input: { sessionToken: string }): Promise<void>;
};

export async function logoutPrismSession({ store, sessionToken }: { store: PrismSessionStore; sessionToken: string | undefined }): Promise<void> {
  if (!sessionToken) return;
  await store.deleteCurrentSession({ sessionToken });
}

export function createPostgresPrismSessionStore(database: Database): PrismSessionStore {
  return {
    async deleteCurrentSession({ sessionToken }) {
      // This single conditional delete is atomic. The browser token is never
      // persisted or returned in plaintext.
      await database.query("delete from prism_sessions where session_token_hash = $1", [hashSecret(sessionToken)]);
    }
  };
}
