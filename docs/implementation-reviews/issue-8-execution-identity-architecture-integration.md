# Architecture Integration Brief: issue-8-execution-identity

## Existing ownership

- Package/component/module/library:
  - **Method requirements/classification:** `src/server/slack/method-registry.ts` owns supported/unsupported Slack method classification and the `CapabilityMap`-derived availability projection. Issue #8 must not introduce a second method table; any execution-identity requirement/preference metadata should extend this registry or be derived from its classification.
  - **Pre-forwarding policy:** `src/server/token-profiles/method-policy.ts` owns bearer-token resolution, unsupported/deferred decisions, Capability map enforcement, surface/workspace checks, Slack-shaped denied bodies, and the allowed handoff currently consumed by `app/v1/slack/api/[method]/route.ts`.
  - **Token profile policy:** `src/server/token-profiles/presets.ts` owns `CapabilityMap.executionIdentity` (`user | bot | automatic | selectable`) and action/surface/mutation semantics. The resolver should consume the stored effective map, not client-provided capability output.
  - **Safe developer-token resolution:** `src/server/token-profiles/local-tool-status.ts` and `src/server/token-profiles/store.ts#createPostgresTokenProfileStore().resolveDeveloperToken` own resolving `Authorization: Bearer prism_dev_...` into safe metadata: profile state, Slack connection health/team, and credential-kind existence. Current resolution intentionally does **not** select credential envelopes.
  - **Credential custody:** `src/server/slack/postgres-store.ts`, `src/server/credentials/encryption.ts`, `src/server/credentials/factory.ts`, and `src/server/slack/refresh.ts` own encrypted Slack credential envelopes and server-only decryption/refresh. Local tools and response bodies must never receive Slack credentials.
  - **Slack-compatible HTTP boundary:** `app/v1/slack/api/[method]/route.ts` is the current Slack Web API-compatible tracer route. It delegates to `evaluateSlackMethodPolicy`, emits `Cache-Control: no-store` and `X-Prism-Request-ID`, returns denied/unsupported Slack-shaped bodies, and returns allowed `slack_forwarding_not_implemented` without upstream Slack calls.
  - **App substrate:** Next.js App Router route handlers plus plain `pg`/Postgres are the approved substrate per ADR 0001; dependency guard tests enforce server-only modules and reject Supabase/PostgREST-style replacements.
- Current owner rationale:
  - Issue #7 established a reusable pre-forwarding policy gate; issue #8 should add the next reusable handoff layer: execution identity selection plus response adaptation for future issue #9 forwarding.
  - Execution identity is not just policy. `method-policy.ts` should continue answering “is this call allowed before forwarding?” while a sibling server-only module answers “which server-held Slack credential kind would this allowed call use?”
  - Response adaptation belongs near Slack HTTP/forwarding code, not token-profile policy, because it maps Slack upstream responses to Prism's Slack-compatible boundary.
- Source evidence:
  - `method-policy.ts` returns an `allowed` decision with method/category/profile/capability/mutation/execution-identity availability, and denied/unsupported/auth-failed decisions with Slack-shaped `ok:false` bodies.
  - `store.ts` selects `exists(...) as has_user_credential/has_bot_credential` and `c.team_id`, but not `slack_connection_id` or credential envelopes. Future credential retrieval needs a deliberate server-only extension, not envelope selection in policy metadata.
  - `postgres-store.ts` is the existing place that reads/writes `slack_credentials`; `refresh.ts` decrypts refresh tokens using AAD `slack-connection:${connectionId}:${kind}`.
  - Focused baseline passed: `npm test -- --run src/server/token-profiles/method-policy.test.ts src/server/slack/method-registry.test.ts src/server/token-profiles/local-tool-status.test.ts app/v1/slack/api/[method]/route.test.ts --reporter=dot` (12 tests, 4 files).

## Existing interaction model

- User/system behaviors that already exist:
  - Local tools authenticate with `Authorization: Bearer prism_dev_...`; malformed/missing developer tokens fail before DB lookup.
  - Invalid auth is Slack-shaped on `/v1/slack/api/[method]`: `ok:false`, `error:"invalid_auth"`, Prism diagnostics in `body.prism`, plus `X-Prism-Request-ID` and `Cache-Control: no-store`.
  - Expired/revoked/bootstrap profiles fail before method checks; unsupported/deferred methods and policy-denied methods return `ok:false` without Slack calls.
  - `X-Prism-Workspace-ID` and `X-Prism-Surface` are current pre-forwarding context hints; missing required surface currently denies with `surface_required`.
  - `executionIdentityStatus` reports configured identity, availability of user/bot/automatic/selectable modes, and unavailable reasons from safe metadata only.
  - Successful upstream Slack forwarding does not exist yet. Allowed tracer calls currently return HTTP 501 with `ok:false,error:"slack_forwarding_not_implemented"` and Prism diagnostics in the body.
- Behaviors that must remain unchanged:
  - Prism developer tokens remain opaque Prism tokens; local tools never receive Slack access/refresh tokens, credential envelopes, token hashes, peppers, client secrets, or Slack OAuth raw responses.
  - Denied/unsupported/auth-failed branches must not call Slack, decrypt Slack credentials, refresh tokens, auto-join channels, invite the app, open DMs, or mutate membership state.
  - Capability enforcement must remain server-owned from the stored Token profile `capability_map`, never from `/v1/prism/capabilities` output or request headers.
  - Method registry classification must stay the single source for supported/deferred/unsupported method families.
  - Existing Slack-shaped denied bodies may keep Prism `body.prism` diagnostics. The new “diagnostics outside body” rule applies to successful Slack responses so Slack-compatible success bodies remain unwrapped.
  - All local-tool/Slack-compatible route responses should continue `Cache-Control: no-store` and `X-Prism-Request-ID`.
- Runtime or UX evidence:
  - Existing tests assert route/policy responses contain no `prism_dev_`, `tokenHash`, pepper, `xox[bp]-`, refresh/access token, or client secret strings.
  - Slack docs state Web API methods are RPC-style `https://slack.com/api/METHOD_FAMILY.method`, accept GET/form/json depending on method, and all Web API responses contain a top-level `ok` boolean. Successful Prism forwarding should therefore preserve Slack's body as-is.
  - Next.js route handlers support dynamic route params and response header setting via standard Web `Response`/`NextResponse` APIs; the existing `[method]` route already follows this model.
- Conflicts between docs and code:
  - No current conflict found. `docs/slack/README.md` says policy enforcement is implemented by issue #7 and upstream forwarding remains deferred; the current tracer route matches that. Issue #8 should not update docs to imply real upstream forwarding exists.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep `evaluateSlackMethodPolicy` as the mandatory first gate. Do not move policy checks into the execution resolver or route handler.
  - Add a sibling server-only module, recommended `src/server/token-profiles/execution-identity.ts` or `src/server/slack/execution-identity.ts`, that consumes an `allowed` policy decision plus request header/context and returns either a selected execution identity (`user` or `bot`) or a Slack-shaped denial reason. Prefer the token-profile package if it only uses safe metadata; prefer `src/server/slack/*` if it also returns forwarding credential references.
  - Extend `ResolvedDeveloperToken`/store resolution only with safe fields needed for later server-side credential lookup, especially `slackConnectionId`; do not add envelope fields to `resolveDeveloperToken`.
  - If issue #8 needs a credential lookup abstraction for future forwarding, add it beside existing custody (`src/server/slack/postgres-store.ts`) and require an explicit `connectionId + kind`. It may return encrypted envelopes only to server-only forwarding code or a decrypted access token only through `CredentialCipher`; never route JSON.
  - Add a Slack response adapter near forwarding, recommended `src/server/slack/response-adapter.ts`, with tests using synthetic Slack responses. It should set Prism diagnostics headers on successful responses while preserving the exact Slack body.
  - Reuse route conventions from `app/v1/prism/status/route.ts`, `app/v1/prism/capabilities/route.ts`, and `app/v1/slack/api/[method]/route.ts`: request ID via `randomUUID`, `NextResponse`, `Cache-Control: no-store`, `X-Prism-Request-ID`.
  - Use Next.js App Router route handlers only; no Pages Router API, Express/Fastify, ORM, Supabase, or Slack SDK dependency is required for this slice.
- Relevant docs or library capabilities:
  - Slack Web API JSON POSTs require Slack tokens in the Authorization header and successful responses are Slack JSON objects. Prism's upstream call in issue #9 can inject server-held Slack `Authorization: Bearer xox...`; issue #8 should not expose that value.
  - Slack `chat.postMessage` accepts a `channel` but Prism must not turn bot mode into membership repair. If bot access lacks membership, future forwarding should let Slack return its own error rather than auto-joining/inviting/opening conversations.
- Existing examples in this codebase:
  - `executionIdentityStatus` already computes safe availability and reasons.
  - `method-policy.test.ts` already covers unavailable identity, unsupported method, policy-denied method, and no-secret assertions.
  - `app/v1/slack/api/[method]/route.test.ts` mocks DB metadata and proves malformed bearer tokens do not query DB.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a parallel Method registry, route-local allowlist, or method-to-identity table outside the registry/evaluator path.
  - Do not create a parallel developer token verifier, cookie fallback, query-param token path, JWT/self-describing token model, or plaintext token comparison.
  - Do not select `access_token_envelope`/`refresh_token_envelope` in `resolveDeveloperToken`; keep that resolver safe-metadata-only.
  - Do not decrypt Slack credentials in policy-denied, unsupported, auth-failed, invalid-header, or unavailable-credential branches.
  - Do not treat Slack OAuth scopes as the effective Prism policy. Stored `CapabilityMap` remains the enforcement source.
  - Do not introduce Slack upstream forwarding, rate-limit handling, retry logic, SDK wrapping, or membership-management side effects in this slice.
- Shortcuts or parallel paths to avoid:
  - No “ignore `X-Prism-Execution-Mode` if not allowed” ambiguity. Header override should be accepted only for selectable profiles; otherwise fail closed with a clear Slack-shaped Prism diagnostic.
  - No accepting `automatic` as a header synonym unless product explicitly expands the contract; issue text says header supports `user`, `bot`, and `auto`.
  - No body wrapping for successful Slack responses such as `{ ok:true, prism:{...}, slack:{...} }`. Prism diagnostics belong in headers on success.
  - No automatic bot channel join, `conversations.invite`, `conversations.open`, DM creation, membership repair, or fallback “try user then bot” sequence that could create side effects or duplicate Slack calls.
- Invariants:
  - Every future upstream Slack call must have exactly one prior policy decision and exactly one selected execution identity.
  - Effective execution mode must resolve to a concrete server credential kind (`user` or `bot`) before an upstream call; `auto`/`automatic` are selection algorithms, not upstream credential kinds.
  - `X-Prism-Upstream-Called` (or equivalent adapter header) must be `false` for tracer/not-forwarding paths and denied paths, and `true` only when a Slack upstream request is actually made.
  - Bot-backed means “use existing bot credential only”; Slack errors caused by bot visibility/membership should pass through later forwarding rather than causing Prism membership mutations.

## Integration plan

- Insert the change at:
  - **Policy stays first:** `app/v1/slack/api/[method]/route.ts` should continue to call `evaluateSlackMethodPolicy` before any execution identity or response-adapter work. Denied/unsupported/auth failures should keep the existing Slack-shaped body behavior.
  - **Execution identity resolver:** add a sibling server-only resolver after policy success. It should accept the allowed decision, safe resolved-token credential availability, method classification/category, and raw `X-Prism-Execution-Mode` header. Recommended output: `{ kind:"resolved", executionMode:"user"|"bot", requestedMode:"user"|"bot"|"auto"|null, tokenProfileId, slackConnectionId? }` or `{ kind:"denied", httpStatus:200, body:{ ok:false, error:"not_allowed", prism:{ errorClass:"execution_identity_unavailable"|"invalid_execution_mode"|"execution_mode_not_selectable", ... }}}`.
  - **Minimal safe store extension:** if needed, include `slack_connection_id` in `ResolvedDeveloperToken` and the `resolveDeveloperToken` query. This is safe metadata needed to identify the server-held credential later; keep envelope selection in custody modules only.
  - **Header parsing:** read `request.headers.get("x-prism-execution-mode")`, trim/lowercase, and accept only exact `user`, `bot`, or `auto`. Empty/missing means no override. Invalid values should fail closed before forwarding with Slack-shaped `ok:false` diagnostics and `X-Prism-Upstream-Called:false`.
  - **Selectable constraint:** only Token profiles with `capabilityMap.executionIdentity === "selectable"` may honor the header. If a non-selectable profile sends `X-Prism-Execution-Mode`, deny rather than silently ignoring it. For selectable profiles with no header, use the automatic algorithm.
  - **Configured modes:** `user` requires available user credential; `bot` requires available bot credential; `automatic` uses the automatic algorithm and requires at least one usable credential; `selectable` requires both credentials to be considered generally available, but a selected `user`/`bot` still resolves to the requested concrete kind.
  - **Automatic algorithm:** resolve to one concrete credential without side effects. Recommended deterministic default: for read/search/users/files metadata categories prefer `user` when available, else `bot`; for message write/destructive/reactions prefer `bot` when available, else `user`. This preserves user-visible read semantics where possible and bot/app authorship for writes where possible, while still supporting single-credential installations. If future method-registry metadata marks a method as user-only or bot-only, apply that before preferences.
  - **Unavailable combinations:** if the chosen/requested mode lacks its credential or Slack connection is `reauth_required`, return `not_allowed` with Prism `errorClass:"execution_identity_unavailable"` and an unavailable reason such as `missing_user_identity`, `missing_bot_identity`, `missing_execution_identity`, or `slack_reauth_required`.
  - **Bot side-effect guard:** resolver/forwarding must not compensate for bot membership. It selects only the existing bot credential; it must not call Slack methods that join/invite/open conversations as part of mode resolution.
  - **Response adapter:** add a reusable adapter that takes a successful Slack upstream body/response and diagnostics `{ requestId, policyDecision:"allowed", executionMode, upstreamCalled }`, then returns the Slack body unchanged with headers such as `X-Prism-Request-ID`, `X-Prism-Policy-Decision`, `X-Prism-Execution-Mode`, `X-Prism-Upstream-Called`, and `Cache-Control:no-store`. For issue #8 route tests, use synthetic/mock upstream responses or direct unit tests; do not implement real Slack forwarding.
  - **Current tracer route:** allowed calls may remain `slack_forwarding_not_implemented` until issue #9, but should emit the new diagnostics headers with `X-Prism-Upstream-Called:false` after execution identity has been resolved. Successful adapter behavior can be covered by unit tests with fake Slack `ok:true` responses.
- Why this is the correct integration point:
  - It preserves issue #7's central policy gate while separating identity selection from allow/deny policy.
  - It keeps credential custody server-side and gives issue #9 a reusable identity+response handoff instead of route-local decisions.
  - It satisfies Slack compatibility by moving Prism diagnostics out of successful response bodies without changing denied/unsupported diagnostic bodies that existing tests already protect.
- Alternatives considered and rejected:
  - **Extending only `method-policy.ts` to choose credentials:** rejected because policy should remain pre-forwarding authorization; credential-kind selection and response adaptation are forwarding-adjacent concerns.
  - **Route-local header parsing/selection:** rejected because future forwarding could bypass it and tests would protect only the tracer route.
  - **Selecting/decrypting credentials inside `resolveDeveloperToken`:** rejected because it breaks safe-metadata token resolution and increases leakage risk.
  - **Implementing live Slack forwarding now:** rejected; issue #9 owns representative upstream calls.
  - **Wrapping success bodies with Prism diagnostics:** rejected by acceptance criteria and Slack Web API compatibility.

## Regression checklist

- Behavior: Existing Method registry discovery/classification remains compatible for `/v1/prism/capabilities` and method-policy tests.
- Behavior: Existing `/v1/slack/api/[method]` denied, unsupported, auth-failed, malformed-token, request-id, and no-store behavior remains green.
- Behavior: Existing `/v1/prism/status` and `/v1/prism/capabilities` bearer-only auth, token expiry/revocation, Slack `reauth_required`, and no-secret behavior remain unchanged.
- Behavior: Token profile creation/listing still stores `CapabilityMap.executionIdentity` values and developer tokens remain copy-once.
- Behavior: Slack OAuth/refresh/encryption custody tests remain green; encrypted credential envelopes are never selected for policy-only decisions.
- Behavior: `X-Prism-Execution-Mode` is ignored nowhere silently: valid only for selectable profiles, invalid/unauthorized values deny before upstream.
- Behavior: User/bot/automatic/selectable and missing-credential combinations are deterministic and tested.
- Behavior: Bot mode uses existing bot access only; no Slack membership/open/invite/join helper is introduced.
- Behavior: Successful Slack response adapter returns the Slack body unchanged and emits Prism diagnostics only in headers.
- Behavior: `npm test` and `npm run build` remain green; dependency guard still passes.

## Test plan

- Existing tests to keep green:
  - `src/server/slack/method-registry.test.ts`
  - `src/server/token-profiles/method-policy.test.ts`
  - `src/server/token-profiles/local-tool-status.test.ts`
  - `src/server/token-profiles/local-tool-capabilities.test.ts`
  - `app/v1/slack/api/[method]/route.test.ts`
  - `app/v1/prism/status/route.test.ts`
  - `app/v1/prism/capabilities/route.test.ts`
  - Token profile service/route tests, Slack OAuth flow/client/refresh/encryption tests, dependency guard, health tests.
- New tests to add before/with implementation:
  - Execution resolver unit tests for configured `user`, configured `bot`, configured `automatic`, configured `selectable` with no header, selectable `user`, selectable `bot`, selectable `auto`, invalid header value, header on non-selectable profile, missing user credential, missing bot credential, missing both, and Slack `reauth_required`.
  - Method/category preference tests for automatic mode: read/search/users/files metadata prefer user when both exist; messages/reactions/destructive prefer bot when both exist; single available credential is used when method permits either.
  - Route tests proving `X-Prism-Execution-Mode` is parsed only as `user|bot|auto`, accepted only for selectable profiles, and denied combinations do not call Slack/decrypt credentials/select envelopes.
  - No-side-effect tests or static assertions proving bot mode resolution imports/calls no membership mutating Slack methods and does not introduce `conversations.join`, `conversations.invite`, or `conversations.open` behavior.
  - Response adapter tests with a synthetic successful Slack body such as `{ ok:true, channel:"C123" }`: response body is exactly unchanged/no `prism` field; headers include request ID, policy decision, execution mode, upstream-called indicator, and no-store.
  - Adapter tests for JSON/content-type preservation and no secret leakage in headers/body.
  - Optional tracer-route allowed test: allowed method resolves execution identity and returns current `slack_forwarding_not_implemented` body with `X-Prism-Upstream-Called:false`, without claiming Slack success.
- Live proof required:
  - Start local app with Postgres/migrations and seeded or created Token profiles covering read-only/messages/selectable identities.
  - `curl -i` a policy-denied call (e.g. read-only `chat.postMessage`): expect Slack-shaped `ok:false`, Prism body diagnostics, `X-Prism-Request-ID`, no upstream-called true.
  - `curl -i` unsupported `admin.users.list`: expect `ok:false,error:"method_not_supported"`, no upstream call.
  - `curl -i -H 'X-Prism-Execution-Mode: bot'` against a selectable profile and an allowed tracer method: expect deterministic execution-mode diagnostics in headers and `X-Prism-Upstream-Called:false` until issue #9.
  - Verify no responses/logs contain `prism_dev_`, token hashes, peppers, `xox`, access/refresh tokens, client secrets, or credential envelopes.

## Risk assessment

- Risk: Execution selection gets embedded in the route and future issue #9 forwarding bypasses it.
  - Mitigation: add a reusable server-only resolver and route tests that assert the route delegates to it.
- Risk: Safe metadata resolution is expanded to include credential envelopes or decrypted tokens.
  - Mitigation: only add `slackConnectionId`/credential-kind metadata there; keep envelope access in custody modules and test DB query strings for absence of envelope columns where appropriate.
- Risk: Header override semantics become ambiguous for non-selectable profiles.
  - Mitigation: fail closed whenever `X-Prism-Execution-Mode` is present and the Token profile is not `selectable`.
- Risk: Automatic mode surprises users by choosing bot for reads or user for writes.
  - Mitigation: encode deterministic category preferences in tests and expose the effective mode in headers.
- Risk: Bot-backed mode accidentally introduces membership side effects or fallback calls.
  - Mitigation: resolver selects a credential kind only; no Slack calls in issue #8; future forwarding must pass through Slack errors without auto-join/invite/open-DM repair.
- Risk: Response adapter accidentally wraps or mutates successful Slack bodies, breaking Slack-compatible clients.
  - Mitigation: exact-body adapter tests with no `prism` field on success and diagnostics asserted only in headers.
- Risk: Adding new diagnostics headers leaks sensitive values.
  - Mitigation: headers should contain only request ID, policy decision, selected/requested non-secret mode, and boolean upstream-called indicator; tests assert no secret-like substrings.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing issue #7 code cleanly separates registry, policy evaluation, route boundary, and safe token metadata, giving issue #8 a clear post-policy/pre-forwarding insertion point.
  - Existing credential custody modules already define where encrypted Slack credentials may be read/decrypted, so the brief can prevent resolver overreach.
  - Acceptance criteria map directly to missing tests around `X-Prism-Execution-Mode`, concrete user/bot selection, no bot membership side effects, and successful-response header diagnostics.
  - Baseline focused tests are green and include strong no-secret patterns to extend.
- Open questions:
  - Exact automatic preference per method category is a product decision. The recommendation above is deterministic and conservative, but the implementer should stop if product docs specify different user-vs-bot defaults.
  - Whether issue #8 should add a credential retrieval interface now or only a credential-kind/reference resolver depends on how much issue #9 wants to consume. Do not decrypt tokens unless tests/spec explicitly require it for reusable forwarding code.
  - Header names beyond `X-Prism-Request-ID` are not yet established in code. The recommended names are simple and testable; if implementers choose different names, preserve the same semantics.
