# Architecture Integration Brief: issue-6-token-status-capabilities

## Existing ownership

- Package/component/module/library:
  - **Local-tool Prism HTTP boundary:** Next.js App Router route handlers under `app/v1/prism/*` own Prism-native endpoints. Existing examples are `app/v1/prism/health/route.ts` for unauthenticated fixed health and `app/v1/prism/token-profiles/route.ts` for website-session-protected profile management.
  - **Token profile and developer-token domain:** `src/server/token-profiles/*` owns Token profile policy, opaque Prism developer token generation/verifier material, profile persistence, and service orchestration. Issue #6 must extend this owner to resolve Local-tool bearer tokens and project safe status/capability data.
  - **Capability map source of truth:** `src/server/token-profiles/presets.ts` owns the `CapabilityMap` type and preset/custom policy construction. Capabilities responses must consume the stored effective `capability_map` that came from this module, not reinterpret Slack scopes or raw database rows.
  - **Persistence:** plain Postgres through `src/server/db.ts`, `db/migrations/*.sql`, and store modules owns durable profile/token/session/Slack-connection data. The relevant tables are `token_profiles`, `prism_developer_tokens`, `slack_connections`, and `slack_credentials`.
  - **Slack connection state:** `src/server/slack/postgres-store.ts` and `src/server/slack/refresh.ts` own healthy vs `reauth_required` connection semantics. Issue #6 should read the projected status but must not duplicate refresh/OAuth behavior.
  - **Method registry:** The domain model in `CONTEXT.md` defines a server-owned Method registry, but no implementation exists yet. Issue #6 should introduce the minimum server-only registry needed for discovery; it must not implement Slack forwarding.
  - **Tests/build:** Vitest route/service/unit/component tests and Next production build are the existing validation mechanism.
- Current owner rationale:
  - `CONTEXT.md` says a Prism developer token is an opaque bearer secret resolved server-side to exactly one Token profile; the hosted service evaluates the Capability map and Method registry, chooses Execution identity, and keeps Slack credentials server-held.
  - ADR 0001 requires Next.js route handlers plus plain Postgres and explicitly includes opaque Prism token verification as a core v1 requirement.
  - Issue #5 established `src/server/token-profiles/developer-token.ts`, `presets.ts`, `service.ts`, `store.ts`, `app/v1/prism/token-profiles/route.ts`, and migration `0002` as the current Token profile/developer-token owner.
- Source evidence:
  - `src/server/token-profiles/developer-token.ts` issues `prism_dev_` opaque tokens, hashes them with HMAC-SHA256 and pepper ID, and verifies with constant-time comparison.
  - `src/server/token-profiles/presets.ts` defines `CapabilityMap`, deferred surfaces, execution identities, expiry policy, and mutation semantics.
  - `src/server/token-profiles/store.ts` currently supports website session owner resolution, list, and insert; it does not yet resolve Local-tool bearer tokens.
  - `db/migrations/0002_prism_developer_tokens.sql` adds `token_profiles.status IN ('active','bootstrap','revoked')` and `prism_developer_tokens(revoked_at, expires_at, last_used_at)` with one current non-revoked token per profile.
  - `docs/slack/README.md` says Method registry and Slack API forwarding remain deferred; issue #6 should add discovery registry data only.
  - Baseline evidence: `npm test` passed 16 files / 31 tests; `npm run build` passed and lists dynamic `/v1/prism/health`, `/v1/prism/token-profiles`, and Slack OAuth routes. A mistaken `npm test -- --runInBand` failed because Vitest does not support that Jest flag; use `npm test`.

## Existing interaction model

- User/system behaviors that already exist:
  - Developers link Slack via `GET /v1/slack/oauth/start` and `GET /v1/slack/oauth/callback`; successful callback stores encrypted Slack credentials server-side and sets an opaque HTTP-only `prism_session` cookie for the Prism website.
  - The website uses the session cookie to create/list Token profiles at `GET|POST /v1/prism/token-profiles`. Creation returns plaintext Prism developer token material exactly once; listing returns metadata only.
  - Token profile creation is allowed even when Slack is `reauth_required`, but UI warns that Slack calls cannot succeed until reconnect.
  - `/v1/prism/health` returns fixed sanitized service/database health and is not token-authenticated.
  - Refresh failures mark a Slack connection `reauth_required` without deleting users, Slack connections, credentials, or Token profiles.
- Behaviors that must remain unchanged:
  - Local tools receive only opaque Prism developer tokens, never Slack credentials, Slack refresh tokens, credential envelopes, verifier hashes, pepper IDs, database row shapes, or plaintext token material from read/status/capability endpoints.
  - Browser website auth remains cookie/session based; Local-tool status/capabilities auth must be bearer-token based and must not accept `prism_session` cookies as a shortcut.
  - Token profile policy remains a Prism Capability map, not a Slack OAuth scope list.
  - Slack OAuth routes, refresh behavior, token-profile creation/listing, copy-once token UX, and health endpoint response shape must remain stable.
  - Slack method forwarding, rate limits, rotation/revocation UX, and metadata audit beyond request IDs remain out of scope.
- Runtime or UX evidence:
  - Existing UI tests assert Slack status and Token profile panels do not render `xox`, refresh, client secret, access token, `prism_dev_`, token hash, or pepper material after initial creation.
  - Existing route tests assert `/v1/prism/token-profiles` creation sets `Cache-Control: no-store`, returns `developerToken` only on `POST`, and list responses omit developer token material.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add thin dynamic route handlers:
    - `app/v1/prism/status/route.ts`
    - `app/v1/prism/capabilities/route.ts`
  - Use `Authorization: Bearer <prism_dev_...>` as the only Local-tool auth format. Missing, malformed, non-`prism_dev_` tokens should return machine-readable 401 responses with a `requestId`.
  - Reuse `getDeveloperTokenConfig()` from `src/server/config.ts` and `hashDeveloperToken`/`verifyDeveloperToken` semantics from `src/server/token-profiles/developer-token.ts`. Do not introduce JWTs or a second token verifier.
  - Extend `TokenProfileStore`/`createPostgresTokenProfileStore` with a Local-tool resolver, e.g. `resolveDeveloperToken(input: { token: string; verifierConfig: DeveloperTokenConfig; now: Date })`, or split into a clearly named server-only `src/server/token-profiles/local-tool-service.ts` plus store method. Keep SQL out of routes.
  - Resolver SQL should join projected fields from `prism_developer_tokens`, `token_profiles`, `slack_connections`, and safe credential availability from `slack_credentials` without selecting credential envelopes. Recommended selected fields: token/profile IDs, token/profile expiry, token/profile revoked status, `capability_map`, profile `preset`, connection `status`, `last_error_class`, and aggregate booleans for user/bot credential row availability.
  - Add a server-only minimum Method registry module, preferably `src/server/slack/method-registry.ts`, because it classifies Slack Web API method names for future `/v1/slack/*` forwarding. The Prism capabilities service can import it for discovery.
  - Use existing NextResponse JSON conventions and add a local `noStoreJson` helper for these routes. All status/capability responses should set `Cache-Control: no-store`, include body `requestId`, and set response header `X-Prism-Request-ID` to the same generated value.
  - Generate request IDs in the route or service with `crypto.randomUUID()`. If accepting an incoming request ID later, validate/sanitize it first; do not log or echo arbitrary long/header-injection values.
- Relevant docs or library capabilities:
  - Node `crypto.randomUUID()` is sufficient for opaque request correlation IDs.
  - Next.js App Router route handlers are already used for all `/v1/*` API boundaries.
  - PostgreSQL joins and filtered aggregates can project safe status without exposing raw rows or credential JSONB.
- Existing examples in this codebase:
  - `app/v1/prism/token-profiles/route.ts` shows thin route handlers delegating to `src/server/token-profiles/service.ts` and mapping service result kinds to JSON/status codes.
  - `src/server/token-profiles/service.ts` shows validation/orchestration with store interfaces, and copy-once token plaintext never returned from list.
  - `src/server/slack/postgres-store.ts#getSlackLinkStatus` shows projecting Slack connection status without credential material.
  - `app/v1/prism/health/route.test.ts` and token-profile route tests show sanitized route testing patterns.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a parallel `api_keys`, `local_tokens`, JWT, NextAuth/Auth.js, Supabase, PostgREST, ORM, Express/Fastify, or Pages Router API implementation.
  - Do not verify Local-tool tokens by scanning all token rows or by comparing plaintext. Hash the presented token with the configured pepper and resolve via `prism_developer_tokens.token_hash`.
  - Do not use Slack credential encryption/decryption for Prism developer token material. Developer tokens are verifier-only, not decryptable secrets.
  - Do not treat Slack OAuth scopes or `slack_credentials.scopes` as the Capability map. Scopes are the Slack-admin maximum; `token_profiles.capability_map` is the effective Local-tool policy.
  - Do not expose or select Slack credential envelopes, access/refresh token values, token hashes, pepper values, raw SQL rows, or database error details in responses.
  - Do not let `/v1/prism/status` or `/v1/prism/capabilities` mint, rotate, revoke, refresh, or forward Slack requests.
- Shortcuts or parallel paths to avoid:
  - No cookie-authenticated Local-tool status path; Local tools use `Authorization: Bearer` only.
  - No method allow/deny hard-coded inside route handlers. Put Method registry data in one server-owned module so future forwarding policy can reuse it.
  - No capability output that simply dumps the database row. Project a stable response schema from effective policy and registry data.
  - No Slack API calls or credential decryptions for status/capabilities. Connection state and identity availability are local projections.
- Invariants:
  - A Prism developer token maps to exactly one Token profile.
  - A Capability map belongs to exactly one Token profile.
  - `reauth_required` preserves token/profile state but indicates Slack calls need reconnect.
  - Expired/revoked/invalid token states must be clear and machine-readable, each with a request ID.
  - Deferred surfaces remain deferred in issue #6: events, slash commands, interactivity, file transfer, canvases, lists, admin/org methods, and future surfaces.

## Integration plan

- Insert the change at:
  - **Route handlers:** add `app/v1/prism/status/route.ts` and `app/v1/prism/capabilities/route.ts`. Both should parse only `Authorization: Bearer prism_dev_...`, call a service, set no-store and `X-Prism-Request-ID`, and map service result kinds to JSON/status codes.
  - **Service layer:** add Local-tool-facing service functions under `src/server/token-profiles/`, for example `getPrismStatus(...)` and `getPrismCapabilities(...)`, or `src/server/prism/local-tool-status.ts` if the implementer wants a Prism API projection layer. The service should own response schema construction and avoid route-level policy logic.
  - **Store layer:** extend `TokenProfileStore`/Postgres store with safe token resolution. Recommended result shape:
    - token: `tokenProfileId`, `tokenExpiresAt`, `tokenRevokedAt`, `tokenLastUsedAt` if needed later, hash algorithm/pepper ID only internally for verification decisions.
    - profile: `status`, `preset`, `capabilityMap`, `expiresAt`.
    - slack: connection `status`, `lastErrorClass`.
    - identity availability: booleans derived from existence of `slack_credentials` rows by `kind`, not the envelope values.
  - **Developer-token resolution:** compute HMAC using `hashDeveloperToken(presentedToken, getDeveloperTokenConfig())`, query exact `token_hash`, then classify:
    - no row or wrong prefix/malformed: `invalid`.
    - token `revoked_at` set or profile `status='revoked'`: `revoked`.
    - token `expires_at <= now` or profile `expires_at <= now`: `expired`.
    - profile `status!='active'` (including bootstrap): do not treat as usable; return denied machine state such as `invalid` or `revoked` consistently, with no capability map.
    - otherwise token is valid/active; Slack may still be `reauth_required`.
  - **Status response schema:** use a stable projected schema, for example:
    ```json
    {
      "requestId": "uuid",
      "token": { "valid": true, "status": "active", "tokenProfileId": "...", "expiresAt": "...|null" },
      "slack": { "connected": true, "status": "healthy|reauth_required", "reauthRequired": false, "lastErrorClass": null },
      "executionIdentity": {
        "configured": "user|bot|automatic|selectable",
        "available": true,
        "modes": { "user": true, "bot": true, "automatic": true, "selectable": true },
        "unavailableReason": null
      }
    }
    ```
    For invalid/expired/revoked, return the same top-level `requestId` and `token.valid:false`, with no profile capability map and no raw DB details.
  - **Status codes:** recommended mapping:
    - `200` for valid token states, including healthy, missing identity availability, and `reauth_required` Slack connection.
    - `401` for missing/malformed/invalid/expired bearer token.
    - `403` for revoked token/profile if the row resolves and the server can distinguish it.
    - `503` only for sanitized setup/database unavailability.
    This keeps Local tools able to distinguish token auth failure from valid-token-but-Slack-needs-reauth.
  - **Capabilities response schema:** derive from the effective `CapabilityMap` and Method registry, for example:
    ```json
    {
      "requestId": "uuid",
      "token": { "status": "active", "tokenProfileId": "...", "expiresAt": null },
      "capabilityMap": { "version": 1, "preset": "read_only", "surfaces": {}, "actions": {}, "executionIdentity": "automatic", "deferred": {} },
      "categories": {
        "conversations.read": { "allowed": true, "methods": ["conversations.list", "conversations.history"] },
        "search": { "allowed": true, "methods": ["search.messages"] },
        "messages.write": { "allowed": false, "methods": ["chat.postMessage", "chat.update"] }
      },
      "methods": {
        "chat.postMessage": { "category": "messages.write", "status": "denied", "requiredCapability": "writeMessages", "supported": true },
        "admin.users.list": { "category": "admin", "status": "unsupported", "supported": false }
      },
      "unsupported": { "surfaces": ["admin", "events", "slashCommands", "interactivity", "fileTransfer", "canvases", "lists"] }
    }
    ```
  - **Minimum Method registry shape:** include enough data for Local tools to determine category/method availability without forwarding:
    - `conversations.read`: `conversations.list`, `conversations.info`, `conversations.history`, `conversations.replies`; requires `actions.read`.
    - `users.read`: `users.info`, `users.list`; requires `actions.read`.
    - `search`: `search.messages`; requires `actions.search`; user-backed preferred/required unless later Slack docs prove bot support.
    - `messages.write`: `chat.postMessage`, `chat.update`; requires `actions.writeMessages`.
    - `messages.destructive`: `chat.delete`; requires `actions.writeMessages` and `actions.destructive`.
    - `reactions`: `reactions.add`, `reactions.remove`, `reactions.get`; requires `actions.reactions`.
    - `files.metadata`: `files.info`, `files.list`; requires `actions.filesMetadata`; mark content transfer/upload/delete as deferred/unsupported.
    - Explicit unsupported/deferred families: admin/org, events, slash commands, interactivity, file transfer/content, canvases, lists, future.
  - **Execution identity projection:** derive configured mode from `capabilityMap.executionIdentity`; derive availability from safe credential-kind existence and Slack connection status. If `connection.status='reauth_required'`, set `reauthRequired:true` and identity availability false or degraded with `unavailableReason:'slack_reauth_required'`. If requested/configured mode lacks a corresponding credential row, return valid token with `executionIdentity.available:false` and `unavailableReason:'missing_user_identity'|'missing_bot_identity'|'missing_execution_identity'`.
  - **Optional side effect:** updating `prism_developer_tokens.last_used_at` for a successful valid status/capabilities check is acceptable only if done after safe resolution and tested. It is not required for issue #6 and should not become metadata audit work.
- Why this is the correct integration point:
  - It keeps Local-tool auth/status in the Token profile/developer-token owner created by issue #5 while exposing Prism-native API routes under the existing `/v1/prism/*` boundary.
  - It introduces Method registry discovery exactly where the domain model says it belongs, without implementing forwarding or parallel policy logic.
  - It preserves the Slack credential custody boundary by projecting connection/identity availability from safe metadata only.
- Alternatives considered and rejected:
  - **JWT or self-describing developer tokens:** rejected because Prism developer tokens are opaque and server-resolved.
  - **Dumping `token_profiles.capability_map` directly as the entire capabilities endpoint:** rejected because issue #6 also requires Method registry-derived method/category availability.
  - **Building Method registry into the route:** rejected as a parallel path that future forwarding would bypass or duplicate.
  - **Using Slack OAuth scopes as capabilities:** rejected because scopes are maximum Slack app permissions, not effective Token profile policy.
  - **Calling Slack or decrypting credentials for status:** rejected because status/capabilities should be safe local projections and must not expose or depend on Slack credential material.

## Regression checklist

- Behavior: Existing `GET /v1/prism/health` response shape and sanitization remain unchanged.
- Behavior: `GET|POST /v1/prism/token-profiles` still use website `prism_session`, return plaintext developer tokens only from creation, and list metadata without token/verifier/pepper material.
- Behavior: Slack OAuth start/callback still link Slack, store encrypted credentials only, and do not create Token profiles implicitly.
- Behavior: Refresh failures still mark connections `reauth_required` and preserve Token profiles/developer-token rows.
- Behavior: Local-tool status/capabilities use only `Authorization: Bearer prism_dev_...` and never cookies or query parameters for bearer secrets.
- Behavior: Valid, invalid, expired, revoked, and `reauth_required` states all produce clear machine-readable JSON with `requestId` and no secret/database leakage.
- Behavior: Capabilities are derived from effective `CapabilityMap` plus Method registry, not raw DB rows or Slack scopes.
- Behavior: Missing bot/user identity availability is distinguishable from invalid token and from Slack reauth required.
- Behavior: Deferred/unsupported surfaces remain disabled/discoverable; no Slack forwarding, rate limiting, rotation/revocation UX, or audit-log broadening is introduced.
- Behavior: `npm test` and `npm run build` stay green.

## Test plan

- Existing tests to keep green:
  - `src/server/health.test.ts`
  - `app/v1/prism/health/route.test.ts`
  - `src/server/dependency-guard.test.ts`
  - `src/server/config.test.ts`
  - `src/server/credentials/encryption.test.ts`
  - `src/server/slack/oauth-flow.test.ts`
  - `src/server/slack/refresh.test.ts`
  - `app/v1/slack/oauth/start/route.test.ts`
  - `app/v1/slack/oauth/callback/route.test.ts`
  - `app/slack-status-panel.test.tsx`
  - `app/token-profiles-panel.test.tsx`
  - `src/server/token-profiles/developer-token.test.ts`
  - `src/server/token-profiles/presets.test.ts`
  - `src/server/token-profiles/service.test.ts`
  - `app/v1/prism/token-profiles/route.test.ts`
- New tests to add before/with implementation:
  - `src/server/slack/method-registry.test.ts`: registry exposes supported categories/methods, maps methods to required Capability map fields, and marks admin/events/slash/interactivity/file-transfer/canvases/lists as unsupported/deferred.
  - `src/server/token-profiles/local-tool-status.test.ts` or service equivalent:
    - healthy active token returns `token.valid:true`, Slack healthy, request ID, configured execution identity, and available modes.
    - expired token/profile returns machine-readable `expired` without capability map or secrets.
    - revoked token/profile returns machine-readable `revoked` without capability map or secrets.
    - invalid/malformed token returns `invalid` with request ID and no DB details.
    - `reauth_required` Slack connection returns valid token plus `slack.reauthRequired:true` and execution unavailable/degraded reason.
    - missing user/bot credential rows returns valid token with `executionIdentity.available:false` and a precise missing-identity reason.
    - all responses omit `xox`, `refresh`, `access_token`, `client_secret`, `tokenHash`, `pepper`, credential envelopes, and presented bearer token.
  - `src/server/token-profiles/local-tool-capabilities.test.ts` or service equivalent:
    - read-only profile allows read/search categories and denies write/reaction/files/destructive methods.
    - messages-only profile allows message/reaction methods and denies search/files/destructive.
    - full bridge/custom/destructive profiles project allowed/denied method states from `CapabilityMap.actions`.
    - unsupported/deferred surfaces appear as unsupported/deferred, not silently allowed.
  - Route tests:
    - `app/v1/prism/status/route.test.ts` covers Authorization parsing, status code mapping, no-store, `X-Prism-Request-ID`, body `requestId`, healthy, invalid, expired, revoked, reauth, and missing identity cases.
    - `app/v1/prism/capabilities/route.test.ts` covers Authorization parsing, no-store/request ID, capability/method projection, and no secret leakage.
  - Store tests or route-level mocked SQL assertions should confirm queries do not select `access_token_envelope`, `refresh_token_envelope`, pepper, or plaintext token values.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - With local server on port `3732`, create a Token profile through the existing website/mock OAuth path or seeded local DB, copy the `prism_dev_...` token once, then verify:
    - `curl -i -H "Authorization: Bearer <token>" http://localhost:3732/v1/prism/status` returns 200, `Cache-Control: no-store`, `X-Prism-Request-ID`, body `requestId`, token active, Slack state, and no secret material.
    - `curl -i -H "Authorization: Bearer <token>" http://localhost:3732/v1/prism/capabilities` returns effective capabilities and method/category availability with no secret material.
    - `curl -i -H "Authorization: Bearer prism_dev_invalid" .../status` returns invalid machine-readable JSON with request ID.
  - If feasible via DB update in local dev, flip a test token to expired/revoked and Slack connection to `reauth_required`, then capture corresponding status/capability responses. Do not commit seeded data or secrets.

## Risk assessment

- Risk: A route or service could expose raw `capability_map` plus raw profile/token/slack rows, leaking internal IDs/status fields or creating an unstable API.
- Risk: Selecting or serializing `slack_credentials` envelopes could leak credential custody internals even without plaintext tokens.
- Risk: Hard-coding Method registry decisions in route handlers could create a parallel policy path that future Slack forwarding bypasses or contradicts.
- Risk: Treating `reauth_required` as invalid/revoked would incorrectly tell Local tools their Prism developer token is bad and could drive unnecessary token rotation.
- Risk: Treating missing identity availability as invalid token would hide the actionable remediation: reconnect Slack or ensure the profile execution identity has a corresponding user/bot credential.
- Risk: Returning capabilities for expired/revoked/invalid tokens could reveal policy data to unauthorized callers.
- Risk: Updating `last_used_at` on every invalid attempt or before classification could create noisy writes or side-channel behavior.
- Mitigation: Keep route handlers thin, centralize token resolution/projection in server-only token-profile services, use explicit response DTOs, add no-secret tests, add registry tests, and keep status/capability endpoints read-only except optional successful `last_used_at` update.

## Decision confidence

- Confidence: high
- Reasons:
  - Issue #5 created the exact Token profile/developer-token owner needed for issue #6, and current code cleanly separates route, service, store, config, and verifier responsibilities.
  - Existing docs and database schema already define the required token/profile/slack state primitives: active/expired/revoked, `reauth_required`, Capability map, execution identity, and credential custody boundaries.
  - The only missing architectural piece is the Method registry; adding a minimum server-only discovery registry is directly supported by `CONTEXT.md` and does not require Slack forwarding.
- Open questions:
  - Exact public response schema names can be adjusted during implementation, but must preserve the semantics above and remain stable/machine-readable.
  - Whether revoked tokens should be HTTP 401 or 403 is a product/API decision. This brief recommends 403 when the server can distinguish revoked material, and 401 for missing/malformed/invalid/expired auth failures.
