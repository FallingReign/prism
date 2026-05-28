import { cookies } from "next/headers";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../src/server/admin/postgres-store";
import { createPostgresAdminUserDirectoryStore } from "../../../src/server/admin/postgres-user-directory-store";
import { listAdminUsers } from "../../../src/server/admin/user-directory";
import { database } from "../../../src/server/db";
import { prismSessionCookieName } from "../../../src/server/slack/oauth-flow";
import { AdminAccessDenied } from "../admin-shell";
import { AdminUserDirectoryView } from "./admin-users";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  try {
    const cookieStore = await cookies();
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: await loadAdminAllowlist(),
      sessionToken: cookieStore.get(prismSessionCookieName)?.value
    });
    const result = await listAdminUsers({ decision, store: createPostgresAdminUserDirectoryStore(database), limit: 100 });
    if (result.kind !== "users") return <AdminAccessDenied />;
    return <AdminUserDirectoryView scope={result.scope} users={result.users} />;
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return <AdminAccessDenied />;
    throw error;
  }
}
