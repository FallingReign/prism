# Architecture Integration Brief: issue-10-metadata-audit

## Existing ownership

- Package/component/module/library:
  - **Slack-compatible method boundary:** `app/v1/slack/api/[method]/route.ts` owns `/v1/slack/api/{method}` request IDs, bearer extraction, policy invocation, execution identity resolution, and returning Slack-shaped denied/unsupported/auth/setup responses.
  - **Forwarding service:** `src/server/slack/forwarding.ts` owns post-policy request parsing, Local-tool `token` field stripping, no-op rate-limit seam, upstream client invocation, and `X-Prism-Upstream-Called` diagnostics for forwarded or pre-upstream parse/rate-limit failures.
  - **Method registry and policy gate:** `src/server/slack/method-registry.ts` classifies methods/categories; `src/server/token-profiles/method-policy.ts` owns token resolution handoff, workspace/surface/capability decisions, denied/unsupported/auth-failed Slack-shaped bodies, and allowed policy metadata.
  - **Execution identity:** `src/server/token-profiles/execution-identity.ts` owns `X-Prism-Execution-Mode` parsing and final user/bot selection after policy approval.
  - **Token profile/session website flows:** `src/server/token-profiles/service.ts`, `src/server/token-profiles/store.ts`, `app/v1/prism/token-profiles/route.ts`, `app/token-profiles-panel.tsx`, and `app/page.tsx` own website-session-backed profile creation/listing and copy-once Prism developer token display.
  - **OAuth/session/custody stores:** `src/server/slack/oauth-flow.ts`, `src/server/slack/postgres-store.ts`, and `app/v1/slack/oauth/*/route.ts` own Slack OAuth state/callbacks, Prism website sessions, Slack connection metadata, encrypted Slack credential envelopes, and link status display.
  - **Postgres substrate:** `db/migrations/0001_slack_oauth_custody.sql`, `db/migrations/0002_prism_developer_tokens.sql`, `scripts/run-migrations.mjs`, and `src/server/db.ts` own plain SQL migrations, `schema_migrations`, and the `Database`/transaction abstraction.
  - **Response diagnostics:** `src/server/slack/response-adapter.ts`, plus `/v1/prism/status` and `/v1/prism/capabilities` route helpers, own `Cache-Control: no-store`, `X-Prism-Request-ID`, `X-Prism-Policy-Decision`, `X-Prism-Execution-Mode`, and `X-Prism-Upstream-Called` response metadata.
- Current owner rationale:
  - `CONTEXT.md` defines Metadata-only audit as Prism hosted service behavior and the Prism website as the user-facing audit review surface, while Local tools get only Prism developer tokens.
  - Issue #9 placed the correct forwarding seam after registry/policy and execution identity; audit for Slack API activity must attach to that pipeline rather than create a parallel Slack proxy or policy path.
  - Existing stores already use explicit server-only service/store boundaries with injected `Database` for unit tests and plain SQL migrations.
- Source evidence:
  - `app/v1/slack/api/[method]/route.ts` lines 27-51 show the mandatory order: request ID -> `evaluateSlackMethodPolicy` -> denied return -> `resolveSlackExecutionIdentity` -> denied return -> `forwardSlackMethod`.
  - `src/server/slack/forwarding.ts` lines 33-49 show parse/rate-limit/upstream outcome points and current response construction.
  - `src/server/token-profiles/store.ts` lines 83-105 resolve developer tokens with safe token/profile/connection metadata and explicitly avoid selecting Slack credential envelopes.
  - `app/page.tsx` lines 18-22 and 46-47 show the current website pattern: read server-side session cookie, fetch linked status/profile summaries, pass compact props to panels.

## Existing interaction model

- User/system behaviors that already exist:
  - Slack OAuth start/callback stores only hashed state/session tokens and encrypted Slack credentials server-side, then redirects to the homepage with Slack link state.
  - The homepage displays Slack link status and, when linked, token profile creation/listing. Profile creation returns the Prism developer token once; listing never returns token plaintext/hash/pepper.
  - Local tools call `/v1/prism/status` and `/v1/prism/capabilities` with `Authorization: Bearer prism_dev_...` to inspect token validity, Slack health, execution identity availability, capability map, categories, methods, and unsupported surfaces.
  - Local tools call `/v1/slack/api/{method}` with the same Prism bearer token. Invalid/malformed auth, unsupported/deferred/admin methods, policy denials, invalid execution-mode overrides, malformed JSON, multipart/file-transfer deferral, rate-limited responses, and forwarded mock Slack calls are already represented as Slack-compatible responses.
  - Default upstream forwarding is mocked by `MockSlackWebApiClient`, returning Slack-shaped bodies for representative conversations, chat, reactions, search, and files metadata methods.
- Behaviors that must remain unchanged:
  - Local tools remain bearer-only and never receive or present Slack credentials.
  - Denied/unsupported/auth-failed/deferred paths remain pre-upstream and must not decrypt/select credential envelopes or call Slack.
  - Allowed forwarding continues through the existing route -> policy -> identity -> forwarding-service path, with successful and ordinary upstream error bodies unwrapped and Prism diagnostics in headers.
  - Website auth remains the existing `prism_session` HTTP-only cookie resolved through Postgres; do not add a parallel website auth/session layer.
  - Existing Slack status/profile panels remain compact setup surfaces; audit UI should be a compact recent-activity view, not a broad dashboard/admin console.
- Runtime or UX evidence:
  - Route tests assert no `access_token_envelope`, `refresh_token_envelope`, `xox[bp]-`, `client_secret`, Prism developer token, token hash, or pepper leakage for policy and forwarding paths.
  - Panel tests assert website status/profile HTML does not contain Slack credential material or Prism token internals.
  - `docs/slack/README.md` now matches code by saying representative forwarding is implemented with a default mocked upstream and admin/org/events/interactivity/file content remain deferred.
  - No docs/code conflict found for issue #10. The only gap is intentional: `CONTEXT.md` names Metadata-only audit as a first-class responsibility, but no audit table/store/API/UI exists yet.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a server-only audit service/store under `src/server/audit/` (for example `activity.ts` and `postgres-store.ts`) because audit spans Slack forwarding, OAuth, token profile management, and website display; do not bury cross-product audit ownership inside only `src/server/slack/`.
  - Add migration `db/migrations/0003_prism_activity_audit.sql` following existing numeric SQL migration conventions and `schema_migrations`.
  - Extend safe token/profile resolution metadata in `src/server/token-profiles/local-tool-status.ts` and `src/server/token-profiles/store.ts` as needed for audit identity (`prism_user_id`, `token_profile_name`, `slack_connection_id`, `team_id`, `enterprise_id`, `authed_user_id`) without selecting credential envelopes or token hashes.
  - Record pre-upstream Slack outcomes at `app/v1/slack/api/[method]/route.ts` where auth/policy/identity decisions are known; record post-policy forwarding attempts/outcomes inside `src/server/slack/forwarding.ts` where parse/rate-limit/upstream status and Slack error are known.
  - Record token profile create/list events in `src/server/token-profiles/service.ts` or immediately at `app/v1/prism/token-profiles/route.ts` after service results, using the same store/session owner resolution; creation should be transactionally coupled with profile/token persistence if possible.
  - Record OAuth start/callback metadata in `src/server/slack/oauth-flow.ts` or routes, but only after state/session safety is established and never with `code`, `state`, session token, Slack access/refresh token, or client secret values.
  - Add a compact website/API read surface at `app/v1/prism/activity/route.ts` and/or `app/activity-audit-panel.tsx`, with `app/page.tsx` reading recent activity for the current `prism_session` just like Slack status and token profiles.
- Relevant docs or library capabilities:
  - Next.js App Router route handlers and server components already provide the needed HTTP/API and website display primitives.
  - Postgres JSONB exists in current migrations, but audit should prefer typed columns over arbitrary payload JSON to make non-storage of payloads mechanically reviewable.
  - `Database.transaction` is available for coupling auditable mutations to audit writes.
- Existing examples in this codebase:
  - `createPostgresTokenProfileStore(database)` returns a typed service store plus `LocalToolTokenStore`, which is the pattern to mirror for `createPostgresActivityAuditStore(database)`.
  - `app/v1/prism/token-profiles/route.ts` uses `Cache-Control: no-store`, session cookie resolution, and compact JSON bodies.
  - `app/token-profiles-panel.tsx` shows how to render compact, no-secret user-facing metadata lists.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a second Slack method classifier, policy engine, execution-mode resolver, bearer verifier, or route-local capability allowlist.
  - Do not create a second website auth/session mechanism; reuse `prismSessionCookieName`, `hashSecret`, and existing Postgres session ownership patterns.
  - Do not place audit writes in a path that selects/decrypts Slack credentials before auth/policy/identity gates.
  - Do not add ORM/Supabase/PostgREST/auth dependencies; the ADR and dependency guard preserve plain Postgres/Next.js.
- Shortcuts or parallel paths to avoid:
  - Do not store request bodies, response bodies, Slack message text, raw search queries, Block Kit JSON, attachments, file contents, canvas/list content, thread bodies, DMs/group DM text, Prism developer tokens, token hashes, peppers, Slack access/refresh tokens, OAuth codes/states, client secrets, or payload-shaped JSON.
  - Do not add generic `metadata jsonb`/`payload jsonb` fields unless they are tightly constrained and tested to exclude content-bearing keys. Prefer explicit typed columns.
  - Do not audit by wrapping Slack success bodies or changing Slack-compatible response shapes.
  - Do not broaden the website into an admin dashboard; show only recent activity for the linked user’s own Token profiles.
  - Do not silently skip audit for successful forwarding or token creation; audit is a first-class Prism responsibility.
- Invariants:
  - Audit records are metadata-only: user/profile/workspace/method/category/endpoint/surface/object IDs/status/error/request/rate-limit/retention timestamps are allowed; content and secrets are not.
  - Pre-upstream denied/unsupported/auth-failed paths remain `X-Prism-Upstream-Called:false`.
  - Malformed bearer tokens may only create anonymous/null-owner auth-failed audit rows and must not cause token/credential metadata lookup.
  - Audit display/API is scoped to the current linked Prism user and must not reveal other users’ records.

## Integration plan

- Insert the change at:
  - **Migration:** Add `db/migrations/0003_prism_activity_audit.sql` with a table such as `prism_activity_audit`:
    - `id text primary key`
    - `occurred_at timestamptz not null default now()`
    - `retention_expires_at timestamptz not null`
    - nullable ownership columns: `prism_user_id references prism_users(id) on delete set null`, `slack_connection_id references slack_connections(id) on delete set null`, `token_profile_id references token_profiles(id) on delete set null`
    - safe snapshots: `token_profile_name text`, `slack_user_id text`, `slack_team_id text`, `slack_enterprise_id text`
    - activity columns: `activity_type text`, `endpoint text`, `slack_method text`, `action_category text`, `surface text`, `object_type text`, `object_id text`, `execution_mode text`
    - outcome columns: `status text`, `error_class text`, `http_status integer`, `request_id text`, `upstream_called boolean not null default false`
    - rate-limit columns for issue #12 compatibility: `rate_limit_limited boolean not null default false`, `rate_limit_scope text`, `rate_limit_remaining integer`, `rate_limit_reset_at timestamptz`
    - indexes on `(prism_user_id, occurred_at desc)`, `(token_profile_id, occurred_at desc)`, `(request_id)`, and `(retention_expires_at)`.
  - **Service/store:** Add a server-only audit module with methods like `recordActivity(input)`, `startForwardingAttempt(input)`, `finishForwardingAttempt(id, outcome)`, and `listRecentActivityForSession({ sessionToken, limit })`. Inputs should be typed unions per activity type instead of arbitrary bodies.
  - **Slack API route:** After each policy or identity decision, call audit for `auth_failed`, `unsupported`, and `denied` before returning. Use only decision metadata already produced by policy; extend decision safe metadata if needed instead of re-querying credentials.
  - **Forwarding service:** After payload parsing and before upstream, record parse failures/rate-limit outcomes as final pre-upstream records. For allowed upstream calls, insert an `attempted` audit row before calling the upstream client; after upstream returns, update to `forwarded` or `upstream_error` using top-level Slack `ok`/`error` only, never response body contents.
  - **Token profile flows:** Record `token_profile_created` and `token_profiles_listed` for linked sessions. For creation, include `token_profile_id`, profile name, preset/action category if desired, status, request ID if route adds one, and never the copy-once developer token or verifier. Consider making create+audit one transaction so a failed audit insert does not display a token for an unaudited creation.
  - **OAuth flows:** Record metadata-only `oauth_started`, `oauth_linked`, `oauth_failed`, and `setup_required` where safe. Do not store `code`, `state`, cookie/session token, Slack token fields, or client secret. If scope strings are considered sensitive for this slice, omit them from audit; current Slack connection table already stores scopes separately.
  - **Recent activity API/UI:** Add `GET /v1/prism/activity` returning `{ activity: [...] }` for the current `prism_session`, `401` for unauthenticated/not linked, and `Cache-Control: no-store`. Add an `ActivityAuditPanel` on the homepage under Token profiles that lists the latest ~20 records with timestamp, token profile name, method/activity, category, status/error, execution mode, and request ID. Do not show payload/object content beyond safe IDs.
- Why this is the correct integration point:
  - It preserves issue #7/#8/#9 ownership: route owns pre-upstream decisions; forwarding owns upstream outcome; token profile/OAuth services own their lifecycle events.
  - A cross-cutting `src/server/audit` module prevents Slack-only coupling while avoiding a parallel policy/session system.
  - Typed audit inputs and columns make “metadata-only” testable and harder to regress than a general payload log.
- Alternatives considered and rejected:
  - **Route-only audit:** rejected because the route cannot reliably know forwarding parse/rate-limit/upstream outcome without parsing response bodies or duplicating forwarding logic.
  - **Forwarding-only audit:** rejected because auth/policy/identity/token/OAuth/profile events happen before or outside forwarding.
  - **Generic JSON payload log:** rejected because it invites accidental content/secret storage and fails issue #10’s metadata-only constraint.
  - **Best-effort audit only:** rejected for successful forwarding/token creation because it can produce false success for unaudited important activity. Recommended failure behavior: if the initial audit insert required before an upstream side effect or token creation fails, do not perform the side effect; return a no-store `audit_unavailable`/503-style failure. If the final post-upstream outcome update fails after an upstream call already happened, preserve the Slack response to avoid duplicate retries, leave the pre-inserted row as `outcome_unknown`/`attempted`, and ensure this case is test-covered.

## Regression checklist

- Behavior: `npm test` and `npm run build` remain green.
- Behavior: Existing route tests for denied/unsupported/auth-failed/selectable/forwarded Slack calls still pass.
- Behavior: Malformed Prism bearer tokens still fail before token/profile/credential metadata lookup.
- Behavior: Denied/unsupported/deferred/admin/file-content paths still do not select credential envelopes, decrypt credentials, refresh credentials, or call upstream.
- Behavior: Allowed representative methods still forward to the default mock upstream and preserve Slack-shaped success/error bodies with Prism diagnostics in headers.
- Behavior: `/v1/prism/status`, `/v1/prism/capabilities`, `/v1/prism/token-profiles`, OAuth start/callback, Slack status panel, and Token profiles panel keep their no-store/no-secret guarantees.
- Behavior: Audit table contains no payload bodies, Slack content, raw search queries, developer tokens, token hashes, peppers, Slack tokens, OAuth codes/states, or client secrets.
- Behavior: Audit display/API only returns records for the current linked Prism user and remains no-store.
- Behavior: Default retention is represented as 90 days unless an internal security override is configured.

## Test plan

- Existing tests to keep green:
  - `app/v1/slack/api/[method]/route.test.ts`
  - `src/server/slack/forwarding.test.ts`
  - `src/server/slack/method-registry.test.ts`
  - `src/server/token-profiles/method-policy.test.ts`
  - `src/server/token-profiles/execution-identity.test.ts`
  - `src/server/slack/response-adapter.test.ts`
  - `app/v1/prism/status/route.test.ts`
  - `app/v1/prism/capabilities/route.test.ts`
  - `app/v1/prism/token-profiles/route.test.ts`
  - `src/server/token-profiles/service.test.ts`
  - OAuth/custody/refresh/encryption tests, panel render tests, config/health/dependency guard.
- New tests to add before/with implementation:
  - Audit store unit tests for insert/list/update, session scoping, ordering, retention timestamp default/override, and migration SQL avoiding body/payload columns.
  - Slack route tests proving audit records for `auth_failed`, `unsupported`, `denied`, invalid execution mode, parse failure, rate-limited, forwarded success, and upstream `ok:false` error.
  - Forwarding service tests proving initial audit insert occurs before upstream; if initial insert fails, upstream is not called; if final update fails after upstream, the attempted record remains and response behavior is explicit.
  - Token profile route/service tests proving `token_profile_created` and `token_profiles_listed` audit metadata excludes copy-once developer token, token hash, pepper, and verifier values.
  - OAuth start/callback tests proving audit metadata excludes OAuth `code`, `state`, session token, Slack access/refresh tokens, and client secret.
  - Activity API/UI tests proving current-session scoping, no-store headers, compact rendering, unauthenticated rejection, and no leakage of secrets/content.
  - Explicit no-secret/no-content audit assertions using canary values for message text, DM text, group DM text, thread text/timestamp context if content-bearing, raw search query, search results, file content/name if deemed content-bearing, Block Kit `blocks`, attachments, canvas content, list content, Prism developer token, token hash, pepper, `xoxb-`, `xoxp-`, refresh token, access token, OAuth code/state, and client secret.
  - Object metadata tests confirming only approved safe IDs (`channel`, `file`, `user`, `ts` where accepted) are extracted and raw `text`, `query`, `blocks`, `attachments`, `content`, `messages`, `files`, `canvas`, and `list` structures are omitted.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - Apply migrations with `npm run db:migrate`.
  - Start local app with mock OAuth/upstream, link a mock Slack connection, create a Token profile, call representative allowed/denied Slack-compatible methods, and open the homepage.
  - Capture `curl` output for `GET /v1/prism/activity` showing recent metadata-only records for token creation, denied call, forwarded call, and upstream error.
  - Capture homepage evidence that the compact activity panel displays the same metadata without payload content.
  - Capture no-secret proof from API/UI/database rows: no `prism_dev_`, token hash, pepper canary, `xox`, `access_token`, `refresh`, `client_secret`, Slack message text, raw search query, Block Kit JSON, file content, canvas/list content.

## Risk assessment

- Risk: A generic audit `details` object becomes a payload log and stores Slack content or secrets.
- Risk: Recording audit before auth may accidentally store bearer tokens or force DB lookups for malformed tokens.
- Risk: Audit integration could reorder the issue #7/#8/#9 gate and accidentally select/decrypt credentials or call upstream for denied paths.
- Risk: Failing audit writes around upstream side effects can create either unaudited success or duplicate-prone false failure if not explicitly designed.
- Risk: Extending token resolution metadata could accidentally select credential envelopes/token hashes or expose them through local-tool status/capabilities.
- Risk: Recent-activity API/UI could leak one user’s records to another if it bypasses the existing session/owner model.
- Risk: Auditing every status/capabilities call may add write volume; if included in this slice, keep fields minimal and test failures. It is acceptable to defer high-volume status/capabilities audit if issue #10 acceptance is met by token-management and Slack activity.
- Mitigation: Use typed audit inputs, explicit columns, no arbitrary payload/body fields, service/store injection for tests, ordering tests, no-secret canaries, session-scoped queries, and a required pre-upstream audit insert for auditable side-effecting calls.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing ownership is clear: route owns pre-upstream decisions, forwarding owns upstream outcomes, token profile/OAuth services own lifecycle events, and the website already has compact session-scoped panels.
  - The Postgres/store/test conventions are simple and consistent across the codebase.
  - Issue #10’s metadata-only model is already defined in `CONTEXT.md`, and the current code already distinguishes safe metadata from credential/token material.
  - The main implementation constraint is not placement ambiguity but strict sanitization and audit-failure behavior, both of which can be protected with tests.
- Open questions:
  - Whether to audit `/v1/prism/status` and `/v1/prism/capabilities` in this slice or defer them as high-volume read activity. If included, keep anonymous/auth-failed records metadata-only.
  - Whether `object_id` should store DM/MPIM channel IDs and message timestamps or omit/hash them for extra privacy. The issue allows surface/object ID where applicable, but tests must ensure no DM/thread content is stored.
  - Whether token profile name should be stored as a snapshot in audit rows or joined at read time. Snapshotting improves historical display but should be treated as user-provided metadata and length-limited.
