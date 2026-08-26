# Prism Slack `not_authed` recovery architecture integration

## Decision summary

The live Playtest failure is inside Prism credential refresh, before Slack message delivery. Playtest successfully authenticated to Prism with the signed-in user's `shg_playtest_app` profile, selected `execution_mode=user`, and called `chat.postMessage`; Prism then withheld the upstream call because its expired user credential could not be refreshed.

The first implementation slice should correct Prism's refresh-response contract and its connection-health transition. It should not add another token store, pass Slack credentials through Playtest, fall back to an owner token, or change Playtest's actor binding.

Confidence is high that the main defect is the shared OAuth response normalizer. `src/server/slack/oauth-client.ts` requires `app_id`, `team.id`, and `authed_user.id` for both an installation code exchange and an access-token refresh. Slack's supported token-rotation clients consume a refresh result as a token-shaped top-level response, including for a user token; install identity is not a safe required property of the refresh contract. A valid refresh response can therefore be collapsed to the generic `slack_error`, returned as `unchanged`, and surfaced by forwarding as `slack_refresh_unavailable` while the connection remains incorrectly `healthy`.

## Evidence

### Live metadata, 2026-08-26

- The affected connection is for the expected Slack user and workspace and has status `healthy` with no `last_error_class`.
- Its bot and user credentials both have encrypted refresh-token envelopes and both expired at `2026-08-25 16:39 UTC`.
- Neither credential row has been updated since its OAuth installation on `2026-08-25`.
- The active Slack app configuration is the single bootstrap configuration and was activated in the same installation window. There is no evidence of a later app-client reconfiguration causing this incident.
- The failed `chat.postMessage` audit is `upstream_error`, `execution_mode=user`, `upstream_called=false`, and `error_class=slack_refresh_unavailable`.
- No credential or token material was inspected; these findings use status, timestamps, kinds, scope metadata, and envelope-presence booleans only.

### Current ownership and call path

1. `src/server/slack/forwarding.ts` owns Slack-compatible forwarding. Before calling Slack it requests an access token for the already-resolved connection and execution mode.
2. `src/server/slack/forwarding-credentials.ts` owns credential selection and expiry handling. At the refresh skew it invokes `refreshSlackCredential`; every result other than `refreshed` becomes `not_authed`, with `slack_refresh_unavailable` for `unchanged`.
3. `src/server/slack/refresh.ts` owns decrypt-refresh-encrypt persistence and connection status. Definitive invalid-refresh errors mark `reauth_required`; generic Slack errors return `unchanged` and do not update connection health.
4. `src/server/slack/oauth-client.ts` owns both code-exchange and refresh HTTP contracts. Its shared `normalizeSlackOAuthSuccess` requires installation identity fields before it exposes any refreshed token.
5. `src/server/slack/postgres-store.ts` and `slack_credentials` own encrypted credential custody. `slack_connections` owns the coarse `healthy` / `reauth_required` status displayed by Prism and consumed by token-profile policy.
6. `src/server/slack/oauth-flow.ts` owns link/reconnect persistence. It marks an upserted connection healthy and conditionally stores bot/user credentials only when each returned token contains an access token.
7. `src/server/slack/app-configuration-factory.ts` resolves the currently effective Slack app configuration and creates the refresh client.

### External contract

- Slack's token-rotation guide documents `oauth.v2.access` refresh as returning a new `access_token`, `refresh_token`, `expires_in`, `token_type`, and scopes. The refreshed token is single-use and must be replaced by the newly returned refresh token.
- Slack's own Python SDK token rotator reads user and bot refresh results from the top level and checks `token_type`; it does not require installation identity on the refresh response.
- References: <https://docs.slack.dev/authentication/using-token-rotation/> and <https://docs.slack.dev/tools/python-slack-sdk/reference/oauth/token_rotation/index.html>.

## Do-not-bypass invariants

- Slack access and refresh tokens remain encrypted and server-only. Never return them to browser JavaScript, Playtest, logs, audits, errors, snapshots, or diagnostic output.
- The selected credential remains `(resolved token profile's slack_connection_id, resolved execution mode)`. Do not accept a browser-supplied Prism/Slack user ID and do not fall back to a shared owner credential.
- Keep the current metadata-only activity audit and `x-prism-upstream-called` truthfulness.
- Preserve one-time OAuth state consumption, transactional link/reconnect persistence, HttpOnly Prism sessions, and current scope policy.
- Existing token profiles remain attached across a Slack reconnect. A credential failure must not delete, replace, or silently rebind a profile to another Prism user.
- A refresh response must match the requested credential kind and must provide a fresh access token, refresh token, and bounded positive expiry before it is persisted.
- Only definitive credential-invalid conditions should become `reauth_required`. Network, timeout, rate-limit, and Slack-service failures must remain retryable and must not tell users that reconnecting will solve an operator/upstream problem.

## Integration plan

### 1. Split installation exchange from token refresh

In `src/server/slack/oauth-client.ts`, replace the single result shape with two explicit contracts:

- installation/code exchange result: requires `app_id`, `team.id`, `authed_user.id`, and exposes the optional bot/user credentials used by `oauth-flow.ts`;
- token refresh result: contains only the requested credential kind and the rotated token fields. Parse the top-level `access_token`, `refresh_token`, `expires_in`, `token_type`, and `scope`; do not require installation identity.

Validate the refresh response strictly:

- `token_type` must equal the requested `bot` or `user` kind;
- access and refresh token values must both be non-empty strings within defensive size bounds;
- `expires_in` must be a positive finite integer within a defensive maximum;
- scopes are optional metadata and never authorization proof beyond the existing profile/method policy.

Keep OAuth failure bodies sanitized, but preserve a useful finite error classification instead of collapsing every response to `slack_error`. At minimum distinguish definitive credential invalidation (`invalid_refresh_token`, `invalid_grant`, `token_revoked`, `token_expired`), configuration failure (`invalid_client_id`, `bad_client_secret`), retryable upstream failure (`ratelimited`, `service_unavailable`, `request_timeout`, network), and malformed success.

### 2. Make refresh state transitions truthful

Update `src/server/slack/refresh.ts` to consume the new refresh-only result:

- valid rotated token: atomically replace both encrypted envelopes and expiry, then mark healthy;
- missing stored refresh token or definitive revoked/invalid refresh grant: mark `reauth_required` with a sanitized error class;
- mismatched token kind or malformed success: do not persist any partial value; surface a sanitized refresh-response error for audit/operator diagnosis;
- retryable/configuration failure: do not incorrectly mark the user's connection as reauth-required. Preserve the exact sanitized class so the audit does not degrade to `slack_refresh_unavailable`.

`forwarding-credentials.ts` should return the specific sanitized refresh class received from refresh rather than replacing all non-refreshed outcomes with one class. The Slack-compatible response body may remain `{ ok:false, error:"not_authed" }`; metadata/audit must retain the actionable reason without credential material.

### 3. Close the reconnect stale-credential hole

In `oauth-flow.ts`, do not mark a connection healthy if a successful reconnect response omitted a credential Prism requires. Because Prism configuration requires the user `chat:write` scope and Playtest sends as the user, a fresh user access token is mandatory. If bot scopes were requested, the bot credential should likewise be required before the transaction succeeds.

Perform identity upsert, connection upsert, required encrypted credential writes, and healthy status in the same transaction. A malformed/incomplete OAuth success must roll back and produce the existing safe callback error; it must not leave a stale expired credential attached to a newly healthy connection.

### 4. Serialize single-use refreshes

Slack refresh tokens are rotated on use. The current read-network-write sequence has no per-credential concurrency guard. Add one server-owned serialization mechanism per `(connection_id, kind)` before production reliance:

- preferred: a Postgres advisory/row-lock-backed store operation that re-reads the credential after acquiring the lock and skips refresh if another request already installed a sufficiently fresh token;
- keep the Slack network call bounded with an explicit timeout;
- never solve this with browser state or a process-local-only mutex, because Prism can run more than one server process.

This can be a follow-on commit if the immediate parser fix is kept small, but it is a required regression item for reliable token rotation.

### 5. Handle credentials rejected before recorded expiry

After a real Slack Web API call, `not_authed`, `invalid_auth`, `token_revoked`, and `token_expired` are credential-state signals. Add a narrowly scoped outcome hook owned by the credential/connection service so the exact resolved connection can be marked `reauth_required`; do not mark on `missing_scope`, channel errors, 429, or network/service failures. This prevents Prism from continuing to advertise a rejected connection as healthy.

## Playtest impact

No Playtest transport or authentication change is required to restore sending. Playtest reached the correct Prism profile and Prism selected the correct signed-in user's credential. The functional fix belongs in Prism.

A small, optional Playtest UX follow-up should map `not_authed` to an actionable message such as “Your Slack connection in Prism needs attention” with a safe link to the configured Prism origin. It must not suggest reconnect for a Prism app-configuration or transient upstream failure unless Prism exposes a stable, sanitized reason. Existing profile creation and per-user binding must remain unchanged.

Scheduled delivery remains a separate delegated-grant path; it must use the same corrected Prism credential provider and must never use a browser session or owner token.

## Regression checklist

- Initial Slack link and reconnect still require exact one-time state and produce an HttpOnly website session.
- A successful user-token refresh whose response has token fields only (no `app_id`, `team`, or `authed_user`) succeeds and updates encrypted metadata.
- Bot refresh likewise accepts its documented token-only response.
- A user refresh response with `token_type=bot`, missing/empty access token, missing/empty replacement refresh token, or invalid expiry is rejected without overwriting the stored envelopes.
- The refresh token used in a successful call is replaced; the old envelope is not retained after success.
- Definitive invalid/revoked refresh errors set `reauth_required`; retryable and app-configuration errors do not masquerade as user reauth.
- A callback lacking the required user credential cannot set the connection healthy or leave a stale credential usable.
- A successful reconnect preserves existing Prism user identity and token-profile bindings while replacing credentials.
- Concurrent refresh attempts for one connection/kind perform at most one effective rotation and all callers receive the new credential.
- Web API `not_authed`/`invalid_auth` from a supposedly unexpired token marks the resolved connection reauth-required; ordinary Slack errors do not.
- Audit contains method, actor/profile/connection metadata, execution mode, upstream-called truth, and sanitized error class only.
- No token, refresh token, envelope, secret, Authorization header, Slack message content, or full upstream response appears in logs, response bodies, audit rows, or test snapshots.

## Test plan

### Unit and integration

- `oauth-client.test.ts`: add real refresh-shape fixtures with only top-level token fields for both user and bot; add kind mismatch, malformed values, definitive/retryable/configuration errors, and verify secret redaction.
- `refresh.test.ts`: verify rotated envelopes/expiry, exact status transitions, no persistence on invalid responses, and preservation of profiles.
- `forwarding-credentials.test.ts`: expired credential successfully refreshes from the token-only contract; specific sanitized failure classes survive to audit; no old token is returned after failure.
- `oauth-flow.test.ts`: missing required user/bot credential rolls back; reconnect replaces both required credential rows and marks healthy only after persistence.
- `forwarding.test.ts` and route tests: pre-upstream refresh failures retain `upstream_called=false`; rejected live credentials mark reauth without changing Slack-compatible response shape.
- Postgres-store tests: transaction/locking or compare-and-swap semantics and metadata-only SQL assertions.

### Live proof

1. Restart Prism with the implementation and the existing database; do not reconnect first.
2. Trigger one Playtest “Send now” as the signed-in manager.
3. Confirm the existing expired user credential rotates automatically, `chat.postMessage` reports `upstream_called=true`, and the message appears as that Slack user.
4. Confirm the credential `updated_at` and `expires_at` advance and the refresh-envelope-present boolean remains true; inspect no token/envelope value.
5. Confirm the connection remains healthy and audit records `forwarded` with the correct Prism user/profile and Slack request metadata.
6. Run a controlled invalid-refresh fixture in local test mode to prove the UI changes to Reconnect Slack and existing token profiles remain present.

## Risks and decisions

- **Root-cause confidence: high.** Live credentials are expired with refresh envelopes present, the configured app was not changed, and no refresh was persisted. The current parser rejects a documented refresh shape that Slack's own SDK accepts.
- **Residual uncertainty:** Prism currently discards Slack's exact refresh error into `slack_error`, so the live upstream response cannot be proven without consuming a single-use secret. The implementation should improve sanitized classification before any invasive live diagnostic.
- **Configuration-version risk:** credentials are refreshed with the currently active Slack app configuration and are not bound to the configuration that minted them. A future Slack app reconfiguration should mark prior connections reauth-required (recommended) or introduce an explicit version binding; never silently try an unrelated client secret.
- **Scope decision:** fix refresh parsing, truthful health, and incomplete reconnect persistence in Prism now. Keep Playtest changes to optional error copy/linking after Prism exposes a stable reason. Do not broaden this slice into a new credential store, scheduler, or identity model.
