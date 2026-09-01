# Architecture Integration Brief: local-app policy-aware expiry

## Stable intent and observed failure

Generic local-app pairing must continue to issue one server-defined `messages_only` / `user` Prism developer token after explicit browser approval. A local application still cannot request an expiry, capability map, execution identity, workspace, Slack connection, or Prism subject.

The current exchange path builds that fixed Token profile without `expiryDays`, so `buildTokenProfilePolicy` produces `expiresAt: null`. That is valid under the current code default, but it is outside an administrator-managed Global Token profile policy whose finite `expiry.maximumDays.nonDestructive` disallows no-expiry non-destructive tokens. The exchange therefore correctly fails closed, marks the approved authorization `policy_denied`, and never calls the shared application-profile issuer.

Read-only production evidence on 2026-09-01 confirms this exact mismatch: the deployed Global Token profile policy is administrator-managed at settings version 3, allows `messages_only`, allows only `user` execution, and sets `maximumDays.nonDestructive` to 90. The last day's local-app rows included two `policy_denied` exchanges. Browser approval and authorization persistence have already succeeded by that point.

The correction is not to overwrite or weaken that policy. Local-app issuance should fit its fixed non-destructive token inside the configured ceiling by using the longest expiry the administrator permits. A `null` ceiling continues to mean the current non-expiring local-app token. A genuinely incompatible preset, execution identity, or capability maximum must remain terminally denied.

## Existing ownership

- `src/server/local-app-authorization/postgres-store.ts` owns the exchange transaction: row locking, terminal-state handling, exchange-time Global policy read/validation, workspace metadata lookup, application-profile issuance, audit insertion, and the final `exchanged` transition.
- `src/server/token-profiles/global-policy-store.ts` owns reading and parsing the administrator-managed Global Token profile policy. If the row is absent it returns the current code default; if persisted policy is malformed it fails closed.
- `src/server/token-profiles/global-policy.ts` owns policy meaning and enforcement. `classifyExpiry` already distinguishes unlimited (`null`) and finite non-destructive maximums and returns `no_expiry_disallowed` or `expiry_exceeds_maximum` as appropriate.
- `src/server/token-profiles/presets.ts` owns the canonical `messages_only` capability map and converts an optional `expiryDays` to an exact `expiresAt` from the policy-effective timestamp.
- `src/server/token-profiles/application-profile.ts` owns transaction-safe application profile creation/rebind, one-active-token rotation, persistence of the exact capability map/expiry, and exact Prism-user/Slack-connection eligibility.
- `app/v1/prism/local-app/authorizations/token/route.ts` owns the existing machine HTTP contract. It maps true policy incompatibility to `403 { error: "policy_denied" }` and issued credentials to the current copy-once response.
- `/v1/prism/status` and `/v1/prism/capabilities` already expose the effective token expiry after issuance. No new exchange-response field is needed for this correction.
- Administrators own Global policy through the existing policy service/UI and `prism_settings`. Migration `0024_align_default_non_destructive_token_expiry.sql` deliberately updates only untouched version-1 seeded policy and preserves administrator-managed deployments.

Prism continues to own Slack credentials, browser/session authority, developer-token policy, token verifier storage, and forwarding enforcement. The installed application continues to own its task, session, workspace/channel/thread selection, retry, and approval state.

## Current interaction model

1. The public client begins a bounded authorization for the exact supported `messages_only` / `user` pair.
2. The browser consent flow binds approval to the exact current Prism session and its owned, healthy Slack connection with a user credential.
3. The local app polls with the high-entropy device code and exact client ID.
4. `exchange` locks the authorization row and handles pending, slow-down, denied, expired, exchanged, and previously policy-denied states before any credential generation.
5. For an approved row, `exchange` reads the current Global policy inside the transaction, builds the server-owned local-app Token profile, validates it, and terminally denies incompatibility.
6. Only after policy validation and workspace availability does it create the copy-once credential, call `issueApplicationProfileToken`, audit metadata, and atomically mark the authorization exchanged.
7. The issued bearer continues through the normal status, capability, method registry, execution identity, surface, workspace-grant, reauth, and rate-limit gates.

The bug is confined to step 5: the fixed local-app policy builder is not given a finite expiry when the current Global policy requires one.

## Existing extension points

Use the existing exchange-time Global policy read in `src/server/local-app-authorization/postgres-store.ts` as the adaptation point:

1. Read `globalPolicy.policy.expiry.maximumDays.nonDestructive` before building the local-app policy.
2. Construct one server-owned policy input with the fixed `preset: "messages_only"` and `executionIdentity: "user"`.
3. When the configured maximum is a number, add `expiryDays` with exactly that value. When it is `null`, omit `expiryDays` so `buildTokenProfilePolicy` preserves the existing no-expiry behavior.
4. Pass the resulting capability map and `expiresAt` to the existing `validateRequestedTokenProfilePolicy` call.
5. Pass the same validated capability map and `expiresAt` to `issueApplicationProfileToken`.

This logic belongs in the local-app issuance adapter, not in the Global policy parser/default helper:

- `maximumDays.nonDestructive` remains a ceiling for ordinary user-authored Token profiles; it should not become a system-wide default.
- `applyGlobalTokenProfilePolicyDefaults` intentionally supplies default preset, execution identity, and experiment TTL, not expiry. Using it here could replace fixed local-app semantics with administrator defaults or enable an experiment unexpectedly.
- `buildTokenProfilePolicy` and `validateRequestedTokenProfilePolicy` remain the canonical policy-construction and enforcement systems. Do not hand-calculate `expiresAt` or construct a capability map directly.

The smallest implementation is local to the exchange policy-input block. A tiny private helper is acceptable if it makes the finite/null cases independently testable, but a new service, schema field, migration, configuration setting, or public API is not justified.

## Do-not-bypass systems and invariants

- Do not update, migrate, normalize, or silently replace an administrator-managed Global Token profile policy. Migration 0024's preservation guard is intentional.
- Do not interpret a finite maximum as permission to broaden capabilities. The local-app preset remains exactly `messages_only`; the identity remains exactly `user`.
- Do not silently narrow a disallowed `messages_only` capability map to fit capability maximums. If the preset, identity, any action, or any surface is disallowed, preserve `policy_denied` and issue no credential.
- Do not accept client-supplied `expiryDays`, expiry timestamps, preset alternatives, identity alternatives, capability JSON, Prism/Slack authority, or workspace selection.
- Do not use Global policy defaults for this fixed application flow. Only the finite/non-finite non-destructive ceiling determines the effective local-app expiry.
- Do not bypass `buildTokenProfilePolicy`, `validateRequestedTokenProfilePolicy`, or `issueApplicationProfileToken`.
- Keep the Global policy read and validation inside the same exchange transaction and immediately before issuance. Do not move the decision to begin or browser approval, because policy may change while authorization is pending.
- Preserve exact session-bound Prism user and Slack connection ownership, healthy-connection/user-credential checks, organization workspace grant enumeration, and explicit later workspace selection.
- Preserve row locking, advisory application-profile locking, immediate re-pair rotation, copy-once token behavior, metadata-only audit, and atomic rollback.
- Never persist or log the raw developer token, device code, user code, Slack content, or Slack credentials.
- Keep Prism application-agnostic. Do not add Remote Codex names, state, channel/thread bindings, task IDs, commands, or approvals.

## Recommended integration plan

1. In `exchange`, read the current Global policy before constructing the fixed local-app Token profile input.
2. Derive only the optional `expiryDays` field from `policy.expiry.maximumDays.nonDestructive`:
   - finite number: use that exact number;
   - `null`: leave expiry unspecified.
3. Build the policy once with `buildTokenProfilePolicy(policyInput, input.now)`.
4. Validate the built policy against the same Global policy using the current validator. Keep every current denial branch and terminal transition unchanged.
5. Issue the application profile with the validated `capabilityMap` and `expiresAt` already produced. Do not independently recompute expiry for the profile or token.
6. Add focused red/green store tests before implementation, then run the targeted local-app and Token profile suites, full `npm test`, and `npm run build`.
7. Deploy only the Prism web container with existing environment and Postgres volume preserved. Existing `policy_denied` authorization rows are terminal; live verification must begin a fresh pairing request.

No database migration, policy mutation, browser change, OAuth change, Slack scope change, or Remote Codex reinstall is structurally required for this server-side correction.

## Regression checklist

- Finite non-destructive maximums result in an issued local-app Token profile expiring exactly that many days after `policy_effective_at`.
- A `null` non-destructive maximum preserves the current non-expiring local-app Token profile.
- The effective expiry passed to `issueApplicationProfileToken` is also stored on both the profile and newly issued developer token by the existing helper.
- `messages_only` and `user` remain fixed regardless of Global defaults.
- Disallowed `messages_only`, disallowed `user`, or any exceeded action/surface maximum remains `policy_denied`; no credential, Token profile update, workspace response, or issuance audit occurs.
- Malformed/unavailable persisted Global policy still fails closed through the current 503/error boundary and does not issue a token.
- Policy is re-read at exchange; begin and browser approval do not freeze or override it.
- Pending, slow-down, denied, expired, exchanged, and terminal policy-denied polling semantics remain unchanged.
- A failed re-pair caused by policy denial does not revoke the previously active credential; a successful fresh re-pair still rotates it immediately.
- Exact approving user/connection ownership and organization workspace grant enumeration remain unchanged.
- The token exchange response shape and status codes remain unchanged. Status/capabilities continue to report the effective expiry.
- Existing manual Token profile create/update/rotate semantics, Global policy UI, Playtest application-token behavior, Slack forwarding, and audit constraints remain unchanged.
- No raw token/code/Slack credential/content appears in SQL parameters, audit, logs, errors, docs, or tests.
- No application-specific state or terminology is added to Prism.

## Test plan

### Focused exchange tests

Add a dedicated policy-aware exchange test or extend `src/server/local-app-authorization/postgres-store-metadata.test.ts` using the real Global policy parser/validator and a mocked `issueApplicationProfileToken`:

- Parameterize finite non-destructive maximums (for example 30 and 90 days). For an approved request under an otherwise compatible policy, assert `kind: "issued"`, unchanged `messages_only` / `user` capability semantics, and `expiresAt === new Date(now + maximumDays)` in the issuer call.
- With `maximumDays.nonDestructive: null`, assert successful issuance and `expiresAt: null`.
- With `messages_only` removed from allowed presets, assert terminal `policy_denied`, the authorization update occurs, `issueCredential` is not called, and `issueApplicationProfileToken` is not called.
- Repeat the no-issuance assertion with `user` disallowed and with at least one required `messages_only` capability maximum (for example `writeMessages`) disabled. This proves the correction adapts expiry only and does not silently narrow authority.
- Assert the exact policy effective timestamp used to build expiry is the exchange `now`, preventing off-by-one-day or approval-time drift.

Retain the existing terminal-state test proving a persisted `policy_denied` request can never issue on a later poll.

### Targeted and full regression

- Run the local-app store, service, validation, token-route, authorization-route, and presentation tests.
- Run Global Token profile policy, presets, application-profile/first-party application, status/capabilities, execution identity, method-policy, and default-policy-migration tests.
- Run full `npm test` and `npm run build`.
- A production build may regenerate `next-env.d.ts`; preserve the repository's expected generated import state rather than committing unrelated drift.

### Live proof

Against the deployed administrator-managed 90-day policy:

1. Confirm health and the deployed commit without exposing configuration secrets.
2. Start a fresh local-app authorization, approve the matching code in the browser, and observe a successful token exchange rather than `policy_denied`.
3. Query only safe metadata to confirm the new authorization is `exchanged`, has a Token profile ID, and both profile/token expiry are approximately 90 days from `policy_effective_at`.
4. Call existing status/capabilities through the installed app path and confirm `messages_only`, `user`, and the finite expiry. Never print or paste the bearer.
5. Continue through explicit workspace selection and one bounded Slack read/write smoke path to prove the corrected credential works through existing forwarding policy.
6. Confirm the administrator policy remains version 3, retains its updater identity, and still has the 90-day maximum.
7. Confirm the Postgres container/volume was not recreated and no Slack/token secrets entered logs or evidence.

For the current HTTP private-address pilot, label this non-production. HTTPS remains required for production evidence.

## Risks and mitigations

- **Maximum-versus-default semantics:** a maximum is not generally a default. Restrict this interpretation to the fixed local-app issuer, where the client has no expiry choice and the longest administrator-permitted lifetime is the least disruptive safe value. Do not change ordinary Token profile defaults.
- **Future policy model growth:** a later explicit application-token default TTL could supersede this rule. Until then, deriving from the non-destructive ceiling avoids a new setting and exactly satisfies current enforcement.
- **Token expiry surprises:** deployments that require finite expiry will eventually require re-pairing. Existing status/capabilities already expose expiry; do not widen this hotfix into a new notification or refresh-token system.
- **Accidental capability adaptation:** attempting to make every policy compatible could silently remove Slack actions. Adapt only expiry; keep canonical capability validation fail-closed.
- **Policy race:** Global policy can change after it is read under PostgreSQL's normal transaction isolation. This is existing Token profile issuance behavior, not introduced here. Keep the read as close as possible to validation/issuance and do not weaken the validator.
- **Re-pair regression:** application-profile issuance updates an existing profile and rotates its token. Preserve the existing atomic helper and test both successful and policy-denied re-pair paths.
- **Deployment-policy damage:** changing the live Global policy would erase an administrator's security choice and mask the product bug. The implementation and deployment require no policy write or migration.

## Decision confidence

**Confidence: high.**

The runtime failure is an exact consequence of current code: `buildTokenProfilePolicy` returns `null` expiry without `expiryDays`, while `classifyExpiry` rejects that value under a finite non-destructive maximum. The exchange already owns the live-policy read, canonical policy builder, validator, and application-profile issuer inside one transaction. Supplying the configured finite ceiling as the fixed issuer's `expiryDays` closes the mismatch without changing authority, persistence ownership, schema, routes, client input, or Slack forwarding.

No placement conflict was found. If implementation evidence suggests changing the administrator policy, accepting client expiry, altering the fixed preset/identity, silently narrowing capabilities, or adding application state to Prism, stop rather than diverge from this brief.
