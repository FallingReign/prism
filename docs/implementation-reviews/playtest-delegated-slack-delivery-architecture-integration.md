# Architecture Integration Brief: Playtest delegated Slack delivery

## Slice and recommended outcome

Build one Prism-owned, per-message delegation path and use it for both immediate
and scheduled Playtest announcements. A Playtest manager reviews the immutable
message, sender, channel, and delivery time on Prism in a same-tab flow. Prism
binds that approval to the manager's current Prism user and healthy Slack user
connection, then issues a bounded, one-action delivery grant with a narrow
execution window to the
Playtest server. The Playtest worker may later present that grant, but it never
receives a Slack access token, refresh token, Prism developer token, or browser
session cookie.

The recommended v1 grant is:

- one Prism user and one owned healthy Slack connection;
- user execution only, with no bot fallback;
- one `chat.postMessage` action;
- one exact Slack team and canonical conversation ID;
- one exact canonical payload hash and encrypted payload snapshot;
- one Playtest announcement job and idempotency key;
- one `not_before` time and a short delivery deadline;
- one successful upstream invocation; and
- proof-of-possession bound to a Playtest-held DPoP key.

Prism, not Playtest, derives and records the sender. Playtest may supply its
signed-in OIDC subject only as an expected-subject constraint; neither grant
approval nor execution accepts a caller-selected sender.

This design replaces production `shared_prism`, `owner_token`, and `user_token`
announcement delivery. Those paths must not be fallbacks. Existing historical
receipts remain readable, while every unsent legacy job requires an explicit
new approval.

## First-principles authority model

There are four distinct actors and their authority must stay separate:

1. **The manager's browser** holds the opaque Playtest application session and
   the opaque Prism website session as separate HttpOnly cookies on their
   respective origins. It is the interactive approval surface.
2. **Playtest** owns session readiness, generated announcement content, desired
   delivery time, the local job, and its scheduler-facing automation endpoint.
   It does not own Slack identity or credentials.
3. **Prism** owns the stable Prism subject, Slack connection ownership, consent,
   encrypted Slack credential custody, delivery grant, Slack API invocation,
   and sender-bound audit.
4. **Slack** owns the final message and receipt. Slack does not document an
   idempotency key for `chat.postMessage`, so end-to-end exactly-once delivery
   cannot be promised across an ambiguous network failure.

The worker's authority is therefore not "act as user X." It is only "consume
this already-approved, DPoP-bound, immutable one-message grant during its
allowed time window." Possession of the Playtest database, a job id, an OIDC
subject, or the automation scheduler secret must not be sufficient to mint a
sender or broaden a grant.

## Current evidence and ownership

### Playtest

- `src/app/api/sessions/[id]/announce/route.ts` owns readiness checks, the final
  payload snapshot, immediate send, scheduling, session status updates, and
  local audit.
- `src/lib/announcements/jobs.ts` owns payload validation/canonicalization,
  content hashes, local idempotency, job claiming, retry timing, receipts, and
  status transitions.
- `src/app/api/automation/announcements/route.ts` owns scheduler-to-Playtest
  authentication through `AUTOMATION_RUN_SECRET` and background claims. It
  currently refuses anything except owner-token mode.
- `src/lib/prism.ts` is the outbound Prism client. It currently forwards
  `chat.postMessage` with either a process-wide owner developer token or a
  browser-bound developer token. Its `delegated` mode intentionally throws
  because no contract exists yet.
- `src/lib/auth/*` now gives Playtest a stable Prism OIDC subject, current local
  role enforcement, opaque revocable server-backed application sessions, and
  same-origin mutation protection. OIDC identity is not Slack delivery
  authority.
- `src/lib/db/index.ts` stores full announcement payload snapshots and local
  sender/audit references. `announcement_jobs.sender_mode` currently permits
  `shared_prism|delegated_prism`; schedules are always inserted as
  `shared_prism`.
- `SessionAnnounceButton.tsx`, `DashboardPage.tsx`, and
  `src/lib/dashboard-api.ts` currently treat Send and Schedule as same-page API
  mutations and use a browser confirmation, not an external consent flow.
- Current tests cover payload validation and basic local job idempotency, but
  there is no route-level worker, cancellation, concurrent-send, or browser
  consent coverage.

### Prism

- `prism_users.id` is the canonical OIDC subject. `prism_sessions` stores only
  hashes of opaque browser sessions.
- `slack_connections` ties a Prism user to Slack team/user identity and health.
  `slack_credentials` owns encrypted bot/user access and refresh token
  envelopes.
- `src/server/oidc/*` already implements exact-client authorization code flow,
  S256 PKCE, short-lived hashed codes/tokens, stable subject claims, session
  resolution, abuse caps, and bounded cleanup. These are useful patterns, but
  an OIDC access token must not become a Slack send token.
- `src/server/slack/forwarding-credentials.ts`, `refresh.ts`, and
  `web-api-client.ts` own server-only user credential selection, refresh,
  decryption, and Slack invocation.
- `src/server/slack/method-registry.ts` classifies `chat.postMessage` as
  `messages.write`. The delegated service must reuse that classification and
  the forwarding client, but it must not manufacture a Token profile or call
  the developer-token HTTP route internally.
- `/v1/slack/api/[method]` is a reusable developer-token proxy. Its policy and
  rate limiting are Token-profile-based and messages default toward bot
  execution when available. It is therefore the wrong authorization boundary
  for an exact user-approved grant.
- Playtest currently sends `X-Idempotency-Key`, but the generic Prism route does
  not consume or persist it. Local deduplication alone cannot prevent a second
  Slack call after an ambiguous result.
- `prism_activity_audit` is intentionally metadata-only. Delegated delivery
  should extend it with lifecycle metadata, never message bodies or grant
  material.
- The existing Slack OAuth state has an OIDC continuation. It should become a
  typed continuation that can resume either OIDC login or a delegation approval
  without accepting an arbitrary URL.

### Runtime and external contract evidence

During this scout pass, Prism health and OIDC discovery were live on port 3732;
the discovery contract advertised authorization code, S256, RS256, and a
public client. A Playtest health request failed while concurrent authentication
changes were being rebuilt; the separate mock OIDC flow subsequently passed.
Rerun both health probes immediately before delegated live QA rather than
treating either observation as permanent state.

Slack's current documentation says `chat:write` supports both user and bot
tokens and is compatible with `chat.postMessage`, `chat.scheduleMessage`, and
`chat.deleteScheduledMessage`. It also recommends conversation IDs rather than
names for reliable targeting. The installed Prism connection must still prove
that its **actual user credential** includes `chat:write`; repository manifest
candidates are not runtime evidence. See [Slack `chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)
and [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postmessage).

## Required interaction model

```text
Manager browser       Playtest               Prism                    Slack
      |                   |                     |                        |
      | Preview + approve |                     |                        |
      |------------------>| create draft/job    |                        |
      |                   | create exact request|                        |
      |                   |-------------------->| validate + encrypt     |
      |<----- same-tab approval URL ------------|                        |
      |---------------------- Prism ------------>|                        |
      |                   |                     | resolve Prism session  |
      |                   |                     | or resume Slack OAuth  |
      |<---------------- exact consent page ----|                        |
      | approve POST      |                     |                        |
      |---------------------------------------->| bind user/connection   |
      |<------ code + original state redirect --|                        |
      |------------------>| validate state/PKCE |                        |
      |                   | exchange code + DPoP|                        |
      |                   |-------------------->| hash/bind grant        |
      |<---- Playtest UI -| encrypted grant     |                        |
      |                   |                     |                        |
      |                   | due worker: grant + DPoP proof               |
      |                   |-------------------->| one atomic claim       |
      |                   |                     | decrypt user token      |
      |                   |                     |----------------------->|
      |                   |<----- sender-bound receipt / known outcome ---|
```

The same path is used for immediate sends. Their `not_before` is now, and the
Playtest callback attempts execution immediately; the worker remains a recovery
path if the browser closes after approval.

## Is a same-tab Prism approval required?

Yes, once per immutable message in v1.

The Playtest cookie proves that Playtest authenticated a user earlier. It does
not give Prism direct evidence that the current Prism user approved this exact
sender/channel/payload/time combination. Allowing Playtest to assert approval
server-side would recreate the impersonation boundary this work is intended to
remove. A long-lived reusable "send as me" authorization would also broaden
the blast radius and make cancellation/revocation less clear.

An existing Prism session avoids another Slack OAuth screen, but it must not
auto-approve the message. Prism should show an exact consent page and require a
same-origin POST. If the Prism session is missing, existing Slack OAuth may
reauthenticate and resume the consent page; successful OAuth must never skip
the approval click.

Same-tab is preferred over a popup because it avoids opener/postMessage token
transfer, popup blockers, and close-window ambiguity. The callback returns to
the specific Playtest session card and shows the approved sender and outcome.

## Delegation contract

### Immutable authorization details

Prism independently validates and persists these values before approval:

- exact registered `client_id` and exact callback URI;
- external Playtest job id and revision/idempotency key;
- expected Prism subject from the authenticated Playtest session, used only as
  a match constraint;
- `chat.postMessage`, fixed `execution_mode=user`, and
  `surface=public_channel|private_channel` as applicable;
- exact Slack team id and canonical conversation id (`C...`/`G...`; no display
  name or user-supplied workspace switch);
- canonical `{channel, text, blocks}` payload with existing size/block limits;
- SHA-256 of the canonical payload;
- `not_before`, approval expiry, delivery expiry, and requested schedule;
- S256 challenge, return state, and Playtest DPoP JWK thumbprint (`jkt`).

Prism stores the payload as an AES-256-GCM envelope using the existing
credential-cipher primitive with distinct AAD such as
`playtest-delivery:<request-id>:payload`. This is operational custody needed for
future delivery, not audit data. The audit table remains metadata-only. Payload
envelopes should be erased after a short terminal retention period.

### Code and grant

- Pending request handles may be random non-secret locators, but they must be
  unguessable, short-lived, rate-limited, and capped per client/source/user.
- Approval creates a one-time authorization code. Store only its SHA-256/HMAC
  hash; expire it within five minutes; consume it atomically.
- Code exchange requires the exact client, callback, S256 verifier, and a DPoP
  proof for the key thumbprint persisted on the request.
- Return a 256-bit opaque grant with a distinct prefix. Prism stores only an
  HMAC-SHA-256 hash with a dedicated pepper and the bound `jkt`; it never needs
  to recover the raw grant.
- Playtest encrypts the raw grant at rest with a dedicated deployment key and
  job-specific AAD. It must never return the grant through client-facing JSON,
  HTML, logs, audit, URLs, browser storage, or cookies. The server-to-server
  token response is the only response that contains it.
- Grant expiry should normally be shortly after the scheduled time (for
  example 15-60 minutes), with a conservative maximum scheduling horizon. A
  grant is not renewable. Expiry requires a new preview and approval.

### DPoP profile

Use an ES256 Playtest server key from deployment secret storage. For every
grant exchange, status, cancel, and execute call, send an RFC 9449-style DPoP
proof containing exact `htu`, `htm`, `iat`, unique `jti`, and, once a grant
exists, `ath = BASE64URL(SHA256(grant))`. Prism must:

- allowlist `ES256`, validate the public JWK and its thumbprint, and reject
  symmetric/embedded-private keys;
- accept only an exact normalized Prism HTTPS URL (private/localhost HTTP only
  in explicit non-production mode);
- allow at most small clock skew and a proof lifetime around 60 seconds;
- atomically store a hash of `jkt+jti` until proof expiry and reject replay;
- compare `ath` in constant time; and
- bind the grant to the same `jkt` used during exchange.

DPoP makes a copied SQLite grant envelope or intercepted opaque grant
insufficient without the Playtest key. It does not protect a fully compromised
Playtest host holding both key and grant; the exact one-message constraints and
Prism state machine limit that residual risk. If DPoP is deferred, the only
acceptable interim is HTTPS plus a very short, one-message bearer grant
encrypted in Playtest. A generic Prism developer token is not an interim.

For multi-instance Playtest, provision one managed key ring and keep old public
keys valid only until their last grants expire. Do not generate a new ephemeral
key on every process restart or scheduled grants will become unusable.

### Playtest client authentication

Register delegation separately from the public OIDC login client. A concrete
registration has:

- `client_id=shg-playtest-delegation`;
- one exact Playtest delegation callback;
- one or more exact ES256 public JWKs/kids for a deployment key ring; and
- only the delegation request/status/cancel endpoints as allowed operations.

Request creation and pending-request cancellation happen before a delivery
grant exists, so they require a short-lived registered-client proof. Use a
detached ES256 JWS over client id, exact normalized method/URL, SHA-256 of the
body, `iat`, `exp<=60s`, and unique `jti`; verify it against the registered
public JWK and atomically reject replay. Domain-separate this proof from DPoP
with a distinct `typ` and audience. The same managed key may be used in v1, but
the formats must not be interchangeable.

This proof authenticates the Playtest deployment, not a Slack sender. It can
create or cancel a still-pending consent request, but cannot approve a request,
issue a grant, choose a Prism user/connection, or execute Slack. A dedicated
HMAC client secret is a simpler fallback only if kept distinct from
`PRISM_TOKEN` and restricted to those same non-sending operations; registered
public-key proof is recommended because Prism need not store another reusable
secret.

## Prism integration

### Storage

Add a migration after the current OIDC migrations with three bounded domains:

1. `slack_delivery_delegation_requests`
   - client/job/revision, exact callback, expected subject;
   - method, user execution, team/channel, encrypted payload, payload hash;
   - schedule/not-before/approval/delivery expiry;
   - state, PKCE challenge, DPoP thumbprint;
   - pending/approved/denied/cancelled/expired lifecycle;
   - approved Prism user and owned Slack connection snapshots.
2. `slack_delivery_authorization_codes` and
   `slack_delivery_grants`
   - hash-only code/grant, dedicated pepper id, request FK, DPoP thumbprint;
   - active/executing/sent/failed/cancelled/expired/outcome_unknown state;
   - attempt/lease timestamps and Slack/Prism receipt metadata;
   - uniqueness on client + external job/revision and on grant hash.
3. `slack_delivery_dpop_replay` plus a delegated rate-limit bucket
   - atomic JTI replay protection with expiry;
   - rate limits by Prism user/client/action and channel, not by Token profile.

The migration-ready v1 logical columns are fixed as follows (PostgreSQL types
may use the repository's established aliases, but names and semantics should
not drift):

| Table | Required columns |
| --- | --- |
| `slack_delivery_delegation_requests` | `id` (internal text PK), `approval_handle_hash` (unique), `client_id`, `external_job_id`, `revision`, `idempotency_key`, `callback_uri`, `expected_prism_user_id`, `action`, `execution_mode`, `team_id`, `channel_id`, `payload_envelope`, `payload_sha256`, `return_state_envelope`, `code_challenge`, `dpop_jkt`, `not_before`, `approval_expires_at`, `delivery_expires_at`, `state`, nullable live `approved_slack_connection_id`, immutable `approved_connection_id_snapshot`, `approved_prism_user_id`, `approved_slack_user_id`, `approved_slack_team_id`, `approved_at`, `terminal_at`, `created_at`, `updated_at` |
| `slack_delivery_authorization_codes` | `code_hash` (PK), `request_id` (unique FK), `expires_at`, `used_at`, `created_at` |
| `slack_delivery_grants` | `id` (text PK safe correlation id), `grant_hash` (unique), `pepper_id`, `request_id` (unique FK), `dpop_jkt`, nullable live `slack_connection_id`, immutable `connection_id_snapshot`, `prism_user_id`, `slack_user_id`, `team_id`, `channel_id`, `state`, `attempt_count`, `lease_id`, `lease_expires_at`, `retry_after`, `upstream_called`, `slack_request_id`, `slack_ts`, `slack_permalink`, `last_error_code`, `expires_at`, `status_retained_until`, `executed_at`, `terminal_at`, `created_at`, `updated_at` |
| `slack_delivery_dpop_replay` | `dpop_jkt`, `jti_hash`, `expires_at`, `created_at`, with composite PK `(dpop_jkt,jti_hash)` |
| `slack_delivery_rate_limits` | `bucket_key` (PK), `window_started_at`, `window_reset_at`, `request_count`, `created_at`, `updated_at` |

Required checks are `revision>=1`, fixed `action='chat.postMessage'`, fixed
`execution_mode='user'`, 64-lowercase-hex payload hash, S256 only, ordered
timestamps, and the exact request/grant state enums in this brief. Require
unique `(client_id,external_job_id,revision)` and
`(client_id,idempotency_key)`, expiry/active-work indexes, and a partial
due-grant index. The approval transaction must bind the live
connection to its owner with the repository's existing composite
`(slack_connection_id,prism_user_id)` ownership key.

Connection deletion is a domain operation, not a raw cascade: lock the
connection, cancel/revoke all unexecuted grants, clear the nullable live
connection FK, retain immutable sender/connection snapshots and terminal
audit, then delete. Sent and unknown records remain attributable without
keeping a credential-bearing connection alive. Request, code, grant, and
audit writes that authorize or begin an upstream call are single database
transactions; audit failure before upstream fails closed.

Keep request, code, grant, and DPoP replay tables separate because their
consumption and retention semantics differ. All tables need bounded cleanup
and outstanding caps in addition to the listed indexes and ownership
constraint.

Connection removal or a reauth-required transition must revoke or block every
unconsumed grant for that connection. Preserve sender snapshots and audit even
if the connection row is later removed.

### Server modules and routes

Create a server-only domain such as `src/server/delegated-delivery/` with
validation, store, service, DPoP, state-machine, and presentation modules.
Reuse:

- `createConfiguredCredentialCipher` for encrypted payload custody;
- the OIDC opaque-value, PKCE, exact-client/redirect, abuse-control, and
  no-store response patterns;
- `resolveEligiblePrismSessionIdentity`, strengthened to select the exact
  expected team/owner;
- `classifySlackMethod`, user credential refresh/decryption, and
  `SlackWebApiClient` for the final call;
- browser mutation CSRF protection for approve/deny; and
- metadata-only activity audit with new delegated lifecycle types.

Suggested HTTP boundaries:

- `POST /v1/prism/delegations/slack-message/requests` — create an immutable
  pending request and return only its approval URL/expiry.
- `GET /delegations/slack-message/authorize?request=<handle>` — resolve Prism
  session or start typed Slack OAuth continuation, then render exact preview.
- `POST /v1/prism/delegations/slack-message/{id}/approve` and `/deny` — Prism
  cookie + exact same-origin protection; atomically bind sender and issue code.
- `POST /v1/prism/delegations/slack-message/token` — code + PKCE + DPoP exchange.
- `POST /v1/prism/delegations/slack-message/execute` — DPoP grant, empty or
  receipt-only request body; Prism uses the stored exact payload.
- `GET /v1/prism/delegations/slack-message/status` — DPoP grant, safe state and
  receipt only.
- `DELETE /v1/prism/delegations/slack-message/grant` — DPoP grant; cancel only
  before execution begins.

Machine endpoints must never accept `actorSubject`, Slack token, arbitrary
method, arbitrary payload, channel override, execution mode, or return URL at
execution time. Browser endpoints must never put a grant or code in HTML.

Generalize `slack_oauth_states` from a single OIDC FK into a typed continuation
(`none|oidc|delegated_delivery` plus internal id), or add a mutually exclusive
delegation FK with a database check. The Slack callback resumes the exact
Prism consent page. It must not auto-approve.

### Exact wire profile

Use form encoding only for the code exchange; use strict JSON with unknown-key
rejection for request creation. Field names below are the v1 contract, not
caller-selectable extension points.

Registered machine calls send
`Prism-Client-Proof: <compact-JWS>`. Its protected header is exactly
`typ=prism-client-proof+jwt`, `alg=ES256`, and a registered `kid`; claims are
`iss` and `sub` equal to the client id, the exact Prism delegation audience,
exact normalized `htu` and `htm`, `body_sha256`, `iat`, `exp`, and random
`jti`. Require `exp-iat<=60s`, at most 60 seconds of clock skew, exact body
bytes after UTF-8 serialization, and atomic JTI replay rejection. Every
machine response uses `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

`POST /v1/prism/delegations/slack-message/requests` uses the registered-client
proof and accepts:

```json
{
  "client_id": "shg-playtest-delegation",
  "callback_uri": "https://playtest.example/api/announcements/delegation/callback",
  "external_job_id": "<playtest-job-id>",
  "revision": 1,
  "idempotency_key": "<playtest-job-revision-key>",
  "expected_subject": "<prism-sub>",
  "team_id": "<slack-team-id>",
  "channel_id": "<slack-conversation-id>",
  "action": "chat.postMessage",
  "execution_mode": "user",
  "payload": { "channel": "<same-channel-id>", "text": "<fallback>", "blocks": [] },
  "payload_sha256": "<64-lowercase-hex>",
  "not_before": "<ISO-8601 UTC>",
  "delivery_expires_at": "<ISO-8601 UTC>",
  "state": "<opaque-256-bit-value>",
  "code_challenge": "<S256-challenge>",
  "code_challenge_method": "S256",
  "dpop_jkt": "<JWK-thumbprint>"
}
```

Prism canonicalizes and hashes the payload itself, requires both channel fields
to match, and rejects any hash mismatch. A successful `201` contains only
`request_id`, `approval_url`, and `approval_expires_at`. An idempotent repeat
with the same client/idempotency key and byte-equivalent canonical values for
**every** immutable field, including state, PKCE challenge, callback, and DPoP
thumbprint, returns the same pending request. Any differing field is
`409 idempotency_conflict`; Playtest must reuse its stored approval transaction
when retrying rather than generating new correlation values.

The approval callback carries exactly one `state` and either one short-lived
`code` or one allowlisted `error`. It never carries a grant or identity fields.

`POST /v1/prism/delegations/slack-message/token` uses
`application/x-www-form-urlencoded` with exact single values:

```text
grant_type=urn:prism:params:grant-type:delegated-slack-message
client_id=shg-playtest-delegation
redirect_uri=<exact-callback>
code=<one-time-code>
code_verifier=<S256-verifier>
```

It also requires the DPoP proof. A successful server-to-server JSON response
contains `grant_token`, `token_type: "DPoP"`, `expires_in`, `grant_id`, and the
immutable confirmed metadata: client/job/revision, Prism subject, Slack
user/team/channel, payload hash, `not_before`, and expiry. Playtest must compare
every field with its local transaction before encrypting the grant.

`POST /v1/prism/delegations/slack-message/execute` uses
`Authorization: DPoP <grant>` plus the `DPoP` proof and an empty JSON body.
`GET .../status` and `DELETE .../grant` use the same headers and no grant in the
URL. Safe responses contain only state, typed retry information, sender
metadata, and receipt; they never echo payload or authorization material.

Before a grant is issued,
`DELETE /v1/prism/delegations/slack-message/requests/{request_id}` uses the
registered-client proof and succeeds only for the exact client/job pending
request. It cannot cancel another client's request or an approved/executing
delivery.

All failures use strict JSON shaped as `{ "error": "<allowlisted_code>",
"request_id": "<correlation-id>" }`, optionally with integer
`retry_after_seconds`. Use `400` for malformed contracts, `401` for invalid
client/grant/DPoP proof, `403` for subject/team/connection/scope policy denial,
`404` for an unknown opaque locator, `409` for lifecycle/idempotency conflict,
`410` for expired or already-consumed material, and `429` for bounded rate
limits. Error text, HTML, and redirects must not reflect caller input.

Pin v1 timing to an approval request lifetime of 10 minutes, a code lifetime
of 5 minutes, a maximum requested schedule horizon of 30 days, and a grant
expiry 30 minutes after `not_before`. Configuration may shorten these bounds,
not lengthen them without a contract-version change and review. `expires_at`
ends execute authority. The DPoP-authenticated read-only status endpoint may
continue returning terminal/reconciliation metadata until
`status_retained_until`, initially 30 days after terminal state; it must never
reactivate or extend execution authority.

### Delivery state machine and audit

Before Slack, atomically change an active due grant to `executing`, increment
attempt count, create the metadata-only attempted audit row, and acquire a
short lease. Concurrent callers then receive the same current state and cannot
make another upstream call.

Use the stored Prism user/connection to request **only** the user credential.
Confirm connection owner, team, health, and actual credential scope includes
`chat:write`; never fall back to bot credentials. Refresh may rotate the
credential while retaining the same connection/user binding.

On success, atomically persist `sent`, Prism request id, Slack request id,
channel, timestamp, permalink if available, sender Prism/Slack/team identity,
and sent time. Repeated execute/status calls return that receipt without
calling Slack.

Extend `prism_activity_audit` types for request, approval, denial, execution,
cancel, expiry, rate-limit, and outcome-unknown events. Keep token profile
fields null, attach the Prism user/connection/Slack identity, external job id,
method, channel object id, status, request id, and `upstream_called`; never
persist the message, grant, code, DPoP proof, Authorization header, or payload
envelope in audit.

## Playtest integration

### Database and grant custody

Extend `announcement_jobs` additively with:

- Prism request/grant identifiers safe for display/correlation;
- encrypted grant envelope and its key id;
- expected and confirmed Prism subject, Slack user id, and Slack team id;
- approval expiry, grant expiry, approval/receipt timestamps;
- delivery outcome including `outcome_unknown`;
- revision and nullable `reannounce_of_job_id`; and
- a contract/version marker so historical `delegated_prism` rows cannot be
  mistaken for new grants.

The exact Playtest v1 storage contract is:

| Storage | Required additions |
| --- | --- |
| `announcement_jobs` | `delegation_contract_version INTEGER NOT NULL DEFAULT 0`, `delegation_revision INTEGER NOT NULL DEFAULT 1`, `reannounce_of_job_id TEXT NULL`, existing `prism_request_id` as the safe delegation request id, `prism_grant_id TEXT NULL`, `prism_grant_envelope TEXT NULL`, `prism_grant_key_id TEXT NULL`, `dpop_key_id TEXT NULL`, `expected_prism_subject TEXT NULL`, `confirmed_prism_subject TEXT NULL`, `confirmed_slack_user_id TEXT NULL`, `confirmed_slack_team_id TEXT NULL`, `approval_expires_at TEXT NULL`, `grant_expires_at TEXT NULL`, `approved_at TEXT NULL`, `prism_delivery_state TEXT NULL`, `prism_retry_after TEXT NULL`, and `prism_receipt_request_id TEXT NULL` |
| `announcement_delegation_transactions` | `id TEXT PRIMARY KEY`, `state_hash TEXT NOT NULL UNIQUE`, `job_id TEXT NOT NULL`, `playtest_user_id TEXT NOT NULL`, `auth_session_token_hash TEXT NOT NULL`, `pkce_verifier_envelope TEXT NOT NULL`, `dpop_key_id TEXT NOT NULL`, `prism_request_id TEXT NULL`, `created_at INTEGER NOT NULL`, `expires_at INTEGER NOT NULL`, `consumed_at INTEGER NULL` |

Add foreign keys from the transaction to job, local user, and auth-session
hash with cascade on job/session deletion; add a self-FK for
`reannounce_of_job_id`. Add indexes on unconsumed transaction expiry,
`prism_request_id`, `prism_grant_id`, and the existing due-job predicate.
Require one active transaction per job/revision and one grant id per job.

Do not rebuild the current `announcement_jobs.status` enum merely to add UI
labels. In v1, preserve its existing states and use exact error/state
projections: `draft` plus a live request is Awaiting approval; `failed` plus
`delegation_reapproval_required` is Needs reapproval; `failed` plus
`outcome_unknown` is Outcome unknown. `prism_delivery_state` is the last
authoritative Prism state and never independently authorizes execution.

Use a separate `PLAYTEST_DELEGATION_ENCRYPTION_KEY`, not the app session secret,
with AES-256-GCM and AAD `announcement-job:<id>:prism-grant`. The DPoP private
key is a separate secret. Redact both from health responses, error bodies,
logs, tests, database dumps, and dashboard APIs.

After Playtest durably synchronizes a known `sent`, `cancelled`, `expired`, or
non-retryable `failed` state and safe receipt, erase its grant envelope and key
id. Retain an unknown-outcome envelope only through Prism's bounded status
retention or until explicit reconciliation, then erase it and require a new
grant for any new message. Prism similarly erases the operational payload
envelope after bounded terminal retention while keeping metadata-only audit.

Create a small server-side approval transaction table (state hash, job/user,
PKCE verifier envelope, DPoP key id, expiry, consumed time) rather than relying
on one global cookie. The browser may hold only an opaque HttpOnly correlation
cookie. This permits concurrent tabs, atomic callback replay rejection, and
explicit binding to the current local manager session.

### Route and worker behavior

- `POST /api/sessions/[id]/announce` still owns readiness and payload
  generation. For both actions it creates/reuses a **pending local draft**,
  creates the Prism approval request, and returns `202` with a same-tab
  `approvalUrl`. It does not call Slack.
- Add a dedicated callback such as
  `GET /api/announcements/delegation/callback`. Validate exact state before
  provider errors, consume the local transaction atomically, exchange code,
  verify returned job/payload/channel/sender/time metadata, encrypt the grant,
  then mark the job `approved`/`scheduled`.
- For an immediate job, the callback invokes the same execution service used by
  the worker. If that in-request attempt is interrupted, the job remains due
  and the worker may continue only according to Prism's authoritative state.
- `/api/automation/announcements` keeps its dedicated scheduler secret for the
  scheduler-to-Playtest hop. It claims only `delegated_prism` jobs with a valid
  grant contract version, decrypts the opaque grant, generates a fresh DPoP
  proof, and calls Prism. It never reads a browser cookie or `PRISM_TOKEN`.
- `DELETE /api/announcement-jobs/[id]` asks Prism to cancel first. Mark local
  cancellation only after Prism confirms it was unexecuted. If Prism reports
  executing/sent/unknown, return a visible conflict and reconcile the receipt.
- Job listing exposes approval/schedule/delivery state and safe sender/receipt
  metadata, never encrypted grant fields.

The local content hash remains useful for stale-preview detection and UI
grouping, but Prism is the final idempotency authority. If CL, build, request,
channel, schedule, or template changes after approval, the old snapshot and
grant are immutable. Cancel it and require a new preview/approval.

### UI

Replace generic browser confirmations with a transparent two-step action:

- **Preview** remains non-sending.
- **Approve & send via Prism** and **Approve schedule via Prism** explain that
  Prism will confirm the Slack identity and exact message.
- Navigate same-tab to Prism after the local request succeeds.
- Prism displays sender, workspace, canonical channel, delivery time, fallback
  text, and rendered/structured Block Kit preview, with explicit Approve and
  Cancel buttons.
- On return, focus the originating session and show `Awaiting approval`,
  `Approved`, `Scheduled`, `Sending`, `Delivered`, `Needs reapproval`,
  `Outcome unknown`, or `Cancelled` with sender/receipt metadata.
- Never claim "sent" until Prism returns a durable sent receipt.

## Cancel, reannounce, retry, and expiry semantics

### Cancel

- Pending consent: cancel the pending request through a request-bound proof and
  mark it cancelled. A later callback cannot activate it.
- Approved but unexecuted: consume/revoke the grant atomically, then mark the
  Playtest job cancelled.
- Executing, sent, or outcome unknown: cancellation is no longer truthful.
  Return `409`, show the known receipt or reconciliation instructions, and do
  not silently create a compensating Slack delete.
- Local Prism logout does not cancel already approved deliveries. Slack
  connection removal or an explicit Prism "revoke pending Playtest deliveries"
  action does.

### Reannounce

"Re-announce" means a deliberate new Slack message. It creates a new job
revision, new Prism request, and new grant even when payload bytes are
unchanged, with `reannounce_of_job_id` for audit. It must not return the old
sent receipt under the current content-hash idempotency key.

"Retry" means continue the same grant only when Prism proves the Slack message
was not called or was definitively rejected. Keep these buttons and audit terms
distinct.

### Expiry and revocation

- Pending consent/code expiry: local job returns to `Needs approval`; no
  automatic recreation or redirect loop.
- Grant expires before a known Slack attempt: terminal `grant_expired`; require
  a new preview and approval.
- Slack connection becomes unhealthy, ownership changes, or user credential
  loses scope: fail closed. Refresh may repair the same connection; relinking
  to a new connection requires a new approval.
- Playtest manager deactivation/role removal should proactively cancel that
  user's unexecuted local jobs and Prism grants. Prism cannot infer Playtest
  roles from Slack identity, so short horizons and an explicit cancel sweep are
  required.

### Retries and exactly-once limits

Prism can guarantee one active claim and no duplicate call for concurrent or
ordinary repeated requests. It cannot guarantee external exactly-once behavior
if the process or network fails after Slack may have accepted the message but
before Prism stores the receipt; Slack's documented `chat.postMessage`
contract does not expose a general idempotency key.

Classify outcomes as follows:

| Evidence | Prism state | Automatic retry |
| --- | --- | --- |
| Rejected before Slack, DPoP/rate/expiry/policy error | active/failed as typed | Only typed pre-upstream transient errors |
| Slack 429 with `Retry-After` and a known error response | active with next attempt | Yes, before grant expiry |
| Definitive Slack `ok:false` such as missing scope/channel/not-in-channel | failed | No |
| Slack success receipt persisted | sent | Never; return receipt |
| Timeout/reset/crash after upstream may have been called, or Slack says success may be ambiguous | outcome_unknown | No automatic retry |

A stale `executing` lease becomes `outcome_unknown`, not a retryable failure.
An operator must inspect the target channel/Prism request evidence and either
attach the found receipt or explicitly choose Re-announce as a new message.

## Legacy migration and rollout

Do not infer per-user consent from `requested_by_user_id`,
`approved_by_user_id`, an OIDC login, or a previous owner-token send.

On migration:

- preserve historical `sent`, `failed`, and `cancelled` rows and receipts;
- move unsent `shared_prism` or legacy `delegated_prism` rows in
  `draft|approved|scheduled` to a visible terminal/needs-reapproval state with
  `delegation_reapproval_required`;
- move legacy `sending` rows to `outcome_unknown` with manual reconciliation;
- never generate a grant or confirmed sender during backfill; and
- write a system audit event for every transitioned job.

If adding a new status would make the UI clearer, use `approval_required` and
`outcome_unknown`; otherwise retain the row as `failed` with those explicit
codes and project friendly UI labels. Do not overload `scheduled` for a job
without a live grant.

Roll out in this order:

1. Prism migration/domain/routes behind a disabled feature flag; mock-only
   tests and cleanup controls.
2. Playtest additive schema, encrypted grant client, callback, and UI behind a
   disabled flag; sending remains disabled.
3. Mock end-to-end with two users, process restarts, DPoP replay, concurrent
   workers, cancel, expiry, and unknown outcomes.
4. Run the explicit legacy migration and remove `PRISM_TOKEN` from the Playtest
   deployment. Production startup must fail if delegated mode and a shared
   token coexist.
5. Verify the existing Slack user credential has `chat:write`; then perform
   one explicitly authorized real QA flow in a safe channel.
6. Enable delegated delivery. Keep owner-token code dev-only or remove it; it
   must not be an automatic rollback path.

## Slack-native scheduling alternative

Slack's [`chat.scheduleMessage`](https://docs.slack.dev/reference/methods/chat.scheduleMessage/)
supports blocks and user tokens with `chat:write`, returns a
`scheduled_message_id`, and permits schedules up to 120 days with documented
per-channel limits. It is a viable later optimization: Prism could schedule the
message during interactive approval and Slack, rather than Playtest, would own
the clock.

It is not the recommended first slice because it does not remove the need for
the immediate-send delegation path, adds scheduled-message list/delete state,
moves cancellation into a second Slack mutation, and still has ambiguous
network/idempotency cases. The current Playtest job/worker already owns due-time
delivery. Establishing one exact grant path first gives immediate and scheduled
messages the same security and audit semantics. Revisit Slack-native scheduling
only after real QA confirms user-token authorship and cancellation behavior for
the existing approved app.

## Do-not-bypass systems and invariants

- Do not use `PRISM_TOKEN`, a Prism developer Token profile, an OIDC access
  token, a Playtest cookie, or a caller-provided subject as Slack authority.
- Do not call the generic `/v1/slack/api/[method]` route with a hidden shared
  profile. Reuse its internal method/credential/client/audit primitives.
- Do not fall back from user to bot execution, another connection, another
  team, or another sender after any Slack error.
- Do not allow payload, channel, time, method, execution identity, or sender to
  change after approval.
- Do not put message content in Prism activity audit. Store only the encrypted
  operational payload required by an unconsumed grant.
- Do not return or log raw Slack credentials, grant/code values, grant hashes,
  encryption keys, DPoP private keys/proofs, PKCE verifier, cookies, or
  Authorization headers.
- Do not automatically retry an unknown upstream outcome.
- Do not mark a local job cancelled or sent until Prism confirms that state.
- Do not auto-approve after OIDC or Slack OAuth, even with an existing Prism
  session.
- Require HTTPS outside explicit localhost/private-network development and
  exact allowlisted origins/callbacks in every environment.

## Implementation plan

### 1. Contract and schema

Define one first-party Playtest delegation client, exact callback, time limits,
canonical payload format, error taxonomy, DPoP profile, and cleanup/retention.
Add Prism and Playtest migrations plus redaction tests before route behavior.

### 2. Prism request and approval

Implement immutable request creation, exact preview, session/subject/team/user
credential eligibility, typed Slack OAuth continuation, same-origin approve or
deny, atomic code issuance, and sender-bound audit. No Slack call yet.

### 3. Grant and execution

Implement PKCE/DPoP exchange, hash-only grant custody, replay protection,
one-claim state machine, delegated rate limits, exact user credential reuse,
Slack call, receipt, unknown-outcome handling, cancel, and status.

### 4. Playtest client and UX

Implement local approval transactions, encrypted grant storage, same-tab
redirect/callback, safe job projections, explicit UI states, cancellation, and
new-revision reannounce behavior.

### 5. Worker and migration

Change the worker to claim only valid delegated jobs, authenticate with grant +
DPoP, respect Prism retry/unknown decisions, and never read shared Prism config.
Transition legacy unsent jobs to reapproval and remove shared delivery secrets.

### 6. Mock, review, and live QA

Run both repositories' focused/unit/build suites, full mock browser/worker
flows, an independent security review against this brief, then the explicitly
authorized real Slack checks.

## Regression checklist

- Existing OIDC login remains identity-only and preserves exact state/nonce,
  PKCE, subject, redirect, and session behavior.
- Existing Prism website Slack linking, credential encryption/refresh,
  connection health, developer Token profiles, and generic Slack-compatible
  forwarding remain unchanged.
- Existing Playtest preview, readiness checks, payload generator, session
  status, build links, request inclusion, and Block Kit limits remain canonical.
- Scheduler authentication still protects `/api/automation/announcements`, but
  that secret grants no Prism or Slack authority by itself.
- Every new browser mutation has same-origin protection; every machine mutation
  has exact grant/DPoP validation and no cookie fallback.
- Sender in Playtest and Prism receipts always comes from Prism's approved
  session/connection, and cross-subject/cross-team attempts fail.
- Cancel, expiry, role change, connection removal, credential refresh, process
  restart, and concurrent workers never broaden or silently replace a sender.
- No production code path reads `PRISM_TOKEN` for announcements.
- No grant, DPoP key/proof, Slack token, payload envelope, or message body leaks
  through logs, URLs, API responses, health, audit, snapshots, or test output.

## Test plan

### Prism unit/integration

- Exact client/callback/action/channel/team/payload/time validation; duplicate
  parameters, open redirects, names in place of channel IDs, oversized blocks,
  and untrusted sender fields rejected.
- Pending request rate limit, outstanding cap, expiry cleanup, and encrypted
  payload canaries.
- Prism session absent/expired enters Slack OAuth and resumes consent; existing
  session shows consent; OAuth success never auto-approves.
- Expected-subject/team mismatch, connection-owner mismatch, unhealthy
  connection, missing user credential, and missing `chat:write` fail closed.
- Approval requires POST + exact origin, is one-use under concurrency, and
  creates a hash-only short-lived code.
- Code exchange rejects replay, expiry, client/callback/verifier mismatch,
  wrong DPoP key, and malformed proof; grant/token canaries never appear in DB
  plaintext or responses after exchange.
- DPoP rejects `htu`/`htm`/`iat`/`jti`/`ath`/algorithm/thumbprint mismatch and
  concurrent replay; proof cleanup is bounded.
- Execution ignores/rejects all sender, channel, payload, method, and mode
  overrides; exact stored user credential is the only credential requested.
- Two simultaneous executions yield one Slack call. A sent grant returns its
  receipt; cancelled/expired grants never call Slack.
- Pre-upstream transient, Slack 429, definitive Slack error, timeout, crash, and
  stale lease map to the documented retry/unknown states.
- Metadata audit is fail-closed before upstream where required and contains
  sender/job/channel/status but no content or secrets.

### Playtest unit/integration

- Fresh install/additive migration, encrypted grant round-trip, wrong key/AAD,
  and legacy pending/sending backfill.
- Manager + same-origin required for request/cancel; requester, forged subject,
  cross-origin request, and inactive/demoted user denied.
- Final content hash/channel/time passed to Prism match the stored immutable
  job; later session edits make approval stale rather than mutating it.
- Callback validates exact state before provider error, consumes one local
  transaction, verifies all Prism metadata, stores no plaintext grant, and
  rotates/clears correlation state.
- Worker needs the automation secret for entry and a valid encrypted
  DPoP-bound grant for Prism; no browser cookie or `PRISM_TOKEN` path exists.
- Concurrent worker claims, restart between approval and execution, Prism
  receipt reuse, retry-at handling, unknown outcome, and max attempt/expiry.
- Cancellation marks local state only after Prism; reannounce creates a new
  revision/grant even for identical payload.
- Dashboard API projections and error logs redact all delegation material.

### Mock end-to-end

Use two independent Prism/Playtest users:

1. User A approves a scheduled message; user B cannot approve, exchange,
   execute, cancel, or view its sensitive preview.
2. Stop/restart Playtest after approval, then run the worker without browser
   cookies and confirm mock Slack reports User A, exact channel/payload, and one
   upstream call.
3. Invoke two workers concurrently and replay the DPoP proof; confirm one
   receipt and no duplicate mock message.
4. Cancel one approved schedule, expire another, remove/reauth the connection,
   and verify no call/fallback.
5. Simulate a post-acceptance timeout and confirm `outcome_unknown` with no
   automatic retry; explicit Re-announce creates a different job/grant.
6. Search rendered HTML, JSON, logs, SQLite/Postgres safe columns, and audit for
   secret canaries and payload-in-audit canaries.

### Live QA gates

No real Slack message is part of architecture or automated test execution.
After explicit action-time permission:

- confirm Playtest and Prism health, exact HTTPS/private-dev origins, migrations,
  and absence of shared Prism delivery configuration;
- authenticate a designated developer Slack user through existing Prism;
- verify the stored **user** credential is healthy and includes the already
  approved `chat:write` scope, without printing the credential;
- use a canonical safe channel ID where that user is already a member;
- approve one immediate canary and verify Slack authorship, channel, blocks,
  Prism/Playtest audit, receipt, and no duplicate on replay;
- approve a short future canary, restart Playtest before due, and verify the
  worker sends as the same user without a browser session;
- separately approve then cancel a future canary and confirm nothing posts;
- test logout, grant expiry, and connection reauth without revoking or exposing
  unrelated Slack credentials; and
- inspect sanitized server logs for request IDs only.

If the actual user credential lacks `chat:write`, stop. Do not switch to bot,
owner token, broaden scopes, or request another Slack app approval under this
slice.

## Risks and decisions

- **Real user scope is unknown:** repository docs show candidate scopes, not the
  installed grant. Treat actual user `chat:write` as a launch gate.
- **Exactly-once gap:** Slack has no documented `chat.postMessage` idempotency
  key. Use one atomic Prism claim and an explicit unknown state; never hide the
  limit behind retries.
- **DPoP complexity:** URL normalization, replay storage, key rotation, and
  clock skew are easy to implement incorrectly. Use `jose`, fixed algorithms,
  focused vectors, and an independent security review.
- **Host compromise:** Playtest must hold its DPoP key and encrypted grants for
  background work. Exact one-message/time constraints reduce but do not erase a
  fully compromised-host risk.
- **Long schedules:** long-lived approval increases revocation risk. Keep the
  supported horizon conservative and expiry shortly after due time.
- **Identity drift:** Prism session, OIDC subject, Slack connection owner/team,
  and user credential must all agree. Never repair mismatch by selecting the
  latest arbitrary connection.
- **Content custody:** Prism needs an encrypted payload to render consent and
  execute later. Keep it outside audit, encrypt with distinct AAD, delete it on
  bounded terminal retention, and show users that exact content is being
  approved.
- **Operational scheduler:** a grant does not make the deployment scheduler
  reliable. Monitor missed due jobs and surface expiry/unknown state.
- **Current Playtest readiness:** the observed local health error must be fixed
  or explained before browser/worker QA.

## Decision confidence

Confidence is high on the ownership and security boundary: Prism already owns
the exact identity, browser session, connection, encrypted credential, refresh,
Slack client, and audit primitives; Playtest already owns immutable payload
generation, jobs, receipts, and worker scheduling. A dedicated one-message
grant bridges those owners without turning OIDC or developer tokens into Slack
authority.

Confidence is medium on the final operational scope until live inspection
proves the existing Slack **user** credential has `chat:write`, and on DPoP
implementation until replay/key-rotation tests and an independent review pass.
The recommended next implementation slice is Prism request/consent/code/grant
issuance plus a mock-only Playtest callback, with Slack execution still disabled
until that security substrate is verified.
