# Architecture Integration Brief: generic local-app device authorization

## Stable intent and boundary

Prism needs a generic, browser-approved way for an installed local application to receive a narrowly scoped Prism developer token without asking a non-technical user to create and copy a Token profile manually.

The boundary is strict:

- Prism remains the generic Slack bridge. It owns Slack OAuth, Slack credential custody, Prism website sessions, Token profiles, developer-token issuance and verification, forwarding policy, and the short-lived authorization transaction needed to issue a developer token.
- A local application owns its own application, task, session, binding, command, approval, cursor, and retry state. None of that belongs in Prism.
- The device-authorization contract is generic. There must be no Remote Codex route, schema, policy, callback, status model, or application-specific state in Prism.
- The resulting token uses the existing Slack-compatible endpoints. The feature does not introduce inbound Slack events, Socket Mode, slash commands, interactivity, or an application-specific message transport.

The proposed public contract is:

- `POST /v1/prism/local-app/authorizations` begins a short-lived device authorization.
- `/local-app/authorize` is the signed-in Prism browser consent page.
- `POST /v1/prism/local-app/authorizations/token` polls and exchanges an approved authorization once for a Prism developer token.
- The MVP accepts only the existing `messages_only` preset with `user` execution identity. It may return generic subject metadata such as `prismUserId` and the connection's workspace identity, but it must never return Slack credentials.

## Existing ownership

### Slack identity, connection, and browser session

- `src/server/slack/oauth-flow.ts` owns Slack OAuth state, the `prism_session` cookie, connection creation, encrypted credential persistence, and a 30-day website session.
- `src/server/slack/postgres-store.ts` persists the OAuth state and website session. Since migration `0022_prism_session_slack_connection.sql`, every website session is bound to one owned `slack_connection_id`; there is no safe user-only fallback.
- `src/server/slack/connection-status.ts` owns best-effort display-name enrichment without changing connection authority.
- `app/v1/slack/oauth/start/route.ts` and `app/v1/slack/oauth/callback/route.ts` already carry mutually exclusive continuation handles for OIDC and delegated delivery. A local-app login continuation belongs in this same flow rather than in a second login system.

### Token profiles and developer tokens

- `src/server/token-profiles/developer-token.ts` is the only developer-token generator and HMAC verifier owner. Raw tokens use the `prism_dev_...` format and are never persisted.
- `src/server/token-profiles/presets.ts` owns the exact `messages_only` capability map. It allows conversation reads, message writes/updates, and reactions; it excludes search, file metadata, destructive message deletion, administration, and deferred inbound surfaces.
- `src/server/token-profiles/global-policy.ts` and `global-policy-store.ts` own deployment-wide preset, execution-identity, expiry, and mutation limits. Local-app issuance must be denied when the fixed requested policy is outside current global policy.
- `src/server/token-profiles/store.ts` owns Token profile/developer-token persistence, token resolution, application `client_id` binding, connection eligibility, and workspace grant checks.
- `src/server/token-profiles/local-tool-status.ts`, `method-policy.ts`, `execution-identity.ts`, and `src/server/slack/method-registry.ts` remain authoritative after issuance. The device flow must not reproduce their forwarding decisions.
- Migration `0019_playtest_first_party_app_token.sql` already adds `token_profiles.client_id` and a unique active `(prism_user_id, client_id)` index. This is the correct generic application binding substrate, although the current issuance helper is Playtest-specific and should be generalized before being reused.

### Browser mutation and secure response patterns

- `src/server/http/browser-mutation-csrf.ts` owns the same-origin check for cookie-authenticated browser mutations. Approval and denial must call it.
- The delegated-delivery consent routes demonstrate the required HTML posture: exact form validation, `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, restrictive CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and escaped untrusted content.
- Those delegated-delivery modules are Playtest-specific. The local-app feature should reuse the shared CSRF guard and the security-header pattern, but it must not import or extend Playtest domain services.

### Persistence and audit

- Plain Postgres migrations in `db/migrations` own durable server state. The next migration is the right place for a short-lived generic authorization table and OAuth continuation column.
- `src/server/audit/activity.ts` and `src/server/audit/postgres-store.ts` own metadata-only audit. Approved, denied, and issued events should use this path, with no code, token, display text, intended-use text, or Slack content in audit fields.

### API documentation

- `app/api-reference/endpoint-catalog.ts` is the website API catalog. The two machine endpoints and the browser consent surface must be documented there with their distinct authentication models.
- `README.md`, `docs/setup.md`, and `docs/security.md` are protected by `src/server/docs-guard.test.ts`; examples must use placeholders and must not contain real-looking developer or Slack tokens.

## Existing interaction model and runtime evidence

The current interaction model is:

1. A user links Slack in the Prism website.
2. Prism stores Slack bot/user credentials in encrypted server-side envelopes and issues only an HTTP-only Prism website session to the browser.
3. The website creates a named Token profile and shows its raw Prism developer token once.
4. A local tool presents that developer token to `/v1/prism/status`, `/v1/prism/capabilities`, or `/v1/slack/api/{method}`.
5. Forwarding re-resolves the token, Token profile, exact Slack connection, workspace rule, surface, capability, execution identity, and rate limit on every request.

The device flow changes only step 3: an explicit browser consent transaction creates or rotates an application-bound Token profile and delivers its developer token once to the polling local application.

Current runtime/API evidence:

- The live deployment at `http://10.62.240.10:3732` returned HTTP 200 and `{"service":"ok","database":"ok"}` from `/v1/prism/health`.
- The same deployment returned HTTP 401 with an invalid-token body from `/v1/prism/status` without a bearer token, confirming current local-tool authentication fails closed.
- The current Method registry includes the methods required by a polling message client: `conversations.history`, `conversations.replies`, `chat.postMessage`, `chat.update`, and reactions. `chat.delete` is separately destructive and remains denied by `messages_only`.
- On the same source commit (`598cd1b`), the relevant OAuth, session, Token profile, status, Slack forwarding, and CSRF tests passed: 11 files and 80 tests. The architecture worktree itself has no installed `node_modules`, so the identical clean main checkout was used for this read-only baseline.

The live origin is a private-HTTP pilot, not production-grade token transport. A successful live smoke test over that origin proves behavior, not confidentiality against network interception. Production developer-token delivery requires HTTPS.

## Required interaction model

### 1. Begin on the local machine

The local application sends an unauthenticated, bounded JSON request:

```json
{
  "clientId": "example-local-app",
  "displayName": "Example Local App",
  "intendedUse": "Read and reply to Slack messages for my local workflow",
  "requestedPreset": "messages_only",
  "executionIdentity": "user"
}
```

For the MVP, `requestedPreset` must equal `messages_only` and `executionIdentity` must equal `user`; client-supplied alternatives are rejected rather than silently narrowed. `clientId` is a public-client identifier, not proof of software identity. The browser must label the request as coming from an unverified local app and display the exact client ID.

The server creates a bounded pending request and returns HTTP 201:

```json
{
  "deviceCode": "<high-entropy polling secret>",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://prism.example/local-app/authorize",
  "verificationUriComplete": "https://prism.example/local-app/authorize?user_code=ABCD-EFGH",
  "expiresAt": "2026-09-01T02:10:00.000Z",
  "intervalSeconds": 5
}
```

The local app stores the device code only for this transaction, shows the user code, opens `verificationUriComplete` in the default browser, and polls no faster than the returned interval. There is no localhost callback, custom URI callback, or manually copied developer token.

### 2. Review in the browser

`GET /local-app/authorize` canonicalizes and resolves the user code.

- If there is no eligible Prism session, it redirects through the existing Slack OAuth start/callback using a mutually exclusive local-app authorization continuation, then returns to the consent page.
- If the current connection is reauth-required or has no user credential, the page cannot approve and gives a reconnect action.
- If eligible, it shows the user code, unverified display name and client ID, intended use, exact `messages_only` rights, `user` execution, the current Slack identity/connection, token replacement behavior, and explicit Approve/Deny actions.
- The user is told to approve only when the code shown in the browser matches the code shown by the local app.

The POST back to `/local-app/authorize` accepts only an exact small form containing the authorization locator and `decision=approve|deny`, rejects cross-origin browser mutation, and resolves authority from the HTTP-only website session. It never accepts a caller-supplied Prism user, Slack user, Slack connection, workspace, or Token profile ID.

Approval atomically binds the pending request to the current session's exact `prism_user_id` and `slack_connection_id`. It does not bind a Slack channel, thread, task, command, or application session.

### 3. Poll and exchange once

The local application polls with bounded JSON:

```json
{
  "clientId": "example-local-app",
  "deviceCode": "<high-entropy polling secret>"
}
```

Expected outcomes are:

- HTTP 202 `authorization_pending` while no decision exists.
- HTTP 429 `slow_down` plus `Retry-After` when the persisted poll interval is violated.
- A terminal `access_denied` or `expired_token` response after denial or expiry.
- HTTP 200 once after approval, containing one copy-once `developerToken`, `tokenType: "Bearer"`, `tokenProfileId`, `clientId`, and generic subject metadata.
- `invalid_grant` after the authorization has already been exchanged; Prism cannot replay the raw developer token because it never stores it.

The 200 response may contain:

```json
{
  "developerToken": "prism_dev_...",
  "tokenType": "Bearer",
  "tokenProfileId": "<opaque profile id>",
  "clientId": "example-local-app",
  "subject": {
    "prismUserId": "<opaque Prism subject>",
    "installationScope": "workspace",
    "slackTeamId": "T...",
    "slackEnterpriseId": null
  }
}
```

`slackTeamId` is nullable for organization installations and is convenience identity metadata, not a default workspace selection. Organization-scoped Slack API calls must still supply an explicit `X-Prism-Workspace-ID`, and Prism must still validate the exact active workspace grant. The local application owns and persists any chosen workspace, channel, or thread.

### 4. Re-pairing semantics

The existing active `(prism_user_id, client_id)` constraint means the MVP supports one active credential per Prism user and public client ID. A newly approved exchange for the same client ID rotates immediately with no overlap, invalidating the prior local installation. The consent page must say this before approval.

This is acceptable for the first installed-app MVP and prevents forgotten parallel credentials. Supporting multiple installations of one client later requires an explicit, user-visible installation identifier and a new uniqueness model; it must not be inferred from hostnames, IP addresses, or machine fingerprints.

## Existing extension points to use

- Use `issueDeveloperToken` and `hashDeveloperToken`; do not add a second token format or hashing scheme.
- Use `buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "user" })` and current global-policy validation at exchange time.
- Generalize the application-bound token issuance SQL currently embedded in `createPostgresTokenProfileStore().issuePlaytestAppToken(...)` into a transaction-safe helper accepting fixed server-validated application policy. Keep the Playtest behavior on that helper and use it from local-app exchange; do not copy its profile/token rotation SQL into a second store.
- Preserve `token_profiles.client_id` as the link exposed by `/v1/prism/status`. Reject identifiers reserved for internal/registered first-party flows rather than letting the generic route take over those profiles.
- Use the current website session join, including its exact `slack_connection_id`; do not resolve approval by user ID alone.
- Use `rejectCrossOriginBrowserMutation` on approve/deny.
- Extend the existing OAuth continuation fields and conflict checks with one local-app continuation. Do not create a local-app login cookie.
- Use `evaluateSlackMethodPolicy` after issuance without any local-app exception. Explicit `X-Prism-Surface` and workspace rules remain mandatory.
- Use existing metadata-only audit insertion. Extend audit enums/check constraints only for generic authorization lifecycle events.
- Follow current no-store/request-ID response conventions and secure consent-page CSP.

## Do-not-bypass list and invariants

- Never expose or persist Slack bot tokens, user tokens, refresh tokens, app credentials, credential envelopes, or authorization headers in this flow.
- Never persist the raw Prism developer token, device code, or user code. Persist hashes only; return the raw developer token once.
- Never derive the approved Slack connection from `clientId`, login identity alone, a workspace ID from the request, or the newest connection. Use the exact connection bound to the approving Prism session.
- Never derive an application target workspace from the approving user's identity. Workspace installations are already single-team; organization installations require later explicit workspace selection by the local application.
- Never let the local app submit `prismUserId`, `slackConnectionId`, `slackTeamId`, Token profile ID, capability-map JSON, expiry, destructive access, bot/automatic/selectable execution, or a callback URI.
- Never treat `clientId`, `displayName`, or `intendedUse` as authenticated software identity. Escape them in HTML and label the client unverified.
- Never silently broaden or reinterpret the requested policy. Only the exact allowed preset/identity pair is accepted, and global policy is rechecked at exchange.
- Never bypass the Method registry, Capability map, execution identity, exact workspace grant, surface requirement, rate limit, reauth state, or metadata-only audit after token issuance.
- Never add Remote Codex tables, routes, names, task IDs, Slack thread bindings, message cursors, Codex approvals, or Codex process state to Prism.
- Never add a custom callback to the local machine. Browser approval and device polling are the complete transport.
- Never return an already-issued token on a retry. A lost 200 response requires a new authorization because Prism has no recoverable plaintext token.
- Never allow two successful exchanges for one request. The approval lock, token rotation/creation, audit insert, and transition to `exchanged` must commit in one Postgres transaction.

## Exact integration plan

### A. Domain and validation

Add `src/server/local-app-authorization/` with:

- `types.ts`: public request/response and store decision types.
- `validation.ts`: exact-key, exact-media-type, UTF-8 byte-limit, identifier, display text, fixed preset/identity, user-code canonicalization, and device-code validation.
- `service.ts`: begin, resolve consent, approve/deny, poll/exchange, state-machine decisions, global-policy check, and copy-once issuance orchestration.
- `postgres-store.ts`: all SQL, row locking, bounded cleanup, rate/outstanding caps, session/connection resolution, poll timing, and atomic exchange.
- `presentation.ts`: escaped consent/success/error HTML with the same secure header expectations as other Prism consent surfaces.
- `request-source.ts` only if source attribution cannot be cleanly shared with the existing trusted-proxy logic. Untrusted proxy headers must remain ignored by default.

Keep domain functions dependency-injected and testable with deterministic clocks/random bytes. Do not put policy or SQL in route handlers.

### B. Persistence

Add `db/migrations/0023_generic_local_app_device_authorization.sql` with a narrowly generic table, for example `prism_local_app_authorizations`, containing:

- server request ID;
- `device_code_hash` and canonical `user_code_hash` unique indexes;
- public `client_id`, bounded display name/intended use, requested preset, and execution identity;
- `status` constrained to `pending|approved|denied|exchanged|expired`;
- source/rate bucket key and persisted `poll_interval_seconds`/`last_polled_at`;
- nullable approved `prism_user_id` and `slack_connection_id` with the existing composite ownership foreign key;
- nullable resulting `token_profile_id`;
- created, expiry, decision, exchange, and retention timestamps.

Add indexes for active user-code lookup, device-code exchange lookup, outstanding request caps, and bounded expiry cleanup. Add the local-app OAuth continuation column to `slack_oauth_states` and update its check so OIDC, delegated delivery, and local-app continuations are mutually exclusive.

Do not store display/channel/message/application-session payloads in this table. Display name and intended use are only bounded consent metadata supplied for this short-lived authorization.

Add audit activity types such as `local_app_authorization_approved`, `local_app_authorization_denied`, and `local_app_token_issued`. Audit only client ID as bounded object metadata if needed; never audit either code, raw token, display name, intended-use text, or Slack content.

### C. Token-profile issuance

Refactor the existing Playtest-specific application profile issuance SQL into one internal application-managed profile helper in the Token profile store layer. It must:

- require server-built capability maps rather than caller JSON;
- lock by `(prism_user_id, client_id)` with a transaction advisory lock;
- require the exact approved connection to be healthy and to contain the requested user credential;
- create the application profile when absent;
- rebind an existing same-client profile only as part of a fresh approval;
- immediately revoke/supersede the prior current developer token on re-pair;
- insert only the new token verifier;
- preserve current status/capability resolution through the existing store.

The local-app exchange and authorization state transition must run in the same database transaction as this helper. Global policy must be read/validated immediately before exchange; a disallowed policy produces a terminal policy-denied result without issuing a token.

### D. Route handlers

Add:

- `app/v1/prism/local-app/authorizations/route.ts` with POST begin only.
- `app/v1/prism/local-app/authorizations/token/route.ts` with POST poll/exchange only.
- `app/local-app/authorize/route.ts` with GET review and same-origin POST approve/deny.

Machine routes reject Authorization headers, query strings, wrong content types, duplicate/unknown JSON fields, and oversized bodies. Every response is no-store and carries `X-Prism-Request-ID`. The browser route rejects bearer authorization and unknown query/form fields.

The token polling endpoint is not generally unauthenticated in semantics: the high-entropy device code is its one-time bearer grant. The API reference should represent this distinctly rather than describing it as ordinary anonymous access.

### E. Existing Slack OAuth continuation

Extend:

- `OAuthFlowStore.saveOAuthState`/`consumeOAuthState`;
- `createSlackOAuthStart` continuation exclusivity;
- `app/v1/slack/oauth/start/route.ts` parameter validation;
- `completeSlackOAuthCallback` result metadata; and
- `app/v1/slack/oauth/callback/route.ts` resume routing.

Use only an opaque server request ID in the OAuth continuation. Never put the device code in a browser URL or OAuth row. On successful Slack OAuth, set the existing website session cookie and redirect back to the local-app consent page. On provider denial, make the pending local-app request terminal without exposing its existence to unrelated callers.

### F. Configuration, documentation, and API catalog

Add bounded server defaults/config for request TTL, poll interval, request-rate limits, outstanding per-client/source/global caps, cleanup batch size, and trusted-proxy attribution. Fail closed on invalid values. Follow the existing OIDC abuse-protection model rather than trusting `X-Forwarded-For` by default.

Update `.env.example`, `docs/setup.md`, `docs/security.md`, `README.md`, and `app/api-reference/endpoint-catalog.ts`. State explicitly that:

- local-app device authorization issues Prism developer tokens, never Slack credentials;
- the app identity is a public/unverified identifier;
- codes and tokens must not be logged;
- production requires HTTPS;
- the live private-HTTP allowance is non-production only;
- Prism stores only short-lived authorization state, while application state remains local;
- organization workspace selection remains explicit at Slack API call time.

## Data and security lifecycle

1. Begin generates a 32-byte random device code and a human-readable code from an ambiguity-free alphabet. Both are returned once; only hashes are inserted.
2. The pending row expires after a short fixed window (recommended 10 minutes). Begin and poll enforce fixed-window request limits, outstanding caps, and a global cap under transaction/advisory locks.
3. Browser GET resolves only the user-code hash. It does not change authority.
4. Browser POST approves/denies under the exact current session and row lock. Approval saves only Prism/Slack connection identifiers and timestamps.
5. Poll compares the device-code hash and exact client ID, enforces persisted timing, and reports only coarse state.
6. Exchange generates the raw developer token in memory, persists its HMAC verifier in the existing table, rotates any old same-client credential, inserts metadata-only audit, and marks authorization exchanged in one transaction.
7. The raw developer token is returned once with no-store headers and is then held by the installed application's operating-system credential store. Prism can subsequently verify only its HMAC hash.
8. Expired and terminal authorization rows are deleted in bounded batches. No cleanup path deletes active Token profiles or audit records.

The short user code is not the polling credential. It is a user-presence/correlation value and must be protected with expiry, attempt/rate caps, and generic not-found responses. The high-entropy device code is the exchange credential and must never enter a URL, browser page, log, audit record, or database in plaintext.

## Regression checklist

- Slack OAuth still creates encrypted credentials and a session bound to one exact connection.
- Existing OIDC and delegated-delivery OAuth continuations remain mutually exclusive and resume correctly.
- Existing manual Token profile create/rotate/revoke/policy behavior and copy-once semantics remain unchanged.
- Playtest application-token issuance retains its current client ID, fixed policy, eight-hour TTL, and current global-policy behavior after the shared helper refactor.
- Existing `/v1/prism/status`, `/v1/prism/capabilities`, and `/v1/slack/api/{method}` behavior remains unchanged for manual and application-issued tokens.
- `messages_only` allows required conversation reads/message writes/reactions but not search, files, destructive delete, admin, events, commands, or interactivity.
- `user` execution never falls back to bot identity.
- Workspace installations remain bound to their team; organization installations require explicit `X-Prism-Workspace-ID` and an active connection grant.
- Reauth-required or missing-user-credential connections cannot approve or exchange.
- Re-pairing the same client ID invalidates the previous credential and clearly warns the user.
- Approval/denial requires exact same-origin browser mutation and the current session; no request field can select authority.
- Device/user codes and raw developer tokens are absent from Postgres, logs, errors, HTML, audit, tests, and docs.
- Slack message/search/file content remains absent from authorization state and audit.
- All machine and browser responses use no-store/referrer/CSP protections appropriate to the surface.
- Expired/denied/exchanged authorizations cannot issue again, including under concurrent polling.
- Prism source and schema remain application-agnostic; no Remote Codex state or terminology is introduced.

## Test plan

### Validation and service tests

- Accept the exact begin and token bodies; reject unknown/duplicate fields, wrong media types, authorization headers, query strings, invalid UTF-8, oversized bodies, control characters, reserved client IDs, unsupported preset/identity, and unsafe code formats.
- Prove generated device codes meet entropy/format expectations, user codes are readable/canonical, raw values are returned only by begin, and store calls receive hashes only.
- Cover pending, slow-down, approved, denied, expired, policy-denied, already-exchanged, wrong-client, wrong-device-code, and lost-response/restart behavior.
- Cover HTML escaping for client ID, display name, intended use, and subject display data; assert no injected script/style/form action survives.
- Cover one-active-token semantics and the explicit re-pair replacement warning.

### Store and concurrency tests

- Assert session resolution joins the exact session-bound connection and requires healthy status plus user credential.
- Assert row/advisory locks make double approval, approval-versus-denial, and concurrent exchange deterministic.
- Assert token insertion, old-token revocation, audit insert, and exchanged transition roll back together on failure.
- Assert per-client, per-source, and global rate/outstanding caps, persisted poll interval, bounded cleanup, and untrusted proxy-header behavior.
- Assert only device/user code hashes are SQL parameters and no raw developer token appears in mocked query calls.
- Assert organization connections return nullable workspace subject metadata and do not synthesize a default workspace.

### Route/browser/OAuth tests

- Route tests for every status, no-store/security headers, request ID, Retry-After, exact body handling, and secret canaries.
- Consent GET tests for logged-out OAuth redirect, eligible preview, reauth-required, missing user identity, expired/unknown code, already approved/denied/exchanged, and non-leaking generic errors.
- Consent POST tests for CSRF rejection, exact form parsing, wrong session, session expiry, current-connection binding, approve, and deny.
- OAuth start/callback tests for the new continuation, three-way exclusivity, provider denial, successful session cookie plus consent resume, and no device code in location/state/storage.
- Existing targeted tests plus the full `npm test` and `npm run build` must pass.

### Live proof

On a non-production Prism instance with migrations applied:

1. Start authorization from a real local application on a user machine.
2. Verify logged-out browser continuation through Slack OAuth and return to the matching-code consent screen.
3. Approve and observe one successful token poll; verify a second exchange fails.
4. Call `/v1/prism/status` and `/v1/prism/capabilities` with the token and confirm client ID, fixed policy, and user identity availability.
5. With explicit workspace/surface headers, read a test Slack thread and post/update a test reply through the existing generic Slack endpoints.
6. Re-pair the same client and prove the old token fails while the new token succeeds.
7. Inspect database/audit/log output for hashes/metadata only and confirm no Slack or developer-token plaintext.
8. Exercise denial, expiry, poll-too-fast, reauth-required, and organization-workspace-required paths.

Use HTTPS for release evidence. If `http://10.62.240.10:3732` is used for VPN pilot behavior testing, label that evidence non-production and do not paste the issued token into commands, screenshots, logs, or task messages.

## Risks and mitigations

- **Public client impersonation/phishing:** `clientId` and display name are not client authentication. Mitigate with code correlation, an explicit unverified-app label, escaped exact identifiers, bounded expiry, and deliberate approval. A registered-client/display-name catalog or signed installer attestation is a later trust enhancement, not something to fake with a client secret embedded in a desktop binary.
- **HTTP interception:** a VPN/private address does not provide TLS. A device code or copy-once developer token can be stolen in transit over HTTP. Keep the existing private-HTTP mode non-production-only and require HTTPS for production.
- **Same client on multiple machines:** MVP re-pairing rotates the previous credential. The consent page and local app must say so. Add a first-class installation ID only with an explicit later product decision.
- **Organization workspace ambiguity:** organization identity has no safe default team. Return nullable metadata and preserve explicit workspace selection/grant enforcement in forwarding.
- **Global policy drift:** policy may change after begin or approval. Revalidate at exchange, fail terminally without token issuance, and tell the browser/local app that access is no longer permitted.
- **Concurrency/retry:** multiple pollers can otherwise receive separate tokens or lose lifecycle state. Use row/advisory locks and one transaction for profile rotation, audit, and exchange.
- **Public endpoint abuse:** random client IDs can evade per-client limits. Enforce source and global fixed-window limits, global outstanding caps, bounded body sizes, bounded cleanup, and trusted-proxy opt-in.
- **Shared-helper regression:** generalizing the Playtest issuance path could change its TTL/policy/rebind semantics. Keep those as explicit inputs and preserve its focused tests before switching local-app issuance onto the helper.
- **Consent metadata persistence:** display name/intended use are untrusted and not application state. Bound, escape, avoid audit/logging, and delete them with terminal authorization cleanup.

## Decision confidence

**Confidence: high** for the ownership and integration placement.

Reasons:

- Prism already owns every durable authority needed: exact session-bound Slack connection, encrypted Slack credentials, developer-token hashing, application-bound Token profiles, fixed capability presets, global policy, and forwarding enforcement.
- The required machine methods already fit `messages_only`; no new Slack transport is necessary.
- The existing OIDC/delegated flows provide proven continuation, rate-limit, atomic-store, consent, CSRF, and secure-response patterns without requiring either domain to own this feature.
- The proposed state is bounded authorization/token-profile state, which is inside Prism's bridge/auth purpose; all downstream application state remains local.
- Current targeted tests are green and the live service confirms the present auth boundary fails closed.

Open product constraints that implementation must preserve, not silently redesign:

- The MVP is one active credential per Prism user/client ID. Multi-install support is deferred.
- `clientId` is an unverified public-client identifier. Stronger publisher trust is deferred.
- Subject `slackTeamId` is nullable/non-authoritative for organization installs. Workspace selection remains local and explicit.
- A lost one-time token response requires a new authorization. Prism does not store recoverable developer-token plaintext.

No unresolved placement conflict was found. Implementation can proceed against this brief; if code evidence requires storing application/session state in Prism, choosing a workspace from login identity, weakening exact session-connection binding, or returning recoverable token material, stop rather than diverge.
