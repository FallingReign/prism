# Architecture Integration Brief: issue-5-prism-developer-tokens

## Existing ownership

- Package/component/module/library:
  - **Prism website:** `app/page.tsx`, `app/slack-status-panel.tsx`, and `app/globals.css` currently own the user-facing setup surface. Issue #5's Token profile creation UI belongs here as a narrow extension of the linked Slack status page, not in a separate frontend app.
  - **Website session and Slack-link identity:** `src/server/slack/oauth-flow.ts` issues the opaque `prism_session` cookie; `src/server/slack/postgres-store.ts#getSlackLinkStatus` resolves it to a Slack-linked Prism user/connection. Token profile creation must reuse this session/connection resolution instead of adding a second auth path.
  - **Persistence:** plain Postgres via `src/server/db.ts`, `scripts/run-migrations.mjs`, and `db/migrations/*.sql` owns durable state. The existing `token_profiles` table is a shell from issue #4 and is the correct table to evolve into user-owned Token profiles.
  - **Secret/verifier material:** Node `crypto` and server-only service modules should own Prism developer token generation and verification-material derivation. This is not Slack credential custody and must not use the AES-GCM credential envelope because developer tokens must be non-retrievable, not decryptable.
  - **Configuration:** `src/server/config.ts` and `.env.example` already reserve `PRISM_DEVELOPER_TOKEN_PEPPER`; extend that config for verifier derivation rather than introducing app secrets elsewhere.
  - **Tests:** Vitest owns route/service/component coverage. Existing no-secret assertions around Slack credentials should be copied for Prism developer token plaintext.
- Current owner rationale:
  - `CONTEXT.md` defines the Prism website as the surface for token profile management, the Prism hosted service as the owner of policy enforcement and token resolution, and Prism developer tokens as opaque bearer secrets that resolve server-side to exactly one Token profile.
  - ADR 0001 requires Next.js route handlers/server primitives plus plain Postgres; it explicitly lists opaque Prism token verification as a core v1 requirement.
  - Issue #4 intentionally left a minimal `token_profiles` shell to preserve future Token profiles across Slack refresh failures. Issue #5 is the first slice that should make that shell real.
- Source evidence:
  - `db/migrations/0001_slack_oauth_custody.sql` creates `token_profiles(id, prism_user_id, slack_connection_id, created_at, updated_at)` with `UNIQUE (prism_user_id, slack_connection_id)`, which conflicts with issue #5's requirement for multiple named Token profiles per Slack-linked developer.
  - `src/server/slack/oauth-flow.ts` currently calls `store.ensureTokenProfile(...)` after OAuth callback; this creates exactly one placeholder row per user/connection and must be revisited.
  - `app/page.tsx` already says token profile management is a later Prism website slice.
  - `prism_slack_bridge_brief.docx` paragraphs 232-254 provide the PRD preset/default table for issue #5: read-only, messages-only, full Slack bridge, and custom presets; expiry defaults of no expiry for read-only, 90 days for standard read/write/messages-only and full Slack bridge, 30 days for destructive-capable, and 24 hours or 7 days for experiment tokens; explicit destructive enablement; narrowing without rotation; broadening with explicit confirmation and token rotation; and user-backed/bot-backed/automatic/selectable execution identities.
  - `npm test` passed 24/24 and `npm run build` passed before this brief.

## Existing interaction model

- User/system behaviors that already exist:
  - A developer links Slack through `GET /v1/slack/oauth/start` and `GET /v1/slack/oauth/callback`.
  - A successful callback creates/updates a Prism user, a Slack connection, encrypted Slack credentials, an HTTP-only `prism_session`, and then redirects to `/`.
  - The homepage renders not-linked, linked/healthy, reauth-required, or setup-required Slack status without exposing Slack credentials.
  - Refresh failure marks a Slack connection `reauth_required` without deleting users, Slack connections, credentials, or Token profile rows.
- Behaviors that must remain unchanged:
  - Local tools and browser-visible responses must never receive Slack credentials.
  - OAuth state/session cookies remain opaque, HTTP-only, SameSite=Lax, and server-resolved.
  - `/v1/slack/*` remains the Slack OAuth/Slack-compatible namespace; Token profile management should not collide with Slack method forwarding paths.
  - Socket Mode, events, slash commands, interactivity, file transfer, admin/org methods, and Slack method forwarding remain out of scope for this slice.
  - Reauth-required Slack connections should preserve Token profiles and make the UI prompt Slack reconnect, not delete developer-token state.
- Runtime or UX evidence:
  - Baseline `npm test` passed 11 files / 24 tests.
  - Baseline `npm run build` passed; routes are dynamic for `/`, `/v1/prism/health`, and Slack OAuth handlers.
  - Existing rendered HTML tests assert no `xox`, refresh, `client_secret`, or `access_token` leakage; analogous tests must assert new copy-once Prism token plaintext appears only in the creation response/component state and not in subsequent profile listings.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a server-only domain under `src/server/token-profiles/`, for example:
    - `presets.ts` for named presets and Capability map validation/defaulting.
    - `developer-token.ts` for `randomBytes` token generation and HMAC/SHA verifier derivation.
    - `store.ts` for Postgres reads/writes and session-to-user/connection resolution.
    - `service.ts` for create-profile orchestration.
  - Add a thin App Router route handler such as `app/v1/prism/token-profiles/route.ts` for `POST` creation and optional `GET` listing if the UI needs client fetch. Keep route handlers thin, like existing Slack OAuth routes.
  - Extend the server-rendered homepage with a `TokenProfilesPanel` that is shown only for linked Slack users. If copy-once display needs client state, use a small client component that calls the thin POST route and renders the returned plaintext only in the immediate success state; do not persist it in URL, cookies, localStorage, or database.
  - Use the existing `prism_session` cookie from `src/server/slack/oauth-flow.ts` to authorize browser token-profile management.
  - Use Postgres JSONB for `capability_map`, with TypeScript validation in the service before insert. Later issues (#6/#7) can derive status/capabilities/policy from the same stored map.
  - Use Node `crypto.randomBytes(32 or 48).toString("base64url")` for opaque high-entropy token material and `createHmac("sha256", pepper)` or an equivalent keyed verifier for storage. Include a non-secret token prefix only if useful for operator recognition, e.g. `prism_dev_`; never make it a JWT-like `header.payload.signature` value.
- Relevant docs or library capabilities:
  - Node's `crypto.randomBytes` provides CSPRNG bytes; `createHmac("sha256", pepper)` provides verifier material that cannot reveal plaintext without the server-held pepper.
  - PostgreSQL JSONB plus CHECK constraints/partial indexes can enforce profile/token invariants without an ORM.
  - Next.js App Router supports both server-rendered pages and route handlers; this repo already uses route handlers for hosted-service HTTP boundaries.
- Existing examples in this codebase:
  - `app/v1/slack/oauth/start/route.ts` and `callback/route.ts` show thin route handlers delegating to server modules and setting secure cookies.
  - `src/server/slack/postgres-store.ts` centralizes SQL for Slack/session identity. Token profile SQL should be similarly isolated, not embedded in React components.
  - `src/server/credentials/encryption.test.ts` and Slack OAuth tests show canary-based no-secret persistence assertions.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add Supabase, PostgREST, Prisma/Drizzle, NextAuth/Auth.js, JWT auth, Express/Fastify, or Pages Router API routes.
  - Do not create a second browser authentication/session system; reuse `prism_session` and the existing Prism user/Slack connection tables.
  - Do not store Prism developer tokens with the Slack credential AES-GCM decryptable envelope; developer-token storage must be verifier-only.
  - Do not treat Slack OAuth scopes as Token profile policy. Capability maps are Prism policy objects that narrow Slack-admin-approved maximum app capability.
  - Do not create a separate `developer_profiles`/`api_keys` parallel model when `token_profiles` already exists as the domain owner.
- Shortcuts or parallel paths to avoid:
  - No plaintext Prism developer token in Postgres, logs, cookies, URLs, query params, localStorage, screenshots after copy, profile listing responses, test snapshots, or subsequent page renders.
  - No JWTs or structured bearer credentials whose embedded payload becomes policy source-of-truth.
  - No Local tool route that can mint developer tokens without a Slack-linked website session.
  - No mock-only creation flow that skips the real token generation/verifier-storage path.
  - No broad Method registry/forwarding implementation in this issue; store maps now, enforce/forward later.
- Invariants:
  - A Prism developer token maps to exactly one Token profile.
  - A Capability map belongs to exactly one Token profile.
  - A Slack-authenticated Prism user can own multiple Token profiles for the same Slack connection.
  - Token plaintext is shown exactly once at creation and is not retrievable afterward.
  - Stored verification material cannot reveal plaintext token material.
  - Capability maps must not exceed v1 documented/deferred boundaries: no admin/org methods, events/interactivity, slash commands, canvases/lists, or file transfer by default.

## Integration plan

- Insert the change at:
  - **Migration:** add `db/migrations/0002_prism_developer_tokens.sql`. Evolve `token_profiles` rather than creating a parallel table.
    - Drop the current one-profile constraint: `ALTER TABLE token_profiles DROP CONSTRAINT IF EXISTS token_profiles_prism_user_id_slack_connection_id_key;`.
    - Add profile metadata: `name text`, `intended_use text`, `preset text CHECK (preset IN ('read_only','messages_only','full_slack_bridge','custom'))`, `capability_map jsonb`, `expires_at timestamptz`, `created_by_session_hash text` if useful for provenance, and timestamps/status fields as needed.
    - Backfill existing issue-4 placeholder rows safely. Recommended: mark them as non-token-bearing draft/bootstrap rows or migrate to a named default with a conservative read-only capability map and no developer token. Do not create a plaintext token during migration.
    - Add constraints/indexes after backfill: non-empty `name` and `intended_use`, `capability_map` object, `expires_at > created_at` where present, index by `prism_user_id`, and unique `(prism_user_id, name)` if product wants user-local unique names.
    - Add a separate `prism_developer_tokens` table: `id`, `token_profile_id REFERENCES token_profiles(id) ON DELETE CASCADE`, `token_hash text UNIQUE NOT NULL`, `hash_algorithm text NOT NULL`, `pepper_id text NOT NULL`, `created_at`, `expires_at`, `last_used_at`, `revoked_at`. Add a partial unique index for one current token per profile: `UNIQUE (token_profile_id) WHERE revoked_at IS NULL`. This table prepares issue #11 overlap without making plaintext retrievable.
  - **Config:** extend `src/server/config.ts` with `getDeveloperTokenConfig()` returning `pepper` and `pepperId`/algorithm metadata. Use `.env.example`'s `PRISM_DEVELOPER_TOKEN_PEPPER`; add `PRISM_DEVELOPER_TOKEN_PEPPER_ID` if verifier rotation metadata is needed. Missing config should fail with sanitized setup-required errors.
  - **Token generation/verifier service:** add `src/server/token-profiles/developer-token.ts`:
    - `issueDeveloperToken(randomBytes = nodeRandomBytes) -> plaintext` using at least 256 bits of entropy.
    - `hashDeveloperToken(plaintext, { pepper, pepperId }) -> { tokenHash, algorithm, pepperId }` using HMAC-SHA-256 or stronger keyed hashing.
    - Tests must prove the token is opaque, high entropy length, non-JWT-shaped, and verifier output does not contain plaintext.
  - **Preset/Capability map module:** add `src/server/token-profiles/presets.ts` as the single source of truth for the PRD defaults from `prism_slack_bridge_brief.docx` paragraphs 232-254. It should represent experiment options, destructive opt-in, expiry defaults, and execution identity fields explicitly in JSON so future `/v1/prism/status`, `/v1/prism/capabilities`, and Method registry enforcement can consume the same shape. Encode at least:
    - `read_only`: read/search Slack context without posting or mutating; search can be separately enabled/disabled; no expiry allowed for v1, with only later periodic review nudges if desired.
    - `messages_only`: read/write messages and reactions in selected surface types; no file content, canvases, lists, or destructive actions; standard read/write expiry default is 90 days.
    - `full_slack_bridge`: broad non-admin Slack bridge within selected workspaces/surfaces, subject to explicit destructive-action opt-in; expiry default is 90 days unless destructive capability is enabled.
    - `custom`: user manually selects workspace, surface, read/write/search/destructive capabilities, expiry, and execution identity. Destructive-capable custom tokens default to 30 days; experiment tokens use a 24-hour or 7-day preset; non-destructive standard read/write custom defaults to 90 days unless the user chooses a stricter allowed expiry.
    - Policy mutation semantics: destructive actions are supported only through explicit enablement; capability narrowing takes effect immediately without rotation; capability broadening requires explicit confirmation and token rotation.
    - Execution identity options: user-backed, bot-backed, automatic, and selectable; persist the selected/derived value in the capability map rather than inferring it from Slack OAuth scopes.
  - **Store/service:** add `src/server/token-profiles/store.ts` and `service.ts` to:
    - Resolve `prism_session` to `{ prismUserId, slackConnectionId, slackStatus }` using existing session hash semantics.
    - Reject creation if not linked, session expired, or no Slack connection exists. For `reauth_required`, creation may either be allowed with a warning or blocked; choose deliberately in product tests. Recommendation: allow profile management but surface Reauth required, because issue #4 preserved profiles through reauth.
    - Validate input name, intended-use label, preset/custom map, destructive opt-in, experiments, and expiry before SQL.
    - Insert `token_profiles` and `prism_developer_tokens` in one transaction, returning `{ profile metadata, plaintextDeveloperToken }` only from the create call.
  - **Route/UI:** add `POST /v1/prism/token-profiles` for creation and a website panel/form on `/` for linked users.
    - The creation response may include the plaintext token exactly once. It must set `Cache-Control: no-store` and must not redirect with the token in a URL.
    - The list/read path must return/display profile metadata, preset/capability summary, expiry, and status only; never token plaintext or token hash.
    - UI copy must warn: Slack content is untrusted input to Local tools; Prism does not execute local actions; copy and store the Prism developer token now because it cannot be retrieved later.
  - **Existing OAuth code:** remove or narrow `ensureTokenProfile` behavior from `completeSlackOAuthCallback`. Issue #5 should not create usable developer tokens during Slack OAuth. If placeholder preservation is still needed, make it explicit and non-token-bearing; otherwise update tests to assert OAuth does not mint a developer token.
- Why this is the correct integration point:
  - It keeps token profile management in the Prism website and hosted service, uses the existing Slack-linked Prism user/session model, and evolves the domain table already introduced for this purpose.
  - It separates decryptable Slack credential custody from one-way Prism developer-token verification material, preserving the security boundary in `CONTEXT.md`.
  - It gives future issue #6/#7 a durable Capability map source without implementing forwarding/policy evaluation prematurely.
- Alternatives considered and rejected:
  - **JWT developer tokens:** rejected by issue acceptance and glossary; policy must be server-resolved, not embedded.
  - **Encrypting Prism developer tokens for retrieval:** rejected because copy-once requires non-retrievable verifier-only storage.
  - **Adding an API-key package/ORM/auth framework:** rejected as unnecessary and contrary to ADR 0001/dependency guardrails.
  - **Creating `api_keys` separate from `token_profiles`:** rejected as a parallel domain path that would obscure the exactly-one Token profile mapping.
  - **Creating tokens during Slack OAuth callback:** rejected because issue #5 says a developer creates named Token profiles with intended-use labels and copy-once token UX; OAuth linking should only establish identity/connection.

## Regression checklist

- Behavior: Slack OAuth start/callback still links a user, stores only encrypted Slack credentials, and shows linked/healthy without credential leakage.
- Behavior: `prism_session` remains opaque, HTTP-only, SameSite=Lax, and server-resolved; no second website auth path is introduced.
- Behavior: Existing refresh failure keeps Token profiles and marks Slack connection Reauth required.
- Behavior: A linked developer can create more than one named Token profile for the same Slack connection; the old unique `(prism_user_id, slack_connection_id)` invariant no longer blocks this.
- Behavior: Prism developer token plaintext appears only in the immediate creation result/UI and not in subsequent profile listings, database rows, logs, cookies, URLs, or tests.
- Behavior: Stored verifier material is keyed/hashed and cannot reveal plaintext developer tokens.
- Behavior: Preset/custom Capability maps remain Prism policy objects and do not masquerade as Slack scopes.
- Behavior: Deferred surfaces and admin/org/file-transfer capabilities remain excluded or explicitly disabled unless a custom map marks future/experiment options without enabling enforcement.
- Behavior: `GET /v1/prism/health` remains fixed/sanitized; `/v1/slack/*` OAuth routes remain unchanged.
- Behavior: `npm test`, `npm run build`, and migration idempotency remain green.

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
- New tests to add before/with implementation:
  - Migration tests or SQL verification: `0002` is idempotent, drops/replaces the one-profile uniqueness, backfills existing placeholder rows safely, creates `prism_developer_tokens`, and enforces token hash uniqueness plus exactly-one-current-token-per-profile.
  - Config tests: missing developer-token pepper produces sanitized setup-required errors; config/test output does not include the pepper.
  - Developer-token unit tests: generated token has >=256 bits entropy, is opaque/non-JWT-shaped, verifier hash does not contain plaintext, same token+pepper verifies consistently, wrong token/pepper fails.
  - Preset tests: read-only, messages-only, full Slack bridge, and custom defaults match `prism_slack_bridge_brief.docx` paragraphs 232-254 exactly: read-only allows read/search only with separately toggleable search and no expiry; messages-only allows selected-surface messages/reactions read/write only and defaults to 90 days; full Slack bridge is broad non-admin bridge capability within selected workspaces/surfaces and defaults to 90 days; custom requires explicit workspace/surface/capability/expiry/execution-identity choices. Destructive actions must be explicit opt-in and default to 30 days when enabled; experiment tokens must use 24-hour or 7-day presets; standard read/write defaults to 90 days.
  - Policy-change tests: capability narrowing takes effect immediately without token rotation; capability broadening requires explicit confirmation and token rotation; execution identity supports user-backed, bot-backed, automatic, and selectable values.
  - Service tests: unauthenticated/not-linked creation is rejected; linked creation inserts one Token profile and one verifier row transactionally; multiple profiles per linked user/connection are allowed; invalid custom maps are rejected; reauth-required behavior matches the chosen product decision.
  - Route tests: `POST /v1/prism/token-profiles` returns `Cache-Control: no-store`, returns plaintext only on creation success, never returns token hash/pepper, and rejects missing/expired session.
  - UI tests: linked page shows token creation form, preset/custom choices, intended-use field, warning copy, copy-once success state, and subsequent metadata-only profile list without plaintext token.
  - No-secret tests: database rows, rendered profile list, route errors, logs, and snapshots do not contain Prism developer token canaries, Slack token canaries, `access_token`, `client_secret`, or pepper values.
- Live proof required:
  - Run `npm run db:migrate` against local Docker Postgres twice to prove idempotency.
  - Start `npm run dev` on port `3732`; complete mock or real Slack OAuth to get linked/healthy.
  - Create a Token profile from the website; capture proof that the copy-once token is displayed with warning copy and no Slack credentials.
  - Refresh/navigate back to profile management; prove the same token is not retrievable and only metadata remains.
  - Inspect Postgres rows at a high level for profile/verifier presence and absence of plaintext token canary; do not print real secrets.
  - Run `npm test` and `npm run build` after implementation.

## Risk assessment

- Risk: The existing `token_profiles` uniqueness and `ensureTokenProfile` placeholder behavior cause issue #5 to support only one profile or accidentally mint profiles during OAuth.
  - Mitigation: Explicitly migrate/drop the uniqueness, update OAuth tests, and make token issuance happen only through the profile creation service.
- Risk: Implementer stores developer tokens in the decryptable Slack credential envelope or another retrievable form.
  - Mitigation: Use a separate verifier-only `prism_developer_tokens` table and HMAC/keyed hash module; add canary tests against persistence and responses.
- Risk: PRD preset/default semantics drift from the authoritative DOCX table.
  - Mitigation: Treat `presets.ts` as a single tested source of truth backed by `prism_slack_bridge_brief.docx` paragraphs 232-254. Tests must assert the exact preset intents, expiry defaults, destructive opt-in, narrowing/broadening rotation semantics, experiment-token durations, and execution-identity options listed in that source.
- Risk: Copy-once UI leaks token plaintext through URL redirects, browser storage, cache, screenshots, or server logs.
  - Mitigation: Return token only in the immediate no-store creation response/client state; never include it in URLs/cookies; tests assert later renders omit it.
- Risk: Broad Capability map UI accidentally implements Method registry or enables deferred/admin/file-transfer surfaces early.
  - Mitigation: Store declarative maps now; enforcement/forwarding remains later. Defaults must explicitly mark deferred/unsupported surfaces disabled.
- Risk: Reauth-required semantics become confused with token revocation/expiry.
  - Mitigation: Preserve Slack connection status separately from Token profile/token state; UI can warn about Reauth required without deleting profiles.

## Decision confidence

- Confidence: high
- Reasons:
  - High confidence on structural ownership: Prism website + existing `prism_session` + plain Postgres + evolving `token_profiles` is strongly supported by code, ADR, issues, and docs.
  - High confidence that developer-token material must use one-way verifier storage, not JWTs or decryptable envelopes.
  - High confidence on preset/default semantics because the implementer supplied the authoritative PRD table from `prism_slack_bridge_brief.docx` paragraphs 232-254, removing the prior blocker about missing expiry and preset defaults.
- Open questions:
  - Should Token profile creation be allowed while Slack connection is `reauth_required`, or should it be blocked until reconnect? Recommendation: allow profile management and show a Reauth warning; block only Slack calls in later issues.
  - Should profile names be unique per Prism user, per Slack connection, or allow duplicates with distinct intended-use labels? Recommendation: unique per Prism user for UI clarity unless the PRD says otherwise.
