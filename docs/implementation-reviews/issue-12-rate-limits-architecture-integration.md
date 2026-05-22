# Architecture Integration Brief: issue-12-rate-limits

## Existing ownership

- Package/component/module/library:
  - `app/v1/slack/api/[method]/route.ts` owns the Slack-compatible HTTP boundary, request ID creation, developer-token policy gate, execution identity gate, policy/identity audit, and handoff to forwarding.
  - `src/server/slack/forwarding.ts` owns post-policy Slack request parsing, the existing `SlackForwardingRateLimiter` seam, forwarding audit attempt/outcome, upstream Slack client invocation, and Slack-compatible response return.
  - `src/server/slack/response-adapter.ts` owns Prism diagnostics headers (`Cache-Control`, `X-Prism-Request-ID`, `X-Prism-Policy-Decision`, `X-Prism-Upstream-Called`, `X-Prism-Execution-Mode`).
  - `src/server/slack/web-api-client.ts` owns the `SlackWebApiClient` result shape used to pass upstream status/body back to forwarding; it does not currently expose upstream headers.
  - `src/server/audit/activity.ts` and `src/server/audit/postgres-store.ts` own Metadata-only audit shape and persistence; `rate_limited` already exists as an activity status.
  - Plain Postgres migrations in `db/migrations/` own durable shared state; ADR 0001 explicitly lists rate-limit state as a v1 Postgres requirement.
- Current owner rationale:
  - `CONTEXT.md` defines the Prism hosted service as owner of Slack API forwarding, rate limits, credential custody, policy enforcement, and Metadata-only audit.
  - Issue #9 created the forwarding seam in `forwardSlackMethod`; issue #12 should fill that seam instead of moving limit logic into the route.
  - Existing focused baseline passed: `npm test -- --run src/server/slack/forwarding.test.ts app/v1/slack/api/[method]/route.test.ts --reporter=dot` (2 files, 14 tests).
- Source evidence:
  - `forwardSlackMethod` parses payload first, then invokes `rateLimiter({ tokenProfileId, method, executionMode, requestId })`, then records audit attempt, then calls `client.callMethod`.
  - Route code performs `evaluateSlackMethodPolicy` and `resolveSlackExecutionIdentity` before `forwardSlackMethod`, so malformed/missing tokens, denied policy, revoked/expired tokens, and identity failures do not enter the forwarding rate-limit seam.
  - `prism_activity_audit` has `status IN (..., 'rate_limited', ...)` and `upstream_called boolean`.

## Existing interaction model

- User/system behaviors that already exist:
  - Local tools call `/v1/slack/api/{method}` with a Prism developer bearer token and Slack-shaped GET/form/JSON payloads.
  - Malformed bearer tokens fail before DB lookup; policy-denied, unsupported, revoked, expired, reauth-gated, and identity-denied requests stop before forwarding and set `X-Prism-Upstream-Called:false`.
  - Malformed Slack JSON is parsed inside forwarding, audited as `parse_error` when audit is present, and stops before upstream.
  - Allowed calls create an audit attempt before upstream; upstream outcomes update the same audit record as `forwarded` or `upstream_error` with `upstreamCalled:true`.
  - Successful and ordinary upstream Slack error bodies pass through without Prism body wrapping, with Prism diagnostics in headers.
- Behaviors that must remain unchanged:
  - No Slack call, credential selection, credential decryption, or rate-limit accounting before token/profile policy and execution identity pass.
  - Denied/malformed/revoked/expired/unsupported requests must not consume Prism-side rate-limit buckets.
  - Local-tool payload `token` fields must continue to be stripped from upstream payloads and never audited.
  - Slack response bodies and status, especially upstream Slack `429`, must remain Slack-shaped wherever practical.
  - Audit must remain Metadata-only: no Slack payload text, search query, Block Kit, file contents, Prism developer token, token hash, pepper, or Slack credential.
- Runtime or UX evidence:
  - Existing route/forwarding tests assert no secret leakage and assert `X-Prism-Upstream-Called` truthfulness on stopped vs forwarded paths.
  - GitHub issue #12 requires Prism-side `429` before Slack with `upstreamCalled:false`, and upstream Slack `429` pass-through with `upstreamCalled:true`.
- Conflicts between docs and code:
  - No direct conflict: ADR 0001 says v1 needs Postgres rate-limit state; code currently has only a no-op seam, matching issue #12 as the implementation gap.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Replace the no-op `checkSlackForwardingRateLimit` implementation and keep the `SlackForwardingRateLimiter` injection seam for tests.
  - Add a small server-only rate-limit service/store under `src/server/slack/` (for example `rate-limit.ts` plus `postgres-rate-limit-store.ts`) and have `forwarding.ts` use it by default.
  - Add migration `db/migrations/0005_slack_forwarding_rate_limits.sql` for shared fixed-window state keyed by Token profile and Slack method.
  - Extend `SlackForwardingRateLimitDecision` to carry `retryAfterSeconds` and optional diagnostic body data, and extend response adaptation or forwarding return code to set `Retry-After`.
  - Extend `SlackWebApiResult` to carry selected upstream headers, at minimum `retry-after`, so `forwardSlackMethod` can preserve practical retry headers for upstream Slack `429`.
  - Continue using `ActivityAuditStore.recordActivity` for Prism-side rate-limit denials and existing `recordActivity`/`updateActivityOutcome` for upstream-called outcomes.
- Relevant docs or library capabilities:
  - PostgreSQL supports transactions, row-level locking (`SELECT ... FOR UPDATE`), `INSERT ... ON CONFLICT`, `timestamptz`, and interval/reset arithmetic suitable for atomic fixed-window counters across multiple hosted workers.
  - Next.js `NextResponse.json` returns mutable response headers, so `Retry-After` can be set after `slackApiResponse`/diagnostic headers are applied.
  - HTTP `429` uses `Retry-After` as either delta seconds or HTTP date; use delta seconds for predictable local/client behavior.
- Existing examples in this codebase:
  - Stores accept the shared `Database` abstraction from `src/server/db.ts` and use Postgres migrations rather than in-memory process state.
  - Forwarding tests inject fake `rateLimiter`, `SlackWebApiClient`, and audit store; route tests mock `src/server/db` and inspect SQL for no-secret guarantees.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not move rate-limit decisions into route-local code; `forwarding.ts` is the established owner/seam.
  - Do not add an in-memory-only limiter for product behavior; ADR 0001 and issue #12 require Postgres-backed state for multi-worker safety.
  - Do not duplicate Method registry, Capability map policy, token verification, execution identity, credential custody, response diagnostics, or audit persistence.
  - Do not add Slack credential selection/decryption to rate-limit code; the limiter only needs token profile ID, method, execution mode/request ID diagnostics, and time/window config.
- Shortcuts or parallel paths to avoid:
  - Do not count missing/malformed bearer, policy-denied, revoked, expired, reauth-gated, identity-denied, unsupported, or parse-error requests.
  - Do not wrap upstream Slack `429` bodies with Prism diagnostics in the body; preserve Slack status/body and use headers/audit to mark `upstreamCalled:true`.
  - Do not log payloads or include payload-derived content beyond already-approved object metadata extraction.
  - Do not model exact Slack quotas, workspace-wide quotas, Redis buckets, website-configurable limits, billing quotas, or admin surfaces in this slice.
- Invariants:
  - Ordered pipeline remains: token policy -> execution identity -> payload parsing -> Prism-side rate-limit decision -> pre-upstream audit attempt -> upstream call -> audit outcome -> Slack-compatible response.
  - Prism-side limit response: HTTP `429`, `ok:false`, `error:"rate_limited"`, `Retry-After`, no-store, Prism request ID diagnostics, `X-Prism-Upstream-Called:false`, and Metadata-only audit `status:"rate_limited"`.
  - Upstream Slack limit response: preserve upstream status/body and practical retry headers, add Prism diagnostics, and mark audit/headers `upstreamCalled:true`.

## Integration plan

- Insert the change at:
  - Keep `app/v1/slack/api/[method]/route.ts` unchanged except wiring only if a default limiter factory requires route-level dependency injection; preferred default is inside `forwarding.ts`.
  - In `src/server/slack/forwarding.ts`, enrich `SlackForwardingRateLimitDecision`, call the real default limiter at the existing seam, write Prism-side rate-limit audit there, return via `slackApiResponse`, and set `Retry-After` before returning.
  - Add `src/server/slack/rate-limit.ts` for config/default constants and decision types, plus `src/server/slack/postgres-rate-limit-store.ts` for atomic Postgres state.
  - Add `db/migrations/0005_slack_forwarding_rate_limits.sql` with a table such as `slack_forwarding_rate_limits(token_profile_id REFERENCES token_profiles(id) ON DELETE CASCADE, slack_method text, window_started_at timestamptz, window_reset_at timestamptz, request_count integer, updated_at timestamptz, PRIMARY KEY(token_profile_id, slack_method))` and an index on `window_reset_at` for cleanup/inspection.
  - Extend `src/server/slack/web-api-client.ts` result type to include `headers?: Record<string, string | undefined>` or a narrow `retryAfter?: string`; forwarding should copy only safe practical retry headers (`Retry-After` first) onto the final response.
- Why this is the correct integration point:
  - The existing seam is already after authorization and payload parsing but before audit attempt/upstream; this avoids counting unauthorized/malformed requests and stops runaway loops before Slack.
  - Postgres-backed state matches ADR 0001 and issue #12's future multi-worker requirement.
  - Keeping upstream header pass-through in the client/result/forwarding path preserves Slack behavior without creating a parallel response path around `response-adapter.ts` diagnostics.
- Alternatives considered and rejected:
  - Route middleware limiter: rejected because it would count unauthenticated/denied/revoked requests and bypass established forwarding/audit ownership.
  - In-memory counters: rejected because they reset per process/deploy and fail multi-worker predictability.
  - Per execution-identity buckets for the initial limit: rejected for now because issue #12 scopes protection to the Token profile; splitting by `user`/`bot` would double effective allowance. Keep `executionMode` in input/audit diagnostics and revisit only with an explicit requirement.
  - Exact Slack quota mirroring: rejected as out of scope and brittle; use generous defensive Prism limits.

## Regression checklist

- Behavior: Existing `src/server/slack/forwarding.test.ts` and `app/v1/slack/api/[method]/route.test.ts` remain green.
- Behavior: Existing policy, execution identity, token lifecycle, audit, response adapter, and no-secret tests remain green.
- Behavior: Denied/unsupported/auth-failed/identity-denied/revoked/expired/malformed-token requests do not touch rate-limit state or upstream.
- Behavior: Malformed Slack JSON and unsupported multipart stop before rate-limit accounting and upstream.
- Behavior: Prism-side limited calls do not call `SlackWebApiClient`, do emit one Metadata-only audit row, return `429`, `Retry-After`, `X-Prism-Request-ID`, and `X-Prism-Upstream-Called:false`.
- Behavior: Upstream Slack `429` calls still record attempted/outcome audit with `upstreamCalled:true`, preserve Slack body/status, preserve `Retry-After`, and set `X-Prism-Upstream-Called:true`.
- Behavior: A Token profile/method bucket resets predictably and calls after reset can succeed.
- Behavior: No payloads/secrets are stored in audit rows, SQL params, response bodies, headers, logs, or thrown errors.

## Test plan

- Existing tests to keep green:
  - `src/server/slack/forwarding.test.ts`
  - `app/v1/slack/api/[method]/route.test.ts`
  - `src/server/audit/postgres-store.test.ts`
  - token-profile policy/execution/lifecycle tests
  - `npm test` and `npm run build`
- New tests to add before/with implementation:
  - Rate-limit service/store unit tests for first allowed, within-window allowed count, over-limit denial, `Retry-After` calculation, reset-after-window behavior, and independent Token profile + Slack method buckets.
  - Store tests that prove atomic Postgres behavior through the `Database` abstraction, including no dependency on Slack credentials and no payload columns.
  - Forwarding tests proving Prism-side limit happens after successful payload parsing, before audit attempt/upstream call, emits `status:"rate_limited"`, `errorClass:"rate_limited"`, `httpStatus:429`, `upstreamCalled:false`, and includes no payload/secret canaries.
  - Forwarding tests proving parse errors and unsupported multipart do not call the limiter.
  - Route tests proving malformed tokens, denied policy, revoked/expired tokens, and identity failures do not query/update rate-limit state.
  - Upstream `429` tests with a fake `SlackWebApiClient` returning `{ status:429, body:{ ok:false, error:"rate_limited" }, headers:{ "retry-after":"30" } }`; assert status/body/header preservation, diagnostics, and audit `upstreamCalled:true`.
  - No-secret route tests with payload, Block Kit, search query, Prism developer token, token hash, pepper, and Slack credential canaries.
- Live proof required:
  - Run migrations against local Postgres, then `npm test` and `npm run build`.
  - Start the local app, create/link a mock Slack connection and Prism developer token, then issue repeated `curl` requests to one allowed method until Prism returns `429`; capture body, `Retry-After`, `X-Prism-Request-ID`, and `X-Prism-Upstream-Called:false`.
  - After the reset window, repeat one request and capture success with `X-Prism-Upstream-Called:true`.
  - Exercise/fake an upstream Slack `429` path and capture preserved Slack body/status, preserved `Retry-After`, and `X-Prism-Upstream-Called:true`.
  - Inspect recent audit rows or website activity surface to prove Metadata-only `rate_limited` audit exists without payloads/secrets.

## Risk assessment

- Risk: Counting before policy or before payload parsing would consume buckets for invalid, denied, revoked, expired, or malformed requests.
- Risk: A non-atomic Postgres implementation could allow bursts above the limit under concurrent Local tool loops.
- Risk: Per-method fixed-window rows can grow if many methods/profiles churn; mitigate with primary-key current-bucket rows or cleanup of expired rows.
- Risk: Extending `SlackWebApiResult` incorrectly could drop ordinary Slack bodies or fail to preserve upstream `Retry-After`.
- Risk: Adding Prism diagnostics to upstream `429` bodies would break Slack client compatibility.
- Risk: Including payload-derived content in limiter/audit diagnostics would violate Metadata-only audit.
- Mitigation: Use the existing forwarding seam, narrow store interface, Postgres transaction/row lock or conflict-safe upsert, selected-header pass-through tests, and canary no-secret tests.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership and insertion point are explicit in current code: `forwardSlackMethod` already has the required no-op seam at the correct point.
  - ADR 0001 and issue #12 agree that rate-limit state belongs in Postgres.
  - Existing audit and diagnostics systems already support the core distinction via `status:"rate_limited"` plus `upstreamCalled:false/true`.
  - The only necessary cross-boundary type change is narrow: add retry header data to `SlackWebApiResult` and copy selected safe headers in forwarding/response adaptation.
- Open questions:
  - Exact generous defaults (limit/window) should be chosen during implementation; recommend conservative local-loop defense such as a high fixed-window count per Token profile + method, configurable by server env but not user-visible.
  - Whether to expose additional Prism-side limit diagnostics beyond `requestId` and `Retry-After` in the body should be minimal to preserve Slack compatibility; if added, keep them under a `prism` object and avoid secrets/payloads.
