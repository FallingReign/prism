# Architecture Integration Brief: issue-4-slack-oauth-custody

## Existing ownership

- Package/component/module/library:
  - **Prism website connect/status flow:** existing Next.js App Router website under `app/page.tsx` owns the first user-facing surface. Keep status UI server-rendered; add small server components/modules rather than introducing a separate frontend app or client-side credential flow.
  - **OAuth route handlers:** App Router route handlers under `app/v1/slack/oauth/start/route.ts` and `app/v1/slack/oauth/callback/route.ts` should own the public Slack OAuth HTTP boundary, matching the committed Slack redirect URL `/v1/slack/oauth/callback`.
  - **Persistence:** existing server-only Postgres substrate (`src/server/db.ts`, `pg`, Docker Postgres) owns durable state. Add repository/service modules under `src/server/**`; do not introduce ORM/Supabase/PostgREST.
  - **Encryption abstraction:** add a server-only credential custody layer, e.g. `src/server/credentials/encryption.ts` plus `src/server/credentials/store.ts`, owned by the Prism hosted service. The abstraction should return/store ciphertext metadata compatible with future managed KMS/envelope encryption.
  - **Slack OAuth client:** add an injectable server-only Slack OAuth adapter, e.g. `src/server/slack/oauth-client.ts`, using `fetch` with form-encoded POSTs to Slack `oauth.v2.access`. OAuth is simple enough not to require `@slack/web-api` yet; future Slack method forwarding can decide SDK usage separately.
  - **Reauth state:** own it in Slack connection persistence/service modules, e.g. `src/server/slack/connections.ts`, as a durable `healthy | reauth_required` state on a Slack connection/installation, not as deleted credentials or deleted Token profiles.
- Current owner rationale:
  - ADR 0001 and issue #2 establish Next.js App Router route handlers plus plain Postgres as Prism's hosted service substrate.
  - `CONTEXT.md` says the Prism hosted service owns Slack OAuth callbacks and Slack credential custody; the Prism website owns Slack linking/status UX; Local tools never receive Slack credentials.
  - Issue #3 committed Slack app docs with redirect URLs that already point to `/v1/slack/oauth/callback`, port `3732`, Socket Mode off, token rotation on, and no manual bot/user token supply.
- Source evidence:
  - `package.json`: Next.js 16, React 19, `pg`, `server-only`, Vitest; no auth framework, ORM, Slack SDK, or Supabase.
  - Existing runtime/tests: `npm test` passed 5 tests; `npm run build` passed and shows `/v1/prism/health` dynamic, `/` static.
  - `app/v1/prism/health/route.ts` delegates to `src/server/health.ts`/`src/server/db.ts`; follow this route-handler-to-server-module pattern for OAuth.
  - `docs/slack/*`: OAuth routes and credential custody are explicitly deferred to issue #4; approved candidate redirects include `http://localhost:3732/v1/slack/oauth/callback` first for local QA.

## Existing interaction model

- User/system behaviors that already exist:
  - `npm run dev` binds Next.js to `0.0.0.0:3732`; keep this unchanged for localhost and pilot VM Slack redirects.
  - `GET /v1/prism/health` returns only fixed service/database status and sanitizes failures.
  - The homepage presents Prism hosted service / Prism website / Local tools vocabulary and states Slack credentials stay with the Prism hosted service.
  - `.env.local` may contain Slack app values; do not print, log, echo, screenshot, or serialize them.
- Behaviors that must remain unchanged:
  - Local tools receive only future Prism developer tokens, never Slack access/refresh/client/signing secrets.
  - Browser pages, API responses, console logs, tests, and screenshots must not expose Slack credentials or plaintext persisted credential fields.
  - `/v1/slack/*` remains the Slack-compatible/Slack OAuth API namespace; do not move OAuth under `/api` or Pages Router.
  - Keep Socket Mode/events/interactivity/incoming webhooks/canvases/lists/file transfer out of this slice.
  - Preserve local dev port `3732` and the exact callback path already listed in Slack docs.
- Runtime or UX evidence:
  - The current website is server-rendered static content with no client-side state; status can initially be server-rendered from an HTTP-only session cookie and Postgres.
  - The current health endpoint and tests already assert no secret-like substrings in outputs; copy this sanitation habit into OAuth/status tests.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Next.js App Router `route.ts` handlers for `GET /v1/slack/oauth/start`, `GET /v1/slack/oauth/callback`, and any minimal server-only status endpoint if the website needs one.
  - Server Components/pages for website status; use redirects/cookies from route handlers, not client-side token handling.
  - Existing `src/server/config.ts` for server-only env shape. Extend it with Slack OAuth, redirect URI, public base URL, encryption key/key id, and mock-mode flags, returning names/status only where needed and never values.
  - Existing `src/server/db.ts` `pg` pool. Add query helpers/repositories; keep SQL parameterized.
  - Vitest route/service tests with injected database/Slack/encryption adapters, following existing `health` tests.
  - Node `crypto` / WebCrypto for local AES-256-GCM encryption provider; store algorithm/key id/iv/auth tag/ciphertext separately or as a structured envelope.
- Relevant docs or library capabilities:
  - Slack OAuth v2 authorize URL is `https://slack.com/oauth/v2/authorize`; bot scopes use `scope`, user scopes use `user_scope`.
  - Slack requires the same `redirect_uri` in authorize and `oauth.v2.access` when the authorize step sends it; multiple configured redirects make this especially important.
  - Slack `oauth.v2.access` supports `grant_type=refresh_token` for token rotation and returns `expires_in`/`refresh_token` for bot and user tokens when rotation is enabled.
  - Slack recommends HTTP Basic auth for client id/secret to `oauth.v2.access`; prefer Basic auth over form body secrets where practical.
  - Slack `oauth.v2.access` has `code_verifier`/PKCE support but can return `pkce_not_allowed`; for this confidential server-side flow with a client secret, defer PKCE unless the Slack app is explicitly configured to allow it.
  - Slack Sign in with Slack/OpenID uses separate endpoints/scopes and warns not to combine SIWS identity scopes with non-SIWS Web API scopes in one OAuth flow.
- Existing examples in this codebase:
  - `app/v1/prism/health/route.ts` + `src/server/health.ts` demonstrate thin route handlers delegating to testable server functions.
  - `src/server/dependency-guard.test.ts` demonstrates architectural guardrails for forbidden dependencies.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add Supabase Auth, Supabase SDKs, PostgREST, Prisma/Drizzle, NextAuth/Auth.js, a custom Express/Fastify server, or Pages Router API routes for this slice.
  - Do not bypass the Prism hosted service by putting Slack OAuth secrets, token exchange, refresh, or credential decryption in client components, Local tools, or browser JavaScript.
  - Do not create a mock-only OAuth path that has a different persistence/security model than the live adapter; mocks must exercise the same service functions and storage abstraction.
- Shortcuts or parallel paths to avoid:
  - No Slack credentials in Local tools, browser logs, API JSON, query strings after callback, screenshots, fixtures with real-looking copied secrets, raw test snapshots, plaintext DB columns, or docs.
  - No manual bot/user/access/refresh tokens in `.env.local` or setup docs; Prism obtains and stores Slack credentials only through OAuth.
  - No direct client-side Slack OAuth secret use; the start route may redirect to Slack, but token exchange must happen server-side.
  - No broad Slack method forwarding, Method registry, Capability map editor, Prism developer token issuance, Socket Mode, Events API, slash commands, interactivity, or Slack admin scope work in this slice.
  - No logging of full Slack OAuth responses; parse and persist sensitive fields through the credential store immediately and log only sanitized result classes if logging is added at all.
- Invariants:
  - Prism hosted service owns Slack credential custody.
  - Prism website shows only linked/healthy or Reauth required metadata, not tokens.
  - Refresh failure changes connection state to `reauth_required` and preserves Prism user/profile rows and any Token profile rows.
  - Token rotation fields (`expires_in`, `refresh_token`) are treated as Slack credentials and encrypted just like access tokens.

## Integration plan

- Insert the change at:
  - **Migration mechanism now:** introduce a minimal plain-SQL migration runner because issue #4 is the first durable domain schema. Recommended files: `db/migrations/0001_slack_oauth_custody.sql`, `src/server/migrations.ts` or `scripts/run-migrations.ts`, and `npm run db:migrate`. Use `pg`, transactions, and a `schema_migrations` table; do not add a migration framework/ORM.
  - **Schema:** create durable tables for `prism_users`, `prism_sessions` (opaque HTTP-only website session token hash, expiry), `slack_oauth_states` (state hash, redirect URI, optional PKCE fields only if enabled, expiry, used timestamp), `slack_connections` (Prism user id, team/enterprise/authed user ids, app id, scopes, status `healthy|reauth_required`, last error class, timestamps), `slack_credentials` (connection id, kind `bot|user`, token type, encrypted access/refresh token envelopes, expires_at, scopes, rotation metadata, timestamps), and a minimal `token_profiles` shell only if needed to satisfy preservation tests. If `token_profiles` is introduced, keep it policy/profile metadata only; do not issue Prism developer tokens or implement Capability maps yet.
  - **Config:** extend `src/server/config.ts` with server-only `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_OAUTH_REDIRECT_URI`, `PRISM_PUBLIC_BASE_URL`, `PRISM_CREDENTIAL_ENCRYPTION_KEY`, `PRISM_CREDENTIAL_ENCRYPTION_KEY_ID`, and a non-production mock flag such as `PRISM_SLACK_OAUTH_MOCK=1`. Add placeholders to `.env.example`; never read/print `.env.local` values in tests or logs.
  - **Encryption:** add `src/server/credentials/encryption.ts` with an interface like `encrypt(plaintext, aad) -> {ciphertext, iv, tag, keyId, algorithm}` and `decrypt(envelope, aad)`. Local provider: AES-256-GCM with a base64 32-byte env key and AAD including connection id + credential kind. Future provider can use KMS/envelope encryption under the same interface. Local dev must not require real KMS.
  - **Credential store:** add `src/server/credentials/store.ts` to accept Slack token strings only inside server code, encrypt immediately, and persist only envelopes. Tests should query stored values and assert no `xox`, refresh token canary, or plaintext appears.
  - **Slack OAuth adapter:** add `src/server/slack/oauth-client.ts` with injectable `exchangeCode` and `refreshToken`. Live adapter uses `fetch` to Slack `oauth.v2.access` with form-encoded fields, Basic auth for client credentials where possible, matching redirect URI, and sanitized error mapping. Mock adapter returns deterministic synthetic token values only to the service layer.
  - **OAuth services:** add `src/server/slack/oauth-flow.ts` for state creation/validation, callback exchange, profile upsert, connection upsert, credential storage, session creation, and sanitized redirect decisions. Add `src/server/slack/refresh.ts` for refresh success/failure state transitions.
  - **Start route:** `GET /v1/slack/oauth/start` creates a high-entropy state, stores only a hash with short expiry, sets an HTTP-only SameSite=Lax correlation cookie, and redirects to Slack authorize with `client_id`, configured `redirect_uri`, candidate bot/user scopes from issue #3, and `state`. Optional `team` may be accepted only as sanitized metadata if needed; no secrets in URL.
  - **Callback route:** `GET /v1/slack/oauth/callback` validates `state` against the cookie and DB row, marks it used atomically, handles `error`/missing `code` with a generic website redirect, exchanges `code` server-side, upserts the Prism user from `authed_user.id` plus team/enterprise identity, stores bot/user Slack credentials encrypted, sets status `healthy`, creates an HTTP-only Prism website session, and redirects to the website status surface without token-bearing query params.
  - **Website status:** update `app/page.tsx` or add a narrow route such as `app/slack/page.tsx` to show one of: not linked + Connect Slack button, linked/healthy, or Reauth required + reconnect button. The button should hit the start route; the page must not render raw Slack OAuth response fields beyond safe IDs/names if approved.
  - **Refresh handling:** refresh service decrypts only the needed refresh token server-side, calls Slack `oauth.v2.access grant_type=refresh_token`, encrypts replacement access/refresh tokens and updates `expires_at` on success, and marks `slack_connections.status='reauth_required'` on tested recoverable failures such as `invalid_refresh_token` without deleting users/connections/Token profiles. For transient Slack failures (`ratelimited`, `service_unavailable`), prefer leaving state unchanged plus sanitized error class unless product explicitly wants Reauth.
- Why this is the correct integration point:
  - It follows the existing route-handler/server-module pattern, keeps credential custody inside the Prism hosted service, uses the documented Slack callback path, and introduces durable schema only where issue #4 needs it.
  - Plain SQL migrations are the smallest step from health-only Postgres to durable OAuth custody without violating ADR 0001.
  - The encryption interface models KMS-compatible custody while keeping local development self-contained.
- Alternatives considered and rejected:
  - SIWS/OpenID or legacy `identity.*` scopes for v1: rejected/deferred because v1 needs Web API OAuth credentials and Slack warns SIWS scopes conflict with non-SIWS scopes in one OAuth flow. Use `authed_user.id` from Web API OAuth for the tracer-bullet Slack identity.
  - PKCE by default: deferred because this is a confidential server-side OAuth flow with client secret custody, and Slack may return `pkce_not_allowed` unless the app allows PKCE. State + HTTP-only cookie is required now; PKCE can be added behind config later.
  - Real managed KMS for local dev: rejected as unnecessary for the tracer bullet. Use an abstraction and local AES-GCM provider now; managed KMS can replace/wrap keys later.
  - Auth framework/full account system: rejected. A minimal opaque website session is enough to show the Slack-linked Prism user profile.
  - Slack SDK dependency now: optional but not necessary for `oauth.v2.access`; avoid adding it until Method registry/Slack Web API forwarding needs it.

## Regression checklist

- Behavior: `npm run dev` still serves on `0.0.0.0:3732`; `GET /v1/prism/health` behavior and sanitization remain unchanged.
- Behavior: `npm test` and `npm run build` remain green; dependency guard still rejects Supabase/PostGREST.
- Behavior: Slack authorize and token exchange use the same configured redirect URI, especially `http://localhost:3732/v1/slack/oauth/callback` for first live QA.
- Behavior: Browser-visible pages show only not linked, linked/healthy, or Reauth required state; no Slack credential values or raw OAuth responses appear.
- Behavior: DB persistence contains no plaintext Slack access/refresh tokens; credential tables store encrypted envelopes and metadata only.
- Behavior: Local tools and `/v1/*` API responses never receive Slack credentials.
- Behavior: OAuth state is one-time-use, expires, and protects callback forgery/replay.
- Behavior: Refresh success rotates stored encrypted token envelopes and leaves connection healthy.
- Behavior: Refresh failure marks Reauth required without deleting Prism users, Slack connection rows, credential history needed for diagnosis, or Token profile rows.
- Behavior: Socket Mode/events/interactivity/Slack method forwarding remain absent.
- Behavior: `.env.example` has placeholders only; `.env.local` values are never printed in command output or tests.

## Test plan

- Existing tests to keep green:
  - `src/server/health.test.ts`
  - `app/v1/prism/health/route.test.ts`
  - `src/server/dependency-guard.test.ts`
  - `npm run build`
- New tests to add before/with implementation:
  - Migration tests against Postgres or a controlled test database path: migrations create required tables, `schema_migrations` is idempotent, uniqueness/upsert constraints preserve one Prism user per Slack identity.
  - Config tests: missing Slack/encryption config fails with sanitized setup-required errors; test output never includes env values.
  - Encryption tests: local AES-GCM round-trip works; ciphertext differs from plaintext; wrong AAD/key fails; stored JSON/rows do not contain token canaries such as `xox` or `refresh-secret`.
  - OAuth start route tests: creates state hash, sets HTTP-only SameSite cookie, redirects to Slack authorize with configured redirect URI/scopes/state, and excludes client secret/tokens.
  - OAuth callback route/service tests with mocked Slack responses: rejects missing/mismatched/replayed/expired state; exchanges a valid code; creates/updates Prism user and Slack connection; stores bot/user credentials encrypted; sets HTTP-only session; redirects to status page without token query params.
  - Slack OAuth adapter tests: live adapter request construction uses Basic auth or otherwise does not log secrets; mocked responses cover `ok: true`, Slack `ok: false`, and network failure with sanitized error classes.
  - Refresh tests: success replaces encrypted access and refresh token envelopes and updates `expires_at`; recoverable failure marks `reauth_required`; Token profile/profile rows remain present.
  - Website tests: not-linked page shows Connect Slack; linked healthy page shows linked/healthy; reauth page shows Reauth required/reconnect; rendered HTML contains no credential canaries.
  - No-secret assertions across route responses, rendered HTML, logs captured in tests, and persisted credential rows.
- Live proof required:
  - Run migrations against local Docker Postgres, then `npm run dev` on port `3732` without printing `.env.local` values.
  - For mock QA, enable only the non-production mock flag and complete start/callback path; capture screenshot of linked/healthy or Reauth required status with no token values.
  - For live Slack QA, use the configured Slack app with redirect `http://localhost:3732/v1/slack/oauth/callback`, click Connect Slack in the Prism website, complete Slack consent, and verify the website shows linked/healthy. Do not capture Slack credential-bearing network payloads; screenshots should show only Prism status.
  - Inspect browser console/network at a high level for absence of token-like values in Prism responses. Do not print Slack response bodies.
  - Trigger mocked refresh success and refresh failure paths; verify healthy vs Reauth required status and persistence invariants.

## Risk assessment

- Risk: OAuth callback leaks credentials through raw Slack response logging, JSON response, query params, test snapshots, or screenshots.
  - Mitigation: route handlers redirect to generic status pages; service modules sanitize errors; tests assert absence of token canaries and secret-like fields.
- Risk: First schema overbuilds future Token profile/Capability map work or models the wrong ownership.
  - Mitigation: limit schema to Prism users, website sessions, Slack connections, OAuth state, encrypted credentials, and an optional minimal Token profile shell solely for preservation semantics; defer developer token issuance and Capability maps.
- Risk: Local encryption provider is mistaken for production KMS.
  - Mitigation: name it `local-aes-gcm-v1`, require explicit key id, store envelope metadata, and document that managed KMS/envelope provider can replace it without schema changes.
- Risk: Slack token rotation behavior differs between mocked and real app configuration.
  - Mitigation: keep token rotation fields optional but fully handled; if live OAuth omits `refresh_token`/`expires_in`, status can be linked with non-rotating credentials only if admin config intentionally differs, but issue #3 says token rotation is enabled and implementation should surface config mismatch.
- Risk: PKCE implementation causes `pkce_not_allowed` or stores code verifiers unsafely.
  - Mitigation: defer PKCE by default; use state + cookie now. Add PKCE only behind explicit Slack app support/config.
- Risk: SIWS identity scopes get mixed into Web API OAuth and break scope approval.
  - Mitigation: avoid SIWS/OpenID/legacy identity scopes for v1; use Web API OAuth `authed_user.id` and approved user scopes from docs.
- Risk: Callback/session approach becomes a hidden auth system.
  - Mitigation: implement only opaque HTTP-only website session needed to display current linked Slack user; do not add roles, admin, JWTs, or Local tool auth.
- Risk: Transient Slack refresh failures incorrectly force Reauth required.
  - Mitigation: classify Slack errors; tests should distinguish recoverable credential failures from transient service/rate-limit errors if implemented in this slice.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing code, ADR, issue #1, issue #3 docs, and Slack docs align on Next.js App Router, `/v1/slack/oauth/callback`, server-side OAuth exchange, plain Postgres, token rotation, and strict credential custody.
  - The only new architectural substrate required is durable schema/migrations plus encryption abstraction; both fit the existing `pg`/server-only pattern without adding platform dependencies.
  - Slack docs explicitly support Web API OAuth with bot/user scopes and token rotation through `oauth.v2.access`, which matches Prism's v1 credential-custody objective.
- Open questions:
  - Exact final bot/user scope list may still be reduced by Slack admin/security before live install; implementation should centralize scopes in config/constants so they are easy to adjust.
  - If maintainers want no `token_profiles` table until a later issue, refresh-failure tests should still prove users/connections are preserved and document Token profile preservation as a future invariant. My recommendation is to add only a minimal shell if necessary to make the acceptance criterion testable now.
  - If Slack/admin explicitly enables PKCE, add it behind config with hashed/verifier custody in `slack_oauth_states`; otherwise defer.
