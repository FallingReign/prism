import { cookies } from "next/headers";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../src/server/admin/postgres-store";
import { database } from "../../../src/server/db";
import { prismSessionCookieName } from "../../../src/server/slack/oauth-flow";
import { createPostgresGlobalTokenProfilePolicyStore } from "../../../src/server/token-profiles/global-policy-store";
import { AdminAccessDenied } from "../admin-shell";
import { AdminTokenProfilePolicyView } from "./admin-token-profile-policy";

export const dynamic = "force-dynamic";

export default async function AdminTokenProfilePolicyPage() {
  try {
    const cookieStore = await cookies();
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: await loadAdminAllowlist(),
      sessionToken: cookieStore.get(prismSessionCookieName)?.value
    });

    if (decision.kind !== "authorized") return <AdminAccessDenied />;
    const settings = await createPostgresGlobalTokenProfilePolicyStore(database).readGlobalTokenProfilePolicy();
    return (
      <AdminTokenProfilePolicyView
        scope={decision.scope}
        settings={{
          policy: settings.policy,
          version: settings.version,
          updatedAt: settings.updatedAt?.toISOString() ?? null,
          updatedByPrismUserId: settings.updatedByPrismUserId
        }}
        editable={decision.scope.kind === "global"}
      />
    );
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return <AdminAccessDenied />;
    throw error;
  }
}
