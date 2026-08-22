# Architecture Integration Brief: Prism first-run Slack configuration center

## Decision summary

Build one complete first-run slice in Prism:

1. A host operator runs `npm run setup:bootstrap`. The command mints a 256-bit,
   short-lived, one-time setup capability, stores only its SHA-256 hash, and
   prints the plaintext once to the terminal.
2. The operator opens `/setup`, exchanges the capability through a same-origin
   POST, and receives a short-lived encrypted-transport/HttpOnly setup session.
3. A guided form saves an immutable **pending** Slack app configuration. The
   client secret is encrypted with Prism's existing root credential cipher
   before it reaches Postgres.
4. The form starts Slack OAuth against that exact pending configuration. The
   OAuth state row is bound to its immutable configuration version and the
   setup session.
5. A successful Slack callback atomically activates that version, creates the
   normal Prism user/connection/session, consumes the setup session, and makes
   that Slack user the initial **Prism configuration admin**.

This removes routine `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and scope editing
from local `.env` files without putting a secret in browser storage or inventing
an unauthenticated settings screen. The deployment URL, database credentials,
and root encryption key remain infrastructure-owned. Existing complete
environment/secret-manager Slack credentials remain authoritative and lock the
UI read-only.

Slack does not provide an “all scopes” wildcard or discovery endpoint. Slack's
OAuth contract accepts explicit comma-separated `scope` and `user_scope`
values, and Slack recommends requesting only permissions the product needs:

- https://docs.slack.dev/authentication/installing-with-oauth/
- https://docs.slack.dev/reference/scopes/
- https://docs.slack.dev/reference/app-manifest/

Per the operator requirement, an omitted scope selection defaults to every
scope in Prism's typed, reviewed catalogue. The form also provides explicit
**Select all Prism-supported** and per-scope controls. It must never call that
selection “all Slack scopes,” and it must warn that selecting a scope does not
add or approve it in the Slack app. Slack can still reject authorization when
the existing app or workspace has not approved one of those explicit scopes.

Decision confidence is **high**. There is no architectural blocker. Real QA is
externally gated on the existing Slack app already having `chat:write`; the
slice must not request a new Slack app or claim new approval.

## Evidence inspected

- Repository instructions: `AGENTS.md` requires this separate Architecture
  Scout brief before implementation and a separate post-implementation review.
- Current configuration owner: `src/server/config.ts#getSlackOAuthConfig` reads
  Slack client credentials, URLs, scopes, and mock flags synchronously from
  `process.env`. Empty real scopes currently fail setup.
- OAuth interaction: `app/v1/slack/oauth/start/route.ts` resolves config before
  persisting state; `src/server/slack/oauth-flow.ts` creates a 32-byte state,
  hashes it, sets an HttpOnly SameSite=Lax cookie, and builds Slack's authorize
  URL. The callback consumes the state once, exchanges the code, encrypts Slack
  tokens, and creates a Prism session.
- State store: `src/server/slack/postgres-store.ts` owns atomic state consume and
  user/connection/session persistence. `slack_oauth_states` already carries
  typed OIDC and delegated-delivery continuations.
- Secret custody: `src/server/credentials/encryption.ts` owns the existing
  AES-256-GCM `CredentialCipher`. Envelopes contain algorithm, key ID, IV, tag,
  and ciphertext; associated data prevents moving a secret to another owner.
  `src/server/credentials/factory.ts` obtains the root key from
  `PRISM_CREDENTIAL_ENCRYPTION_KEY` and its key ID.
- Existing setup helper: `scripts/ensure-local-encryption-key.mjs` already makes
  local root-cipher setup less manual. The root key remains the root of trust
  and is not suitable for storage inside the database it encrypts.
- Existing settings/audit convention: migration `0011` and
  `src/server/token-profiles/global-policy-store.ts` use Postgres transactions
  so a settings mutation cannot commit without its metadata-only audit row.
- Existing admin model: Slack-authenticated admin decisions use
  `resolvePrismAdmin` plus a server-side JSON allowlist. That cannot authorize
  first-run Slack configuration because no Slack session exists yet, and it
  would reintroduce the raw-file administration the user wants removed.
- Browser mutation protection: `rejectCrossOriginBrowserMutation` requires an
  exact configured origin or positive same-origin Fetch Metadata signal.
- Current UI: `app/page.tsx` and `app/slack-status-panel.tsx` already model
  `setup_required`, but only tell the operator to change server settings.
- Scope catalogue evidence: the checked-in manifest and review packet list 13
  bot and 14 user v1 candidate scopes. Those are Prism-supported candidates,
  not evidence that the real Slack app has approved them. `chat:write` is the
  only scope required by the current Playtest announcement delivery slice.
- Runtime observation: no listener was present on port 3732 during this review.
  The focused existing suite passed 34 of 35 tests; the one failure was an
  existing five-second timeout in `app/page.test.tsx` (“renders the API
  reference link”), not a configuration assertion.

## Ownership and boundaries

### Prism owns in this slice

- Slack app client ID and client secret custody.
- The explicit bot/user scope request used by Prism's Slack OAuth flow.
- Pending/active configuration versions and effective-config resolution.
- Bootstrap capability/session lifecycle.
- Slack OAuth version binding, activation, initial configuration-admin claim,
  and metadata-only configuration audit.
- `/setup` and the Prism configuration-center UI.

Recommended modules:

- `src/server/slack/app-configuration.ts`: types, typed scope catalogue,
  defaults, validation, redacted presentation, and resolver contracts.
- `src/server/slack/app-configuration-postgres-store.ts`: immutable versions,
  activation, authorization, and transactional audit.
- `src/server/setup/bootstrap.ts` and `bootstrap-postgres-store.ts`: capability
  generation/hash/consume, setup-session issuance, expiry, and recovery rules.
- `src/server/slack/app-configuration-factory.ts`: the only production factory
  combining deployment env policy, Postgres, and the configured root cipher.
- `app/setup/*`: first-run server page and reusable form.
- `app/admin/configuration/*`: authenticated status/read surface after claim.

`src/server/config.ts` remains the owner of deployment-level configuration:
database URL, public origin/redirect policy, root cipher, dev mocks, OIDC
signing, and delegated-delivery registration. It should parse an optional
environment Slack bundle but stop being the only source of app credentials.

### Playtest owns later, not here

Playtest may later own a friendly UI for its Prism issuer/client registration,
GetBuild integration, and Playtest-specific behavior. It must not store, proxy,
or display Prism's Slack client secret or decide Prism's Slack scopes. The only
Playtest change justified by this slice is a later status/link to Prism setup;
do not couple the first-run implementation to a broad Playtest settings page.

### Do not bypass

- Do not store the Slack client secret, bootstrap capability, setup-session
  token, OAuth state, Slack code, or Slack token in plaintext.
- Do not put setup capabilities or secrets in URLs, fragments, query strings,
  HTML, browser local/session storage, logs, errors, audit rows, or telemetry.
- Do not add a public “first visitor becomes admin” path. Host access plus the
  one-time capability is the pre-authentication authority.
- Do not accept an editable OAuth callback/public-base URL in the setup form.
  The callback is deployment-owned and derived from the validated Prism origin.
- Do not select a pending configuration through a query-string ID supplied by
  the browser. Server-side setup/admin authorization chooses the candidate.
- Do not let a later configuration edit swap client ID, secret, redirect, or
  scopes underneath an outstanding OAuth state.
- Do not let DB configuration override a complete environment/secret-manager
  bundle. Do not merge one credential from env with another from Postgres.
- Do not make Slack scopes the Prism Capability map. Scopes remain the Slack
  app's maximum; Token profile policy remains the effective local-tool policy.
- Do not mix Sign in with Slack identity scopes into this existing Web API
  OAuth flow.
- Preserve dev mock behavior as an explicitly labelled non-production path;
  production mock guards remain fail-closed.

## User interaction model

### Initial setup

1. Prism's setup-required panel says “Configure Slack in Prism” and links to
   `/setup`; it no longer tells a local developer to edit several variables.
2. `/setup` shows the exact callback URI to register in Slack and asks for the
   one-time setup code. It never reveals whether a guessed code exists.
3. After a valid code exchange, show a guided form:
   - Slack Client ID (plain text; it is not a bearer secret).
   - Slack Client Secret (`type=password`, never prefilled or returned).
   - User and bot scope checklists, with the complete reviewed catalogue
     selected when no prior selection exists.
   - Required user `chat:write` cannot be removed.
   - “Select all Prism-supported” and “Reset to default” actions.
   - Copy explaining that choices must already be configured/approved on the
     existing Slack app and that no wildcard exists.
   - Read-only callback URI with a copy button.
4. Saving creates a pending version and shows “Not verified.” It does not make
   unverified credentials the normal runtime configuration.
5. “Verify and connect Slack” is a same-origin POST that starts OAuth for the
   server-selected pending version.
6. On success the callback activates the version, signs the person into Prism,
   grants initial configuration-admin ownership, clears setup cookies, and
   returns to a success page. On Slack/config failure it returns a generic
   retryable error while the short-lived setup session remains usable.

### After the initial claim

- `/admin/configuration` shows source (`Prism configuration` or
  `Environment locked`), active version, secret status (“Stored,” never its
  value), selected scopes, callback URI, and last activation metadata.
- This slice may be read-only after activation. Post-login client-secret
  replacement/rotation is explicitly deferred if implementing it would expand
  the first-run slice. Recovery remains the host-minted `--recover` path.
- Existing globally allowlisted Prism admins may read the status. Mutation in a
  future slice should require either the claimed configuration-admin role or an
  existing global admin and must use the same pending/verify/activate model.

## Scope model

Create one server-owned catalogue with literal IDs, token kind, product family,
risk/help copy, and whether the scope is required/default. Derive the UI and
OAuth validator from that same catalogue; do not duplicate string lists.

Default when no scope selection is stored or supplied:

```ts
botScopes = ALL_PRISM_SUPPORTED_BOT_SCOPES;
userScopes = ALL_PRISM_SUPPORTED_USER_SCOPES;
```

The explicit “Select all Prism-supported” action selects the current manifest
candidates:

- Bot: `channels:read`, `channels:history`, `groups:read`, `groups:history`,
  `im:read`, `im:history`, `mpim:read`, `mpim:history`, `chat:write`,
  `reactions:read`, `reactions:write`, `files:read`, `users:read`.
- User: the same list plus `search:read`.

Do not include `chat:write.public`, email/profile expansion, team/admin/org,
app-management, events, Socket Mode, discovery, SCIM, audit logs, canvases,
lists, workflows, or file-write scopes. Adding a catalogue entry is a reviewed
product/security change.

Validation canonicalizes catalogue order, deduplicates, rejects unknown values,
and requires user `chat:write` for this Playtest slice. A saved empty/missing
list does not mean a wildcard. The OAuth URL contains only explicit selected
values.

Legacy environment behavior follows the same explicit operator default:

- If neither scope variable is configured, use the complete reviewed Prism
  catalogue above.
- If either `SLACK_BOT_SCOPES` or `SLACK_USER_SCOPES` is configured, treat both
  as an explicit legacy selection; the omitted side is empty.
- Reject unknown scopes and reject a combined selection without user
  `chat:write` for the Playtest-enabled build.

## Data model and migration

Add one additive migration (next sequence, currently `0017`) with these tables
and columns. Use repository text UUID conventions unless the implementer first
standardizes existing IDs; all opaque tokens remain hashes.

### `prism_slack_app_configuration_versions`

- `id text primary key`
- `version bigint generated always as identity unique`
- `status text check in ('pending','active','superseded')`
- `client_id text not null` with a bounded-length check
- `client_secret_envelope jsonb not null`
- `bot_scopes text[] not null default '{}'`
- `user_scopes text[] not null`
- `created_via text check in ('bootstrap','configuration_admin')`
- `created_by_prism_user_id text null references prism_users(id)`
- `setup_session_id text null references prism_setup_sessions(id)`
- `created_at`, `activated_at`, `superseded_at`
- a unique partial index allowing at most one `active` version
- an index over pending versions/creation time for cleanup

Generate the version ID before encryption and use stable AAD:
`prism-slack-app-configuration:<version-id>:client-secret`. An update that keeps
an old secret must decrypt then re-encrypt it under the new version's AAD; never
copy an envelope to a different AAD owner. Reads return `secretConfigured: true`
only, never the envelope.

### `prism_setup_bootstrap_tokens`

- `id text primary key`
- `token_hash text unique` constrained to 64 lowercase hex characters
- `purpose text` fixed to `initial_slack_configuration`
- `recovery boolean not null default false`
- `created_at`, `expires_at`, `used_at`, `revoked_at`
- `used_by_request_id text null`

The CLI invalidates prior unused tokens before inserting a new token. Default
TTL: 15 minutes. Only `--recover` may mint after an active configuration or
configuration admin exists; this explicit host action is break-glass authority.

### `prism_setup_sessions`

- `id text primary key`
- `session_token_hash text unique`, SHA-256 only
- `bootstrap_token_id text references prism_setup_bootstrap_tokens(id)`
- `purpose text` fixed as above
- `created_at`, `expires_at`, `revoked_at`, `claimed_at`
- `claimed_by_prism_user_id text null references prism_users(id)`

The browser receives only the random session token in an HttpOnly,
SameSite=Strict cookie. Production requires Secure/HTTPS. Path `/` is required
because both `/setup` and OAuth start/callback participate. Max age must not
exceed the DB expiry (recommended 30 minutes).

### `prism_configuration_admins`

- `prism_user_id text primary key references prism_users(id)`
- `role text` fixed to `global_configuration_admin`
- `claim_source text` fixed to `initial_bootstrap` for this slice
- `created_at`, `revoked_at`

This is a narrow Prism configuration role, not Slack administration. It need not
replace the existing general admin allowlist in this slice.

### OAuth state binding

Alter `slack_oauth_states` to add:

- `slack_app_configuration_version_id text null references
  prism_slack_app_configuration_versions(id) on delete restrict`
- `setup_session_id text null references prism_setup_sessions(id) on delete set
  null`
- `environment_configuration_fingerprint text null` constrained to 64 hex
  characters

Every new OAuth state has exactly one configuration binding:

- DB source: immutable version ID; setup verification also binds setup session.
- Environment source: an HMAC-SHA-256 fingerprint over the complete effective
  bundle using root-cipher material as the HMAC key. The callback recomputes and
  fails closed if a deployment restart changed the bundle mid-flow. Never use a
  plain hash of the client secret.

Leave legacy rows nullable for migration compatibility, but new code rejects an
unbound live state. The normal state cookie, one-time consume, continuation
constraints, and redirect-URI equality checks remain.

### Audit constraint

Extend `ActivityType` and the database check with metadata-only events:

- `slack_configuration_candidate_created`
- `slack_configuration_activated`
- `configuration_admin_claimed`

Use `objectType: "slack_app_configuration"`, the opaque version ID as object
ID, `executionMode: "bootstrap"` or `"configuration_admin"`, request ID,
status, and actor IDs when one exists. Never audit client ID, secret/envelope,
scope list, setup token/session hash, OAuth state/code, or Slack response.
Candidate save and audit must share a transaction; callback activation, owner
claim, setup-session consume, connection/session persistence, and both activation
audits must share the existing callback transaction.

## Effective configuration precedence

Resolve an atomic bundle, never field-by-field:

1. **Complete environment bundle:** a real non-placeholder
   `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` makes environment/secret-manager
   configuration authoritative. The UI shows `Environment locked` and cannot
   overwrite it. Scope rules above apply. A partial pair is a setup error and
   does not fall back to Postgres.
2. **Actor-authorized pending DB version:** used only by the setup/admin verify
   POST and only when that setup session/admin owns the pending candidate.
3. **Active DB version:** used by ordinary Slack connect/reauth.
4. **No source:** setup required.

When `next start` loads Prism's complete reserved development-mock bundle from
a shared local environment file, production classifies that exact bundle as no
source. It is never returned as a real OAuth client, so an active DB version or
`/setup` can win. A mock flag combined with a non-reserved real client and every
partial real credential pair remain sanitized setup errors.

The complete bundle also includes the deployment-owned validated public base
URL and exact callback URI. Do not persist an operator-editable redirect in the
Slack config row. In non-production, `http://localhost:3732` may remain the
documented default; production URL/HTTPS policy remains in `src/server/config.ts`.

Introduce an asynchronous resolver because DB-backed configuration cannot be
safely hidden behind the current synchronous `getSlackOAuthConfig`. Keep the
returned OAuth config shape stable for the Slack client. OAuth start, callback,
homepage setup status, forwarding refresh, display-name enrichment refresh, and
the display-name backfill must all use the resolver. Do not add a second
environment loader in routes or scripts.

The callback must resolve the version **after** the one-time state is validated
and consumed. Refactor `completeSlackOAuthCallback` to accept a trusted
configuration resolver keyed by the stored binding, rather than passing the
current global config before state consume. A missing/superseded/unauthorized
binding or environment fingerprint mismatch is a generic OAuth error before
Slack token exchange.

## Routes and response policy

### Host command

- `npm run setup:bootstrap` -> `scripts/create-setup-bootstrap.mjs`
- `npm run setup:bootstrap -- --recover` for explicit break-glass recovery.
- Require migrated Postgres and a valid configured root cipher.
- Print the code once plus `/setup` instructions. Do not print a tokenized URL.

### Setup surface

- `GET /setup`: public, dynamic, no-store; renders only generic code entry until
  a valid setup session exists.
- `POST /v1/prism/setup/session`: exact same-origin, JSON/form size bounded,
  rejects every query string before CSRF/source/body work, returns generic
  invalid/expired responses, atomically consumes the capability and inserts the
  session, then issues the setup cookie and redirects to `/setup`.
- `PUT /v1/prism/setup/slack-configuration`: setup-session required, validates
  and creates/replaces that session's pending immutable version.
- `POST /v1/prism/setup/slack-configuration/verify`: setup-session required;
  creates OAuth state bound to the server-selected pending version and returns
  a 303 Slack redirect. A normal HTML form is preferable to fetch so the browser
  follows the cross-origin redirect without exposing state to client code.

### Existing OAuth routes

- `GET /v1/slack/oauth/start`: ordinary user linking only, using the active or
  environment-locked config. It never accepts a version ID or setup claim from
  query input.
- `GET /v1/slack/oauth/callback`: consumes state, resolves its exact config
  binding, exchanges code, and performs activation/claim when setup-bound.

### Admin/read surface

- `GET /admin/configuration`: requires configuration-admin or existing global
  Prism admin; shows redacted status/source/version.
- An authenticated JSON status route is optional. Do not add post-login secret
  mutation to this first slice unless it reuses pending verification end to end.

All setup/config responses use no-store, no-referrer, frame denial/CSP, request
correlation IDs, generic errors, and no reflected input. Mutations call the
existing same-origin guard. Add bounded body sizes and database-backed attempt
limits; do not trust forwarding headers unless the existing trusted-proxy policy
explicitly permits them.

## Bootstrap and activation threat model

| Threat | Required mitigation |
| --- | --- |
| First network visitor claims admin | No automatic claim. Require a 32-byte host-minted capability, then bind the setup session through OAuth state to the callback user. |
| Capability leaks through history/log/referrer | Print only to the host terminal; accept only in POST body; never create a tokenized URL; no-store/no-referrer; redact request bodies and queries. |
| Brute force or repeated guessing | 256-bit entropy, SHA-256 at rest, 15-minute TTL, single active token, atomic one-use consume, generic errors, database-backed per-source/global attempt limits. |
| CSRF uses a valid setup cookie | SameSite=Strict setup cookie plus exact same-origin mutation guard; frame denial; state/cookie binding on OAuth. |
| Setup-session theft | HTTPS/Secure in production, HttpOnly, short TTL, hashed at rest, rotate at capability exchange, revoke on successful callback/recovery/expiry. |
| Configuration swapped during OAuth | Immutable pending versions and configuration-version ID stored in one-time OAuth state; callback never resolves “latest.” |
| Attacker supplies an exfiltration redirect | Callback/public origin are deployment-owned and strictly validated; form cannot edit them; OAuth state retains exact redirect equality. |
| Secret appears in DB/UI/audit | AES-256-GCM root cipher with version-specific AAD; presentation exposes only a boolean; audit stores only opaque version metadata. |
| Two callbacks race to become owner | One-time OAuth state plus row locks/unique active version/primary-key config-admin claim in a single transaction; loser rolls back with a generic conflict. |
| Environment secret manager is shadowed | Complete real env pair locks the whole effective bundle; partial env pair fails closed; UI is read-only while locked. A known development mock bundle is fallback-only so it cannot block migration to a verified DB configuration. |
| Broad scope escalation | Typed allowlist, visible per-scope checklist, no wildcard/custom text, and real Slack approval remains an external gate. The requested all-supported default is explicit in the UI and can be narrowed before OAuth. |
| Recovery silently takes ownership | `--recover` requires host access, revokes prior setup artifacts, is explicitly labelled break-glass, and is metadata-audited without secrets. |

On setup callback success, the transaction must lock the pending version and
setup session, confirm both are unused/unexpired and no configuration admin
already exists (unless this is an explicit recovery design approved later), then
activate and claim. It must not “link but fail to claim” or “claim but fail to
save credentials.”

## Validation details

- Client ID: required, trimmed, bounded (for example 1–255), rejects
  `replace-with-*` and known mock fixtures in production. Do not impose a broad
  numeric/dotted regex Slack does not normatively guarantee.
- Client secret: required on first save, 1–4096 bytes, no control characters,
  never trimmed silently, never echoed. A blank update is not implemented in
  the first slice.
- Scope IDs: exact catalogue membership, canonical order, deduplicated;
  `chat:write` required in user scopes; at least one total.
- URLs: deployment parser remains exact-origin, no credentials, query, fragment,
  controls, backslashes, or production HTTP.
- Optimistic version: pending replacement uses the setup session's current
  version to prevent double-submit/lost-update; the database is authoritative.
- Mock OAuth: allowed only in non-production and visually labelled; it cannot
  activate the real initial configuration-admin claim. Real Slack callback is
  required for ownership.

## TDD plan

Work red-green-refactor in the following order:

1. **Scope catalogue tests**
   - Missing selection resolves to the exact 13 bot / 14 user reviewed
     catalogues.
   - Select-all returns the exact 13/14 reviewed catalogues and never a wildcard.
   - Unknown/admin/optional-unapproved strings are rejected and canaries do not
     appear in errors.
2. **Bootstrap service/store tests**
   - CLI random source is 32 bytes; DB sees only a 64-hex hash.
   - Expired/used/revoked/wrong tokens fail generically; concurrent consume has
     exactly one winner; a new token revokes prior unused tokens.
   - Normal mint refuses after activation; `--recover` is explicit.
3. **Configuration encryption/store tests**
   - Plaintext secret canary never appears in SQL parameters after encryption,
     returned records, serialized UI, audit, or errors.
   - Correct AAD decrypts; moved/tampered envelope fails.
   - Candidate + audit are atomic and immutable; one active partial index holds.
4. **Effective resolver tests**
   - Complete real env bundle wins and locks; partial env fails; DB active
     fallback; authorized pending only for verify; no source setup-required.
   - A known development mock bundle is fallback-only and cannot lock setup or
     outrank an active database configuration.
   - Environment omitted scopes use the complete reviewed catalogue; one
     explicit legacy scope variable makes the other side explicitly empty.
5. **Setup route/UI tests**
   - Public GET leaks no configuration.
   - Same-origin and body bounds fail closed; cookie flags are exact; capability
     absent from Location/HTML/log captures.
   - Form has accessible labels, password field, minimal default, reset and
     explicit select-all copy, callback read-only, loading/errors.
6. **OAuth binding tests**
   - State persists exact version/setup-session binding.
   - Changing “latest” pending version cannot affect callback.
   - Superseded/missing version and env fingerprint drift fail before exchange.
   - Callback replay/concurrent callback yields one activation/admin claim.
   - Activation, Slack credential save, Prism session, admin claim, setup revoke,
     and audit roll back together on any database/audit failure.
7. **Regression tests**
   - Ordinary active-config connect, OIDC continuation, delegated-delivery
     continuation, mock-dev flow, state cookie, redirect equality, refresh,
     Slack credential encryption, homepage status, global admin console, full
     suite, typecheck/build.

The current homepage timeout should be triaged separately or the focused test
given a justified timeout; do not hide a new regression behind that baseline.

## Live QA plan

Use a disposable QA database/schema; do not reset the user's existing data.

1. Start Prism with DB/public-base/root-cipher configuration but without Slack
   client/scope env values. Confirm the homepage links to `/setup` and ordinary
   OAuth start cannot contact Slack.
2. Run `npm run setup:bootstrap`. Report only that a code was minted; do not
   capture it in task logs/screenshots. Confirm DB contains a hash, TTL, and no
   plaintext.
3. Prove wrong/expired/replayed codes fail generically. Exchange the real code
   manually and inspect Secure/HttpOnly/SameSite/expiry behavior.
4. Save the form with a secret canary and its default selection. Confirm
   Postgres holds only an AES-GCM envelope and authorize output has the exact
   reviewed scope catalogue with no wildcard. Scan HTML/logs/audit for canary.
5. Before live OAuth, compare the visible selection with the existing app's
   approved scopes and narrow it when necessary; Prism must not pretend that
   selecting a scope grants Slack approval.
6. With the user's real developer Slack app and explicit approval to interact,
   complete OAuth with the visible approved selection. Confirm the exact pending version is
   activated, the callback user becomes the sole initial configuration admin,
   setup artifacts are unusable, and a normal Prism session exists. Report no
   IDs, state, code, token, client secret, or full OAuth URL.
7. Restart Prism without Slack credential env variables. Confirm the active DB
   config survives and another user can use ordinary Slack connect while the
   config center remains authorization-protected.
8. Launch two callback requests with the same state in a controlled test; prove
   one activation/claim/audit only.
9. Launch with a complete synthetic environment bundle. Confirm the UI becomes
   read-only `Environment locked` and DB configuration cannot shadow it.
10. Run focused tests, full tests, `npm run build`, dependency/secret scans, and
    a Playtest OIDC login + delegated-announcement approval regression.

Real Slack success must be described as externally verified only after Slack
returns the grant and stored credential scopes include `chat:write`.

## Regression checklist

- [ ] Local tools and Playtest never receive Slack app/user/bot secrets.
- [ ] Root cipher stays outside Postgres and is still required to decrypt both
      Slack tokens and the app client secret.
- [ ] Existing environment deployments remain operational and authoritative.
- [ ] Production rejects mock config and insecure URLs.
- [ ] OAuth state remains one-time, cookie-bound, redirect-bound, and now
      configuration-version-bound.
- [ ] OIDC and delegated-delivery continuation exclusivity remains intact.
- [ ] First admin claim is authorized by the setup session, not callback order.
- [ ] No wildcard/custom scope string; omitted selection defaults to the exact
      reviewed Prism-supported catalogue.
- [ ] Scope selection does not claim Slack approval or grant capabilities by
      itself.
- [ ] Candidate save and activation cannot succeed without their audit records.
- [ ] Setup, callback, admin, and status responses are no-store and secret-free.
- [ ] Forwarding, display-name enrichment, and backfill refresh clients resolve
      the same atomic effective app configuration instead of reading env only.
- [ ] Development-mock refresh uses only the synthetic OAuth adapter with the
      resolved reviewed scopes; it never constructs the real Slack fetch client.
- [ ] General Prism admin scope and Slack administration semantics are unchanged.

## Rollback and recovery

- Migration is additive. A code rollback leaves new tables/columns in place; do
  not drop encrypted configuration or bootstrap audit data during rollback.
- Before deploying old code, restore a complete Slack environment bundle from
  the managed secret source because old code cannot read DB configuration. Do
  not export/decrypt through a browser, CLI stdout, issue, or log.
- A feature flag may hide `/setup`/configuration routes, but it must not make
  env configuration lose precedence.
- Revoke all unused bootstrap tokens and active setup sessions if setup abuse is
  suspected. If a plaintext Slack client secret may have leaked, rotate it in
  Slack and reauthorize; if the root cipher leaked, rotate/re-encrypt all
  credential envelopes through a separately reviewed key-rotation procedure.
- Failed/unverified pending versions are safe to retain briefly for diagnosis
  because their secrets are encrypted; add bounded cleanup after the slice,
  rather than deleting them in the callback error path.

## Explicit deferrals

- Broad Playtest settings UI and GetBuild configuration.
- Moving database credentials, public deployment origin, OIDC signing keys,
  delegated-delivery private material, developer-token peppers, or the root
  credential key into the UI. A UI cannot securely bootstrap the root key stored
  in the same database it protects.
- Post-login Slack client-secret rotation/edit, multi-admin role management, and
  self-service configuration-admin revocation. The first slice may expose
  status only after activation; recovery uses the explicit host command.
- Automatic discovery of Slack scopes, automatic Slack app mutation, new Slack
  app approval, wildcard scopes, or silently expanding an existing grant.
- Multiple Slack apps/tenants, KMS/HSM integration, root-key rings, and automated
  envelope re-encryption.
- Sign in with Slack identity scopes, Slack admin/org APIs, Events API, Socket
  Mode, interactivity, slash commands, canvases, lists, workflows, and file
  mutation.

## Implementation sequence and gate

1. Migration + scope/config/bootstrap domain types and failing unit tests.
2. Bootstrap CLI/store/session routes and `/setup` code exchange.
3. Encrypted pending config form/store and redacted presentation.
4. Async effective resolver and environment-lock compatibility.
5. OAuth state binding, verify POST, callback activation, initial admin claim,
   and transactional audit.
6. Homepage/config-status UX, docs, focused/full checks, disposable live QA.
7. Separate reviewer verifies this brief's invariants and no-secret evidence.

If implementation finds that the existing callback transaction cannot include
activation/admin claim without breaking OIDC or delegated-delivery continuation
semantics, stop at that evidence boundary and revise the callback service
contract; do not activate configuration in a route-local side transaction.

## Confidence

- **High**: ownership, insertion points, bootstrap need, root-cipher reuse,
  environment-lock precedence, explicit all-supported default, and immutable OAuth
  config binding.
- **High**: first successful callback can safely claim initial configuration
  ownership only when the setup session is carried through state and claimed in
  the same transaction.
- **Medium**: exact post-login role integration because the current general admin
  model is file-allowlisted. A narrow `prism_configuration_admins` role is the
  smallest non-bypass path; consolidating admin sources is a later design.
- **External gate, not architecture blocker**: the real Slack app's currently
  approved scopes and client credentials must be verified by the user during
  live QA. The implementation must assume no additional approval is available.
