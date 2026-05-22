# Architecture Integration Brief: issue-7-method-policy

## Existing ownership

- Package/component/module/library:
  - **Method classification:** `src/server/slack/method-registry.ts` already owns the server-only Method registry used by capabilities discovery. Issue #7 should extend this module from discovery projection into enforcement metadata and helpers, not create a second allow/deny table.
  - **Token profile policy:** `src/server/token-profiles/presets.ts` owns `CapabilityMap`, action flags, surface flags, workspace mode, expiry semantics, execution identity setting, deferred surfaces, and mutation semantics. Enforcement must consume the stored effective `capability_map` resolved from the Token profile.
  - **Local-tool bearer-token resolution:** `src/server/token-profiles/local-tool-status.ts` and `src/server/token-profiles/store.ts#createPostgresTokenProfileStore().resolveDeveloperToken` own resolving `Authorization: Bearer prism_dev_...` to safe token/profile/Slack-state metadata. Policy evaluation must reuse this path so expiry, revocation, bootstrap/revoked profile state, Slack `reauth_required`, and credential availability are interpreted consistently.
  - **Slack-compatible HTTP boundary:** existing `/v1/slack/*` routes are only OAuth today (`app/v1/slack/oauth/start`, `app/v1/slack/oauth/callback`). No Slack Web API forwarding route exists yet. Issue #7 should introduce only the pre-forwarding policy gate and representative Slack-compatible denied/unsupported route behavior needed before issue #9 implements upstream Slack calls.
  - **Persistence:** plain Postgres via `src/server/db.ts`, `db/migrations/0001_slack_oauth_custody.sql`, and `db/migrations/0002_prism_developer_tokens.sql` owns `slack_connections`, `slack_credentials`, `token_profiles`, and `prism_developer_tokens`.
  - **Slack credential custody:** encrypted Slack credential envelopes are stored/read by `src/server/slack/postgres-store.ts` and refresh code. Issue #7 must not decrypt credentials or call Slack; that belongs to later forwarding/refresh paths.
- Current owner rationale:
  - `CONTEXT.md` defines the Prism hosted service as owner of policy enforcement, Method registry classification, Slack credential custody, Slack API forwarding, rate limits, and metadata-only audit; it defines Capability maps as Token profile policy, not Slack scopes.
  - Issue #6 introduced `src/server/slack/method-registry.ts` for discovery and `src/server/token-profiles/local-tool-status.ts` for safe bearer-token status/capability projection. Issue #7 is the next layer: a reusable decision function that future Slack forwarding must call before any upstream Slack request.
  - Focused runtime tests passed for the current discovery/status/capability path: `npm test -- --run src/server/slack/method-registry.test.ts src/server/token-profiles/local-tool-status.test.ts src/server/token-profiles/local-tool-capabilities.test.ts app/v1/prism/status/route.test.ts app/v1/prism/capabilities/route.test.ts`.
- Source evidence:
  - `src/server/slack/method-registry.ts` currently classifies conversations read, users read, search, messages write/destructive, reactions, files metadata, and unsupported admin/events/slashCommands/interactivity/fileTransfer/canvases/lists/future methods.
  - `src/server/token-profiles/presets.ts` stores workspace mode as `linked_slack_connection`, surface booleans, action booleans, execution identity, expiry-driving experiment/destructive policy, deferred surfaces, and mutation flags `narrowingAppliesImmediately: true` / `broadeningRequiresRotation: true`.
  - `src/server/token-profiles/local-tool-status.ts` already returns invalid/expired/revoked token results and execution-identity availability from safe metadata; `store.ts` resolves token hashes without selecting credential envelopes.
  - `app/v1/prism/status/route.ts` and `app/v1/prism/capabilities/route.ts` parse only `Authorization: Bearer <token>`, set `Cache-Control: no-store`, and return `X-Prism-Request-ID`.

## Existing interaction model

- User/system behaviors that already exist:
  - Local tools authenticate Prism-native status/capability calls with `Authorization: Bearer prism_dev_...`; cookies are not accepted for Local-tool auth.
  - Invalid/malformed bearer tokens return 401 machine-readable JSON without querying the database. Expired tokens return 401; revoked/bootstrap profiles return 403. Valid tokens with Slack `reauth_required` still resolve but show identity unavailable.
  - `/v1/prism/capabilities` exposes effective `CapabilityMap` plus Method registry-derived `categories`, `methods`, and `unsupported` discovery without Slack API calls or credential leakage.
  - Website Token profile creation/listing remains cookie-authenticated under `/v1/prism/token-profiles`; developer token plaintext is copy-once on creation only.
  - Slack OAuth routes under `/v1/slack/oauth/*` link Slack and store encrypted Slack credentials server-side; they are not Slack Web API forwarding endpoints.
- Behaviors that must remain unchanged:
  - Local tools never receive Slack credentials, credential envelopes, token hashes, peppers, refresh tokens, access tokens, raw DB rows, or Slack scopes as policy.
  - Capability enforcement must be server-owned and based on the resolved Token profile's stored effective `CapabilityMap`, not on client-provided method lists or `/v1/prism/capabilities` output.
  - Method classification must remain broad enough for non-admin Slack Web API extensibility while explicit admin/org, inbound events, slash commands, interactivity, file transfer/content, canvases, lists, and future families stay unsupported/deferred in v1.
  - Denied and unsupported Slack-compatible calls must not call Slack, decrypt Slack credentials, update Slack state, or pretend forwarding succeeded.
  - Existing status/capability/Token profile/OAuth response shapes and no-secret assertions must remain stable.
- Runtime or UX evidence:
  - Focused tests show current status/capabilities behavior passes and asserts no `prism_dev_`, token hash, pepper, `xox[bp]-`, refresh, access token, or client secret leakage.
  - There is no existing `/v1/slack/api/*` or Web API forwarding route in `app/v1`; implementers must treat any route added in issue #7 as a gate/tracer endpoint, not as Slack upstream forwarding.
- Conflicts between docs and code:
  - `docs/slack/README.md` says Method registry and Slack API forwarding remain deferred. Code now has a minimum registry from issue #6, but still no forwarding. Resolve this by updating docs only if issue #7's implementation introduces a policy gate/tracer route; do not treat the doc line as permission to create a second registry.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Extend `src/server/slack/method-registry.ts` with a single classification/enforcement-friendly shape, for example exported functions like `classifySlackMethod(method: string)` and `buildMethodAvailability(capabilityMap)` sharing the same registry entries.
  - Add policy evaluation in a server-only module that composes existing owners, preferably near Local-tool services, e.g. `src/server/token-profiles/method-policy.ts` or `src/server/slack/method-policy.ts`. It should take `{ bearerToken, method, requestSurface/channel metadata if available, developerTokenConfig, store, now, requestId }` and return an allow/deny/unsupported decision plus diagnostics.
  - Reuse `hashDeveloperToken`, `getDeveloperTokenConfig`, `LocalToolTokenStore.resolveDeveloperToken`, `executionIdentityStatus`, and `CapabilityMap` instead of route-local token/profile logic.
  - Parse Local-tool auth with the same exact format as status/capabilities: `Authorization: Bearer <prism_dev_...>`. If helper extraction is added, share it or keep behavior identical; no query-param tokens and no cookie fallback.
  - Use App Router route handlers for any Slack-compatible tracer endpoint. A precise minimal integration point is a dynamic Slack Web API-compatible path under `/v1/slack/api/[method]` (e.g. `/v1/slack/api/chat.postMessage`) with `GET`/`POST` handlers accepting Slack-shaped form/json requests but evaluating policy before any upstream call. Since Slack forwarding is issue #9, allowed decisions may return an explicit `ok:false` not-yet-forwarding response or route-level placeholder only if acceptance tests require exercising the gate; denied/unsupported decisions must be fully implemented.
  - Use NextResponse JSON conventions with `Cache-Control: no-store` and `X-Prism-Request-ID`, matching `/v1/prism/status` and `/v1/prism/capabilities`.
- Relevant docs or library capabilities:
  - Slack Web API error shape is top-level JSON `ok: false` with `error: "..."`. Prism diagnostics can be additive fields, e.g. `prism: { requestId, errorClass, method, category, requiredCapability, tokenProfileId? }`, while keeping `ok:false` and `error` easy for Slack-compatible callers.
  - Next.js App Router dynamic segments can represent method names containing dots via `[method]` for a route such as `/v1/slack/api/chat.postMessage`.
  - PostgreSQL already stores token/profile expiry, revocation, status, Slack connection health, and credential-kind availability; no new migration appears necessary for policy evaluation itself.
- Existing examples in this codebase:
  - `getPrismCapabilities` shows how to combine resolved developer token data with `buildMethodAvailability`.
  - `getPrismTokenStatus` centralizes token invalid/expired/revoked handling and execution identity availability.
  - `app/v1/prism/status/route.ts` and `capabilities/route.ts` show request ID/no-store/header conventions for Local-tool bearer-token APIs.
  - `app/v1/prism/*/route.test.ts` mock `src/server/db` and assert no secret selection/leakage.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a parallel Method registry, route-local allowlist, or separate JSON method map outside `src/server/slack/method-registry.ts`.
  - Do not create a parallel token resolver, token table, JWT/self-describing token path, plaintext token comparison, or cookie-authenticated Local-tool path.
  - Do not treat Slack OAuth scopes (`slack_connections.bot_scopes/user_scopes` or `slack_credentials.scopes`) as the effective policy. They are only the Slack-admin maximum; `token_profiles.capability_map` is the enforcement source.
  - Do not decrypt Slack credentials, call Slack, refresh Slack tokens, or select credential envelopes for denied/unsupported policy decisions.
  - Do not add Supabase/PostgREST/Auth/ORM/Express/Fastify or a Pages Router API path; ADR 0001 and dependency guard tests prohibit this direction.
- Shortcuts or parallel paths to avoid:
  - No “allow unknown method by default and forward later” branch. Unknown/unclassified methods should be explicit `unsupported`/`method_not_supported` until registered.
  - No broad admin/org wildcard forwarding. Admin/organisation families must be explicit unsupported matches and should also catch prefixes such as `admin.`, `team.`, `usergroups.`, `auth.teams.`, `apps.`, `conversations.invite/archive/create/rename/setPurpose/setTopic`, or any governance/provisioning-style additions chosen by the implementer.
  - No route-level policy decisions that bypass the central evaluator because future issue #9 forwarding could forget to call them.
  - No “surface” inference from Slack payloads that silently expands access beyond stored booleans; if channel/surface cannot be confidently known before forwarding, deny with a clear Prism diagnostic or require a safe default.
- Invariants:
  - Every future Slack upstream call must have exactly one prior Method registry classification and Token profile policy decision.
  - Denied/unsupported/deferred/admin/org decisions never call Slack.
  - Expiry and revocation continue to take effect before method capability checks.
  - Execution identity availability must be checked before allowing a method that requires a Slack identity; issue #7 may not fully resolve which upstream token to use, but it must deny when the configured identity is unavailable.
  - Capability broadening remains represented in `CapabilityMap.mutation.broadeningRequiresRotation: true`; narrowing remains immediate via the stored effective map. Issue #7 should enforce the current map, not implement full rotation UX.

## Integration plan

- Insert the change at:
  - **Registry:** Extend `src/server/slack/method-registry.ts` from discovery-only arrays into a reusable registry with per-method/family metadata: `category`, `supported/deferred/admin`, required `CapabilityMap.actions`, required/deferred surface flags where meaningful, destructive flag, and execution identity constraints. Preserve `buildMethodAvailability(capabilityMap)` as the capabilities endpoint API.
  - **Policy evaluator:** Add one server-only policy module that first resolves the developer token through the existing store/config path, then classifies the requested Slack method through the registry, then applies checks in this order: token invalid/expired/revoked/bootstrap, Slack connection health if forwarding would require Slack, method unsupported/deferred/admin, workspace restriction (`workspaces.mode === "linked_slack_connection"` only), surface flags, action/read/write/search/destructive requirements, expiry/revocation already resolved, and execution identity availability.
  - **Slack-compatible response mapping:** Add a small mapper for policy decisions to Slack-compatible bodies. Recommended denied body: HTTP 200 with `{ ok:false, error:"not_allowed", prism:{ requestId, errorClass:"capability_denied", method, category, requiredCapability, tokenProfileId } }`. Recommended unsupported/deferred body: HTTP 200 with `{ ok:false, error:"method_not_supported", prism:{ requestId, errorClass:"unsupported_method"|"deferred_surface", method, category } }`. Auth failures may use HTTP 401/403 with `ok:false` and `error:"invalid_auth"|"token_expired"|"token_revoked"` to remain Slack-shaped while preserving existing status semantics.
  - **Route/tracer boundary:** If issue #7 needs an HTTP route for acceptance tests before issue #9, add a thin dynamic handler under `app/v1/slack/api/[method]/route.ts` (or a similarly documented Slack-compatible path) that parses method from the URL, parses Authorization exactly like `/v1/prism/status`, calls the policy evaluator, returns denied/unsupported Slack-compatible responses, and for allowed methods returns an explicit non-forwarding response such as `ok:false,error:"slack_forwarding_not_implemented"` without calling Slack. Do not implement real Slack forwarding until issue #9.
  - **Store:** Reuse `createPostgresTokenProfileStore(database)`; no schema change is required unless tests reveal a missing safe field. Do not select `access_token_envelope` or `refresh_token_envelope`.
  - **Docs:** If a new `/v1/slack/api/[method]` tracer route is added, update README or Slack docs minimally to state policy-denied/unsupported tracer behavior exists but upstream forwarding remains deferred.
- Why this is the correct integration point:
  - It keeps classification in the server-owned Method registry introduced by issue #6 and keeps policy source-of-truth in Token profile `CapabilityMap` data created by issue #5.
  - It gives issue #9 one mandatory reusable pre-forwarding gate rather than route-local checks that could be bypassed once Slack forwarding is implemented.
  - It preserves Slack credential custody because denied/unsupported decisions require only safe token/profile/connection metadata.
- Alternatives considered and rejected:
  - **New `slack-methods.json` or route-local method map:** rejected as a parallel registry that would diverge from `/v1/prism/capabilities`.
  - **Embedding policy in `/v1/slack/api/[method]` route handlers:** rejected because future forwarding could bypass route-local checks and tests would not protect service-level enforcement.
  - **Treating `/v1/prism/capabilities` output as enforcement input:** rejected because capabilities is a projection for Local tools, not trusted policy state.
  - **Calling Slack to discover channel/surface before policy:** rejected for issue #7 because policy must decide before any Slack upstream call. If needed surface metadata is absent, use conservative denial or require caller-supplied metadata only as untrusted diagnostic input.
  - **Implementing actual Slack forwarding now:** rejected; user context says forwarding is issue #9.

## Regression checklist

- Behavior: Existing Method registry discovery results for `/v1/prism/capabilities` remain compatible, including `categories`, `methods`, `unsupported.surfaces`, and no-secret output.
- Behavior: Existing `/v1/prism/status` and `/v1/prism/capabilities` auth semantics remain unchanged: bearer-only, request IDs, no-store, invalid 401, expired 401, revoked 403, valid `reauth_required` 200.
- Behavior: Existing Token profile creation/listing remains cookie-based and copy-once; no new Local-tool route mints, rotates, or retrieves developer tokens.
- Behavior: Slack OAuth start/callback continue to link Slack and store encrypted credentials only.
- Behavior: Policy-denied Slack-compatible method calls return `ok:false` Prism diagnostics and do not call Slack, decrypt credentials, or select credential envelopes.
- Behavior: Admin/organisation, event/interactivity/slash command, file transfer/content, canvases, lists, future, unknown, and explicitly deferred methods return unsupported/deferred `ok:false` responses and do not call Slack.
- Behavior: Read/write/search/reactions/files metadata/destructive capability boundaries are enforced from the stored `CapabilityMap`.
- Behavior: Destructive methods require both the write action and `actions.destructive === true` / destructive opt-in.
- Behavior: Execution identity unavailability (`reauth_required`, missing user credential, missing bot credential, selectable without both) denies forwarding before Slack.
- Behavior: `CapabilityMap.mutation` semantics remain represented: broadening requires confirmation/rotation, narrowing applies immediately.
- Behavior: `npm test` and `npm run build` remain green; dependency guard still passes.

## Test plan

- Existing tests to keep green:
  - `src/server/slack/method-registry.test.ts`
  - `src/server/token-profiles/local-tool-capabilities.test.ts`
  - `src/server/token-profiles/local-tool-status.test.ts`
  - `app/v1/prism/status/route.test.ts`
  - `app/v1/prism/capabilities/route.test.ts`
  - `src/server/token-profiles/presets.test.ts`
  - `src/server/token-profiles/service.test.ts`
  - `app/v1/prism/token-profiles/route.test.ts`
  - Slack OAuth, refresh, encryption, dependency guard, health, build tests.
- New tests to add before/with implementation:
  - Method registry unit tests for representative classifications: `conversations.list/history/replies`, `chat.postMessage/update/delete`, `reactions.add/remove/get`, `search.messages`, `files.info/list`, `files.upload`, file delete/download/content-transfer names if represented, events/interactivity/slashCommands, admin/org families, and unknown methods.
  - Policy evaluator unit tests for read-only, messages-only, full bridge without destructive, destructive custom, no search, no file metadata, revoked token, expired token, bootstrap profile, Slack `reauth_required`, missing user credential, missing bot credential, selectable identity, and unknown/deferred/admin methods.
  - Route tests for the Slack-compatible policy tracer path showing denied `chat.postMessage` on read-only and unsupported `admin.users.list`/`files.upload` return `ok:false` and Prism diagnostics.
  - No-upstream-call tests with an injectable Slack client/fetch spy (or absence of client dependency) proving denied/unsupported/admin/deferred paths never call `fetch`, never decrypt credentials, and never select `access_token_envelope` or `refresh_token_envelope`.
  - Tests asserting invalid/missing Authorization produces Slack-shaped `ok:false` auth errors and does not query DB for malformed tokens, preserving current status/capabilities behavior where applicable.
  - Tests asserting capability broadening/narrowing semantics are surfaced from `CapabilityMap.mutation` and that the evaluator enforces the current stored map immediately.
- Live proof required:
  - Start local app on port 3732 with Postgres/migrations and mock or seeded data.
  - Create or seed a read-only Token profile, then call `curl -i -H 'Authorization: Bearer <read-only-prism_dev_token>' http://localhost:3732/v1/slack/api/chat.postMessage` (or POST equivalent). Expected: Slack-compatible `ok:false`, `error:"not_allowed"`, Prism request ID/diagnostics, no Slack network call/log.
  - Call the same route for `admin.users.list` and `files.upload`. Expected: Slack-compatible `ok:false`, explicit unsupported/deferred error, no Slack network call/log.
  - Call an allowed representative read method such as `conversations.history`. Until issue #9, expected: policy allows but route returns explicit `slack_forwarding_not_implemented` without contacting Slack; after issue #9 this becomes the forwarding handoff point.
  - Confirm responses contain no `prism_dev_`, `tokenHash`, pepper, `xox`, refresh/access token, client secret, or credential envelope material.

## Risk assessment

- Risk: A new route-local allow/deny implementation could diverge from `/v1/prism/capabilities` and later forwarding. Mitigation: centralize classification in `src/server/slack/method-registry.ts` and policy in one reusable service; route handlers stay thin.
- Risk: Surface controls are stored but there is no reliable channel/surface lookup before Slack calls. Mitigation: enforce known global surface flags (`search`, `filesMetadata`, deferred canvases/lists/fileTransfer) and deny or mark unknown channel-surface checks as not yet supported rather than calling Slack to discover them.
- Risk: Execution identity resolution is likely issue #8, so issue #7 could overbuild token selection. Mitigation: evaluate availability only using existing `executionIdentityStatus`; deny unavailable identities and leave actual upstream credential choice to issue #8/#9.
- Risk: Slack-compatible error semantics could conflict with existing Prism status HTTP statuses. Mitigation: for Slack-compatible routes, keep body `ok:false` with Slack-like `error`; use existing 401/403 only for auth failures if tests/product choose, and keep diagnostics additive.
- Risk: Broad non-admin extensibility could accidentally permit unknown governance/destructive methods. Mitigation: unknown or unregistered methods are unsupported until classified; broadening the registry requires explicit code/test updates.
- Risk: Policy tests may accidentally mock away the “no Slack call” guarantee. Mitigation: design evaluator with no Slack client dependency and route tests with fetch/client spies that fail on any call for denied/unsupported branches.
- Risk: New docs may imply real forwarding exists. Mitigation: explicitly label issue #7 behavior as pre-forwarding policy gate/tracer; actual upstream forwarding remains issue #9.

## Decision confidence

- Confidence: high
- Reasons:
  - The codebase already has clear owners for all required pieces: `CapabilityMap` in presets, safe bearer-token resolution in local-tool status/store, and Method registry in `src/server/slack/method-registry.ts`.
  - Acceptance criteria align directly with extending issue #6 discovery into a reusable pre-forwarding policy evaluator.
  - No schema or dependency change is required for the core decision path; existing Postgres data contains token/profile expiry, revocation, Slack connection health, and credential-kind availability.
  - Focused current tests pass and provide strong no-secret regression patterns.
- Open questions:
  - Exact Slack-compatible route shape is not yet implemented or documented. Recommended minimal path is `/v1/slack/api/[method]`, but implementers should keep it explicitly pre-forwarding until issue #9.
  - Channel/surface restriction enforcement cannot be complete without either trusted local metadata or a future safe lookup path. Issue #7 should not call Slack for surface discovery; conservative denial for unknown surface-sensitive cases is acceptable.
  - Exact error strings should be standardized in tests before implementation (`not_allowed`, `method_not_supported`, `invalid_auth`, `token_expired`, `token_revoked`, `slack_forwarding_not_implemented`).
