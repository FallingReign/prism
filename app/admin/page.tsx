import { cookies } from "next/headers";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../src/server/admin/postgres-store";
import { database } from "../../src/server/db";
import { prismSessionCookieName } from "../../src/server/slack/oauth-flow";
import { AdminAccessDenied, AdminConsoleShell } from "./admin-shell";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  try {
    const cookieStore = await cookies();
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: await loadAdminAllowlist(),
      sessionToken: cookieStore.get(prismSessionCookieName)?.value
    });

    if (decision.kind !== "authorized") return <AdminAccessDenied />;
    return <AdminConsoleShell decision={decision} />;
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return <AdminAccessDenied />;
    throw error;
  }
}
