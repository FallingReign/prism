# Architecture Integration Brief: slack-connection-real-names

## Existing ownership

- Package/component/module/library:
  - `app/page.tsx` owns hosted homepage composition: it reads the HTTP-only `prism_session` cookie, calls `getSlackLinkStatus(database, sessionToken)`, then renders `SlackStatusPanel` in the hosted-service hero (`app/page.tsx:23-29`, `app/page.tsx:65-78`, `app/page.tsx:113-118`).
  - `app/slack-status-panel.tsx` owns visible Slack connection copy for `not_linked`, `setup_required`, `linked/healthy`, and `linked/reauth_required`. It currently renders workspace/organization display text and `safeConnectionText(status.slackUserId)` for the user (`app/slack-status-panel.tsx:4-16`, `app/slack-status-panel.tsx:77-100`, `app/slack-status-panel.tsx:120-150`).
  - `app/slack-connection-display.ts` owns safe name-with-ID formatting for workspace/organization display and redacts credential-shaped substrings (`app/slack-connection-display.ts:3-19`).
  - `app/website-overview.ts` owns top-level Slack summary detail copy and currently mentions the raw `slackUserId` plus workspace/organization display (`app/website-overview.ts:55-90`).
  - `src/server/slack/oauth-client.ts` owns Slack OAuth response normalization. It already normalizes `team.name` and `enterprise.name`, but not a Slack user display name (`oauth-client.ts:3-23`, `oauth-client.ts:87-111`).
  - `src/server/slack/oauth-flow.ts` owns OAuth callback orchestration and the `OAuthFlowStore` contract. It passes `teamName` and `enterpriseName` into `upsertSlackConnection` and stores credentials through encrypted custody only (`oauth-flow.ts:30-55`, `oauth-flow.ts:126-145`, `oauth-flow.ts:196-222`).
  - `src/server/slack/postgres-store.ts` owns Slack OAuth/connection/credential/session persistence, `getSlackLinkStatus`, and the `RefreshStore` implementation used by refresh/credential providers (`postgres-store.ts:11-84`, `postgres-store.ts:86-131`, `postgres-store.ts:133-178`).
  - `db/migrations/0001_slack_oauth_custody.sql` owns the base connection/credential schema; `db/migrations/0007_slack_connection_display_names.sql` added nullable `team_name` and `enterprise_name` columns only (`0001_slack_oauth_custody.sql:26-54`, `0007_slack_connection_display_names.sql:1-3`).
  - `src/server/slack/forwarding-credentials.ts` plus `src/server/slack/refresh.ts` own safe access-token retrieval, refresh, reauth marking, and decryption for a selected `connectionId + kind` (`forwarding-credentials.ts:7-60`, `refresh.ts:6-30`, `refresh.ts:32-84`).
  - `src/server/slack/web-api-client.ts` owns the server-side Slack Web API HTTP client seam with injected `fetch`, Authorization header handling, payload sanitization, and selected header pass-through (`web-api-client.ts:24-31`, `web-api-client.ts:33-78`, `web-api-client.ts:133-147`).
  - Token profile behavior/status is owned by `src/server/token-profiles/*`, especially `local-tool-status.ts` for Token profile status bodies and `store.ts` for resolving session-scoped profile ownership without exposing credentials (`local-tool-status.ts:40-57`, `local-tool-status.ts:72-97`, `store.ts:14-30`).
- Current owner rationale:
  - The user-visible bug is connection status metadata presentation, not a new browser API or Local-tool capability. The existing pipeline is: OAuth/credentials in server custody -> `slack_connections` metadata -> `getSlackLinkStatus` -> website status/overview render.
  - Existing real rows can predate `team_name`/`enterprise_name`, and OAuth lacks user display names, so enrichment belongs in server-side connection metadata ownership and display helpers, not in client components or Token profile status responses.
- Source evidence:
  - Current tests already expect friendly workspace/org `Name (ID)` when present and fallback IDs/no secret leakage when absent (`app/slack-status-panel.test.tsx:15-31`, `app/slack-status-panel.test.tsx:49-70`, `app/slack-status-panel.test.tsx:72-88`; `src/server/slack/postgres-store.test.ts:7-40`).
  - Docs define Prism hosted service as Slack credential custody owner; Local tools and browsers must not receive Slack credentials (`README.md:3`, `README.md:45-51`, `docs/security.md:5-12`).

## Existing interaction model

- User/system behaviors that already exist:
  - `not_linked`: website shows Connect Slack and does not load Token profiles/activity (`app/slack-status-panel.tsx:37-53`, `app/page.tsx:27-29`, `app/page.tsx:82-98`).
  - `setup_required`: panel shows configuration-needed copy and OAuth routes can redirect to `?slack=setup_required` on missing config (`app/slack-status-panel.tsx:23-35`, `app/v1/slack/oauth/start/route.ts:26-39`, `app/v1/slack/oauth/callback/route.ts:43-56`).
  - `linked/healthy`: hosted-service hero says Slack connected and shows workspace/organization plus Slack user; Token profiles and Metadata audit remain available (`app/page.tsx:77-83`, `app/page.tsx:99-107`, `app/slack-status-panel.tsx:94-102`, `app/slack-status-panel.tsx:139-154`).
  - `linked/reauth_required`: the same session identity remains visible, Token profile management remains present, and UI changes the action/copy to reconnect before Slack calls resume (`app/slack-status-panel.tsx:79-91`, `app/slack-status-panel.tsx:120-136`; tests at `app/slack-status-panel.test.tsx:90-102`).
  - Token profile `/v1/prism/status` behavior intentionally reports token validity, Slack connected/reauth state, and execution identity availability only; it does not return Slack names or credential material (`local-tool-status.ts:40-57`, `local-tool-status.ts:88-97`, `local-tool-status.ts:219-225`).
  - Server-side forwarding uses Method registry, Token profile policy, Execution identity, rate limits, metadata-only audit, credential retrieval/refresh, and then Slack Web API. This ordering must not be repurposed into a browser lookup path (`app/v1/slack/api/[method]/route.ts:29-79`, `forwarding.ts:51-140`).
- Behaviors that must remain unchanged:
  - Raw Slack IDs remain available as secondary/fallback support/debug details: current display uses `Name (ID)` for workspace/organization and ID-only fallback when name is absent (`slack-connection-display.ts:3-12`). The same pattern should be used for users.
  - `not_linked`, `setup_required`, `linked/healthy`, and `linked/reauth_required` state semantics must not change.
  - Reauth-required must not delete Slack connection, credentials, Token profiles, or user-facing identity metadata; refresh already marks connection state instead (`refresh.ts:47-63`, `refresh.test.ts:138-170`).
  - Token profile status/capabilities and Slack-compatible endpoint responses must not grow new browser-facing Slack lookup behavior or expose Slack credentials.
  - Metadata-only/no-secret policy remains strict: no Slack message text, search query/results, file contents, token material, authorization headers, token hashes, peppers, client secrets, raw credential envelopes, or full Slack profile JSON.
- Runtime or UX evidence:
  - The reported hosted copy, `organization E06GM8RK8JH is connected for Slack user U06G9KK584F`, is produced by the current linked status component when `enterpriseName`, `teamName`, and user display metadata are unavailable (`slack-status-panel.tsx:77-100`).
  - Existing tests demonstrate the intended fallback posture: names are used when present, IDs remain visible, and credential-like strings are redacted (`slack-status-panel.test.tsx:15-31`, `slack-status-panel.test.tsx:72-88`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Extend `SlackWebsiteStatus` and `getSlackLinkStatus` rather than adding a separate homepage API. Add a nullable, minimal user display field such as `authed_user_display_name`/`slackUserName` and return it beside `slackUserId`.
  - Add a nullable column on `slack_connections` for the selected user display name. Keep `team_name` and `enterprise_name` as the existing workspace/org persistence targets (`0007_slack_connection_display_names.sql:1-3`).
  - Reuse `displayNameWithId`/`safeConnectionText` or a sibling helper for user display, so the UI renders `Display Name (U123)` when available and `U123` when not (`slack-connection-display.ts:8-19`).
  - Reuse existing server-only custody seams for optional enrichment: `createPostgresRefreshStore`, `createSlackForwardingCredentialProvider`, `createDefaultSlackWebApiClient`/`FetchSlackWebApiClient`, and injected `fetch`/client patterns. Do not introduce Slack SDK or route-local fetch unless separately justified.
  - Add a narrow server-only connection metadata enrichment function/store method, e.g. `enrichSlackConnectionDisplayNames({ connectionId })` plus store methods to read connection ids/missing fields and update only safe display-name columns.
  - Use OAuth link/reconnect path for future data (`completeSlackOAuthCallback` already has the connection id and credentials after exchange), and use a best-effort server-side enrichment/backfill-on-status-read path for existing linked rows with null names.
- Relevant docs or library capabilities:
  - Slack `auth.test` checks authentication and requires no scopes. It returns `team`, `user`, `team_id`, `user_id`, and for Enterprise can include `enterprise_id` (Slack docs: https://api.slack.com/methods/auth.test). This can recover workspace team name and a Slack username where available, but it does not provide a full profile display/real name or enterprise name.
  - Slack `users.info` returns a user object including `real_name` and `profile.display_name`/normalized fields, with `users:read` for normal profile data and `users:read.email` only for email; Prism must not request/use email here (Slack docs: https://api.slack.com/methods/users.info). Current default scopes and manifest include `users:read` for bot and user tokens (`config.ts:63-93`, `prism-slack-app-manifest.template.yml:29-60`, `scope-review-packet.md:23-43`).
  - Slack `team.info` can return team name and enterprise name, but it is not currently in the Method registry and docs/scope packet list `team:read` as optional supporting scope, not a v1 default (`scope-review-packet.md:46-53`; Slack docs: https://api.slack.com/methods/team.info). Do not require it for this slice.
  - Admin/org APIs (`admin.*`, SCIM, audit logs, discovery, etc.) are explicitly excluded and inappropriate for display-name enrichment (`scope-review-packet.md:63-79`, `method-registry.ts:65-86`, `docs/security.md:62-66`).
- Existing examples in this codebase:
  - `createSlackForwardingCredentialProvider` decrypts only the selected execution identity credential and refreshes expired credentials without persisting plaintext token canaries (`forwarding-credentials.test.ts:10-53`, `forwarding-credentials.test.ts:55-117`).
  - `FetchSlackWebApiClient` already has safe request construction and token stripping for server-held Slack calls (`web-api-client.test.ts:11-68`).
  - OAuth flow tests assert names from OAuth are passed into connection persistence and no token canaries leak (`oauth-flow.test.ts:90-175`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate or replace `getSlackLinkStatus`, `OAuthFlowStore`, `createPostgresOAuthFlowStore`, `createPostgresRefreshStore`, `createSlackForwardingCredentialProvider`, the encrypted credential envelopes, or website session ownership.
  - Do not add client-side Slack Web API calls, browser-side `/v1/slack/api/users.info` calls, browser-visible Slack tokens, Local-tool-powered enrichment, or Slack credential passthrough.
  - Do not create a second Slack status cache, second OAuth response parser, second credential decryptor, or a separate account/profile subsystem.
  - Do not bypass Token profile state semantics or make display enrichment affect authorization, uniqueness, method policy, execution identity, rate limits, forwarding, or audit.
- Shortcuts or parallel paths to avoid:
  - No client component fetching Slack names directly from Slack or through a new unauthenticated endpoint.
  - No use of `admin.*`, `team.*` requiring new admin/team scopes, SCIM, Audit Logs, discovery APIs, `users.profile:read`, or `users:read.email` for this display-only slice.
  - No storing full OAuth/Web API responses, full Slack user/profile JSON, profile images, emails, statuses, time zones, locale, domains, search/message/file content, token scopes as proof text, request/response payload dumps, or raw credential envelopes.
  - No making optional Slack name lookup failure fatal to OAuth linking or homepage rendering.
  - No hiding IDs completely; display names are primary when available, IDs remain secondary/fallback.
- Invariants:
  - Server custody only: any Slack API lookup must use server-held encrypted credentials through existing custody/refresh/decryption seams.
  - Metadata minimization: persist only selected short display strings needed for connection status (`team_name`, `enterprise_name`, and one user display name field), not Slack profile documents.
  - Fail closed for secrets and fail soft for names: if lookup is unavailable, missing-scope, rate-limited, reauth-required, or malformed, keep rendering IDs and do not leak implementation details.
  - Homepage remains dynamic/session-scoped and status rendering stays in `app/` with redaction helpers.

## Integration plan

- Insert the change at:
  - **Schema:** add a new migration after `0007` with nullable `slack_connections.authed_user_display_name text` (or equivalent exact name). Optionally add a simple non-empty check only if it does not complicate backfill; otherwise sanitize/trim in service code. Do not add profile JSON columns.
  - **Types/store:** extend `OAuthFlowStore.upsertSlackConnection` input, `getSlackLinkStatus` return shape, and `SlackWebsiteStatus` with nullable user display name. Update `createPostgresOAuthFlowStore.upsertSlackConnection` and tests to preserve compatibility.
  - **Display:** add a user display helper in `app/slack-connection-display.ts` or reuse `displayNameWithId`. Render `Slack user Display Name (U123)` when present and `Slack user U123` otherwise in both compact and panel states; update `website-overview.ts` similarly.
  - **Future OAuth link/reconnect enrichment:** after credentials are stored during `completeSlackOAuthCallback`, invoke a best-effort server-side enrichment step using the created `connection.id`. It may call `auth.test` first and `users.info` only when an access token with `users:read` is available. It must never block successful linking; failures leave nullable fields as OAuth-provided names/IDs.
  - **Existing-row enrichment:** to address current hosted rows, enrich opportunistically on status read only when the session is linked and one or more display fields are missing. Keep it bounded and non-fatal: select the current connection id/status plus nullable display fields, attempt at most the minimum safe calls, update the same row, then return refreshed metadata or the original ID fallbacks. If implementers consider status-read mutation too surprising, provide a small server-only backfill helper/script that uses the same enrichment service and is run once after deployment; do not add browser/API lookup.
  - **Lookup sequence:** prefer already-persisted names; use OAuth response names on reconnect; for missing workspace name use `auth.test.team`; for missing user display name use `users.info(user=authed_user_id)` with `users:read`, storing only `profile.display_name_normalized || profile.display_name || profile.real_name_normalized || real_name || name`; for enterprise name, use existing OAuth response if available and otherwise fall back to enterprise ID rather than requiring `team.info`/`team:read`.
  - **Credential selection:** use the existing credential provider and `connectionId + kind`; prefer user credential for the authed user if present, otherwise bot credential only for `auth.test`/`users.info` if it has `users:read`. Do not choose credentials based on browser input.
  - **Failure fallback:** on `missing_scope`, `not_authed`, `invalid_auth`, refresh/reauth failure, Slack network failure, 429, malformed response, deleted user, or empty unsafe display names, leave the DB unchanged and render IDs. Reauth marking should stay owned by refresh/custody behavior when credentials are invalid/expired.
- Why this is the correct integration point:
  - It fixes real rows by enriching durable server-side connection metadata and lets the existing homepage render path benefit without a second status system.
  - It reuses Slack custody/refresh/Web API abstractions already built for safe server-side Slack calls and preserves the no-token browser boundary.
  - It keeps Slack IDs as the stable identity keys and treats names as optional display metadata only.
- Alternatives considered and rejected:
  - Browser-side Slack lookup: rejected because it would expose/require Slack tokens or create a parallel server proxy outside custody.
  - `team.info`/`team:read` as a required solution: rejected for the smallest slice because current scopes do not reliably include `team:read`, and `auth.test` plus OAuth metadata cover the common workspace-name case.
  - `admin.*`/SCIM/Audit Logs for enterprise/user names: rejected as over-scoped, explicitly excluded, and unnecessary.
  - Full profile storage: rejected by metadata minimization and prompt-injection/privacy risk.
  - Display-only fixture change: rejected because it would not improve real hosted rows with null names.

## Regression checklist

- Behavior: Existing rows with all name fields null still render safely using Slack IDs.
- Behavior: Rows with `team_name`/`enterprise_name` still render `Name (ID)` and retain ID fallback/debug detail.
- Behavior: Rows with a user display name render user name as primary and raw Slack user ID as secondary/fallback.
- Behavior: Not-linked and setup-required states do not attempt Slack API lookups or credential decryption.
- Behavior: Reauth-required state still renders existing identity metadata and Reconnect Slack, and Token profiles remain visible.
- Behavior: OAuth link/reconnect still stores encrypted credentials only, creates HTTP-only website sessions, and does not expose Slack credentials in redirects/HTML/responses/logs.
- Behavior: Optional enrichment failure does not fail OAuth linking, homepage rendering, Token profile management, or forwarding.
- Behavior: Token profile `/v1/prism/status` and `/v1/prism/capabilities` response shapes stay unchanged unless separately approved.
- Behavior: Method registry, policy gates, rate limits, Metadata-only audit, and Slack forwarding are not bypassed or broadened.
- Behavior: No Slack message text, search query/results, file contents, token material, authorization headers, token hashes, peppers, client secrets, raw credential envelopes, or full Slack profile JSON are stored, logged, rendered, or tested as snapshots.

## Test plan

- Existing tests to keep green:
  - `app/slack-status-panel.test.tsx`
  - `app/website-overview.test.ts`
  - `src/server/slack/postgres-store.test.ts`
  - `src/server/slack/oauth-flow.test.ts`
  - `src/server/slack/oauth-client.test.ts`
  - `src/server/slack/forwarding-credentials.test.ts`
  - `src/server/slack/web-api-client.test.ts`
  - `src/server/slack/refresh.test.ts`
  - `src/server/token-profiles/*` tests covering reauth/profile behavior
  - Full `npm test` and `npm run build` before final review.
- New tests to add before/with implementation:
  - Migration/store tests: new nullable `authed_user_display_name` column exists; `getSlackLinkStatus` returns it; null remains backward-compatible.
  - UI tests: compact and panel linked/reauth render `User Name (U123)` when present, raw ID fallback when absent, workspace/org name-plus-ID behavior unchanged, and secret redaction still applies to Slack-derived names.
  - Overview tests: Slack summary uses friendly user/workspace/org labels where present and ID fallback where absent.
  - OAuth/service tests: reconnect/link passes through persisted display metadata; optional enrichment failures do not change result kind or leak token canaries.
  - Enrichment service tests with injected Slack client/credential provider: `auth.test` can backfill workspace/user strings without scopes; `users.info` with `users:read` stores only the chosen short display field; `missing_scope`, 429, invalid auth, deleted/missing user, malformed body, refresh/reauth, and network errors fall back to IDs without throwing to callers.
  - No-secret tests: persisted rows, rendered HTML, thrown errors, and any logs captured by tests do not contain token canaries, authorization headers, full profile JSON, email, status text, image URLs, message/search/file content, token hashes, peppers, or client secrets.
- Live proof required:
  - Run migrations, `npm test`, and `npm run build`.
  - In local/mock QA, verify existing null-name rows still render IDs, then verify a row with display names renders names plus IDs.
  - In hosted/live QA, sign in with an existing linked session that previously showed raw IDs; load the homepage and capture proof that workspace/user names appear where Slack allowed them, with raw IDs retained as secondary/fallback and no credential-like values visible.
  - Inspect browser console/network for hydration/runtime errors and absence of Slack/Prism tokens in HTML and Prism responses. Do not capture Slack credential-bearing upstream requests/responses.

## Risk assessment

- Risk: Current scopes may not reliably permit friendly user real/display names for every install.
  - Mitigation: use `auth.test` no-scope data where useful, attempt `users.info` only when `users:read` is present/approved, and fall back to IDs on `missing_scope` or other failures.
- Risk: `auth.test` returns Slack username rather than full display/real name, and may not provide enterprise name.
  - Mitigation: treat it as best-effort display metadata; for enterprise name use OAuth-provided `enterprise.name` on reconnect and otherwise keep enterprise ID.
- Risk: Status-read enrichment mutates state during page render and could add latency/rate-limit pressure.
  - Mitigation: only run when display fields are missing, make it non-blocking/bounded where practical, cache results in `slack_connections`, and consider a one-shot server-side backfill helper if render-time mutation is unacceptable.
- Risk: Slack profile/display fields are user-controlled and can contain prompt-injection or credential-shaped text.
  - Mitigation: length-limit, trim, store only one selected display string, render via `safeConnectionText`, and never store status text, custom profile fields, email, images, or full profile JSON.
- Risk: Optional lookups could mark healthy connections as reauth-required unexpectedly.
  - Mitigation: only existing refresh/custody invalid-token handling should mark reauth; lookup-specific missing scope/rate limit/network/malformed failures should leave connection status unchanged unless credential provider explicitly reports reauth.
- Risk: Enterprise Grid and Slack Connect user/team behavior can vary.
  - Mitigation: keep IDs visible, do not infer org names from workspace calls, and do not add admin/org scopes.
- Risk: New display metadata could accidentally affect authorization/ownership.
  - Mitigation: keep uniqueness and policy keyed on Slack IDs only; names are nullable presentation metadata.

## Decision confidence

- Confidence: medium-high
- Reasons:
  - High confidence on ownership: status display, OAuth persistence, encrypted credentials, refresh, and Web API calls already have clear server-only owners and tests.
  - High confidence that `auth.test` can provide no-scope workspace/user strings and that existing OAuth already captures future team/enterprise names when Slack returns them.
  - Medium confidence on real human user names for all installs: `users.info` requires `users:read` and Slack profile contents vary; existing default scopes include `users:read`, but older/real installations may not have it or may return only username-like values.
  - Medium confidence on enterprise display backfill: current safe fallback is OAuth `enterprise.name` on reconnect or ID fallback; requiring `team.info`/`team:read` is not appropriate for the smallest slice.
- Open questions:
  - Should implementation enrich missing names opportunistically on status read, or ship a server-only backfill helper run once after deploy to avoid render-time mutation?
  - Should the stored user display preference be Slack display name first, real name first, or username first? Recommended: `display_name_normalized || display_name || real_name_normalized || real_name || name`, because display name is what Slack users commonly choose to show.
  - Should `users.info` be attempted with bot token, user token, or both? Recommended: prefer the user credential for the authed user, fallback to bot only if present and scoped; never broaden scopes just for display.
