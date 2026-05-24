# Architecture Integration Brief: real-slack-forwarding-client

## Existing ownership

- Package/component/module/library:
  - **Slack-compatible route boundary:** `app/v1/slack/api/[method]/route.ts` owns `GET`/`POST /v1/slack/api/{method}` and the ordered route gate: Prism developer token policy, Method registry classification, Execution identity resolution, and handoff to `forwardSlackMethod` (`route.ts:21-79`).
  - **Forwarding orchestration:** `src/server/slack/forwarding.ts` owns post-policy request parsing, local `token` stripping, Prism-side rate limit check, pre-upstream audit attempt, upstream client call, audit outcome update, selected upstream header pass-through, and Prism diagnostics headers (`forwarding.ts:27-107`, `forwarding.ts:110-189`).
  - **Slack Web API client seam:** `src/server/slack/web-api-client.ts` owns the `SlackWebApiClient` interface and default client factory. It is the current production-readiness fault: `createDefaultSlackWebApiClient()` unconditionally returns `new MockSlackWebApiClient()` (`web-api-client.ts:20-26`).
  - **Method registry:** `src/server/slack/method-registry.ts` owns supported/unsupported/deferred method classification and capability projection. Current supported representative methods include conversations, users, search, chat, reactions, and files metadata; admin/events/interactivity/file transfer/canvases/lists/future paths remain unsupported or deferred (`method-registry.ts:50-155`).
  - **Token profile policy and token resolution:** `src/server/token-profiles/method-policy.ts` owns bearer-token resolution, workspace/surface/capability checks, Slack connection metadata propagation, and fail-closed policy decisions (`method-policy.ts:61-112`). `src/server/token-profiles/local-tool-status.ts` owns safe developer-token resolution/status/capabilities and intentionally exposes only credential presence booleans, not encrypted envelopes (`local-tool-status.ts:7-33`, `local-tool-status.ts:160-180`).
  - **Execution identity:** `src/server/token-profiles/execution-identity.ts` owns `X-Prism-Execution-Mode` parsing and final concrete `user`/`bot` selection from the allowed policy decision (`execution-identity.ts:21-50`).
  - **Slack credential custody:** `src/server/slack/oauth-flow.ts`, `src/server/slack/postgres-store.ts`, `src/server/slack/refresh.ts`, `src/server/credentials/encryption.ts`, and `src/server/credentials/factory.ts` own encrypted Slack credential envelopes, AAD conventions, refresh, and Reauth-required state (`oauth-flow.ts:192-218`, `postgres-store.ts:82-127`, `refresh.ts:32-84`, `encryption.ts:5-69`, `factory.ts:6-9`).
  - **Config:** `src/server/config.ts` owns current env parsing. Slack OAuth mock is explicitly configured by `PRISM_SLACK_OAUTH_MOCK === "1"` and disabled in production; there is no equivalent Web API mock/real mode config today (`config.ts:47-91`).
  - **Rate limits:** `src/server/slack/rate-limit.ts`, `src/server/slack/postgres-rate-limit-store.ts`, and migration `db/migrations/0005_slack_forwarding_rate_limits.sql` own Prism-side per-Token-profile/per-method rate limits (`rate-limit.ts:36-69`, `postgres-rate-limit-store.ts:13-90`, migration lines 1-15).
  - **Metadata-only audit:** `src/server/audit/activity.ts` owns audit record shape and object metadata extraction without payload/secret content (`activity.ts:29-120`, `activity.ts:122-140`). `src/server/audit/postgres-store.ts` owns persistence.
  - **Tests:** `src/server/slack/forwarding.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, `src/server/slack/rate-limit.test.ts`, `src/server/slack/refresh.test.ts`, `src/server/credentials/encryption.test.ts`, policy/identity/method-registry tests, config tests, and dependency guard tests own regression coverage.
- Current owner rationale:
  - `CONTEXT.md` defines the **Prism hosted service** as the confidential owner of Slack OAuth callbacks, Slack credential custody, policy enforcement, Slack API forwarding, rate limits, and Metadata-only audit (`CONTEXT.md:15-17`, `CONTEXT.md:59-68`). The real Slack client therefore belongs in server-only Slack forwarding/custody modules, not in Local tools, browser routes, or Token profile/status responses.
  - The route and forwarding service already express the correct architectural pipeline; the slice should replace the mock-only upstream client and add credential retrieval at the existing post-gate client seam, not create a parallel proxy path.
- Source evidence:
  - Current route tests already assert denied/unsupported/auth-failed/reauth paths do not query credential envelopes and do not consume rate limits (`route.test.ts:110-137`, `route.test.ts:389-444`).
  - Current forwarding tests assert local `token` payload stripping, no upstream on invalid JSON/rate-limit/audit-unavailable, metadata-only audit, Slack-shaped pass-through, and upstream 429 header pass-through (`forwarding.test.ts:19-95`, `forwarding.test.ts:97-148`, `forwarding.test.ts:202-289`).

## Existing interaction model

- User/system behaviors that already exist:
  - Local tools call Slack-compatible endpoints with `Authorization: Bearer prism_dev_...`; malformed/missing bearer tokens fail before DB lookup (`local-tool-status.ts:160-180`, `route.test.ts:373-387`).
  - The route evaluates Token profile policy and Method registry before selecting an Execution identity or forwarding (`route.ts:29-79`).
  - Policy-denied, unsupported, malformed-token, revoked/expired-token, reauth-gated, invalid execution mode, and non-selectable execution mode paths return Slack-compatible `ok:false` responses with `X-Prism-Upstream-Called:false` and no credential envelope access (`route.test.ts:110-220`, `route.test.ts:389-444`).
  - Allowed calls currently pass through `forwardSlackMethod`, which parses GET query, JSON POST, and form POST payloads; rejects invalid/non-object JSON and multipart; strips local `token` fields; checks Prism-side rate limits; records a metadata-only audit attempt before upstream; calls the client; records the outcome; preserves Slack bodies and selected upstream headers (`forwarding.ts:44-107`, `forwarding.ts:110-189`).
  - Prism-side 429s happen before upstream and set `X-Prism-Upstream-Called:false`; upstream Slack 429s pass through status/body plus `Retry-After` and `X-Slack-Req-Id` with `X-Prism-Upstream-Called:true` (`route.test.ts:309-370`, `forwarding.test.ts:202-246`).
  - Audit stores metadata only: request/user/profile/workspace/method/category/status/error/request ID and selected object IDs, not Slack payloads, message text, Block Kit, search results, Local-tool tokens, or Slack credentials (`activity.ts:29-55`, `activity.ts:88-120`; `route.test.ts:447-475`).
  - Mock upstream QA currently exists by default and returns representative IDs such as `C-MOCK-GENERAL` (`web-api-client.ts:24-79`; `route.test.ts:139-169`, `route.test.ts:222-283`).
- Behaviors that must remain unchanged:
  - Bearer-only Prism developer token auth; no cookies/query tokens/Slack tokens from Local tools for `/v1/slack/api/{method}`.
  - Method registry, Token profile policy, Execution identity resolution, Prism-side rate limit, and required pre-upstream audit attempt must remain before any real Slack side effect.
  - Denied/unsupported/auth-failed/identity-denied/Prism-rate-limited/parse-error/audit-unavailable paths must not call Slack, select credential envelopes, decrypt tokens, refresh tokens, or leak secrets.
  - Success and ordinary Slack error bodies must remain Slack-shaped and unwrapped; Prism diagnostics stay in headers.
  - Metadata-only audit must stay payload-free and secret-free.
  - Upstream Slack 429 must remain distinct from Prism-side 429 and must preserve Slack retry headers where practical.
  - Mock behavior must remain available only when explicitly configured for local/mock testing and disabled in production.
- Runtime or UX evidence:
  - `README.md` and `docs/setup.md` describe Local tools receiving only Prism developer tokens and using Prism endpoints, while Slack credentials stay in Prism hosted service custody (`README.md:1-4`, `docs/setup.md:1-23`).
  - `.env.example` has an explicit non-production OAuth mock flag but no Web API mock flag (`.env.example:32-34`).
- Conflicts between docs and code:
  - `CONTEXT.md` and product docs describe the Prism hosted service as owner of Slack API forwarding, and `docs/setup.md` describes Slack-compatible endpoint calls as forwarded behavior (`CONTEXT.md:15-17`, `docs/setup.md:57-94`), but current default runtime always uses mock upstream data (`web-api-client.ts:24-26`).
  - `docs/slack/README.md` explicitly says issue #9 forwarding has a default mocked upstream (`docs/slack/README.md:7`). That statement is accurate today but conflicts with the production-readiness goal and must be updated after implementation.
  - Prior issue #9 architecture intentionally recommended default mock upstream; that decision is superseded for this slice. Keep mock as explicit local/test mode only.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep `app/v1/slack/api/[method]/route.ts` as the thin HTTP boundary and keep `forwardSlackMethod` as the post-policy forwarding owner.
  - Extend `src/server/slack/web-api-client.ts` rather than introducing a Slack SDK or route-local fetch. Existing OAuth client uses injected `fetchImpl` and no Slack SDK dependency (`oauth-client.ts:37-78`); dependency guard currently protects server-only custody modules (`dependency-guard.test.ts:17-34`).
  - Add explicit Web API mock/real config in `src/server/config.ts`, following the existing non-production-only OAuth mock convention. Recommended name: `PRISM_SLACK_WEB_API_MOCK=1` or `PRISM_SLACK_FORWARDING_MODE=mock`; production must ignore/refuse mock mode.
  - Add a server-only forwarding credential provider/store beside custody, e.g. in `src/server/slack/postgres-store.ts` or a small sibling module. It should accept `{ connectionId, kind }` and return only the selected credential metadata/envelopes needed by forwarding. Do not add encrypted envelopes to `resolveDeveloperToken` or status/capabilities bodies.
  - Reuse `createConfiguredCredentialCipher()` and existing AAD convention `slack-connection:${connectionId}:${kind}:access` to decrypt access tokens (`oauth-flow.ts:207-214`, `refresh.ts:53-55`).
  - Reuse `refreshSlackCredential` and `createPostgresRefreshStore(database)` to refresh expired/near-expired credentials and mark Reauth required on unrecoverable refresh failures (`refresh.ts:32-84`, `postgres-store.ts:82-127`).
  - Preserve existing client injection seams in `forwardSlackMethod({ client, rateLimiter, audit })` for unit tests (`forwarding.ts:27-43`). For route tests, switch from implicit default mock to explicit mock config or module-level factory mock.
  - Extend the `SlackWebApiCall` shape to include server-held credential material or, preferably, have the forwarding service resolve/decrypt credentials and pass an `accessToken` only to the real client. Also include request encoding information (`query`, `json`, `form`) because the current `httpMethod` + parsed payload loses original POST content-type (`web-api-client.ts:7-18`, `forwarding.ts:87-92`, `forwarding.ts:110-129`).
- Relevant docs or library capabilities:
  - Slack Web API uses RPC-style endpoints at `https://slack.com/api/{method}`. Send server-held Slack access tokens via `Authorization: Bearer <xox...>` to Slack only, never in Local-tool response bodies or logs.
  - For GET, forward sanitized payload as query parameters. For POST JSON, send `Content-Type: application/json` and JSON body. For POST form/default, send `application/x-www-form-urlencoded` with `URLSearchParams`. Preserve repeated query/form fields where possible.
  - Read Slack response JSON and pass ordinary Slack bodies/status through. Copy only selected safe upstream headers (`Retry-After`, `X-Slack-Req-Id`) unless a later slice explicitly broadens header pass-through.
- Existing examples in this codebase:
  - OAuth callback chooses mock vs real OAuth client from explicit config and encrypts both bot/user credentials with AAD (`app/v1/slack/oauth/callback/route.ts:17-30`, `oauth-flow.ts:139-140`, `oauth-flow.ts:192-218`).
  - Refresh tests use canary tokens to prove decrypted token values are not persisted or leaked (`refresh.test.ts:39-86`, `refresh.test.ts:88-136`).
  - Forwarding and route tests already provide injected clients/rate limiters and DB mocks for proving ordering and no-secret behavior (`forwarding.test.ts:19-95`, `route.test.ts:66-108`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass the Method registry with a route-local allowlist or “let Slack decide” proxying for unknown methods.
  - Do not bypass Token profile policy, workspace/surface checks, mutation/destructive policy, or Execution identity resolution.
  - Do not bypass Prism developer token hashing/resolution with cookies, query tokens, JWTs, plaintext token comparison, or Slack-token passthrough.
  - Do not bypass encrypted credential custody by storing plaintext Slack tokens, adding credential envelopes to Token profile resolution/status/capability responses, or returning Slack credentials to Local tools/browser responses.
  - Do not bypass Prism-side rate limits, Metadata-only audit, or audit-unavailable fail-closed behavior before real Slack side effects.
  - Do not replace the existing injected-fetch convention with a Slack SDK unless a separate dependency review justifies it and dependency guards are intentionally updated.
- Shortcuts or parallel paths to avoid:
  - No route-local `fetch("https://slack.com/api/...")` directly from `[method]/route.ts`.
  - No mock-by-default fallback when real config is missing in normal dev/production. Missing real forwarding config should fail safely with setup/reauth-style Slack-compatible error; tests/local mock QA must opt in explicitly.
  - No auto-join, invite, DM open, membership repair, retry with another identity, or fallback from user credential to bot credential after Slack denial. Use the resolved concrete identity only.
  - No forwarding admin/org/deferred/file-content/multipart methods beyond the Method registry.
  - No request/response/log/audit leakage of `prism_dev_`, token hashes, peppers, `xox[bp]-`, refresh/access tokens, Slack client secrets, Authorization headers, message text, Block Kit, search result content, or file contents.
- Invariants:
  - Mandatory ordered pipeline: developer token verification -> Method registry classification -> Token profile policy -> Execution identity resolution -> payload parse -> Prism-side rate limit -> metadata-only audit attempt -> selected credential retrieval/refresh/decrypt -> Slack Web API call -> response adapter -> audit outcome update/log-safe failure handling.
  - `X-Prism-Upstream-Called:false` for all paths with no Slack call; `true` only after a real or explicitly configured mock upstream call.
  - The selected Slack credential kind must match the resolved `identity.executionMode` exactly.

## Integration plan

- Insert the change at:
  - `src/server/config.ts`: add explicit Slack Web API forwarding mode config. Recommended behavior: real client by default; mock allowed only when `PRISM_SLACK_WEB_API_MOCK=1` and `NODE_ENV !== "production"` (or equivalent explicit mode). Add `.env.example` and docs updates explaining mock is local-only.
  - `src/server/slack/web-api-client.ts`: add `FetchSlackWebApiClient` (or `RealSlackWebApiClient`) using injected `fetchImpl`, Slack method URL, `Authorization: Bearer ${accessToken}`, sanitized payload encoding, JSON response parsing, safe network/error classification, and selected header preservation. Keep `MockSlackWebApiClient`, but make `createDefaultSlackWebApiClient()` choose it only when explicit mock config allows it.
  - `src/server/slack/forwarding.ts`: keep the existing orchestration owner. Extend payload parsing to return encoding metadata. After rate limit and successful pre-upstream audit insert, resolve/decrypt the selected Slack credential using `identity.slackConnectionId` and `identity.executionMode`, optionally refresh if expired/near-expired, and then call the client with the access token. Preserve existing audit-unavailable fail-closed behavior before credential retrieval and upstream call.
  - `src/server/slack/postgres-store.ts` or a new server-only forwarding credential store: add a narrow method for forwarding credential selection by `connectionId + kind`. It may reuse `createPostgresRefreshStore` for reads/refresh, but keep a forwarding-facing type so the client/route do not learn custody internals.
  - `src/server/slack/refresh.ts`: reuse, do not duplicate. If forwarding detects expired credentials, call refresh using the existing store/cipher/OAuth client, then re-read/decrypt the refreshed access token. If refresh returns `reauth_required` or credential is missing, return a Slack-compatible failure without upstream and with no token leakage.
  - Tests: update route tests that currently rely on default mock to opt into explicit mock. Add real-client and credential-provider tests before changing defaults.
- Why this is the correct integration point:
  - The current fault is exactly the default client factory and absence of credential-aware real client; all surrounding gates already exist and are tested.
  - `forwardSlackMethod` already centralizes rate limit, audit, payload normalization, response adaptation, and test injection. Adding credential access/client call here avoids parallel behavior in the route.
  - Credential custody already owns encrypted token storage and refresh; forwarding should consume that custody API, not add new persistence.
- How to select/decrypt bot/user credential:
  - Require `identity.slackConnectionId`; if absent, return `{ ok:false, error:"not_authed" }` or `{ ok:false, error:"reauth_required" }` with `X-Prism-Upstream-Called:false` and metadata-only audit outcome. Prefer a Prism error class such as `slack_credential_unavailable` only in audit/diagnostics, not secret-bearing body fields.
  - Use `identity.executionMode` as `kind`. Do not inspect payload/method to choose credentials after identity resolution.
  - Fetch credential row for `{ connectionId: identity.slackConnectionId, kind }`; refresh first if `expiresAt` is at/before now or within a small skew; decrypt `accessTokenEnvelope` with AAD `slack-connection:${connectionId}:${kind}:access`; pass plaintext only in memory to `FetchSlackWebApiClient`.
  - Never include access tokens in thrown error messages; catch and map decryption/refresh/network failures to sanitized Slack-compatible errors and audit error classes.
- How to preserve mock mode only when explicitly configured:
  - Add tests proving `createDefaultSlackWebApiClient()` returns/uses real mode when no mock env is set, and mock mode only with explicit non-production env.
  - Production must not allow mock even if the env flag is set. Prefer throwing sanitized setup/config error at startup/call time or ignoring mock flag in production and requiring real config.
  - Existing local/mock QA docs should instruct setting the explicit mock flag; default `.env.example` should not enable it.
- How to call Slack Web API:
  - Construct `https://slack.com/api/${method}` for registry-approved method names only.
  - For GET: append sanitized payload fields as query parameters; append repeated values for array payload entries; no body.
  - For POST JSON: send JSON object body and `Content-Type: application/json; charset=utf-8`.
  - For POST form/default: send `URLSearchParams`, repeated keys for arrays, and `Content-Type: application/x-www-form-urlencoded`.
  - Always set Slack Authorization from server-held credential. Never forward Local-tool `Authorization`, local payload `token`, Prism diagnostics headers, or browser cookies to Slack.
  - Parse response JSON when possible. For non-JSON/malformed Slack response, return sanitized `{ ok:false, error:"slack_bad_response" }` with a 502-like status; for network errors, return `{ ok:false, error:"slack_unavailable" }` with sanitized status. Preserve upstream Slack `ok:false,error:*` bodies/statuses without Prism wrapping.
- Alternatives considered and rejected:
  - **Route-local real fetch:** rejected because it bypasses forwarding owner, credential custody seam, audit/rate-limit ordering, and test injection.
  - **Expose encrypted credential envelopes via `resolveDeveloperToken`:** rejected because Local-tool status/capabilities and policy should remain safe metadata only.
  - **Keep mock default with optional real flag:** rejected by the production-readiness goal; normal local/dev/production after real OAuth must perform real Slack forwarding.
  - **Slack SDK dependency:** rejected for this slice because existing code uses injected fetch and no current need requires SDK surface area.

## Regression checklist

- Behavior: All existing Method registry, policy, execution identity, forwarding, route, rate-limit, refresh, encryption, audit, config, dependency guard, docs guard, and UI tests remain green.
- Behavior: Allowed calls with real mode and valid stored credential call Slack using the resolved `user` or `bot` credential and produce real Slack side effects for write methods.
- Behavior: Explicit mock mode still returns representative mock Slack-shaped responses for local/mock QA, but only when configured and never in production.
- Behavior: Policy-denied/unsupported/auth-failed/invalid execution mode/reauth/Prism-rate-limited/parse-error/audit-unavailable paths perform no credential retrieval, decryption, refresh, or upstream call.
- Behavior: Rate limit is checked before credential retrieval/upstream; Prism 429 has `X-Prism-Upstream-Called:false`.
- Behavior: Required pre-upstream audit insert still happens before credential retrieval/upstream; audit-unavailable returns 503/no upstream.
- Behavior: Audit remains metadata-only and stores selected object IDs only, not payload text/content/search results/tokens.
- Behavior: Slack success and ordinary Slack errors remain unwrapped; Prism diagnostics remain headers.
- Behavior: Upstream Slack 429 preserves Slack status/body/`Retry-After`/`X-Slack-Req-Id` and has `X-Prism-Upstream-Called:true`.
- Behavior: Missing/expired/unrefreshable/decryption-failed credentials fail safely with sanitized Slack-compatible response, audit outcome, and no token leakage.
- Behavior: No Slack credentials, Prism developer tokens, token hashes, peppers, client secrets, refresh tokens, or access tokens appear in responses, headers, logs, thrown errors, snapshots, or docs.
- Behavior: Docs no longer imply default mock upstream is production behavior.

## Test plan

- Existing tests to keep green:
  - `src/server/slack/forwarding.test.ts`
  - `app/v1/slack/api/[method]/route.test.ts`
  - `src/server/slack/rate-limit.test.ts`
  - `src/server/slack/postgres-rate-limit-store.test.ts`
  - `src/server/slack/refresh.test.ts`
  - `src/server/slack/oauth-flow.test.ts`, `src/server/slack/oauth-client.test.ts`
  - `src/server/credentials/encryption.test.ts`
  - `src/server/token-profiles/method-policy.test.ts`, `execution-identity.test.ts`, `local-tool-status.test.ts`, `local-tool-capabilities.test.ts`, `developer-token.test.ts`, store/service tests
  - `src/server/audit/activity.test.ts`, `src/server/audit/postgres-store.test.ts`
  - `src/server/config.test.ts`, `src/server/dependency-guard.test.ts`, docs guard tests, full `npm test`, and `npm run build`.
- New tests to add before/with implementation:
  - Config tests for explicit Web API mock mode: default real, mock only when env flag/mode is set and `NODE_ENV !== "production"`, sanitized setup errors, no secret echoing.
  - `FetchSlackWebApiClient` unit tests with injected `fetchImpl` proving:
    - Slack URL is `https://slack.com/api/{method}`.
    - Server-held access token is sent only as Slack `Authorization: Bearer xox...`.
    - GET query, POST JSON, and POST form shapes are correct, including repeated array fields.
    - Local-tool `token` fields and Prism bearer/diagnostic headers are not forwarded.
    - Slack success, ordinary `ok:false`, upstream 429 headers, network errors, and non-JSON responses map correctly without secret leakage.
  - Forwarding credential-provider tests with encrypted canary bot/user credentials proving:
    - credential retrieval/decrypt happens only after parse success, policy/identity (via route or service harness), rate-limit allow, and audit attempt success;
    - selected credential kind matches `identity.executionMode`;
    - expired credentials call `refreshSlackCredential`, re-read refreshed access envelope, and mark Reauth required on refresh failure;
    - missing/decryption-failed credentials return sanitized no-upstream or no-real-upstream error and no plaintext leak.
  - Route tests updated so mock upstream requires explicit mock env/module setup; add a real-mode route/service test that injects fake fetch/credential store and proves no `C-MOCK-*` response appears by default.
  - No-secret regression tests over responses, headers, logs/errors, audit records, SQL queries, and docs/config examples.
  - Ordering tests proving policy-denied and Prism-rate-limited paths do not query `slack_credentials` and real-mode allowed paths query credentials only after `slack_forwarding_rate_limits` and audit insert.
- TDD sequence recommendations:
  1. Write failing config/factory tests that default mode is real and mock requires explicit non-production config.
  2. Write failing real Web API client injected-fetch tests for GET/JSON/form, Authorization, response/429/error handling, and no secret forwarding.
  3. Write failing forwarding credential-selection/order tests using encrypted canaries and fake stores.
  4. Implement real client and config factory with mock opt-in.
  5. Implement credential provider/decrypt/refresh inside `forwardSlackMethod` after rate limit and audit attempt.
  6. Update existing mock route tests to opt into mock and add default-real regression.
  7. Run focused tests, then full `npm test` and `npm run build`.
- Live proof required:
  - Start Prism with real Slack OAuth config and no Web API mock flag. Complete real Slack linking and create a Token profile with the narrowest required capabilities.
  - `curl -i /v1/prism/status` and `/v1/prism/capabilities` with the Prism developer token showing healthy Slack, available execution identity, and no secrets.
  - Call a safe read method such as `conversations.list` and verify real workspace channel IDs/names are returned, not `C-MOCK-*`; capture `X-Prism-Upstream-Called:true`, `X-Prism-Execution-Mode`, and `X-Prism-Request-ID`.
  - Call a controlled write method such as `chat.postMessage` to a test channel with resolved bot/user identity and verify the message appears in Slack; capture response `ok:true`, real channel/ts, and no secret leakage.
  - Trigger a policy-denied method and a Prism-side rate limit showing `X-Prism-Upstream-Called:false` and no Slack side effect.
  - If possible, trigger or simulate upstream Slack 429 with injected fetch/staging proof showing Slack `Retry-After` pass-through and `X-Prism-Upstream-Called:true`.
  - Review audit UI/DB metadata for request IDs/status/object IDs only; confirm message text and tokens are absent.

## Risk assessment

- Risk: Real writes could create Slack side effects before audit if ordering is changed. Mitigation: preserve audit attempt before credential retrieval/upstream and test audit-unavailable fail-closed.
- Risk: Credential retrieval might be added to token resolution/status/capabilities and leak custody internals. Mitigation: add a forwarding-only server-only credential provider and negative tests on safe metadata queries.
- Risk: Default mock may accidentally remain in normal dev/production, hiding failed real forwarding. Mitigation: config tests and live proof requiring non-`C-MOCK-*` results without mock flag.
- Risk: Mock mode could be enabled in production. Mitigation: production guard in config/factory tests.
- Risk: User/bot identity could drift or fallback to the wrong credential. Mitigation: tests for selectable/user/bot/automatic identity using distinct encrypted canary tokens.
- Risk: Refresh flow could leak refresh/access tokens in thrown errors or logs. Mitigation: catch/map sanitized errors and no-secret log/response tests.
- Risk: Payload encoding changes could break Slack-compatible calls, especially repeated form/query fields, JSON arrays, or search query values. Mitigation: client request-shape tests.
- Risk: Upstream non-JSON/network failures could break route responses or expose implementation details. Mitigation: sanitized `slack_unavailable`/`slack_bad_response` mapping tests.
- Risk: Docs/tests relying on mock IDs may become stale. Mitigation: update docs to separate explicit mock QA from production forwarding and update route tests to opt into mock mode.
- Risk: Adding fetch/Slack behavior may make unit tests flaky if real network is used. Mitigation: all tests use injected `fetchImpl` or explicit mock; live Slack proof is separate manual/live QA.

## Decision confidence

- Confidence: high
- Reasons:
  - The correct insertion point is unambiguous: `createDefaultSlackWebApiClient()` is the mocked default, and `forwardSlackMethod` is already the tested orchestration owner.
  - Credential custody, encryption AAD, refresh, execution identity, policy, rate limit, audit, and response-adapter systems already exist and have targeted tests.
  - The product/domain boundary is clear: Local tools never receive Slack credentials; the Prism hosted service must call Slack with server-held credentials after policy and identity selection.
  - Implementing with injected `fetch` follows existing OAuth client conventions and avoids new dependency risk.
- Open questions:
  - Exact env naming should be chosen once and documented (`PRISM_SLACK_WEB_API_MOCK` vs `PRISM_SLACK_FORWARDING_MODE`). Recommendation: explicit boolean mock flag mirroring `PRISM_SLACK_OAUTH_MOCK`, with production disabled.
  - Exact Slack-compatible error string for missing/decryption-failed credentials should be standardized. Recommendation: use Slack-like `not_authed` or `invalid_auth` body with sanitized Prism/audit error class if diagnostics are needed, and mark/reflect **Reauth required** where refresh proves authorization is no longer valid.
  - Whether to refresh only after expiry or with a safety skew should be implementation-defined and tested. Recommendation: small skew (for example 60 seconds) to avoid near-expiry writes failing mid-call.

## Live QA addendum: Enterprise Grid workspace selection

- Finding:
  - Real Slack QA against an Enterprise Grid/org-level install produced `missing_argument` from `conversations.list` until a concrete workspace `team_id` was supplied.
  - The existing public Prism affordance for workspace selection is `X-Prism-Workspace-ID`, already read by the route and policy layer. The forwarding layer should reuse that header as the Slack Web API `team_id` when the Local tool supplies it and the payload does not already contain `team_id`.
- Integration adjustment:
  - Keep policy ownership in `app/v1/slack/api/[method]/route.ts` / `method-policy.ts`; do not create a route-local Slack API path.
  - In `forwardSlackMethod`, after parsing and local-token stripping, merge `X-Prism-Workspace-ID` into the sanitized Slack payload as `team_id` when present. This preserves the existing Local tool header affordance and avoids asking Local tools to duplicate workspace identity in query/body payloads.
  - Existing `checkWorkspace` remains the enforcement point for non-org linked workspaces. For Enterprise Grid connections with no stored team ID, Slack still enforces team access using the supplied `team_id`.
- Added regression requirement:
  - Test that `X-Prism-Workspace-ID: T...` becomes `team_id` in the upstream Slack payload, does not override an explicit payload `team_id`, and does not forward Prism credentials or diagnostics.
