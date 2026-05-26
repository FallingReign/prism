# Architecture Integration Brief: slack-connection-identity-ux

## Existing ownership

- Package/component/module/library:
  - `app/page.tsx` owns the hosted-service homepage composition: reads the `prism_session` cookie, loads Slack link status with `getSlackLinkStatus`, conditionally loads Token profiles/activity, computes `buildWebsiteOverview`, renders the top product header, hosted-service hero/status area, primary Token profiles workspace, supporting status aside, and Metadata audit.
  - `app/slack-status-panel.tsx` owns state-specific Slack connection rendering for `not_linked`, `setup_required`, `linked/healthy`, and `linked/reauth_required`, including the current linked copy called out by the user.
  - `app/website-overview.ts` owns summary labels/details used by the product header badge and hosted-service overview copy.
  - `src/server/slack/oauth-client.ts` owns Slack OAuth response normalization. It already parses `team.name` and `enterprise.name` into `SlackOAuthSuccess`, but not a user display name.
  - `src/server/slack/oauth-flow.ts` owns OAuth callback orchestration and the storage contract (`OAuthFlowStore`) for Prism user, Slack connection, encrypted credentials, and website session creation.
  - `src/server/slack/postgres-store.ts` owns Postgres persistence for OAuth state/connection/credentials/session and the session-scoped `getSlackLinkStatus` query consumed by the website.
  - `db/migrations/0001_slack_oauth_custody.sql` owns the current OAuth custody schema. It stores Slack team/user/enterprise IDs, app ID, scopes, status, last error class, encrypted credential envelopes, and session-token hashes; it does not store Slack team, enterprise, or user names.
  - Shared UI primitives live in `app/ui.tsx` (`Panel`, `StatusBadge`, `Notice`, `SummaryMetric`, `LinkButton`, shadcn-backed controls). They should remain the visual substrate for the pass.
- Current owner rationale:
  - The requested change is a homepage/status UX and safe metadata presentation change, not a new OAuth/storage path. The existing owners already load status, render linked/not-linked/reauth states, and preserve token custody boundaries.
  - If richer identity fields are added, they belong in the existing OAuth response normalization -> OAuth flow store contract -> Postgres store/query -> website status type pipeline. Adding a parallel client-side Slack lookup or a separate status API would duplicate ownership.
- Source evidence:
  - `app/page.tsx` lines 23-31 load Slack status, Token profiles, activity, and overview; lines 65-82 render the hosted-service area; lines 84-105 put Token profiles first and Slack status in a supporting aside.
  - `app/slack-status-panel.tsx` lines 66-80 render `Linked and healthy`, `Ready for forwarding`, raw Slack identity/scope IDs, and `Server custody active` notice.
  - `app/website-overview.ts` lines 73-90 formats linked status using raw `slackUserId`, `teamId`, and `enterpriseId`.
  - `src/server/slack/oauth-client.ts` lines 96-108 normalizes `team.name` and `enterprise.name`; `src/server/slack/oauth-flow.ts` lines 124-137 drops those names before persistence; `src/server/slack/postgres-store.ts` lines 129-167 returns IDs only.
  - Targeted baseline passed: `npm test -- --run app/slack-status-panel.test.tsx app/website-overview.test.ts src/server/slack/oauth-flow.test.ts src/server/slack/oauth-client.test.ts` (4 files, 11 tests).

## Existing interaction model

- User/system behaviors that already exist:
  - `not_linked`: homepage does not load Token profiles/activity; Token profile panel is replaced by a locked state with `Connect Slack`; Slack status panel says `Not linked` and links to `/v1/slack/oauth/start`.
  - `linked/healthy`: homepage loads Token profiles and Metadata audit; Token profile management is available; Slack status panel shows linked identity/scope and no reconnect action.
  - `linked/reauth_required`: homepage still loads Token profiles/activity; Token profile management remains visible but `TokenProfilesPanel` warns calls need Slack reauth; header/status action says `Reconnect Slack` and links to `/v1/slack/oauth/start`.
  - `setup_required`: `SlackStatusPanel` and `SlackWebsiteStatus` model it, and OAuth start/callback routes redirect to `/?slack=setup_required` when config is missing.
  - Top header already contains brand, nav, Slack status badge, and setup action. The hosted-service hero currently contains custody copy but not the linked identity details. Slack details are lower in the right aside, making them feel like a separate panel.
  - Token profiles are the primary task area and must remain first-class. Linked status is supporting context, not a marketing/sales block.
- Behaviors that must remain unchanged:
  - The OAuth start/reconnect href remains `/v1/slack/oauth/start`.
  - Linked and reauth states must continue to show enough identity/scope context for the user to know which Slack installation is active.
  - Reauth-required must keep profile management visible and must not imply Slack calls are healthy.
  - Not-linked/setup-required must continue to direct users to connect/configure Slack before creating Token profiles.
  - No UI state may expose Slack access tokens, refresh tokens, client secrets, Authorization headers, token hashes, peppers, Prism developer tokens except existing copy-once success flows, Slack message contents, search contents, file contents, or raw credential envelopes.
- Runtime or UX evidence:
  - Current static tests assert no secret-like strings in Slack status and overview. `app/slack-status-panel.test.tsx` also protects Enterprise Grid no-workspace handling and reauth identity retention.
  - `PRODUCT.md`/`DESIGN.md` align with the requested direction: top product header should show Slack status/setup action; layout should answer linked status, active Token profiles, and recent activity; Slack link/status is supporting context; copy should be precise and custody boundaries short. Current runtime placement/copy partially conflicts because linked status is a standalone aside card with promotional wording (`Ready for forwarding`, `Server custody active`) and raw IDs.
  - Code conflict to flag: `setup_required` is modeled and tested in the panel type, and OAuth routes redirect with `?slack=setup_required`, but `app/page.tsx` currently does not read `searchParams` and `getSlackLinkStatus` cannot return `setup_required`. Do not silently broaden this slice unless implementation intentionally fixes that existing reachability gap.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use `app/page.tsx` as the integration point for moving linked connection state up into the hosted-service/status area. The page already has all required data and should remain `dynamic = "force-dynamic"`.
  - Use or extend `SlackWebsiteStatus` in `app/slack-status-panel.tsx` as the UI-facing status shape. Keep the state union explicit (`not_linked`, `setup_required`, `linked` with `healthy | reauth_required`).
  - Use `buildWebsiteOverview` for concise header/summary wording if the hosted-service area needs reusable summary strings. Avoid computing display strings in server stores.
  - Use existing `Panel`, `StatusBadge`, `Notice`, `SummaryMetric`, and `LinkButton` from `app/ui.tsx`; do not introduce one-off cards/inline styles for this pass.
  - Use existing OAuth normalization in `src/server/slack/oauth-client.ts` for Slack team/enterprise names already returned by `oauth.v2.access`.
  - If names are persisted, add a new migration that minimally extends `slack_connections` with nullable `team_name` and `enterprise_name` (and possibly `authed_user_name` only if a safe source is explicitly added). Extend `OAuthFlowStore.upsertSlackConnection`, `createPostgresOAuthFlowStore.upsertSlackConnection`, and `getSlackLinkStatus` rather than creating a new store.
  - If a user-friendly Slack user name is required now, it likely needs an extra Slack Web API call (for example `users.info` with `users:read`) or another identity endpoint; do not hide this behind the existing OAuth exchange. Store only a deliberately selected safe display field and retain the raw user ID as fallback/secondary detail.
- Relevant docs or library capabilities:
  - Slack OAuth response data currently modeled in code includes `team.name` and `enterprise.name`, so workspace/org names can be captured without a new browser-visible token path if Slack includes them.
  - The existing Slack Web API client (`src/server/slack/web-api-client.ts`) is a forwarding-oriented client requiring an access token and can call arbitrary methods, but using it during OAuth identity enrichment would be a new server-side behavior with privacy/scope/testing implications. It must not become a client-side lookup.
  - Existing default scopes include `users:read`, and method registry supports `users.info`, but names/profile fields are Slack-derived content and must be stored/displayed narrowly.
- Existing examples in this codebase:
  - `app/token-profile-workspace.ts` and `app/website-overview.ts` use small pure presentation helpers tested with Vitest.
  - `app/slack-status-panel.test.tsx`, `app/website-overview.test.ts`, `src/server/slack/oauth-flow.test.ts`, and `src/server/slack/oauth-client.test.ts` are the right patterns for visible copy/no-secret and data pipeline coverage.
  - Prior briefs in `docs/implementation-reviews/` consistently keep website presentation in `app/` and data custody in `src/server/slack/*`/Postgres migrations.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate or replace `getSlackLinkStatus` with a new homepage query/store/status endpoint unless the existing function is extended.
  - Do not fetch Slack identity details from the browser, client components, or Local tools. Any enrichment must be server-side and must use server-held credentials only through existing custody owners.
  - Do not create a second Slack OAuth parser, credential store, status cache, session layer, or token-profile loader.
  - Do not bypass `completeSlackOAuthCallback`, `OAuthFlowStore`, `createPostgresOAuthFlowStore`, encrypted credential storage, `createPostgresRefreshStore`, or existing token-profile/audit services.
  - Do not duplicate UI primitives with ad hoc panels/badges/notices or inline styles.
- Shortcuts or parallel paths to avoid:
  - Avoid adding names only to website component fixtures while leaving real status data raw-ID only; that creates a fake success path.
  - Avoid extra Slack API calls in render/page load for every homepage visit. If enrichment is needed, capture safe identity metadata at OAuth link/reconnect time and serve it from Postgres.
  - Avoid storing or displaying full Slack user/profile objects, Slack response bodies, token material, scopes as proof of safety, authorization headers, token hashes, peppers, Slack messages, search query/result text, file contents, or raw credential envelopes.
  - Avoid hiding raw IDs completely. Product-friendly names should be primary when available, but raw IDs remain useful as secondary/fallback detail for support/debugging and Enterprise Grid ambiguity.
- Invariants:
  - Homepage remains session-scoped and dynamic; no static caching of identity/status.
  - Token profile management remains the primary task area.
  - Slack connection state becomes quieter and closer to the hosted-service/status area, but all linked/not-linked/reauth/setup semantics remain distinct.
  - Custody copy stays short and explicit: Slack credentials are server-held/encrypted; Local tools receive Prism developer tokens.
  - Status uses text plus tone, not color alone.

## Integration plan

- Insert the change at:
  - Layout/copy: update `app/page.tsx` to surface the linked/reconnect/not-linked connection summary inside or immediately adjacent to the `Prism hosted service` status area/header, before the lower two-column workspace. The lower `SlackStatusPanel` can be simplified, demoted, or reused as a compact status detail, but do not leave the primary linked identity only in the low aside.
  - Presentation helper: update `app/website-overview.ts` or add a small local helper in `app/slack-status-panel.tsx` to build quiet display labels such as `Slack connected`, `Connected workspace`, `Reconnect needed`, and concise custody detail. Keep status strings in `app/`, not in server stores.
  - UI component: update `app/slack-status-panel.tsx` to use product-like copy. Replace salesy labels (`Linked and healthy`, `Ready for forwarding`, `Server custody active`) with quieter status language. Preserve `Connect Slack`/`Reconnect Slack` actions and explicit identity/scope details.
  - Data model, minimal safe option: add nullable `team_name` and `enterprise_name` columns to `slack_connections`; pass `slackResult.team.name ?? null` and `slackResult.enterprise?.name ?? null` through `OAuthFlowStore.upsertSlackConnection`; return them from `getSlackLinkStatus`; add them to `SlackWebsiteStatus`. Existing rows and missing names fall back to `teamId`/`enterpriseId`.
  - User name enrichment: do not add by default unless product accepts an extra server-side Slack API call/scope/privacy behavior. Current OAuth parsing only has `authed_user.id`; it does not parse/store human user names. If added later, implement in the OAuth/linking pipeline, store one nullable safe display field (for example `authed_user_display_name`) plus the ID fallback, and test that no full profile data or token material persists.
  - Fallback behavior: show name when available with ID as secondary compact text, e.g. workspace `Acme Platform (T123)` or organization `Acme Enterprise (E123)`. For user, show `User U123` or `Slack user U123` until a verified safe name exists. Never invent placeholder names that imply enrichment happened.
- Why this is the correct integration point:
  - The request is about homepage hierarchy/copy and identity display. `app/page.tsx`, `app/slack-status-panel.tsx`, and `app/website-overview.ts` already own that UX and already receive session-scoped status.
  - Capturing team/enterprise names in the existing OAuth persistence path avoids homepage-time Slack calls and keeps enrichment under server custody.
  - Nullable columns maintain backward compatibility for existing installations and let old rows continue to render safely with IDs.
- Alternatives considered and rejected:
  - Client-side call to Slack or `/v1/slack/api/users.info`: rejected because it exposes a parallel identity lookup path, depends on Token profile policy, and risks Slack-derived content/token leakage into a browser task that should only read safe status metadata.
  - New `/v1/prism/connection-status` endpoint: rejected unless a broader API need emerges; homepage already uses server-side composition and `getSlackLinkStatus`.
  - Storing full OAuth/Web API response JSON for future display: rejected because it violates metadata minimization and increases secret/content leakage risk.
  - Only changing copy while still showing raw IDs and low placement: rejected as incomplete for the stated UX goal, though copy-only may be an acceptable first commit if data-model work is deliberately deferred.

## Regression checklist

- Behavior: Not-linked users still see `Connect Slack`, the OAuth start href, and Token profiles remain unavailable until Slack is linked.
- Behavior: Linked healthy users still see connected identity/scope context, Token profiles load, active profile count remains accurate, and no reconnect action is shown unless needed.
- Behavior: Reauth-required users still see `Reconnect Slack`, identity/scope context, and Token profile management with the existing warning.
- Behavior: Enterprise Grid/no-workspace state still uses organization context and does not render an empty workspace label.
- Behavior: Existing rows without new name columns populated render safely using Slack IDs.
- Behavior: Team/enterprise names, if persisted, are treated as display metadata only and cannot affect uniqueness, authorization, token-profile ownership, or forwarding.
- Behavior: OAuth linking/relinking still encrypts credentials, stores no plaintext tokens/refresh tokens/client secrets, and creates the website session cookie as before.
- Behavior: Homepage remains `force-dynamic`, session-scoped, and does not cache status/profile/activity across users.
- Behavior: UI remains task-first around Token profile management and does not add a marketing panel above the primary workflow.
- Behavior: No Slack messages, search contents, file contents, Slack/Prism tokens, authorization headers, token hashes, peppers, client secrets, or raw credential data appear in rendered HTML, docs, logs, tests, screenshots, or audit/status metadata.

## Test plan

- Existing tests to keep green:
  - `app/slack-status-panel.test.tsx`
  - `app/website-overview.test.ts`
  - `app/ui.test.tsx`
  - `app/token-profiles-panel.test.tsx`
  - `app/token-profile-workspace.test.ts`
  - `app/v1/slack/oauth/start/route.test.ts`
  - `app/v1/slack/oauth/callback/route.test.ts`
  - `src/server/slack/oauth-flow.test.ts`
  - `src/server/slack/oauth-client.test.ts`
  - `src/server/slack/refresh.test.ts`
  - `src/server/slack/forwarding-credentials.test.ts`
  - `src/server/token-profiles/*` tests that protect reauth/profile behavior
  - Full `npm test` and `npm run build` before final review.
- New tests to add before/with implementation:
  - `app/slack-status-panel.test.tsx`: update linked/reauth assertions for quieter copy, name-plus-ID rendering, fallback-to-ID rendering, Enterprise Grid organization name rendering, and no-secret regex assertions.
  - `app/website-overview.test.ts`: cover friendly workspace/organization labels when names are present and raw-ID fallback when names are absent.
  - `src/server/slack/oauth-client.test.ts`: assert `team.name` and `enterprise.name` normalization remains available and sanitized.
  - `src/server/slack/oauth-flow.test.ts`: if persistence changes, assert `upsertSlackConnection` receives team/enterprise names and still never persists token canaries.
  - `src/server/slack/postgres-store.test.ts` or a focused store test: assert `getSlackLinkStatus` returns nullable names and remains backward compatible with null names.
  - Migration/schema test if the repo has migration guards; otherwise manually inspect/run migrations in local DB QA.
  - If user display-name enrichment is added via extra Slack API call, add tests for call timing, scope/failure fallback, stored safe field only, and no full profile/token/authorization leakage.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - Start the app with the existing `npm run dev` script and capture browser/accessibility evidence at desktop and mobile widths.
  - Verify a not-linked homepage and a linked/mock-OAuth homepage if local DB/mock OAuth is available. The linked proof should show connection details near the hosted-service/status area, Token profiles as the primary task area, friendly workspace/org names when present, and ID fallback when names are absent.
  - Inspect browser console for hydration/runtime errors and inspect rendered page/source/screenshot for secret-like leakage.

## Risk assessment

- Risk: Moving Slack status up could make Token profiles feel secondary. Mitigation: keep Token profiles as the primary workspace below/alongside the hosted-service status and make Slack status compact/supporting.
- Risk: Copy could understate custody boundaries while becoming quieter. Mitigation: preserve one short explicit custody sentence and no-secret tests.
- Risk: Adding name columns could break existing OAuth store implementations/tests. Mitigation: make fields nullable, update the `OAuthFlowStore` contract and memory test store together, and keep uniqueness based on Slack IDs.
- Risk: Existing linked sessions will not have names. Mitigation: fallback to IDs and repopulate names on reconnect/relink only; do not require a backfill.
- Risk: User display names require extra Slack-derived data and may include untrusted/profile content. Mitigation: defer by default or store only a safe, length-limited display field from an approved server-side call with strict tests.
- Risk: An extra Slack API call during OAuth could fail linking or slow it down. Mitigation: do not make optional enrichment failure fatal; prefer existing OAuth response fields first.
- Risk: Setup-required state is currently modeled but may not be reachable on homepage render. Mitigation: keep this conflict visible; do not conflate it with linked-state UX unless the implementer explicitly addresses query/status plumbing.
- Risk: Friendly names could be mistaken for authorization keys. Mitigation: use names only for display; all authorization/session/profile lookups continue to use IDs and existing server stores.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership boundaries are clear: homepage/status presentation belongs in `app/page.tsx`, `app/slack-status-panel.tsx`, and `app/website-overview.ts`; OAuth custody/status data belongs in `src/server/slack/oauth-*`, `postgres-store.ts`, and migrations.
  - The current code already parses Slack team/enterprise names, so a minimal friendly workspace/org improvement can be integrated without a new Slack API path.
  - The safety boundary is well covered by existing tests and docs: server-held encrypted Slack credentials, opaque developer tokens, metadata-only UI, no secret-like rendering.
  - The requested layout/copy change aligns strongly with `PRODUCT.md` and `DESIGN.md`.
- Open questions:
  - Should this slice include a nullable Postgres migration for team/enterprise names now, or make a copy/layout-only pass first and leave friendly names to a follow-up? Recommendation: include team/enterprise name persistence now because the data is already parsed and the migration is small/backward-compatible.
  - Should human Slack user display names be pursued now? Recommendation: defer unless explicitly approved, because current OAuth data only provides the user ID and safe user-name display likely requires an extra server-side Slack API call and stricter privacy tests.
  - Should the existing `setup_required` reachability gap be fixed in this slice? Recommendation: flag it but defer unless tests around status query parameters are already being touched; it is adjacent but not required for linked-state UX.
