# Architecture Integration Brief: slack-connection-management

## Existing ownership

- Package/component/module/library:
  - `app/page.tsx` owns the Prism website homepage composition. It reads the HTTP-only `prism_session` cookie, calls `readSlackWebsiteStatus(sessionToken)`, conditionally loads Token profiles/activity only for linked sessions, and renders `SlackStatusPanel` in the hosted-service hero (`app/page.tsx:23-31`, `app/page.tsx:77-83`, `app/page.tsx:113-118`).
  - `app/slack-status-panel.tsx` owns user-visible Slack connection state rendering for `not_linked`, `setup_required`, `linked/healthy`, and `linked/reauth_required`, including Connect/Reconnect links to `/v1/slack/oauth/start` (`app/slack-status-panel.tsx:4-17`, `app/slack-status-panel.tsx:38-53`, `app/slack-status-panel.tsx:80-103`, `app/slack-status-panel.tsx:121-156`).
  - `app/slack-connection-display.ts` owns safe Slack workspace/org/user display formatting and credential-shaped redaction (`app/slack-connection-display.ts:3-23`).
  - `app/website-overview.ts` owns top-level Slack summary copy used in the product header/overview (`app/website-overview.ts:55-90`).
  - `app/v1/slack/oauth/start/route.ts` and `src/server/slack/oauth-flow.ts` own Slack OAuth start. `createSlackOAuthStart` creates state, persists only the state hash, and redirects to Slack `oauth/v2/authorize`; this is the correct Change Slack authorization path (`app/v1/slack/oauth/start/route.ts:10-25`, `src/server/slack/oauth-flow.ts:57-86`).
  - `src/server/slack/oauth-flow.ts` and `src/server/slack/postgres-store.ts` own OAuth callback persistence: Prism user upsert, Slack connection upsert, encrypted Slack credential storage, and website session creation (`oauth-flow.ts:126-157`, `postgres-store.ts:12-84`).
  - `src/server/slack/postgres-store.ts` owns session-scoped Slack connection lookup via `getSlackConnectionDisplayRecordForSession`, joining `prism_sessions` to `slack_connections` and selecting the current/latest connection for that Prism user (`postgres-store.ts:148-193`).
  - Token profile local access is owned by `src/server/token-profiles/service.ts` and `src/server/token-profiles/store.ts`. They resolve the current owner from `prism_session -> prism_user -> latest slack_connection` and scope all profile mutations by `prismUserId + slackConnectionId` (`service.ts:57-108`, `store.ts:14-30`, `store.ts:31-39`).
  - Destructive Prism website mutation patterns are owned by route handlers under `app/v1/prism/token-profiles/*`, which generate a request ID, read the session cookie, delegate to server services, return `Cache-Control: no-store` JSON, and avoid token/secret material in responses (`app/v1/prism/token-profiles/route.ts:13-34`, `route.ts:36-69`, `route.ts:100-105`; `[profileId]/route.ts:15-43`; `[profileId]/revoke/route.ts:15-40`).
  - Postgres cascade ownership is in migrations: `slack_credentials.connection_id -> slack_connections(id) ON DELETE CASCADE`, `token_profiles.slack_connection_id -> slack_connections(id) ON DELETE CASCADE`, `prism_developer_tokens.token_profile_id -> token_profiles(id) ON DELETE CASCADE`, and `slack_forwarding_rate_limits.token_profile_id -> token_profiles(id) ON DELETE CASCADE` (`db/migrations/0001_slack_oauth_custody.sql:42-60`, `db/migrations/0002_prism_developer_tokens.sql:122-139`, `db/migrations/0005_slack_forwarding_rate_limits.sql:1-10`).
  - Metadata-only audit rows reference Slack connections and Token profiles with `ON DELETE SET NULL`, so connection removal should not require payload/secret audit erasure (`db/migrations/0003_prism_activity_audit.sql:1-10`).
- Current owner rationale:
  - This slice changes Prism website Slack connection management, not Slack administration. The existing owners already model Slack connection state, OAuth reauthorization, server credential custody, session scoping, destructive local Token profile mutations, and DB cascades.
  - The correct destructive boundary is a small server-side connection-management service/store that resolves the current `prism_session` to the current Slack connection, then deletes that `slack_connections` row. Do not put deletion SQL directly in a client component or route without the service seam requested by PRD #28.
  - The correct non-destructive boundary is the existing OAuth start route. A separate Slack picker, Slack admin API, or local workspace/org selection would bypass Slack's OAuth-owned approval/picker model.
- Source evidence:
  - PRD #28 and issues #29-#31 require Change Slack authorization, Remove Slack connection, and end-to-end QA; issue #30 explicitly says local removal deletes only Prism's current Slack connection row and must not call Slack uninstall/revoke APIs.
  - `CONTEXT.md` now defines **Remove Slack connection** as a destructive local Prism reset that does not uninstall Slack app/admin approval, and **Expand Slack connection** as changing Slack authorization through Slack (`CONTEXT.md:83-89`, `CONTEXT.md:103`).
  - Targeted baseline passed: `npm test -- --run app/slack-status-panel.test.tsx app/v1/slack/oauth/start/route.test.ts src/server/slack/postgres-store.test.ts src/server/slack/connection-status.test.ts src/server/token-profiles/store.test.ts app/v1/prism/token-profiles/route.test.ts` (6 files, 25 tests).

## Existing interaction model

- User/system behaviors that already exist:
  - `not_linked`: website shows Connect Slack, links to `/v1/slack/oauth/start`, does not load Token profiles/activity, and tells the user Token profiles unlock after Slack is connected (`app/slack-status-panel.tsx:38-53`, `app/page.tsx:82-98`).
  - `linked/healthy`: website shows Slack connected identity/scope context, loads Token profiles, and loads Metadata audit (`app/page.tsx:27-29`, `app/page.tsx:77-83`, `app/page.tsx:99-107`, `app/slack-status-panel.tsx:95-103`).
  - `linked/reauth_required`: website preserves the visible Slack identity and Token profile workspace, while presenting Reconnect Slack via `/v1/slack/oauth/start` before Slack calls resume (`app/slack-status-panel.tsx:80-91`, `app/slack-status-panel.tsx:121-136`; `app/page.tsx:57-61`, `app/page.tsx:82-83`).
  - OAuth start is GET-only and redirects to Slack with `client_id`, `redirect_uri`, state, bot scopes, and user scopes; the client secret is not put in the authorize URL (`oauth-flow.ts:67-85`; start route test `app/v1/slack/oauth/start/route.test.ts:17-33`).
  - OAuth callback upserts the same `slack_connections` row for the same `team_id + authed_user_id`, refreshes status to `healthy`, and creates a fresh website session (`postgres-store.ts:42-74`, `oauth-flow.ts:126-157`).
  - Reauth-required is a preserved local state, not deletion: refresh failures mark `slack_connections.status='reauth_required'` without removing the Prism user, connection, or Token profiles (`postgres-store.ts:119-130`; `CONTEXT.md:79-81`).
  - Token profile Remove access revokes Prism developer tokens and preserves profile/audit metadata; permanent Token profile deletion is only allowed after access is inactive. This is prior art for warning copy and destructive route patterns, but it is not the same as removing a Slack connection (`token-profile-detail-panel.tsx:263-292`, `token-profiles/store.ts:110-222`).
- Behaviors that must remain unchanged:
  - Change Slack authorization must remain a link/form action to `/v1/slack/oauth/start`; Slack, not Prism, owns workspace/org picker, Enterprise Grid approval, and admin prompts.
  - Reauth-required copy/behavior must remain available. Do not replace reconnect with destructive Remove Slack connection.
  - The same browser session must remain valid after local removal. Because `prism_sessions` references `prism_users`, not `slack_connections`, deleting the connection row should make current reads render `not_linked` without deleting the session row (`0001_slack_oauth_custody.sql:11-14`, `postgres-store.ts:171-175`).
  - Removing a Slack connection must not remove the Prism user row or clear the browser session cookie.
  - No Slack credentials, refresh tokens, Authorization headers, token hashes, peppers, Prism developer tokens, Slack payloads, or raw credential envelopes may be rendered, returned, logged, or put in audit rows.
  - Metadata-only audit posture must remain metadata-only and must not store Slack payloads or secrets (`docs/security.md:29-33`).
- Runtime or UX evidence:
  - Current compact healthy Slack card has no management actions; only not-linked and reauth states currently link to `/v1/slack/oauth/start` (`slack-status-panel.tsx:66-103`).
  - Existing UI tests protect no-secret rendering, Enterprise Grid/no-workspace behavior, display-name redaction, and reauth identity retention (`app/slack-status-panel.test.tsx:15-31`, `app/slack-status-panel.test.tsx:59-112`).
  - Existing route tests protect no-store/request-ID and no secret-bearing responses for Token profile routes (`app/v1/prism/token-profiles/route.test.ts:118-242`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use `/v1/slack/oauth/start` exactly for Change Slack authorization. Prefer `LinkButton href="/v1/slack/oauth/start"` in the Slack card/header over new route handlers or custom Slack authorize URL construction.
  - Extend `app/slack-status-panel.tsx` as the visible owner for connection actions/copy. If typed confirmation requires client state, add a small nested client component (for example `app/slack-connection-management-actions.tsx`) rather than converting unrelated server page logic to client-side fetching.
  - Use existing UI primitives: `Button`, `LinkButton`, `Notice`, `StatusBadge`, `Panel` from `app/ui.tsx`; shadcn/Radix `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle` from `components/ui/dialog.tsx`; `Input` and `Label` from `components/ui/*` for typed confirmation. This matches Token profile destructive UI patterns.
  - Add a server-only connection-management module under `src/server/slack/`, e.g. `connection-management.ts`, with a narrow interface such as `removeSlackConnection({ store, sessionToken, audit?, now }) -> removed | unauthenticated | not_linked | not_found`. Keep outcomes explicit as requested in PRD #28.
  - Extend `src/server/slack/postgres-store.ts` or add a sibling Postgres store factory to implement the removal interface. It should resolve by session token hash and delete only the selected current `slack_connections.id` for that session's `prism_user_id`.
  - Add a thin App Router mutation route under a Prism website namespace, preferably `app/v1/prism/slack-connection/route.ts` with `DELETE`, because this is a Prism-local website mutation, not a Slack-compatible Web API method and not Slack OAuth.
  - Follow existing mutation route conventions: `randomUUID()` request ID, `prismSessionCookieName`, `NextRequest`, `NextResponse.json`, `Cache-Control: no-store`, `X-Prism-Request-ID`, error JSON with no secret-bearing fields (`app/v1/prism/token-profiles/[profileId]/route.ts:15-43`).
  - If recording a metadata-only audit event for removal, use `createPostgresActivityAuditStore`/`insertActivityAuditRecord` and add a migration to extend the activity/status check constraints with e.g. `slack_connection_removed` / `removed`. Record before deletion; FK `ON DELETE SET NULL` will preserve metadata while clearing deleted connection/profile references.
- Relevant docs or library capabilities:
  - Slack OAuth is already implemented with `oauth.v2/authorize` and server-side state handling (`oauth-flow.ts:57-86`). No Slack SDK is needed for Change authorization.
  - Slack app/admin methods are unsupported/deferred by Method registry prefix rules; `apps.*` is classified as `admin` unsupported (`method-registry.ts:76-85`). Do not add `apps.uninstall` to supported forwarding.
  - Current codebase contains no `apps.uninstall` or `auth.revoke` implementation references in `app/` or `src/`; keep it that way for this slice.
  - Existing cascades already perform the intended deletion graph for credentials, Token profiles, developer-token verifiers, and rate-limit rows. Do not hand-delete those child rows unless tests prove a missing cascade.
- Existing examples in this codebase:
  - Token profile route/service/store tests show how to test public seams: service/store outcome, route response, no-store/request-ID headers, and no-secret response assertions (`app/v1/prism/token-profiles/route.test.ts:118-242`, `src/server/token-profiles/store.test.ts:232-294`).
  - `app/token-profile-detail-panel.tsx` shows client-side Dialog-based destructive confirmation patterns (`token-profile-detail-panel.tsx:241-260`, `token-profile-detail-panel.tsx:273-292`). The new typed `REMOVE` confirmation should be stricter than this prior art.
  - `src/server/slack/postgres-store.test.ts` is the existing home for Slack session-scoped store tests; add connection-management store tests there or in a new focused `connection-management.test.ts`.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate `createSlackOAuthStart`, Slack OAuth config parsing, OAuth state storage, or Slack authorize URL construction for Change Slack authorization.
  - Do not create a Prism workspace/org picker, Enterprise Grid chooser, or Slack admin approval simulator.
  - Do not create a separate website session model, client-visible session token, localStorage auth state, or browser-side credential/status cache.
  - Do not bypass `getSlackLinkStatusWithDisplayNameEnrichment` / `getSlackConnectionDisplayRecordForSession` for homepage status after removal.
  - Do not bypass Postgres cascades by manually deleting Slack credentials, Token profiles, developer-token verifiers, or rate limits unless a test reveals the schema does not cascade as documented.
  - Do not use `/v1/slack/api/[method]` forwarding, Method registry, Token profile policy, Local tool developer tokens, or Slack Web API client for connection removal.
  - Do not add Slack SDK/admin API calls for this feature.
- Shortcuts or parallel paths to avoid:
  - No Slack `apps.uninstall`, `auth.revoke`, bot-token revocation, user-token revocation, admin API, SCIM, Audit Logs, or app-management scope work.
  - No UI label `Disconnect Slack` unless copy explicitly explains local-only semantics; PRD prefers `Remove Slack connection` to avoid Slack-side uninstall implications.
  - No deleting `prism_users` or `prism_sessions`; this would violate the preserved-session acceptance criterion.
  - No returning deleted row credential metadata, token profile details, token hashes, developer-token material, or Slack token envelopes from the remove endpoint.
  - No logging full SQL params, session token values, Slack credential envelopes, developer token hashes, or Slack token canaries.
  - No broad dashboard/admin console. Keep actions compact inside the existing Slack connection card/surface.
- Invariants:
  - Change authorization is non-destructive and Slack-owned.
  - Remove Slack connection is destructive but local-only: it deletes Prism's selected/current Slack connection row for the session and relies on DB cascades; it does not make Slack-side changes.
  - Session scoping is mandatory: the route must be able to remove only a connection joined through the request's `prism_session` and non-expired session row.
  - After deletion, the next homepage read for the same session should produce `not_linked`, which keeps Token profiles unavailable and shows Connect Slack.
  - Slack credentials remain server-held; Local tools continue to receive only Prism developer tokens, and those tokens should stop resolving once their cascaded Token profiles/developer-token verifiers are gone.
  - Status/action UI must be keyboard reachable, screen-reader understandable, and mobile-safe; status uses text plus tone, not color alone.

## Integration plan

- Insert the change at:
  - **Change Slack authorization UI (#29):** update `app/slack-status-panel.tsx` linked/healthy compact and full panel states to include a compact `Change Slack authorization` action linking to `/v1/slack/oauth/start`. Update reauth-required copy/actions to use language consistent with changing Slack authorization while preserving Reconnect semantics. Include copy that Slack controls workspace/org selection and admin approval.
  - **Connection management client action:** add a small client component rendered only for `status.kind === "linked"`, e.g. `SlackConnectionActions`, containing the Change authorization `LinkButton` and Remove Slack connection Dialog. It should require typing exact `REMOVE` before enabling the destructive button, submit `DELETE` to the Prism local route, then call `router.refresh()` so the same browser session re-renders as not linked.
  - **Server service/store (#30):** add `src/server/slack/connection-management.ts` with a tiny service interface and outcomes. Add a Postgres implementation either in `src/server/slack/postgres-store.ts` or a sibling `connection-management-store.ts`; reuse `hashSecret` and query via `prism_sessions -> slack_connections` to delete only the latest/current connection for that session.
  - **Mutation route (#30):** add `app/v1/prism/slack-connection/route.ts` with `DELETE`. It should read `prism_session`, call the service, return no-store JSON plus request ID, map unauthenticated/not-linked/not-found explicitly, and include no secret-bearing response content. If the route needs setup/audit error handling, follow existing Token profile routes.
  - **Database/audit:** no migration is required for core deletion if current cascades are trusted. If adding a new audit activity for the local reset, add a migration only for audit check constraints and record metadata before deleting the connection; do not add tables for this slice.
  - **UI copy:** destructive warning must state Prism removes its stored Slack connection, encrypted credentials, dependent Token profiles, and local-tool access for this connection; Slack app installation/approval remains managed in Slack and Prism does not uninstall the Slack app or revoke bot tokens.
- Why this is the correct integration point:
  - SlackStatusPanel is already the Slack connection card owner and already contains the Connect/Reconnect affordances that this slice extends.
  - `/v1/slack/oauth/start` is already the tested Slack-owned authorization entrypoint; linking to it preserves Slack picker/admin behavior and avoids a parallel OAuth path.
  - A `src/server/slack/*` service/store keeps destructive deletion server-side, testable, and aligned with the existing Slack connection persistence owner.
  - A Prism `/v1/prism/*` route names the operation honestly as a Prism-local website mutation, not a Slack-compatible API or Slack app administration action.
  - Deleting the connection row is the narrowest operation that activates existing schema cascades and naturally causes current status reads to return `not_linked` while preserving the session row.
- Alternatives considered and rejected:
  - Calling Slack `apps.uninstall`: rejected by PRD research, Method registry admin exclusion, and product semantics; it would imply Slack-side app removal and can have workspace/org side effects.
  - Calling Slack `auth.revoke` on bot tokens: rejected because bot-token revocation can deactivate the bot/remove channel memberships; it is outside local Prism reset semantics.
  - Deleting `prism_users`: rejected because it would destroy the website session owner and conflict with preserved-session/reconnect requirements.
  - Manually deleting child credentials/profiles/verifiers first: rejected as unnecessary and more error-prone while schema cascades already encode ownership.
  - Creating a separate Slack connection admin page/dashboard: rejected because PRD asks to add management to the existing Slack connection card and keep the homepage compact.
  - Using Local tool `/v1/slack/api/*` forwarding for removal: rejected because connection management is website/session-scoped, not developer-token scoped or Slack-compatible.

## Regression checklist

- Behavior: Not-linked users still see Connect Slack, the OAuth start href, locked Token profiles copy, and no Remove Slack connection action.
- Behavior: Setup-required state still renders configuration-needed copy and does not expose management actions that cannot work.
- Behavior: Healthy linked users see Slack identity/scope, Token profiles, Metadata audit, Change Slack authorization, and Remove Slack connection.
- Behavior: Reauth-required linked users retain visible identity, Token profile management, and Reconnect/Change authorization behavior; remove remains clearly separate and destructive.
- Behavior: Change Slack authorization uses `/v1/slack/oauth/start`, sets OAuth state cookie, redirects to Slack authorize, and exposes no client secret or token material.
- Behavior: Remove Slack connection requires exact typed `REMOVE` before enabling final action.
- Behavior: Remove Slack connection deletes only the current session's current Slack connection row; another Prism user's connection cannot be removed.
- Behavior: Existing cascades remove `slack_credentials`, `token_profiles`, `prism_developer_tokens`, and `slack_forwarding_rate_limits` tied to that connection.
- Behavior: Existing `prism_sessions` row/session cookie remains valid; homepage refresh after deletion renders `not_linked` and allows reconnect.
- Behavior: Slack app installation/approval is not changed and no Slack uninstall/revoke API is called.
- Behavior: Token profile and Local tool access tied to the removed connection stops working because the underlying profile/verifier rows are gone.
- Behavior: Metadata-only audit remains metadata-only; if removal is audited, deleted Slack connection/profile FKs may become null via existing `ON DELETE SET NULL` and no payload/secrets are stored.
- Behavior: Display-name enrichment/status reads fail soft and do not block not-linked rendering after removal.
- Behavior: No rendered HTML, JSON body, logs, tests, screenshots, or audit records include Slack access tokens, refresh tokens, `Authorization`, token hashes, peppers, Prism developer tokens, credential envelopes, client secrets, or Slack payload content.
- Behavior: Full repository tests and production build remain green; no existing Token profile revoke/delete semantics regress.

## Test plan

- Existing tests to keep green:
  - `app/slack-status-panel.test.tsx`
  - `app/website-overview.test.ts`
  - `app/v1/slack/oauth/start/route.test.ts`
  - `app/v1/slack/oauth/callback/route.test.ts`
  - `src/server/slack/oauth-flow.test.ts`
  - `src/server/slack/postgres-store.test.ts`
  - `src/server/slack/connection-status.test.ts`
  - `src/server/slack/connection-display-names.test.ts`
  - `src/server/slack/refresh.test.ts`
  - `src/server/slack/forwarding-credentials.test.ts`
  - `src/server/token-profiles/store.test.ts`
  - `src/server/token-profiles/service.test.ts`
  - `src/server/token-profiles/local-tool-status.test.ts`
  - `app/v1/prism/token-profiles/route.test.ts` and nested token profile mutation route tests.
  - Full `npm test` and `npm run build` before final review.
- New tests to add before/with implementation:
  - UI tests in `app/slack-status-panel.test.tsx`: healthy linked card renders `Change Slack authorization`, `/v1/slack/oauth/start`, Slack-owned workspace/org/admin approval copy, destructive `Remove Slack connection` copy, and no secret-like strings.
  - UI tests for reauth-required state: existing Reconnect behavior remains, language is consistent with changing Slack authorization, and Remove action remains separate.
  - Client interaction tests for the new management component: final Remove button disabled until exact `REMOVE`, cancel keeps state, successful fetch calls `router.refresh()`/renders appropriate status, error shows accessible alert. If current server-render tests cannot exercise client state, add a focused Vitest/jsdom setup only if the repo already supports it; otherwise keep pure component tests around initial render and route/service tests for behavior.
  - Service/store tests: unauthenticated/no cookie returns `unauthenticated`; expired/unknown session returns `not_linked`; linked session deletes only `slack_connections.id` joined to the session's `prism_user_id`; not-found race returns `not_found`; generated SQL does not include credential columns or secret-bearing fields.
  - Cascade proof test: with a real or integration-test Postgres DB if available, insert a temporary Prism user/session/Slack connection/credentials/Token profile/developer-token/rate-limit rows, delete the Slack connection, and assert child rows are gone while session remains. If no DB integration harness exists, document manual SQL/live proof and keep unit tests verifying only the parent delete is issued.
  - Route tests for `DELETE /v1/prism/slack-connection`: success, unauthenticated, not-linked, not-found/race, no-store, `X-Prism-Request-ID`, and secret-free response body.
  - Regression guard that remove path never imports/calls Slack Web API client, `auth.revoke`, or `apps.uninstall`. At minimum add tests/assertions that mocked Slack clients are not involved and code search/review confirms no such strings in the implementation path.
  - Token profile/local tool status test: after the owning connection is absent/deleted, developer token resolution/status should fail as not found/unauthorized through existing cascaded rows or absent ownership.
- Live proof required:
  - Run migrations if any audit-constraint migration is added.
  - Run `npm test` and `npm run build`.
  - Start the production Next server (or the project's standard live QA server) and verify in browser at desktop and mobile widths.
  - Healthy linked proof: card shows Change Slack authorization and Remove Slack connection; Change link navigates to `/v1/slack/oauth/start` and redirects to Slack authorize without exposing secrets.
  - Reauth-required or simulated proof: existing reconnect/reauth copy still routes through OAuth start and does not imply deletion.
  - Removal proof with temporary QA rows/session: type `REMOVE`, submit, confirm response has no-store/request ID and no secrets, same browser session refreshes to `not_linked`, Token profiles disappear, Connect Slack is available, and temporary data is cleaned.
  - Console/network proof: no hydration/runtime errors and no Slack/Prism secret patterns in rendered HTML or Prism JSON responses.

## Risk assessment

- Risk: Remove action accidentally deletes the Prism user or session, breaking preserved-session reconnect. Mitigation: delete only `slack_connections` joined by current non-expired session; tests assert session row remains and status becomes not-linked.
- Risk: Delete query removes another user's connection or an older unintended connection. Mitigation: resolve inside the delete statement/transaction from the request session hash and `prism_user_id`; use current/latest connection semantics matching `getSlackConnectionDisplayRecordForSession`; tests cover cross-user/non-current rows.
- Risk: Cascades do not remove every local-access row assumed by the PRD. Mitigation: inspect schema before implementation (done) and add integration/manual cascade proof for credentials, Token profiles, developer-token verifiers, and rate limits.
- Risk: Copy implies Slack-side uninstall/disconnect. Mitigation: use exact labels `Change Slack authorization` and `Remove Slack connection`; include explicit Slack-managed installation/approval language; avoid `Disconnect Slack` as the primary label.
- Risk: Implementation calls Slack `auth.revoke` or `apps.uninstall` later under the guise of cleanup. Mitigation: do not import Slack Web API client in connection-management service/route; add regression/review guard and keep Method registry `apps.*` unsupported.
- Risk: New client component broadens the server-rendered status surface and introduces hydration/accessibility issues. Mitigation: keep client state isolated to actions/dialog; preserve server-rendered status text; test initial render and live QA keyboard/mobile behavior.
- Risk: Audit event insertion before deletion fails and blocks removal. Mitigation: decide whether removal audit is required. If required, follow existing mutation pattern where audit availability can fail safely with explicit `audit_unavailable`; if not required, do not add audit coupling for this slice.
- Risk: Display-name enrichment on status read could race with deletion. Mitigation: deletion returns not-linked on subsequent reads; enrichment already fails soft and should not be involved in the delete service.
- Risk: Secret leakage through responses/logs/tests. Mitigation: keep responses to `{status/outcome}` plus request ID, no row contents; extend no-secret regex assertions used by existing tests.
- Risk: Full-page Token profile state is stale after removal. Mitigation: client calls `router.refresh()` after successful delete; server page only loads Token profiles when status is linked.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership is clear: existing Slack status UI, OAuth start route, server Slack Postgres store, and Token profile mutation patterns directly match the requested behavior.
  - Existing schema already encodes the core destructive cascade from `slack_connections` to credentials, Token profiles, developer-token verifiers, and rate limits while preserving sessions and audit metadata.
  - Current tests already cover no-secret rendering, OAuth start secrecy, session-scoped status, display-name enrichment fallback, and Token profile destructive mutation patterns; the missing tests are straightforward additions at public seams.
  - No current code path implements `apps.uninstall` or `auth.revoke`, and the Method registry already treats `apps.*` as unsupported admin surface.
- Open questions:
  - Should Remove Slack connection record a metadata-only audit event? The PRD requires metadata-only posture but does not explicitly require a removal audit row. If added, a small migration is needed to extend audit check constraints.
  - The phrase "current Slack connection" currently maps to the latest `slack_connections` row for the Prism user, matching existing status/profile-owner resolution. If multi-connection management is introduced later, this must become explicit by connection ID; that is out of scope for #28-#31.
