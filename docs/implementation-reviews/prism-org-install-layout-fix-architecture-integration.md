# Prism organization-install and homepage-layout regression integration

**Status:** Architecture Scout integration brief
**Date:** 2026-08-28
**Scope:** Prism only (`C:\Development\slack apps\prism`)
**Issue/slice:** `prism-org-install-layout-fix`
**Implementation constraint:** This review is read-only with respect to product code. It describes the safe integration path; it does not implement it.

## Executive decision

The two reported symptoms have different causes and should be fixed together as a narrow regression slice:

1. The homepage hero uses an unbounded intrinsic-width Slack status column. The new organization/workspace explanation and grant list can consume the available width, while the introductory column is explicitly allowed to shrink to zero. The hero needs a bounded responsive second column and explicit `min-width: 0` behavior.
2. The live local database does **not** contain an organization Slack installation. It contains one workspace installation for `2136b Dev`, with Enterprise Grid metadata attached. Prism is accurately displaying the persisted installation shape. Slack organization membership/approval and Slack's OAuth installation scope are not the same thing.

There is also a latent connection-selection defect that must be corrected before retrying the organization upgrade: website sessions bind only to a Prism user, while status, admin, OIDC, token-profile ownership, and removal queries choose whichever Slack connection has the newest mutable `updated_at`. A successful organization reauthorization can coexist with the old workspace connection and later appear to “revert” when refresh or display-name enrichment touches the old row.

The safe solution is:

- keep Slack's `oauth.v2.access` response authoritative (`is_enterprise_install=true`, `team=null`, and a valid enterprise ID means organization; a team ID means workspace);
- bind every new website session to the exact Slack connection created or refreshed by that OAuth callback;
- reuse the existing safe `auth.teams.list` paginator to synchronize organization workspace grants immediately after a successful organization OAuth result, without making the normal homepage render call Slack;
- show the exact returned installation result and effective grants in Prism;
- bound the homepage Slack status column so it cannot collapse the product introduction.

Do **not** infer organization scope merely because an OAuth response contains an `enterprise` object. Slack workspace installs inside Enterprise Grid legitimately contain both `team` and `enterprise`.

## Evidence inspected

### Live local database, safe metadata only

A read-only query against the running local PostgreSQL instance returned:

- exactly one `slack_connections` row;
- `installation_scope = 'workspace'`;
- `is_enterprise_install = false`;
- team `2136b Dev` (`T09MEU6PRQB`);
- enterprise name `2136a` (`E06GM8RK8JH`);
- one active grant for `2136b Dev`, sourced from `legacy_backfill`;
- no organization connection row and no grant for the second workspace.

This shape satisfies the database workspace constraint in `db/migrations/0021_slack_organization_workspace_grants.sql:39-44`. If Slack had returned a valid organization OAuth result, Prism would have inserted or updated a separate organization connection through the organization partial unique index path at `src/server/slack/postgres-store.ts:148-185`. The current database therefore proves that no organization installation was persisted; it is not just the new UI mislabelling an organization record.

### Slack contract

Slack's current Enterprise Grid documentation confirms:

- organization OAuth returns `team: null`, an enterprise object, and `is_enterprise_install: true`;
- apps can still be installed to an individual workspace inside an Enterprise organization, in which case both team and enterprise metadata can be present;
- organization approval does not itself add the app to every workspace;
- `auth.teams.list` is the authoritative list of workspaces to which an organization installation has access.

Primary references:

- <https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/>
- <https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth/>
- <https://docs.slack.dev/reference/methods/auth.teams.list/>

## Current ownership and interaction model

### OAuth start and callback

- `app/v1/slack/oauth/start/route.ts:13-42` resolves the active Prism Slack configuration, creates server-side state, and redirects to Slack.
- `src/server/slack/oauth-flow.ts:123-146` owns state persistence and constructs the Slack authorize URL. It sends client ID, exact redirect URI, state, bot scopes, and user scopes. It does not and should not invent an installation scope after Slack responds.
- `app/v1/slack/oauth/callback/route.ts:19-89` owns the callback boundary, error-safe redirect, transaction cookie cleanup, and website session cookie.
- `src/server/slack/oauth-client.ts:120-165` normalizes the `oauth.v2.access` response. Lines 125-155 correctly distinguish organization from workspace based on `is_enterprise_install`, team presence, and enterprise presence.
- `src/server/slack/oauth-client.test.ts:101-157` explicitly protects both valid shapes. Its workspace fixture includes an enterprise object and still expects `installationScope: "workspace"`; this is correct and must remain.
- `src/server/slack/oauth-flow.ts:237-334` validates the normalized result, upserts the Prism user and Slack connection, stores encrypted credentials, and creates the website session.

### Installation and grant persistence

- `db/migrations/0021_slack_organization_workspace_grants.sql:26-52` separates workspace and organization connections with explicit constraints and partial unique indexes.
- `db/migrations/0021_slack_organization_workspace_grants.sql:54-74` owns explicit active/revoked workspace grants.
- `src/server/slack/postgres-store.ts:148-185` persists workspace and organization installations in separate conflict namespaces.
- `src/server/slack/oauth-flow.ts:289-297` creates an OAuth-source grant only when Slack returned a team. A valid organization result has `team=null`, so it begins with no grants unless a subsequent directory sync runs.
- `src/server/playtest-directory/directory.ts:55-84` synchronizes organization grants only when the Playtest directory endpoint is invoked. `auth.teams.list` pagination and safe failure behavior live at lines 134-170.
- `src/server/playtest-directory/postgres-store.ts:31-55` atomically activates the complete discovered set and revokes absent grants only after a complete successful enumeration.

### Website-session connection selection

`prism_sessions` currently contains only `session_token_hash`, `prism_user_id`, expiry, and creation time (`db/migrations/0001_slack_oauth_custody.sql:11-15`). `createWebsiteSession` likewise stores only those values (`src/server/slack/postgres-store.ts:206-210`).

Consequently, multiple independent “current connection” reads select by mutable recency:

- homepage Slack status: `src/server/slack/postgres-store.ts:367-371`;
- admin authorization identity: `src/server/admin/postgres-store.ts:38-43`;
- OIDC/Playtest login identity: `src/server/oidc/postgres-store.ts:241-257`;
- token-profile owner/first-party Playtest token connection: `src/server/token-profiles/store.ts:21-36`;
- “remove current Slack connection”: `src/server/slack/connection-management.ts:42-50`.

This is not a stable selection rule. Display-name enrichment updates `slack_connections.updated_at` at `src/server/slack/postgres-store.ts:395-409` and `427-438`; credential refresh also marks a connection healthy and updates its timestamp. An older workspace connection can therefore become “current” after a newer organization connection was authorized.

Delegated delivery is different and should retain its existing exact-target resolver. `src/server/delegated-delivery/postgres-store.ts:588-620` deliberately finds a healthy connection for the approved subject and exact target workspace, preferring an exact workspace install before a granted organization install. That is part of the approved delivery architecture, not the website-current-connection bug.

### Homepage layout

- `app/page.tsx:88-105` creates the hero.
- At `app/page.tsx:89`, the desktop columns are `minmax(0,1fr)` plus `auto`.
- The left introduction at `app/page.tsx:90-102` has a maximum width but no minimum width.
- The right compact status at `app/slack-status-panel.tsx:101-111` has no bounded width.
- Organization/workspace explanation, badges, grant rows, and recovery guidance now live in `app/slack-access-details.tsx:14-68`.

CSS Grid gives the `auto` track its intrinsic content width and allows the `minmax(0,1fr)` track to shrink to zero. The new status content therefore explains the observed “crushed” left introduction. The grant list's vertical bound at `app/slack-access-details.tsx:52` does not bound horizontal size.

## Exact likely causes

### Crushed homepage introduction — high confidence

The direct cause is `lg:grid-cols-[minmax(0,1fr)_auto]` combined with an unbounded, content-rich compact status panel. The right column can claim too much horizontal space, and the left column is allowed to collapse fully. This is a deterministic layout issue, not missing CSS or a data problem.

### Organization selection still displayed as workspace — confirmed persisted state, two contributing gaps

1. **Confirmed persisted result, unresolved failed callback stage:** the live database has only the original workspace connection. Two newer OAuth states were consumed, but neither attempt created a new Prism session or Slack connection, so the organization attempts failed somewhere after state consumption and before durable completion. The old row does not prove that Slack returned a workspace-scoped result. Prism currently collapses provider exchange, normalized validation, runtime resolution, and transaction failures into the same generic error, which prevents safe diagnosis. Enterprise membership metadata on the old workspace row still cannot be used to promote it to an organization connection.
2. **Insufficient completion feedback:** every successful callback redirects with only `?slack=linked` (`src/server/slack/oauth-flow.ts:344-350` and `411-424`). The homepage does not explain what Slack just returned or whether an attempted organization upgrade actually succeeded.
3. **Latent selection instability:** if a future callback does create a separate organization connection, the session is still not bound to it. Any later update to the old workspace row can make all `updated_at desc limit 1` readers show and use the old connection again.
4. **Deferred grant discovery:** even a correctly persisted organization connection will have no workspaces on the Prism homepage until the Playtest directory endpoint causes `auth.teams.list` synchronization. That conflicts with the user's expectation that Prism immediately confirms the workspaces selected in Slack.

## Extension points and integration plan

### 1. Repair the responsive hero without redesigning it

- Replace the intrinsic `auto` Slack column with a bounded track, for example a left `minmax(0,1fr)` and right `minmax(20rem,28rem)` at a breakpoint where both fit.
- Add `min-w-0` to both grid children and `w-full min-w-0` to the compact Slack status section.
- Keep the status stacked below the introduction below that breakpoint.
- Preserve all current Slack installation/grant information and actions; this is a containment fix, not a rollback of clarity.

### 2. Bind website sessions to the exact Slack connection

Add migration `0022` (or the next available additive migration) that:

- adds `slack_connection_id` to `prism_sessions`;
- backfills each existing session deterministically from its user's latest connection only as a compatibility bridge;
- adds a database invariant that `(slack_connection_id, prism_user_id)` references the same connection owner (a composite unique key on `slack_connections(id, prism_user_id)` plus composite foreign key is preferable);
- uses `ON DELETE CASCADE` so removing the session's connection invalidates that website session rather than silently falling back to another connection;
- makes the column non-null after a complete backfill.

Then pass `connection.id` from `src/server/slack/oauth-flow.ts` into `createWebsiteSession`. Update website/admin/OIDC/token-profile/removal queries to join the exact session connection. Do not replace the current rule with “prefer organization”: that would make an intentional later workspace authorization impossible to select.

Existing developer tokens and delegated grants remain bound to their recorded connection IDs and are not rewritten. Existing historical connections must not be deleted merely because the user upgrades.

### 3. Make organization grant discovery reusable and immediate

- Extract the complete, strict `auth.teams.list` paginator from `src/server/playtest-directory/directory.ts:134-170` into a Slack-owned organization workspace discovery module.
- Reuse it from both the Playtest directory service and the OAuth completion path.
- After Slack returns a valid organization installation, enumerate grants using the newly returned user credential before discarding the in-memory OAuth result.
- Persist the full grant set atomically only after complete successful pagination. Reuse the existing replace semantics in `src/server/playtest-directory/postgres-store.ts:31-55` rather than implementing a second revocation algorithm.
- If discovery fails, keep the organization connection and any previous grants; do not fail OAuth and do not revoke unseen workspaces. Show “organization connected; workspace discovery unavailable” or zero grants as applicable.
- Do not call Slack on ordinary homepage/admin renders. Those screens must remain local-database reads.

This synchronization handles what Slack actually granted. It must never convert a workspace OAuth token into an organization token.

### 4. Report the returned installation result, not assumed intent

- Carry safe result metadata (`workspace` or `organization`, connection ID internally, grant-sync status/count) from OAuth completion to a one-time status presentation without putting credentials or raw provider responses in URLs/logs.
- If an “organization connection” action/intent is introduced, store that intent inside the existing server-side hashed OAuth state. If Slack returns a workspace result, complete safely but show an explicit mismatch: “Slack returned workspace-only authorization for 2136b Dev; Prism was not installed at organization level.” Do not relabel or reject a valid workspace credential based solely on intent.
- Preserve the generic `Change Slack authorization` path, but update its guidance to distinguish selecting the Enterprise organization from merely selecting workspaces to which an already-approved app should be added.
- For a successful organization install with no grants, offer the Slack organization app-management workspace-add link only when it can be constructed from trusted stored enterprise/app IDs. Keep it an operator navigation aid, not an authorization bypass.

### 5. Keep status/admin grant display local and exact

The current uncommitted scope-clarity work is structurally correct:

- `src/server/slack/postgres-store.ts:354-388` reads active grants for homepage status;
- `src/server/admin/postgres-store.ts:22-47` reads active grants for admin presentation;
- `app/slack-access-details.tsx:18-68` distinguishes workspace-only and organization access.

Retain those fields, but make both stores join `s.slack_connection_id` after the session migration. The grant list must remain the effective active rows for that exact connection.

## Systems and invariants not to bypass

- OAuth state hashing, one-time state consumption, exact redirect binding, callback cookie clearing, no-store headers, and generic error behavior.
- Slack's authoritative `is_enterprise_install`/team/enterprise response semantics. Never infer organization scope from enterprise membership alone.
- Encrypted bot/user credential custody, AAD binding, refresh rotation, and advisory locks.
- Stable Prism user/OIDC subject. A workspace-to-organization upgrade must not mint a different identity or rewrite historical ownership.
- Explicit workspace grants and complete-pagination-before-revocation. Organization approval is not blanket workspace access.
- First-party Playtest token connection binding and narrow `playtest.slack.directory.read` capability.
- Exact target/team/channel binding and deterministic connection choice in delegated delivery.
- Existing token profiles, audit history, delegated grants, and old workspace connections. Do not delete or silently migrate them.
- No raw OAuth response, access token, refresh token, authorization code, or workspace/channel data beyond safe names/IDs in logs or UI.
- No external Slack call on normal homepage/admin rendering.
- No manual grant-policy UI in this regression slice.

## Regression checklist

### Layout

- Homepage introduction remains readable at 1024, 1280, 1440, and 1920 CSS pixels.
- Status stacks below the introduction before the two-column layout has enough room.
- Zero, one, two, and at least 50 granted workspaces do not widen or overflow the card.
- Long safe workspace/enterprise names and IDs wrap inside the status column.
- Slack actions remain reachable without horizontal page scrolling.
- Existing dark/light styling, focus states, and status badges remain intact.

### OAuth and persistence

- Workspace OAuth result with both team and enterprise remains a workspace install.
- Organization result requires `is_enterprise_install=true`, `team=null`, and a valid enterprise ID.
- A workspace-to-organization reauthorization preserves the Prism subject and creates/selects the organization connection.
- A later refresh/display-name update to the old workspace connection cannot change the current website session's selected connection.
- A later intentional workspace authorization creates a new session bound to that workspace connection.
- Session deletion/expiry and current-connection removal cannot fall through to another connection.
- No credential, code, state, or raw OAuth JSON appears in status metadata or logs.

### Organization grants

- A complete multi-page `auth.teams.list` response is persisted and immediately visible in Prism.
- Both `2136a` workspaces appear only if Slack returns both as granted.
- Partial failure, malformed rows, missing cursor metadata, repeated cursor, timeout, or rate limit never revoke prior grants.
- First-time discovery failure preserves a connected organization with an explicit unavailable/zero-grant state.
- Revoked grants remain retained for audit and are excluded from effective display and delivery.
- Playtest directory refresh and OAuth-time discovery use the same parser and replacement policy.

### Downstream identity/connection consumers

- Homepage, admin, OIDC, token-profile creation/listing, first-party Playtest token issuance, and user connection removal all resolve the session-bound connection.
- Existing developer tokens remain bound to their original connection until explicitly rotated/reissued.
- Delegated delivery still chooses only an eligible exact-target connection and active organization grant; it does not blindly use the website session connection.
- Playtest logout/login after organization reauthorization binds a new Playtest first-party token to the organization connection.

## Test plan

### Unit/store tests

- Extend `src/server/slack/oauth-flow.test.ts` with a complete organization callback test. Assert organization connection fields, exact session connection ID, encrypted credential persistence, and zero/full grant behavior without secret leakage.
- Retain and expand `src/server/slack/oauth-client.test.ts:101-176` for workspace-with-enterprise, valid organization, and contradictory response shapes.
- Add migration text/real-Postgres tests for session connection backfill, composite ownership FK, non-null enforcement, and connection-delete session invalidation.
- For each session-scoped store, seed two connections whose `updated_at` ordering changes and assert the bound connection remains selected.
- Move the existing pagination/failure cases in `src/server/playtest-directory/directory.test.ts:7-54` and `142-184` onto the extracted shared discovery module, then retain service-level integration coverage.
- Add OAuth-time grant sync tests for complete two-page success, provider failure with existing grants, and first-time provider failure.
- Keep status/admin safe-display tests for workspace, organization, zero grants, multiple grants, malformed IDs, duplicate IDs, and credential-shaped display names.

### Component and browser tests

- Static rendering should assert the exact workspace-vs-organization explanation and mismatch notice.
- Add Playwright or equivalent computed-layout tests for the hero at representative widths. Assert the intro and status bounding boxes are both non-zero, neither overlaps, and `document.documentElement.scrollWidth === clientWidth`.
- Exercise grant-list overflow with 50 realistic workspace rows and keyboard scrolling.

### Live QA

1. Record the safe pre-test connection rows (scope/IDs/status only).
2. From Prism, begin an organization-intent reauthorization.
3. In Slack, confirm the top-right install target is the Enterprise organization, not `2136b Dev`.
4. Complete OAuth and verify Prism explicitly reports the returned organization installation.
5. Verify the database contains a separate organization connection with `team_id=null` and `is_enterprise_install=true`.
6. Verify both expected workspaces appear only after `auth.teams.list` confirms them.
7. Refresh/use the old workspace token, then reload Prism; the page must remain on the organization connection selected by the current session.
8. Sign out/in to Playtest and verify its workspace picker shows both granted workspaces.
9. Revoke one workspace in Slack, refresh directory state, and verify it disappears and cannot send.
10. Capture homepage screenshots at 1024 and 1440 pixels to prove the introduction no longer collapses.

## Risks and mitigations

### Session migration chooses an imperfect legacy connection — medium

Old sessions do not contain enough history to prove which connection created them. A deterministic latest-row backfill is only a compatibility bridge. Make the choice visible and require reauthorization when the operator needs to select a different installation. All new sessions are exact.

### Organization OAuth UX remains Slack-controlled — medium

Prism cannot force Slack to issue an organization token by relabelling a workspace response. Mitigate with explicit intent, returned-result feedback, and exact operator guidance. Treat the Slack response and live database shape as authoritative.

### External grant discovery increases callback latency — low/medium

Use a strict timeout and bounded pagination. OAuth success must survive discovery failure. Never hold a database transaction open across Slack network calls.

### Old and new connections coexist — intentional

Coexistence preserves existing token profiles, audits, and grants. Session binding prevents accidental selection drift. A later connection-management slice may offer explicit switching or retirement, but this regression must not delete history.

### Homepage grant lists can be large — low

Keep the count and bounded scroll region, constrain the entire status column, and test 50+ rows. Do not truncate the data contract or load Slack during render.

## Decision confidence

- **Crushed-layout cause:** high. The grid definition directly permits the observed collapse.
- **Current persisted Slack scope:** high. The live database contains one workspace connection and no organization connection.
- **OAuth parser correctness:** high. Code and tests match Slack's current primary documentation.
- **Session-selection instability:** high. Multiple production queries use mutable `updated_at` as authority, and ordinary refresh/enrichment mutates it.
- **Need for immediate organization grant sync:** high for the requested experience; current sync is only Playtest-directory-triggered.
- **Exact reason Slack returned a workspace result despite the operator's selections:** medium. Prism does not retain raw provider responses (correctly), and Slack controls the install screen. Live QA with explicit organization intent/result feedback is required to distinguish an operator-target selection issue from Slack organization app-management workflow behavior.

## Gate conclusion

Implementation may proceed as one focused regression slice: bound the layout, add exact session-to-connection binding, reuse the safe organization grant discovery during OAuth completion, and present the returned result explicitly. Do not broaden this into manual workspace grant policy, connection-history management, new Slack admin scopes, or a Playtest redesign.
