# Architecture Integration Brief: Playtest identity, access, and requester slice

## Outcome

Deliver a vertical slice in which Prism supplies a useful Slack display name, the verified Prism configuration administrator can become the first Playtest administrator exactly once, requesters can see only their own request history, and requesters can see a server-redacted read-only schedule. Manager and administrator workflows remain unchanged.

## Existing ownership

- Prism Slack display metadata: `src/server/slack/connection-display-names.ts`, `connection-status.ts`, and `postgres-store.ts`.
- Prism OIDC identity and signed claims: `src/server/oidc/service.ts`, `postgres-store.ts`, and `app/oauth/*`.
- Verified Prism setup ownership: `prism_configuration_admins`, created by setup/bootstrap and finalized in the Slack callback transaction.
- Playtest OIDC validation and user binding: `src/lib/auth/prism-oidc.ts`, `users.ts`, and the auth callback.
- Playtest roles and enforcement: `types.ts`, `guards.ts`, `policy.ts`, `/api/users/**`, and Admin -> Users.
- Request ownership: `requests.submitted_by_user_id`, derived from the authenticated user by `POST /api/requests`.
- Requester schedule redaction: `GET /api/sessions`; the manager dashboard is not a safe requester component.

## Confirmed display-name defect

`needsSlackConnectionDisplayNameEnrichment()` stops retrying whenever `displayNamesEnrichedAt` is set, even when `slackUserDisplayName` is still null. An unsuccessful first attempt therefore becomes permanent. OIDC reads the row directly and does not invoke website status enrichment, so Playtest-only users can receive the raw Slack ID indefinitely.

Downstream propagation is already correct: Prism signs `name`/`preferred_username`, Playtest validates those claims, updates `users.display_name` on each login, and TopNav renders it.

## Integration plan

### Retry and use Prism display-name enrichment

- Treat `display_names_enriched_at` as the last attempt time, not proof of success.
- Retry a healthy missing-name row after a persisted cooldown; do not retry on every request.
- Stop user-name lookups once a safe name exists.
- Add a migration that clears stale attempt markers for healthy rows with no user display name.
- Add a small OIDC orchestration seam: resolve identity, best-effort enrich if needed, then re-read before issuing the code. Failure must preserve ID fallback and must not block login.
- Keep Slack credentials and external calls in existing server-only owners.

### Narrow first-admin eligibility from Prism

- At token issuance, derive a boolean from a live, unrevoked `prism_configuration_admins` row whose role is `global_configuration_admin` for the current Prism user.
- Emit `playtest_initial_admin_eligible: true` only for the registered Playtest client.
- This is one-time eligibility, not a general Prism role or continuing cross-system provisioning contract.
- Never derive it from request input, display name, email, Slack profile fields, or the JSON admin allowlist.

### One-time Playtest bootstrap

- Accept only a literal boolean in the verified ID token; development and developer-token login are never eligible.
- Persist a unique `initial_admin` bootstrap claim independently of the user so claiming can never reopen later.
- In one SQLite transaction after OIDC user upsert: require eligibility, require no prior claim, require zero active admins, record the claim, replace the exact authenticated user's global role with admin, and write `admin.bootstrap_claim` audit.
- Existing installations with an administrator but no claim receive a sentinel claim during migration.
- After bootstrap, existing Admin -> Users remains the only normal role-management surface and last-active-admin protection remains intact.

### Requester history and schedule

- Requester GET `/api/requests` must always add `submitted_by_user_id = auth.user.userId`; URL filters may only further narrow that set. Legacy null-owned requests remain manager-only.
- Render a dedicated read-only My Requests view for requesters; do not reuse manager mutation controls.
- Render a dedicated requester schedule using only redacted `GET /api/sessions`; it must not call generation, request backlog, announcement jobs, builds, Slack, roster, launch-argument, or settings endpoints.
- Preserve navigation: requester Schedule/My requests/New request; manager Sessions/Requests/New request; admin adds Admin/Settings.

## Invariants

- Canonical identity remains signed Prism `sub`; Slack IDs are binding metadata and names are presentation only.
- Playtest remains the application authorization owner.
- No public self-promotion endpoint and no client-selected role or owner.
- Initial admin claiming is OIDC-only, single-use, atomic, and audited.
- Slack/Prism tokens, session values, authorization codes, verifiers, signing keys, and credential envelopes never enter Playtest storage, browser JavaScript, HTML, URLs, or logs.
- OIDC state, nonce, issuer, audience, azp, time, JWKS, RS256, code replay, and S256 PKCE checks remain unchanged.
- Request ownership remains server-derived; requester redaction remains server-side.
- Manager dashboard, backlog, builds, announcements, and administration remain behaviorally unchanged.

## Test and live-QA plan

- Prism: retry cooldown and successful-name stop conditions; login failure fallback; migration; OIDC refreshed name; live/revoked configuration-admin eligibility; no eligibility for other clients; full tests and build.
- Playtest: strict boolean claim parsing; eligible zero-admin claim; noneligible denial; replay/existing-admin/concurrency protection; sentinel migration; audit; requester ownership isolation; manager full queue; redacted session shape; navigation and route policy; full typecheck, tests, lint, and build.
- Live: returning owner logs in without reinstall, sees Slack name and Administrator; Admin/Settings appear; a fresh second Slack user lands on Schedule, sees only requester navigation, submits a request, sees only their history, and cannot reach privileged routes.

## Risks and decisions

- Bound display retry to avoid Slack API pressure and login latency; enrichment fails open only to safe ID display.
- Preserve the bootstrap claim even if the original admin is removed so zero-admin state never reopens claiming.
- Do not infer ownership for legacy requests from names.
- Revoking Prism configuration administration after bootstrap does not silently demote a Playtest administrator; that would be a separate provisioning policy.
- `PLAYTEST_BOOTSTRAP_*` remains temporary break-glass compatibility, not the normal flow.

## Confidence

High. The identity pipeline, setup-owner record, local role system, live role revalidation, audit, last-admin guard, request ownership, and requester-safe session API already exist. This slice extends their current owners without parallel authentication or authorization systems.
