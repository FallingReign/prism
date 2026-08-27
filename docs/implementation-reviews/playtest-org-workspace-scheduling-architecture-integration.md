# Playtest organization/workspace scheduling architecture integration

**Status:** Architecture Scout integration brief  
**Date:** 2026-08-27  
**Repositories inspected:** `C:\Development\slack apps\prism` and `C:\Development\projects\shg-playtest`  
**Prism baseline:** `e8b57a7e6c91cf39dd0cb047d4b36c0cc7ee531c` (`codex/playtest-oidc-provider`)  
**Playtest baseline:** `fbca93581aff7c842c573a05bd2723adef342072` (`codex/playtest-manager-rebuild`)

## Executive decision

Prism and Playtest must remain independently startable, deployable, and versioned applications. Prism owns Slack installation custody, user credentials, effective workspace grants, delegated consent, and final Slack execution. Playtest owns playtest/session configuration, the exact selected Slack workspace/channel target, announcement content and schedule, and the durable scheduled job. Neither application should infer the target workspace from the workspace used to authenticate the person.

The existing delegated-delivery design is the correct security substrate for background scheduling: Playtest stores a narrow, encrypted, one-message grant; the worker exchanges/executes it through Prism with DPoP and without a browser session or a general Slack credential. The implementation should extend that path to support organization installations and explicit workspace/channel selection. It should not replace it with browser tokens, a shared owner token, or server-wide Slack credentials.

The central semantic correction is:

> `team_id` on an announcement/delegation is the immutable **target workspace ID**. It is not the Slack installation's team, the user's login team, or an organization approval.

For an organization installation, Slack can return `team: null`, an `enterprise` object, and `is_enterprise_install: true`. Organization approval does not itself grant every workspace. Prism must maintain explicit effective workspace grants for the installation, populated from `auth.teams.list` and later optionally kept current by `team_access_granted` / `team_access_revoked` events. Playtest must select one of those granted workspace IDs and then an immutable channel ID within it.

## Current ownership and deployment boundary

### Prism owns

- Slack application setup and OAuth custody.
- Encrypted bot/user credentials and refresh-token lifecycle.
- Prism users, Slack connections, OIDC sessions and stable Prism subjects.
- Token-profile policy and first-party Playtest credentials.
- Browser approval/denial of delegated delivery.
- PKCE, DPoP, replay prevention, rate limits, exact-message integrity, grant exchange, and final `chat.postMessage` execution.
- Auditable attribution to the actual Slack user/connection that approved and sent.

Evidence:

- `src/server/slack/oauth-client.ts:120-143` normalizes Slack OAuth.
- `src/server/slack/oauth-flow.ts:240-274` completes connection custody.
- `src/server/slack/forwarding-credentials.ts`, `refresh.ts`, and `web-api-client.ts` implement server-side credential use and refresh.
- `src/server/delegated-delivery/postgres-store.ts:571-593` selects an eligible user identity.
- `src/server/delegated-delivery/execution.ts:80-145` verifies the grant and invokes `chat.postMessage`.
- `db/migrations/0016_delegated_slack_delivery.sql` supplies hash-only codes/grants, encrypted payload custody, replay controls, rate limits, lifecycle state, and audit columns.

### Playtest owns

- Playtest templates, dated sessions, rosters, playlists, maps/requests, build references, and announcement formatting.
- The target Slack workspace/channel selected for each playtest or session.
- When to send, content revision, scheduling state, retry state, and operator-visible status.
- The durable announcement job and encrypted delegated grant obtained from Prism.
- Role authorization for Playtest managers/admins.

Evidence:

- `src/lib/db/index.ts:93-167` defines playtests and sessions.
- `src/lib/db/index.ts:293-375` defines announcement jobs and delegation transactions.
- `src/lib/announcements/delegation/service.ts` creates/revises local jobs, begins delegated consent, and stores returned grant material.
- `src/app/api/automation/announcements/route.ts` claims due jobs and executes delegated sends.
- `src/lib/announcements/payload.ts` and related announcement UI own the Block Kit content.

### Startup remains independent

- Playtest `npm start` runs `scripts/playtest-cli.mjs start` and starts Playtest only. Its Docker Compose deployment is a separate packaging path.
- Prism `npm start` runs `scripts/start-local.mjs`; it may start Prism's own PostgreSQL dependency, apply Prism migrations, and start Prism. Prism Docker Compose runs Prism and its database.
- Playtest must never start, configure, migrate, or health-manage Prism. Configuration between them is an external provider contract: issuer/base URL, client registration, and supported contract version.

## Current data and identity model

### Prism's current workspace-only assumption

`db/migrations/0001_slack_oauth_custody.sql` currently makes both `prism_users.slack_team_id` and `slack_connections.team_id` non-null and keys users/connections by team plus Slack user. `db/migrations/0016_delegated_slack_delivery.sql` likewise makes delegation request/grant `team_id` non-null and validates it as a Slack team identifier.

Keeping the delegation target non-null is correct. Keeping the **installation** team non-null is not correct for organization installs.

The OAuth parser currently rejects the Slack organization shape twice:

- `src/server/slack/oauth-client.ts:120-128` requires `body.team.id` and models `team` as mandatory.
- `src/server/slack/oauth-flow.ts:250-264` persists the normalized mandatory team.
- `is_enterprise_install` is not parsed or stored.

The OIDC store also assumes one selected workspace connection. `src/server/oidc/postgres-store.ts:241-261` resolves a website session by joining healthy Slack connections and taking the most recently updated one. OIDC identity claims currently include a string `slack_team_id` through `src/server/oidc/service.ts`. Playtest is already more permissive: `src/lib/auth/prism-oidc.ts:402-417` treats the Slack team claim as optional, and Playtest's `users.slack_team_id` is nullable.

### Stable identity requirement

For enterprise users, the desired canonical Slack identity is enterprise/global Slack user where Slack supplies a stable enterprise identity; for non-enterprise installs it remains workspace/user. Existing Prism subjects must not be silently changed. Existing production data may contain the same human as several Prism users across workspace installations. Before any canonicalization, run a production preflight grouped by `slack_enterprise_id, slack_user_id` and enumerate collisions and every foreign-key reference.

Recommended additive approach:

1. Preserve every existing `prism_users.id` and OIDC `sub`.
2. Add an explicit canonical identity namespace/key or alias table rather than rewriting subjects in place.
3. Backfill unambiguous identities.
4. If multiple existing Prism users map to one enterprise/user pair, keep them as aliases pending an explicit, audited merge policy. Do not silently choose the newest connection or re-parent audit history.
5. New organization installs resolve by enterprise/user identity, but compatibility aliases allow existing subjects to continue.

This identity migration is the least certain part of the design and requires a real production duplicate report before its exact DDL is approved.

## Slack's organization-install contract

Slack's documented organization OAuth result can contain `team: null`, an `enterprise` object, and `is_enterprise_install: true`. Approval at organization level does not install the app into every workspace; an admin subsequently grants selected workspaces. Some Web API methods require an explicit `team_id` with an organization token, and Slack recommends supplying it when workspace context matters.

Primary references:

- Slack enterprise organization behavior and OAuth response: <https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/>
- Bolt OAuth installation model (`team` undefined for enterprise install): <https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth/>
- Effective workspace enumeration: <https://docs.slack.dev/reference/methods/auth.teams.list/>
- Per-user channel enumeration and organization `team_id`: <https://docs.slack.dev/reference/methods/users.conversations/>
- Workspace grant/revoke events: <https://docs.slack.dev/reference/events/team_access_granted/> and <https://docs.slack.dev/reference/events/team_access_revoked/>

The Prism Slack manifest already has `org_deploy_enabled: true` and token rotation. The scope configuration in `src/server/slack/app-configuration.ts` already defaults to the complete supported bot/user scope catalog when not explicitly overridden. Events/Socket Mode are intentionally deferred, so the first compatible delivery should use cached `auth.teams.list` synchronization. Event-driven grant updates can be added later without changing Playtest's contract.

## Proposed Prism persistence extension

Use an additive migration (next migration after the current sequence; do not rewrite old migrations).

### Installation scope

Extend `slack_connections` with:

- `installation_scope`: `workspace | organization` (or an equivalent constrained text field).
- `is_enterprise_install boolean not null default false`.
- Nullable `team_id`/`team_name` only when `installation_scope = 'organization'`.
- Required `enterprise_id` when `installation_scope = 'organization'`.

Constraint:

- workspace connection: non-null team, `is_enterprise_install = false`;
- organization connection: null team, non-null enterprise, `is_enterprise_install = true`.

Replace the old uniqueness rule with partial unique indexes:

- workspace: app + team + authed Slack user;
- organization: app + enterprise + authed Slack user.

Do not use `coalesce(team_id, enterprise_id)` uniqueness: it obscures the namespace and makes migration/debugging unsafe.

### Effective workspace grants

Add `slack_connection_workspace_grants`:

- `id`
- `slack_connection_id` FK
- `team_id` (non-null immutable Slack ID)
- `team_name` (display snapshot only)
- `status`: `active | revoked`
- `source`: `legacy_backfill | oauth | auth_teams_list | event`
- `discovered_at`, `last_verified_at`, `revoked_at`, timestamps
- unique `(slack_connection_id, team_id)`
- index `(slack_connection_id, status, team_id)`

Backfill one active grant for every existing workspace connection. This makes the new eligibility logic compatible with all healthy production connections before organization support is enabled.

For an organization OAuth result, create the connection with zero assumed grants, then synchronize `auth.teams.list` using the connection's credential. Approval without returned teams is a valid connected-but-not-yet-granted state and must be represented in the UI rather than widened to all workspaces.

Synchronize all pages. Mark a prior grant revoked only after a complete successful enumeration (or an authoritative revoke event), never after a partial/failed page. Retain revoked rows for audit. Cache a successful sync for approximately five minutes; support a user/admin refresh action and a bounded stale-on-provider-error result.

## OAuth and installation parsing changes

Update Prism's Slack result model to accept these mutually exclusive shapes:

- workspace: `team.id` present, `is_enterprise_install` false/absent;
- organization: `team` absent/null, `enterprise.id` present, `is_enterprise_install` true.

Reject contradictory or identifier-less responses. Persist the raw semantic flags as normalized fields, not the entire provider response. Keep the existing state/CSRF transaction, code exchange, encrypted custody, refresh-token rotation, and setup-finalization boundaries.

Setup must report both organization approval and effective grants:

- “Connected to organization X” is installation status.
- “Available in workspaces A, B” is grant status.
- “Connected, but no workspaces have been granted” is not an OAuth failure.

The setup/admin pages must not demand a team ID for organization installations. Existing workspace setup and the current production connection path remain unchanged.

## Channel directory contract

Playtest needs a narrow Prism directory API rather than a broad Slack proxy or manually typed IDs. Recommended first-party endpoints:

```text
GET /v1/prism/playtest/slack/workspaces
GET /v1/prism/playtest/slack/workspaces/{teamId}/channels?cursor=...&limit=...
```

The endpoints authenticate the current `shg_playtest_app` first-party token, resolve the token's Prism subject/connection, and enforce a dedicated read capability. Do not bypass `src/server/token-profiles`, the capability map, the method registry, or global execution policy. The current first-party profile in `src/server/token-profiles/first-party-app.ts` is deliberately write-only and eight hours long. Introduce a narrowly named directory capability (or a versioned capability map) instead of enabling broad generic `conversations.*` forwarding.

Workspace response fields:

- `contract_version`
- `team_id`, `team_name`
- `grant_status`, `last_verified_at`
- optional installation label/type for operator explanation

Channel response fields:

- `contract_version`
- `team_id`
- immutable `channel_id`
- current `channel_name`
- minimal visibility metadata (`is_private`, if needed for display)
- `next_cursor`

Use the user's Slack credential and `users.conversations` with explicit `team_id`, member-visible public/private types, `exclude_archived=true`, and complete cursor pagination. Return only channels the authenticated user can actually target. Do not return tokens, topics, purposes, arbitrary raw provider objects, or messages.

Cache workspace grants for roughly five minutes and channels for one to five minutes with an ETag/version and stale-if-provider-error behavior. A normal schedule/dashboard render must read local Playtest target snapshots and must not call Slack. Call the directory only when a picker opens or the user refreshes it.

## Playtest workspace/channel data model

Add explicit target fields to playtests and sessions:

- `slack_workspace_id`
- `slack_workspace_name` (display snapshot)
- `slack_channel_id`
- `slack_channel_name` (display snapshot)

Retain existing `channel` columns during compatibility rollout. Backfill values that are already valid immutable channel IDs (`C…`, `G…`, or other explicitly accepted Slack channel identifier formats) into `slack_channel_id`; never treat a `#name` as an ID.

The effective target is an atomic pair:

1. use the session override only when both session workspace and channel ID are present;
2. otherwise use the playtest pair only when both are present;
3. otherwise the target is unconfigured.

Never independently `coalesce` workspace and channel fields; that can combine a session channel with a playtest workspace.

Names are mutable display snapshots. Authorization, scheduling, sending, deduplication, and audit always use IDs. Renaming a Slack channel updates a display snapshot but does not alter the target.

Legacy rows with a channel ID and no workspace can be resolved only by querying the current user's granted workspace/channel directory and finding exactly one matching workspace. Persist that result. If zero or multiple matches exist, require manager selection. Never fill the workspace from `auth.user.slackTeamId`.

The UI should select workspace first and channel second, expose inherited versus session override state, and clearly show “organization connected but this workspace is not granted.” Existing free-text fields can remain read-only legacy display until every active configuration is migrated.

## Delegated scheduling correction

The current Playtest implementation wrongly binds the send target to the login identity:

- `src/lib/announcements/delegation/service.ts:278-305` requires `expectedTeamId` from the current OIDC actor.
- `src/lib/announcements/delegation/service.ts:245-254` considers authority current only when the actor row's `slack_team_id` matches that team.
- `src/app/api/announcements/delegation/callback/route.ts:121-127` requires `auth.user.slackTeamId` and passes it back into grant exchange.

Change the boundary as follows:

1. Resolve the canonical workspace/channel pair from the session/playtest configuration.
2. Snapshot both IDs into the announcement job and delegation transaction.
3. Send that target workspace as the existing delegation `team_id` and target channel as `channel_id`.
4. Use the authenticated actor only for subject, Playtest role, session freshness, and approval attribution—not target derivation.
5. In the callback, compare the approved grant's team/channel/content hash with the stored job target and transaction, not with the login team claim.
6. Any workspace, channel, content, schedule, or sender change creates a new revision and requires a new exact-message approval.

Prism's `resolveEligibleIdentity` currently requires `c.team_id = request.team_id` (`src/server/delegated-delivery/postgres-store.ts:571-593`). Extend it so an eligible connection is either:

- a healthy workspace connection whose team exactly equals the target; or
- a healthy organization connection with an active `slack_connection_workspace_grants` row for the exact target.

Both must belong to the expected Prism subject, have a healthy user credential, and contain `chat:write`. Deterministic precedence should prefer an exact workspace connection, then an organization connection; use a stable tie-breaker and audit the chosen connection. Never fall back to a bot/shared owner credential.

At final Slack execution, preserve the canonical `channel` in the Block Kit request and add `client_context_team_id = grant.team_id` where supported. That context is execution metadata and must not be inserted into the Block Kit preview payload. Keep team/channel/content hashes in the immutable grant and final audit.

The existing v1 delegation request already requires an exact target `team_id`; its wire shape can remain backward compatible if Prism changes only eligibility semantics. Prism should deploy that compatibility first. A future v2 should be used only if response fields or security semantics need to change, and both apps should negotiate an explicit supported contract version rather than release in lockstep.

## Background scheduling invariants

`src/app/api/automation/announcements/route.ts` already executes delegated jobs without a browser token. It decrypts the narrow grant, uses the server's DPoP key, verifies returned metadata, updates idempotent job state, and records audit. Preserve this architecture.

Required behavior:

- The browser is required for consent/approval, not for the later scheduled execution.
- Playtest never stores a general Prism bearer, Slack access token, or refresh token for the scheduler.
- Prism grants stay one-message, subject-bound, team/channel-bound, content-hash-bound, expiry-bound, and revision-bound.
- Browser logout after approval does not cancel an otherwise valid grant.
- Connection/user revocation or grant revocation causes a safe terminal/reapproval state.
- Ambiguous transport failure remains `outcome_unknown`; do not blindly retry a message that may have reached Slack.
- Existing idempotency keys, job claims, stale-claim recovery, maximum attempts, and audit semantics remain intact.

The legacy `owner_token` path is compatibility-only and must not become a fallback for organization installations. Remove it only after existing deployments/jobs have been inventoried and migrated; until then, keep it visibly separate and never select it implicitly.

## Invariants and systems not to bypass

### Prism

- Encrypted credential/token custody with existing AAD and rotation behavior.
- OAuth state/CSRF, setup verification, PKCE where present, and exact callback allowlists.
- Stable Prism subject and OIDC issuer/audience/nonce validation.
- Token-profile capability policy, method registry, and global execution policy.
- Credential refresh/advisory-lock behavior and token-only recovery.
- Delegation exact JSON validation, encrypted payload, content hash, hash-only one-time artifacts, PKCE, DPoP, replay cache, request/grant expiry, rate limits, and lifecycle audit.
- User credential plus `chat:write` for user-attributed delivery; no bot/shared fallback.
- No secrets, raw payloads, codes, grants, or provider responses in logs.

### Playtest

- Server-derived authenticated actor and manager/admin authorization.
- Same-origin/CSRF checks for mutations.
- SQLite transactions pairing mutations with audit records.
- Announcement revisioning, idempotency, claim/retry policy, and `outcome_unknown` handling.
- Current Slack preview contract: the Block Kit Builder URL receives the full blocks JSON but not API envelope fields such as `channel` or top-level `text`; preview remains available for finished sessions.
- Existing image URL behavior and current direct send behavior, which are confirmed working and must be regression-tested.
- GetBuild/Destro remain separate providers and are unrelated to Slack workspace selection.

## Independently deployable contract and compatibility

Prism must be deployable first and remain compatible with current Playtest:

1. Add schema and backfill workspace grants with organization support disabled by default.
2. Make workspace-install OAuth, OIDC claims, token profiles, and v1 delegated sends behave exactly as before.
3. Add grant sync/directory and organization-aware delegated eligibility behind Prism feature flags.
4. Advertise a small capability document or response `contract_version` so Playtest can detect directory/org support.
5. Only then deploy Playtest schema/UI changes. Older Playtest continues sending v1 exact workspace targets; newer Playtest uses explicit selected targets.

Retain old columns and accept old healthy workspace connections throughout the first rollout. Do not drop uniqueness constraints or non-null columns until the replacement indexes/constraints and backfill are transactionally installed. Rollback disables flags and returns UI to legacy target display; it must not require database rollback or loss of grants/jobs.

## Current performance risks

There is no performance harness or recorded baseline in either repository.

The largest current Playtest costs are application-level waterfalls and overfetching, not the week session join itself:

- `src/hooks/useDashboardData.ts:100-108` starts three dashboard reads in parallel, but announcement jobs are fetched only after sessions return, producing a second HTTP waterfall.
- `GET /api/requests` returns broad request/history data with joins and no pagination/default active-board scope.
- `src/lib/db/index.ts` has no request indexes aligned to status/session/priority board reads.
- Common save, send, cancel, and drag/drop handlers frequently call the full dashboard `refetch()`, re-reading playtests, sessions, requests, and jobs instead of patching one affected entity and revalidating in the background.
- A naive Prism directory integration would add Slack latency to every render. The directory must be cached and picker-triggered only.

Recommended first performance slice:

- Add one backward-compatible dashboard aggregate endpoint, for example `GET /api/dashboard/week?from=&to=`, returning active playtests, week sessions, only board-relevant requests, and current announcement jobs from a consistent server-side read. Keep existing endpoints during rollout.
- Add request indexes such as `(status, session_id, priority, created_at)` and a targeted `(session_id, status)` if query plans prove it useful.
- Make active-board filtering the default and paginate/history-load older requests on demand.
- After a local mutation, patch the affected session/request/job optimistically and run a background revalidation; do not reload the document or refetch the whole board synchronously.
- Cache Prism workspace/channel directory responses locally and never block the schedule view on Slack.

## Performance baseline and acceptance plan

Add a dependency-free Node performance runner so it works in both repositories and CI. It should perform warmup, configurable concurrency, fixed-duration or fixed-count runs, and report p50/p95/p99, error rate, and response bytes. Always label development-server and production-build results separately.

Representative Playtest fixture:

- 10 active playtests;
- 30 sessions in the selected week, including multiple sessions per day;
- 2,000 historical requests and at least 100 active requests;
- 100 announcement jobs with mixed terminal/pending states;
- realistic maps, playlists, build references, and audits.

Initial local production-build budgets (to be confirmed against the first measured baseline):

- warm dashboard aggregate API p95 <= 250 ms, error rate 0%, payload <= 500 KB;
- useful schedule content <= 1 second on a warm local production server;
- common local mutations p95 <= 250 ms excluding external providers, with no full-page reload;
- cached Prism workspace directory p95 <= 100 ms;
- cached Prism channel directory p95 <= 200 ms;
- cold Slack-backed directory call measured separately, target <= 2 seconds, hard provider timeout <= 15 seconds;
- internal delegation create/exchange p95 <= 250 ms excluding browser interaction;
- Prism execution overhead <= 100 ms excluding Slack network time;
- 100 dashboard requests at concurrency 10 with zero errors;
- 20 simultaneously due stubbed scheduled jobs produce no duplicate sends or stuck claims.

Record CPU, memory, SQLite/Postgres query counts where practical, response size, external-provider time, and internal time. Compare before/after using the same seeded database and production build.

## Regression and security test checklist

### Prism schema/OAuth

- Existing workspace install migrates and retains the same Prism subject, scopes, encrypted credential, and send behavior.
- Organization OAuth accepts `team:null` only with enterprise ID plus `is_enterprise_install=true`.
- Contradictory shapes, missing identifiers, and false organization flags are rejected.
- Backfill creates exactly one active grant per existing workspace connection and is idempotent.
- Partial unique indexes reject duplicate installation identity without conflating team and enterprise namespaces.
- Production duplicate-user preflight is reviewed before canonical aliases are enabled.

### Workspace grants/directory

- `auth.teams.list` pagination is complete and a failed/partial refresh never revokes unseen grants.
- No organization grant exists merely because OAuth succeeded.
- Grant/revoke, cached refresh, explicit refresh, stale-on-error, and future grant/revoke events converge correctly.
- Directory endpoints reject wrong token profile/subject/capability and never return credentials.
- Channel listing supplies exact `team_id`, paginates, excludes archived channels, and exposes only user-visible/member channels.
- Two workspaces with same channel name remain distinct by IDs.
- Shared/enterprise channel behavior is tested with explicit workspace context.

### Delegation and scheduling

- Target workspace comes from the configured session/playtest target even when login claim contains a different/no team.
- Workspace connection can approve its exact workspace; organization connection can approve only active granted workspaces.
- Revoked/ungranted workspace cannot approve or execute.
- Exact workspace connection precedence over organization connection is deterministic and audited.
- Grant stays subject/team/channel/content/revision/expiry bound.
- Workspace/channel/content/schedule/sender edits invalidate prior approval.
- Callback compares stored job target, not OIDC team.
- Final send includes target workspace context where supported and still sends valid Slack blocks.
- Logout after approval does not break a scheduled grant; user/connection/relevant workspace revocation does.
- Browser session/token is not consulted by the worker.
- DPoP key mismatch, proof replay, code reuse, exchange replay, payload tampering, grant expiry, and concurrent exchange remain rejected.
- A provider timeout after dispatch yields `outcome_unknown` and no automatic duplicate.
- Scheduler claim/reclaim, idempotency, retryable/terminal mapping, and audit remain correct under concurrency.

### Playtest UI/data

- Workspace/channel picker stores an atomic ID pair and refreshes names without changing IDs.
- Session override inherits/overrides the whole pair, never half of it.
- Legacy channel ID resolves only when unique; ambiguous/no match asks the manager.
- Request drag/drop remains asynchronous without horizontal escape, shadow duplication, or full-page refresh.
- Schedule density/inline editing and existing manager/admin permissions remain intact.
- Block Kit Builder preview gets the entire `blocks` array JSON and excludes send-envelope `channel`/`text`.
- Preview works after a session finishes.
- External image URLs, current successful send, direct send, scheduled send, cancel, reannounce, and audit all regress cleanly.
- Playtest login/admin identity is unaffected by organization install team nullability.

## Rollout order

1. Preserve the current known-good Playtest commit and establish before-change functional/performance baselines.
2. Run the Prism production identity-collision and connection-shape preflight; decide alias handling before DDL that affects identity.
3. Add Prism installation/grant schema, constraints, idempotent backfill, and workspace-regression tests. Deploy with org feature disabled.
4. Add OAuth organization parsing plus `auth.teams.list` synchronization and admin observability. Test connected/no-grant/granted/revoked states.
5. Add the narrow versioned Playtest workspace/channel directory capability and caching. Deploy Prism first.
6. Extend Prism delegated eligibility to active grants and add target workspace execution context while retaining v1 workspace behavior. Deploy and verify existing sends.
7. Add Playtest target columns, atomic resolver, directory client, and picker. Keep legacy fields and feature-flag writes.
8. Migrate resolvable legacy channel IDs; require operator selection for ambiguity. Do not infer from login.
9. Change Playtest delegation initiation/callback to use the stored effective target and preserve the existing scheduler/grant machinery.
10. Implement dashboard aggregation/indexes/local mutation updates and run the production-build performance suite.
11. Live QA in order: current workspace install; org install with no grant; grant one workspace; multiple workspaces; revoke; immediate send; schedule then browser logout; scheduled execution; channel rename; user credential revocation.
12. Enable organization support gradually. Retire legacy owner/shared paths only after historical jobs/configurations are inventoried and explicitly migrated.

## Observability required for rollout

Add structured, secret-free metrics/logs for:

- installation scope and normalized OAuth outcome;
- grant-sync success/failure, page count, active/revoked counts, cache age;
- directory cache hit/miss, Slack latency, returned count (not names/topics);
- delegated eligibility reason codes (`no_eligible_connection`, `workspace_not_granted`, `missing_user_chat_write`, `connection_unhealthy`);
- selected installation kind and target team ID in audit metadata;
- scheduler queue delay, claim age, Prism latency, Slack result class, and outcome-unknown count;
- dashboard endpoint latency, payload size, query count, and client revalidation count.

Never log OAuth codes, credentials, grants, DPoP private material, full Block Kit payloads, or message text.

## Confidence and open questions

### High confidence

- Prism/Playtest ownership boundary and independent deployment.
- Slack's `team:null` organization install semantics.
- Need to distinguish organization approval from effective workspace grants.
- Immutable workspace/channel IDs and prohibition on deriving target workspace from login identity.
- Reuse of current delegated grant/DPoP scheduler for background sends without browser tokens.
- Backward-compatible Prism-first rollout and local/cached channel directory.
- Current Playtest waterfall/overfetch performance risks.

### Medium confidence / must verify before implementation

- Exact canonical identity/alias migration after measuring real enterprise duplicates.
- Whether the production Slack app can add Events API delivery soon; polling is a complete first slice.
- Availability and exact user scopes on real organization credentials for every granted workspace.
- Tenant-specific `client_context_team_id` behavior for `chat.postMessage`; verify in live organization QA while preserving the immutable target either way.
- Whether private-channel discovery should be membership-only (recommended) or administratively broader; broader discovery has privacy and sendability consequences.
- Initial performance budgets, because no baseline currently exists.

### Implementation gate conclusion

The slice can proceed without redesigning the secure delivery substrate. The safe path is an additive Prism installation/grant model and directory contract, followed by explicit Playtest workspace/channel persistence and a narrow change to delegation target derivation. Do not implement organization support by making `team_id` optional everywhere, by treating enterprise approval as global workspace access, by using the login claim as the message target, or by giving the scheduler a browser/general Slack token.
