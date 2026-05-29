import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../../src/server/admin/postgres-store";
import { createPostgresAdminUserDirectoryStore } from "../../../../src/server/admin/postgres-user-directory-store";
import { getAdminUserDetail } from "../../../../src/server/admin/user-directory";
import { database } from "../../../../src/server/db";
import { prismSessionCookieName } from "../../../../src/server/slack/oauth-flow";
import { AdminAccessDenied } from "../../admin-shell";
import { AdminUserDetailView } from "../admin-users";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  try {
    const [{ userId }, cookieStore] = await Promise.all([params, cookies()]);
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: await loadAdminAllowlist(),
      sessionToken: cookieStore.get(prismSessionCookieName)?.value
    });
    const result = await getAdminUserDetail({
      decision,
      store: createPostgresAdminUserDirectoryStore(database),
      userId,
      profileLimit: 100,
      activityLimit: 20
    });
    if (result.kind === "not_found") redirect("/admin/users/not-found");
    if (result.kind !== "detail") return <AdminAccessDenied />;
    return <AdminUserDetailView scope={result.scope} detail={result.detail} />;
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return <AdminAccessDenied />;
    throw error;
  }
}
