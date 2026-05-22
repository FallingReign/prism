# Architecture Integration Brief: issue-9-slack-forwarding

## Existing ownership

- Package/component/module/library:
  - **Method registry/classifier:** `src/server/slack/method-registry.ts` owns Slack method classification and capability availability projection. Issue #9 must extend/use this registry only.
  - **Pre-forwarding policy:** `src/server/token-profiles/method-policy.ts` owns bearer token verification handoff, unsupported/deferred/admin decisions, workspace/surface checks, capability-map enforcement, and allowed decisions.
  - **Execution identity:** `src/server/token-profiles/execution-identity.ts` owns `X-Prism-Execution-Mode` parsing and concrete `user`/`bot` selection after policy approval.
  - **Credential custody:** `src/server/slack/postgres-store.ts`, `src/server/slack/refresh.ts`, `src/server/credentials/encryption.ts`, and `src/server/credentials/factory.ts` own encrypted Slack credential envelopes, server-only decryption, refresh, and connection health marking.
  - **Slack-compatible route boundary:** `app/v1/slack/api/[method]/route.ts` owns the `/v1/slack/api/{method}` HTTP boundary and currently acts as an allowed-not-forwarded tracer.
  - **Response adaptation:** `src/server/slack/response-adapter.ts` owns Prism diagnostics headers (`Cache-Control`, `X-Prism-Request-ID`, `X-Prism-Policy-Decision`, `X-Prism-Execution-Mode`, `X-Prism-Upstream-Called`) and preserving successful Slack bodies.
- Current owner rationale:
  - `CONTEXT.md` defines Prism hosted service as owner of Slack credential custody, policy enforcement, Slack API forwarding, rate limits, and metadata-only audit; Local tools receive only Prism developer tokens.
  - Issue #7 established central registry/policy. Issue #8 established identity resolution and response diagnostics. Issue #9 should insert forwarding after those gates, not replace them.
  - Focused baseline verified: `npm test -- --run src/server/slack/method-registry.test.ts src/server/token-profiles/method-policy.test.ts src/server/token-profiles/execution-identity.test.ts src/server/slack/response-adapter.test.ts app/v1/slack/api/[method]/route.test.ts --reporter=dot` passed 5 files / 16 tests.
- Source evidence:
  - `app/v1/slack/api/[method]/route.ts` already orders policy before identity and returns `slack_forwarding_not_implemented` for allowed calls.
  - `store.ts#resolveDeveloperToken` returns safe metadata including `slackConnectionId`, team ID, connection health, and credential-kind existence, but not credential envelopes.
  - `postgres-store.ts#createPostgresRefreshStore().getCredentialForRefresh` is the current server-only credential envelope read path.
  - `docs/slack/README.md` still says upstream forwarding remains deferred; this is true before issue #9 and should be updated once forwarding exists.

## Existing interaction model

- User/system behaviors that already exist:
  - Local tools authenticate Slack-compatible calls with `Authorization: Bearer prism_dev_...`; malformed/missing tokens fail before DB lookup.
  - `/v1/slack/api/[method]` returns Slack-shaped `ok:false` for invalid auth, denied policy, unsupported/deferred methods, invalid execution mode, and allowed-not-forwarded tracer responses.
  - All route responses are `Cache-Control: no-store` and include `X-Prism-Request-ID`; tracer/denied paths set `X-Prism-Upstream-Called:false`.
  - `X-Prism-Execution-Mode` is accepted only for selectable profiles, resolves to concrete `user` or `bot`, and fails closed otherwise.
  - Denied/unsupported/auth-failed branches do not call Slack, decrypt credentials, select credential envelopes, repair membership, or leak secrets.
- Behaviors that must remain unchanged:
  - Bearer-only Local-tool auth; no cookies, query tokens, Slack token passthrough, or client-provided policy.
  - Registry classification, policy approval, and execution identity resolution must precede every upstream call.
  - Existing denied/unsupported/auth-failed Slack-compatible bodies may keep Prism diagnostics in the body; successful Slack bodies must remain unwrapped with Prism diagnostics in headers.
  - Admin/org, inbound events, slash commands, interactivity, canvases, lists, future methods, and file content transfer remain unsupported/deferred.
  - Bot/user execution must not auto-join, invite, open DMs, repair membership, or retry with another identity after Slack denial.
- Runtime or UX evidence:
  - Current tests assert no `prism_dev_`, token hash, pepper, `xox[bp]-`, refresh/access token, or client secret leakage in route/policy/identity/adapter output.
  - Slack Web API docs describe RPC-style `https://slack.com/api/METHOD_FAMILY.method`, GET query args, form POST, JSON POST for many write methods, and top-level `ok` plus `error` on failure.
- Conflicts between docs and code:
  - No current conflict before issue #9: docs say forwarding is deferred and code returns `slack_forwarding_not_implemented`. After issue #9, update `docs/slack/README.md`/README if needed so docs no longer imply all upstream forwarding is deferred.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep `app/v1/slack/api/[method]/route.ts` as the thin route boundary. Replace only the allowed tracer branch with forwarding orchestration.
  - Add a server-only Slack Web API upstream abstraction under `src/server/slack/`, e.g. `slack-web-api-client.ts`, with an interface such as `callMethod({ method, httpMethod, payload, executionMode, accessToken? })`.
  - Add a mock upstream implementation under `src/server/slack/` and make it the default for local/dev/tests. Use an explicit production/real mode config if real Slack forwarding is added; do not require user Slack app config for the default slice.
  - Add a small server-only forwarding credential store beside custody, preferably extending `postgres-store.ts` or a sibling `forwarding-store.ts`, taking `connectionId + kind` and returning only what forwarding needs. Do not add envelopes to `resolveDeveloperToken`.
  - Use `createConfiguredCredentialCipher()` and existing AAD pattern `slack-connection:${connectionId}:${kind}:access` for access-token decryption inside forwarding-only code. Use `refreshSlackCredential`/`createPostgresRefreshStore` before real forwarding when credentials are expired and refresh tokens exist.
  - Extend `response-adapter.ts` so successful and ordinary Slack error responses can pass through body/status/selected upstream headers while adding Prism diagnostics headers.
  - Add an explicit rate-limit check seam before credential retrieval/upstream call. No concrete Prism-side rate-limit implementation exists today beyond ADR/domain references, so the seam should be a tested no-op/default `allowed` decision, not fake enforcement.
- Relevant docs or library capabilities:
  - Slack Web API accepts GET query parameters, `application/x-www-form-urlencoded` POST parameters, and JSON bodies for most write methods; tokens should be sent to Slack via upstream `Authorization: Bearer xox...`, never through Local-tool payloads.
  - Slack error bodies are normally `{ ok:false, error:"machine_code" }`; Prism should pass ordinary upstream errors through and add request diagnostics in headers.
  - Next.js App Router dynamic segment `[method]` already supports Slack method names containing dots in this route.
- Existing examples in this codebase:
  - OAuth client code uses injected `fetchImpl` rather than Slack SDK dependency.
  - Mock OAuth client shows local/dev mock pattern using canary secrets safely encrypted and never returned.
  - Route tests mock `src/server/db` and inspect SQL strings to prove credential envelopes are not selected on denied paths.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - No parallel Method registry, route-local forwarding allowlist, method-to-scope map, or policy table outside `method-registry.ts`/`method-policy.ts`.
  - No parallel token verifier, cookie fallback, query-token auth, JWT/self-describing token path, plaintext token comparison, or accepting Slack tokens from Local tools.
  - No policy decisions based on Slack scopes; Token profile `CapabilityMap` remains enforcement source.
  - No credential envelope selection/decryption before token verification, registry classification, policy approval, identity resolution, and rate-limit seam.
  - No Slack SDK dependency unless the implementer documents a concrete benefit over `fetch` and updates dependency guard expectations; current codebase favors injected `fetch`.
- Shortcuts or parallel paths to avoid:
  - No forwarding unknown methods “because Slack will decide.” Unknown/unregistered methods remain unsupported.
  - No forwarding admin/org/deferred/file-content methods, including `admin.*`, `team.*`, `usergroups.*`, `apps.*`, `files.upload`, `files.delete`, downloads, and multipart content upload.
  - No auto-join/invite/open/membership repair side effects for conversations or DMs. Let Slack return ordinary errors.
  - No wrapping success bodies as `{ slack, prism }`; no payload logging; no Slack credential values in request bodies, response bodies, headers, logs, errors, or tests.
  - No real Slack dependency in default local/test path.
- Invariants:
  - Ordered pipeline is mandatory: developer token verification -> Method registry classification -> policy approval -> execution identity resolution -> Prism-side rate-limit check seam -> credential retrieval/refresh when required -> upstream call -> response adapter.
  - Denied/unsupported/auth-failed/rate-limited-before-upstream paths must set `X-Prism-Upstream-Called:false`.
  - Upstream-called paths must set `X-Prism-Upstream-Called:true` and preserve Slack IDs, pagination cursors, timestamps, file IDs, and ordinary Slack errors wherever practical.

## Integration plan

- Insert the change at:
  - In `app/v1/slack/api/[method]/route.ts`, keep lines 30-48 behavior as the mandatory gate. Replace the `slack_forwarding_not_implemented` allowed branch with a call to a forwarding service.
  - Add `src/server/slack/forwarding.ts` to orchestrate only post-identity work: rate-limit seam, credential access, optional refresh, request normalization, upstream call, and response adaptation.
  - Add `src/server/slack/web-api-client.ts` with `FetchSlackWebApiClient` and `MockSlackWebApiClient`. Default factory should choose mock in non-production/local unless explicit real mode is configured.
  - Add or extend credential custody API for forwarding access tokens by `slackConnectionId` and `executionMode`; keep it server-only and keep `resolveDeveloperToken` safe-metadata-only.
- Why this is the correct integration point:
  - The existing route is already the Slack-compatible boundary and already has the issue #7/#8 gate ordering. Forwarding belongs exactly where allowed tracer behavior currently sits.
  - A forwarding service avoids route-local credential/payload/rate-limit logic and gives future rate-limit/audit issue work a single seam.
  - A Slack client abstraction permits default mocked upstream without Slack app configuration while preserving a later real `fetch` implementation.
- Ordered pipeline details:
  - **Token verification:** reuse `readBearerToken` + `evaluateSlackMethodPolicy`; malformed tokens must not query DB.
  - **Classification/policy:** consume `decision.kind === "allowed"` only; all other decisions return as today.
  - **Execution identity:** call `resolveSlackExecutionIdentity`; require `slackConnectionId` for real credential retrieval.
  - **Rate-limit seam:** call a server-only `checkSlackForwardingRateLimit({ tokenProfileId, method, category, executionMode, requestId })` that currently returns allowed/no-op, with tests proving ordering.
  - **Credential retrieval/refresh:** for mock upstream, do not require real Slack config; still require identity and, where live mock DB is used, existing encrypted mock credentials. For real upstream, fetch/decrypt the selected access token only after all prior gates and refresh expired credentials through existing refresh service.
  - **Request parsing:** preserve Slack-shaped payloads. For GET, forward query parameters except Prism-only diagnostics/auth headers and never forward Prism bearer tokens as Slack `token`. For POST JSON, parse/forward JSON objects for methods such as `chat.postMessage`; invalid JSON should produce Slack-compatible `invalid_json`/`json_not_object` without upstream. For form POST, forward `URLSearchParams`. Reject/defer multipart/file content upload.
  - **Representative methods:** support current approved registry methods across `conversations.*`, `chat.postMessage/update/delete`, `reactions.*`, `search.messages`, and `files.info/list`; do not broaden registry silently.
  - **Response adaptation:** successful Slack bodies pass through unchanged using `slackSuccessResponse` semantics. Ordinary upstream Slack errors (`ok:false`) also pass through in Slack-compatible form with Prism diagnostics headers. Preserve pagination (`response_metadata.next_cursor`), Slack IDs, timestamps, channel IDs, user IDs, reaction/file metadata fields.
- Alternatives considered and rejected:
  - **Route-local fetch to Slack:** rejected because it would duplicate credential/rate-limit/request adaptation concerns and become hard to audit.
  - **Real Slack first:** rejected for this slice because mocked upstream must be default and local/dev/tests must not require Slack app configuration.
  - **SDK wrapper:** rejected unless justified; injected `fetch` matches existing OAuth client and avoids new dependency surface.
  - **Forward by Slack scopes:** rejected; scopes are app maximums, not Prism policy.

## Regression checklist

- Behavior: Existing focused tests for registry, policy, identity, response adapter, and route remain green.
- Behavior: `/v1/slack/api/[method]` remains bearer-only, no-store, request-ID stamped, and Slack-shaped for auth/denied/unsupported responses.
- Behavior: Malformed Prism tokens still fail before DB lookup.
- Behavior: Denied/unsupported/deferred/admin/file-content paths do not select credential envelopes, decrypt credentials, refresh tokens, or call upstream.
- Behavior: `X-Prism-Execution-Mode` semantics remain fail-closed and selectable-only.
- Behavior: Allowed representative methods now return mocked Slack-shaped responses by default instead of `slack_forwarding_not_implemented`.
- Behavior: Successful and ordinary Slack error bodies are not Prism-wrapped; diagnostics appear in headers.
- Behavior: No secrets appear in response bodies, headers, logs, thrown errors, test snapshots, or SQL selected for pre-forwarding decisions.
- Behavior: `docs/slack/README.md` no longer falsely says all Slack API upstream forwarding is deferred once issue #9 lands.
- Behavior: `npm test` and `npm run build` remain green; dependency guard remains green.

## Test plan

- Existing tests to keep green:
  - `src/server/slack/method-registry.test.ts`
  - `src/server/token-profiles/method-policy.test.ts`
  - `src/server/token-profiles/execution-identity.test.ts`
  - `src/server/slack/response-adapter.test.ts`
  - `app/v1/slack/api/[method]/route.test.ts`
  - `src/server/token-profiles/local-tool-status.test.ts`
  - `src/server/token-profiles/local-tool-capabilities.test.ts`
  - Slack OAuth/client/refresh/encryption tests, dependency guard, config, health, and build.
- New tests to add before/with implementation:
  - Mock upstream client unit tests for representative success and error bodies: conversations list/history/replies, `chat.postMessage`, `chat.update`, `chat.delete`, reactions add/remove/get, `search.messages`, `files.info`, and `files.list`.
  - Forwarding service tests asserting exact pipeline order, including no-op rate-limit seam before credential retrieval/upstream.
  - Request-shape tests for GET query, JSON POST, form POST, invalid JSON, non-object JSON, and rejected/deferred multipart/file-content upload.
  - Route tests proving allowed calls use mocked upstream by default, preserve Slack-shaped success bodies/cursors/IDs, and set `X-Prism-Upstream-Called:true`, `X-Prism-Execution-Mode`, and request diagnostics headers.
  - Route/service tests proving ordinary upstream errors pass through as `ok:false,error:<slack_error>` with Prism diagnostics headers and no wrapping.
  - No-secret tests for successful mock responses, upstream errors, headers, logs/errors if captured, and SQL paths. Denied paths must still not select `access_token_envelope`/`refresh_token_envelope`.
  - Real-client unit tests with injected `fetch` only, verifying Slack `Authorization` uses server-held access token and strips any Local-tool Prism token/payload `token` field from outbound requests.
  - Credential retrieval/refresh tests using encrypted canary tokens proving decryption happens only after all gates and with the existing AAD convention.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - Start local app with mock OAuth/upstream defaults, create/link a mock Slack connection and Prism developer token, then `curl` representative `/v1/slack/api/conversations.list`, `/chat.postMessage`, `/reactions.add`, `/search.messages`, and `/files.info` using only `Authorization: Bearer prism_dev_...`.
  - Capture response bodies showing Slack-shaped `ok:true` or ordinary `ok:false`, preserved IDs/cursors, and headers showing `X-Prism-Request-ID`, `X-Prism-Execution-Mode`, `X-Prism-Upstream-Called:true`.
  - Capture a denied/admin/file-content call proving `X-Prism-Upstream-Called:false`.
  - Capture no-secret proof: no `xox`, refresh/access token, pepper, token hash, or Prism developer token in responses/headers/log excerpts.

## Risk assessment

- Risk: Moving too much logic into the route creates a parallel forwarding path around future audit/rate-limit systems.
- Risk: Credential retrieval added to token resolution would leak envelope access into policy/status/capability paths.
- Risk: Mock upstream could drift from Slack shape and hide compatibility bugs.
- Risk: Payload parsing could accidentally drop Slack pagination cursors, IDs, form-encoded array fields, or JSON body structure.
- Risk: Passing through upstream errors without careful headers could expose server-held Slack tokens or omit Prism request diagnostics.
- Risk: Real Slack mode could accidentally become required for local/dev/tests.
- Mitigation: Keep forwarding in one server-only service and client abstraction, default to mock, add order/no-secret/request-shape tests, and update docs to describe representative forwarding only.

## Decision confidence

- Confidence: high
- Reasons:
  - The pre-forwarding route, registry, policy evaluator, execution identity resolver, safe token metadata, credential custody modules, and response adapter already exist and are tested.
  - The insertion point is unambiguous: replace the allowed tracer branch after identity resolution.
  - No existing Prism-side rate-limit implementation was found; a no-op seam is the correct integration-preserving step for issue #9 without pretending enforcement exists.
  - Slack Web API conventions are straightforward for the representative non-file-content methods: RPC method URL, query/form/json args, top-level `ok`, and `error` for failures.
- Open questions:
  - Exact mock response fixtures should be chosen by the implementer, but they should remain representative and Slack-shaped rather than exhaustive.
  - Whether real Slack forwarding is included behind an explicit config flag in this slice is optional; it must not be required for default local/dev/test acceptance.
  - Future issue #12 should replace the no-op rate-limit seam with real policy/state, and future audit work should hook into the same forwarding service rather than the route.
