# Architecture Integration Brief: admin-user-directory-detail

## Existing ownership

- Package/component/module/library:
  - **Domain language and scope:** `CONTEXT.md` owns the Prism admin and Prism user definitions. A Prism admin is Slack-authenticated and server-allowlisted with global, Enterprise Grid, or team scope; a Prism user admin view is safe metadata only (`CONTEXT.md:23-33`, `CONTEXT.md:99-105`, `CONTEXT.md:133-134`).
  - **Admin authorization owner:** `src/server/admin/authorization.ts` owns the reusable admin decision (`authorized | unauthenticated | not_admin`) and broadest matching scope precedence (`authorization.ts:28-55`, `authorization.ts:58-68`). `src/server/admin/postgres-store.ts` owns resolving the current admin actor from the existing `prism_session` plus latest Slack connection (`postgres-store.ts:7-36`).
  - **Admin shell owner:** `app/admin/page.tsx` performs server-side cookie lookup and admin resolution, then renders `app/admin/admin-shell.tsx` (`page.tsx:12-27`, `admin-shell.tsx:6-63`). The shell currently has only active-scope and future-surface placeholders.
  - **Website/API route conventions:** Existing Prism routes use App Router handlers, `randomUUID()` request IDs, `Cache-Control: no-store`, `X-Prism-Request-ID`, session cookies for website APIs, and generic denied JSON (`app/v1/prism/token-profiles/route.ts:13-34`, `app/v1/prism/admin/session/route.ts:13-49`).
  - **Slack identity/display owner:** `src/server/slack/connection-status.ts` and `src/server/slack/postgres-store.ts` own session-to-latest-connection status and optional display-name enrichment (`connection-status.ts:18-57`, `postgres-store.ts:153-193`). `app/slack-connection-display.ts` owns safe display redaction for Slack names/IDs (`slack-connection-display.ts:3-23`).
  - **Token profile metadata owner:** `src/server/token-profiles/service.ts` defines safe `TokenProfileMetadata` and developer-token metadata without token secrets (`service.ts:26-49`, `service.ts:57-108`). `src/server/token-profiles/store.ts` owns Postgres queries and currently scopes listing to the current session owner (`store.ts:14-39`, `store.ts:471-505`).
  - **Metadata-only audit owner:** `src/server/audit/activity.ts`, `src/server/audit/postgres-store.ts`, and `src/server/audit/presentation.ts` own metadata-only record shape, retained listing, and public summary shaping (`activity.ts:32-58`, `postgres-store.ts:55-99`, `presentation.ts:3-41`).
  - **Visual primitives:** `app/ui.tsx` owns Prism-local `Button`, `LinkButton`, `Panel`, `StatusBadge`, `Notice`, and `SummaryMetric`; admin and website pages reuse these card/header patterns (`ui.tsx:48-156`, `app/page.tsx:32-109`, `app/admin/admin-shell.tsx:11-61`).
- Current owner rationale:
  - This slice is a read-only admin view over existing Prism-owned users, Slack connection metadata, Token profile metadata, and metadata-only audit. It belongs behind the existing server-side admin authorization resolver and under `/admin` plus `/v1/prism/admin/*`, not in Slack-compatible `/v1/slack/*` routes and not in local-tool bearer-token services.
  - Cross-user data shaping should be a new server-only admin directory/detail service/store that composes the existing tables and presentation shapes. Do not retrofit current session-owned Token profile/audit methods to silently accept arbitrary target users.
- Source evidence:
  - Issue #34 acceptance criteria in the user prompt require scoped listing/detail, safe metadata only, forbidden/not-found behavior for out-of-scope targets, non-admin denial, responsive Prism UI, and tests for scoping/redaction/empty states.
  - Prior issue #33 brief required future admin directory slices to reuse the admin resolver and avoid broad admin data/mutations in the shell (`docs/implementation-reviews/admin-authorization-scoped-shell-architecture-integration.md:41-80`, `:103-160`).

## Existing interaction model

- User/system behaviors that already exist:
  - A website session is created by Slack OAuth and stored as an HTTP-only `prism_session`; server modules hash the cookie value before querying `prism_sessions` (`src/server/slack/postgres-store.ts:153-177`, `src/server/token-profiles/store.ts:14-30`, `src/server/admin/postgres-store.ts:19-32`).
  - Admin access is resolved from the current Slack-authenticated website session and an operational JSON allowlist, not from Slack roles or Prism developer tokens (`src/server/admin/allowlist.ts:17-25`, `src/server/admin/authorization.ts:33-55`, `app/v1/prism/admin/session/route.ts:13-30`).
  - Current admin UI shows the active admin scope and denies missing/non-admin sessions with generic copy that does not mention allowlists or config paths (`app/admin/admin-shell.tsx:48-61`, `app/admin/admin-shell.tsx:66-83`; tests at `app/admin/admin-shell.test.tsx:37-43`).
  - Current user Token profile detail finds a profile by current-session-owned `listTokenProfiles`, uses `notFound()` for missing profile, and renders profile metadata plus profile-scoped audit (`app/token-profiles/[profileId]/page.tsx:20-52`, `:77-81`).
  - Current audit UI explicitly explains metadata-only storage and redacts credential-shaped canaries before rendering (`app/activity-audit-panel.tsx:15-18`, `:118-123`; tests at `app/activity-audit-panel.test.tsx:98-128`).
- Behaviors that must remain unchanged:
  - Non-admins and missing/expired sessions cannot access admin directory/detail pages or APIs. Denied responses must not reveal allowlist contents or whether a target user exists outside the admin scope.
  - Normal Prism website pages, Token profile lifecycle/policy routes, Slack connection removal, and local-tool bearer-token endpoints must keep current owner scoping and behavior.
  - Directory/detail must remain read-only: no cross-user revoke/delete Slack connection, no Token profile mutation, no global policy editing, no admin action audit, no Slack admin behavior.
  - No UI/API/query should expose Slack credentials, Prism developer tokens, token hashes, peppers, credential envelopes, Slack payloads, message/search/file/canvas/list content, raw allowlist contents, local config paths, or session token hashes.
- Runtime or UX evidence:
  - Existing Prism pages use a responsive max-width shell, rounded card header/nav, badges, and `Panel` sections (`app/page.tsx:32-109`; `app/admin/admin-shell.tsx:11-61`).
  - Existing mobile/desktop-friendly components rely on grid/flex wrapping and `sm:`/`lg:` breakpoints (`app/ui.tsx:93-103`, `app/token-profile-detail-panel.tsx:170-193`).
  - Existing tests assert admin denial, route no-store headers, request IDs, and no secret-shaped strings (`app/v1/prism/admin/session/route.test.ts:42-60`, `:85-122`; `src/server/dependency-guard.test.ts:17-38`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Extend `src/server/admin/authorization.ts` types only if needed; the existing `AdminScope` shape is enough for directory filtering: global = all, enterprise = `slack_connections.enterprise_id`, team = `slack_connections.team_id` (`authorization.ts:3-8`, `authorization.ts:58-68`).
  - Add a server-only admin user directory service/store under `src/server/admin/`, e.g. `user-directory.ts` plus `postgres-user-directory-store.ts`. It should accept an already-authorized admin decision/scope and return shaped directory/detail DTOs.
  - Add admin APIs under `/v1/prism/admin/users` and `/v1/prism/admin/users/[userId]` following existing route conventions: `dynamic = "force-dynamic"`, request ID, `no-store`, cookie-based `resolvePrismAdmin`, generic `401/403/404`, safe JSON only (`app/v1/prism/admin/session/route.ts:11-49`).
  - Add admin pages under `app/admin/users/page.tsx` and `app/admin/users/[userId]/page.tsx` (or a route-group equivalent) that authorize server-side before rendering. Reuse `AdminConsoleShell` header concepts or extract safe shared admin layout components if needed, but do not move authorization into a client component.
  - Reuse `app/slack-connection-display.ts` redaction helpers for Slack names/IDs, `app/activity-audit-panel.tsx` or a read-only admin variant for metadata-only activity, `app/token-profile-summary.ts` safe Token profile summary ideas, and `app/ui.tsx` primitives.
  - Query existing Postgres tables only: `prism_users`, `slack_connections`, `token_profiles`, `prism_developer_tokens`, and `prism_activity_audit` (`db/migrations/0001_slack_oauth_custody.sql:1-54`, `0002_prism_developer_tokens.sql:122-139`, `0003_prism_activity_audit.sql:1-52`).
- Relevant docs or library capabilities:
  - ADR 0001 establishes Next.js App Router plus plain Postgres as the substrate (`docs/adr/0001-nextjs-postgres-substrate.md:1-3`).
  - Security docs require metadata-only audit and prohibit committed/printed Slack credentials, developer tokens, hashes, peppers, and payload content (`docs/security.md:5-12`, `:29-33`, `:62-67`).
- Existing examples in this codebase:
  - Admin allowlist/authorization tests show pure resolver tests and server-only dependency guard coverage (`src/server/admin/authorization.test.ts:5-141`, `src/server/dependency-guard.test.ts:17-38`).
  - `TokenProfileDetailPage` demonstrates server page scoping and `notFound()` for inaccessible profile IDs (`app/token-profiles/[profileId]/page.tsx:20-52`).
  - `ActivityAuditStore.listRecentActivityForSession` and `.listRecentActivityForTokenProfile` demonstrate bounded retained metadata-only audit listing and column selection that avoids payload/secret columns (`src/server/audit/postgres-store.ts:55-99`; tests at `src/server/audit/postgres-store.test.ts:126-180`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a second admin auth/session system, JWT, middleware-only gate, client-side authorization gate, Slack-role check, Slack admin API check, or database admin role table.
  - Do not use Prism developer-token bearer auth or `/v1/slack/api/*` local-tool forwarding for admin authorization.
  - Do not bypass `resolvePrismAdmin`, `loadAdminAllowlist`, `createPostgresAdminIdentityStore`, `hashSecret`, or session expiry checks.
  - Do not bypass existing Token profile metadata/status semantics by reading and returning `prism_developer_tokens.token_hash`, `hash_algorithm`, `pepper_id`, or token envelopes.
  - Do not bypass metadata-only audit owners by adding payload/message/search/file/body columns or raw Slack payload rendering.
  - Do not bypass Slack connection display redaction helpers by directly interpolating raw names/IDs into admin UI.
- Shortcuts or parallel paths to avoid:
  - No SQL string that filters only by `prism_users.slack_enterprise_id`; scope should be based on the target user's current/latest Slack connection because connection status/display is what the UI shows.
  - No "list all then filter in React/client" path. Scope filtering must happen server-side in the admin store/service.
  - No target-detail `403` response that distinguishes "exists but outside your scope" from "not found"; map out-of-scope and missing target to the same generic not-found/forbidden behavior as agreed.
  - No admin action audit or mutation endpoints in this read-only slice, even though `CONTEXT.md:103-105` defines future Admin action audit and `CONTEXT.md:134` describes future destructive admin actions.
- Invariants:
  - Every admin directory/detail read starts with an authorized `AdminAuthorizationDecision`; scopes are applied before rows are returned.
  - Directory/detail DTOs are allowlists of safe metadata, not table row pass-throughs.
  - Pagination/limits should be bounded even if the initial UI is simple.
  - Empty states must be explicit and safe: "No Prism users in this admin scope" rather than global counts.
  - Tests must include secret-shaped canaries in names/activity/object IDs and prove redaction or omission.

## Integration plan

- Insert the change at:
  - **Server service/store:** add `src/server/admin/user-directory.ts` for DTO shaping and authorization outcome mapping, plus `src/server/admin/postgres-user-directory-store.ts` (name flexible) for scoped Postgres queries. Start both with `import "server-only";` and add them to dependency guard.
  - **Scope SQL:** implement reusable predicates:
    - global: no extra scope predicate;
    - enterprise: latest/current target connection `enterprise_id = $scopeEnterpriseId`;
    - team: latest/current target connection `team_id = $scopeTeamId`.
    Use a CTE/window or `distinct on (prism_user_id)` to select the latest Slack connection per Prism user for connection status/display. Include users with retained profiles/activity only through their scoped connection; do not leak users whose latest/current connection is outside scope.
  - **Directory row shape:** return `prismUserId`, Slack user ID/display name, team/enterprise ID/name, connection status/last error class, Token profile counts by status/developer-token status, latest activity timestamp, and active admin scope. Avoid raw `capability_map` unless the UI has a specific safe summary need.
  - **Detail shape:** return the same target identity/current Slack connection, active admin scope, visible retained Token profile summaries (name, intended use, preset, execution identity, status, developer-token metadata status/timestamps only), and recent metadata-only audit summaries for the target. Reuse/adapt `toTokenProfileSummary`/`toActivityAuditSummary` ideas but do not include `prismUserId` unless product wants it visible.
  - **APIs:** add `GET /v1/prism/admin/users` and `GET /v1/prism/admin/users/[userId]`. Return `401` for unauthenticated, `403` for authenticated non-admin to the directory; for detail, return the same generic `404` (or agreed generic `403`) for missing and out-of-scope targets. Always set no-store/request ID.
  - **Pages/UI:** add `/admin/users` directory and `/admin/users/[userId]` detail pages. Update the admin shell/nav to link to "User directory" only after the pages exist. Use responsive card/list/table patterns with `Panel`, `StatusBadge`, `SummaryMetric`, and safe redaction helpers.
  - **Tests:** add pure service/scope tests, SQL mock tests, route tests, render tests, and redaction canaries before/with implementation.
- Why this is the correct integration point:
  - The current admin resolver already provides the least-privilege scope object needed by this slice; adding a scoped read model beneath `src/server/admin` keeps all cross-user behavior under the admin owner.
  - Existing Token profile/audit stores are session-owner stores. A dedicated admin read model avoids corrupting self-service semantics while still reusing their safe presentation shapes.
  - `/v1/prism/admin/*` keeps this Prism-local admin behavior separate from Slack-compatible endpoint behavior and Slack administration.
- Alternatives considered and rejected:
  - **Reuse `listTokenProfiles(sessionToken)` for target detail:** rejected because it only resolves the current website user and would require impersonation/parallel session tricks.
  - **Client-side directory fetch as auth gate:** rejected because admin auth must happen server-side for pages and APIs.
  - **Single broad SQL returning all table columns:** rejected because safe metadata must be explicitly shaped and secret-bearing columns exist nearby.
  - **Add admin mutations/audit now:** rejected by issue #34 scope; read-only directory/detail should not introduce cross-user destructive actions.
  - **Slack admin/workspace member directory:** rejected because Prism admin console is not a Slack admin console (`CONTEXT.md:23-29`; `docs/security.md:62-67`).

## Regression checklist

- Behavior: `/admin` still denies missing/non-admin sessions generically and shows the active scope for allowed global/enterprise/team admins.
- Behavior: `/v1/prism/admin/session` remains no-store, request-ID-bearing, and secret-free for authorized and denied responses.
- Behavior: Non-admins cannot access new admin pages/APIs; local-tool bearer tokens do not grant admin access.
- Behavior: Directory lists only Prism users inside the current admin scope; enterprise/team admins never see out-of-scope rows, counts, or target-existence hints.
- Behavior: Detail for missing and out-of-scope target users is indistinguishable to the caller.
- Behavior: Directory/detail never return Slack credential envelopes, access/refresh tokens, Prism developer tokens, token hashes, peppers, authorization headers, raw Slack payloads, message/search/file/canvas/list content, raw capability JSON if not intentionally summarized, or raw allowlist data.
- Behavior: Existing self-service Token profile list/detail/lifecycle, Slack connection status/removal, and metadata audit pages keep current behavior.
- Behavior: Existing `/v1/prism/token-profiles*`, `/v1/prism/status`, `/v1/prism/capabilities`, and `/v1/slack/api/*` tests stay green.
- Behavior: Admin UI remains usable at mobile and desktop widths and preserves Prism visual patterns.

## Test plan

- Existing tests to keep green:
  - Full `npm test`.
  - Admin tests: `src/server/admin/authorization.test.ts`, `src/server/admin/allowlist.test.ts`, `src/server/admin/postgres-store.test.ts`, `app/v1/prism/admin/session/route.test.ts`, `app/admin/admin-shell.test.tsx`.
  - Token profile/audit/display tests: `app/token-profile-detail-panel.test.tsx`, `app/token-profiles-panel.test.tsx`, `src/server/token-profiles/store`/route tests, `src/server/audit/postgres-store.test.ts`, `app/activity-audit-panel.test.tsx`, `app/slack-status-panel.test.tsx`.
  - Guard tests: `src/server/dependency-guard.test.ts`, `src/server/docs-guard.test.ts`.
- New tests to add before/with implementation:
  - Admin directory service tests for global, enterprise, and team scoping; out-of-scope exclusion; empty state; bounded limits; latest connection selection; counts by Token profile/developer-token status; latest retained activity timestamp.
  - Admin detail service tests for in-scope target, out-of-scope target, missing target, non-admin, unauthenticated, and generic missing/out-of-scope outcome.
  - Safe metadata shaping tests with canaries in Slack display names, Token profile names, audit object IDs/error classes, and fake secret-bearing DB columns; assert redaction/omission of `prism_dev_`, `xox*`, `access_token`, `refresh_token`, `client_secret`, `token_hash`, `pepper`, credential envelope, Authorization, message/search/file payload canaries.
  - SQL/store tests proving scoped predicates are in SQL and selected columns exclude `slack_credentials.*`, `access_token_envelope`, `refresh_token_envelope`, `prism_developer_tokens.token_hash`, `pepper_id`, and payload/body/content columns.
  - Route tests for `GET /v1/prism/admin/users` and `GET /v1/prism/admin/users/[userId]`: `401`, `403`, `200`, generic out-of-scope/missing detail, no-store, request ID, and no secret-shaped response body.
  - Render tests for directory and detail desktop/mobile-friendly markup, empty states, active admin scope, connection status, visible retained Token profiles, metadata-only activity, and canary redaction.
  - Dependency guard update for new `src/server/admin/*` modules.
- Live proof required:
  - Start the app locally, authenticate/link Slack using existing local setup, and verify `/admin` still works for an allowlisted admin.
  - With seeded/local data for at least two Prism users in different teams/enterprises, verify global sees both, enterprise/team scopes see only in-scope users, and detail for out-of-scope target shows the same generic missing/forbidden behavior as a fake ID.
  - Capture browser evidence for `/admin/users` empty and populated states plus `/admin/users/[userId]` detail on desktop/mobile widths.
  - Inspect network responses for no-store/request ID and no secret-shaped material; confirm non-admin sessions deny pages/APIs.

## Risk assessment

- Risk: Accidentally widening self-service Token profile/audit stores into cross-user access. Mitigation: create a separate server-only admin read model that requires an authorized admin decision and applies scope before selecting rows.
- Risk: Secret leakage from adjacent credential/token tables. Mitigation: explicit DTO allowlists, SQL selected-column tests, render/API canary tests, and reuse redaction helpers.
- Risk: Out-of-scope target enumeration through detail status, timing, copy, or IDs. Mitigation: identical missing/out-of-scope mapping, generic copy, no global counts in scoped responses.
- Risk: Enterprise Grid semantics drift because code models org-level display as possible `teamId: null`, while migration `0001` still declares `slack_connections.team_id text NOT NULL` and `prism_users.slack_team_id text NOT NULL` (`db/migrations/0001_slack_oauth_custody.sql:1-9`, `:26-39`; code/tests at `app/slack-status-panel.tsx:69-90`). Mitigation: implement and test null-safe enterprise predicates; if runtime schema still forbids org-only rows, stop for a schema decision before claiming org-only support.
- Risk: Latest-connection semantics may hide older retained profiles/activity. Mitigation: define "current local Slack connection" as the latest connection and show retained profiles/activity only for the in-scope target/current connection unless product explicitly wants historical cross-connection retention.
- Risk: UI scope creep into destructive admin operations or global policy editing. Mitigation: read-only routes/components only; no `POST/PATCH/DELETE` admin users endpoints in this slice.

## Decision confidence

- Confidence: medium
- Reasons:
  - Ownership is clear after issue #33: admin authorization and shell exist, and this slice naturally extends them with a server-only admin read model.
  - Existing self-service Token profile, Slack connection, audit, display, no-store route, and UI primitives provide strong examples for safe metadata shaping.
  - The major unknown is exact multi-connection/Enterprise Grid semantics: code supports organization display with `teamId: null`, but initial schema still marks Slack team IDs non-null.
- Open questions:
  - Should "visible retained Token profiles" include revoked profiles only for the current/latest Slack connection, or all retained profiles for the target Prism user within admin scope? Recommendation: current/latest in-scope connection only for this slice.
  - For out-of-scope detail, should APIs use `404 not_found` or generic `403 forbidden`? Recommendation: `404` for missing and out-of-scope target IDs; keep `403` for authenticated non-admin directory access.
  - Should directory URLs expose `prismUserId` or a Slack identity slug? Recommendation: use opaque `prismUserId` in URLs but do not emphasize it in visible UI.
