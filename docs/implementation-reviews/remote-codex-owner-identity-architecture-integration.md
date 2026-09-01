# Architecture Integration Brief: client-bound Slack owner identity

## Stable intent and boundary

An installed local application that polls Slack conversations through Prism needs to know which Slack user owns its approved Prism developer token. It can then ignore channel messages from other Slack users instead of treating every participant in a configured channel as authority to create or control local work.

This identity assertion must remain generic:

- Prism owns Slack OAuth, canonical Slack identity, exact connection binding, developer-token resolution, policy, forwarding, and credential custody.
- A local application owns its selected workspace/channel, message cursors, task/thread bindings, prompts, approvals, process ownership, and local enforcement behavior.
- Prism may return the safe Slack user ID already associated with an authenticated, client-bound developer token. It must not learn or persist any Remote Codex task, channel, thread, command, approval, or process state.
- The Slack user ID is identity metadata, not a Slack credential, target-workspace selector, new Prism permission, or substitute for normal forwarding authorization.

The required consumer behavior is exact and fail-closed: in the locally configured workspace and channel, a local application may accept an inbound Slack message as owner input only when the message's canonical `user` ID exactly equals the Slack user ID asserted for its current client-bound Prism developer token. Missing identity, bot/system events, or mismatched users must not create or control local work.

## Existing ownership

### Canonical Slack user and connection

- `src/server/slack/oauth-flow.ts` owns Slack OAuth identity capture. The canonical acting user comes from Slack's authenticated `authed_user.id`, not from a local-app request, channel history, display name, or workspace guess.
- `db/migrations/0001_slack_oauth_custody.sql` makes `slack_connections.authed_user_id` non-null. The connection row is the durable owner of that Slack identity.
- Website-session approval already resolves an exact `prism_user_id + slack_connection_id` pair. `src/server/local-app-authorization/postgres-store.ts` reads `c.authed_user_id` for the browser consent identity, and the consent page shows that user before approval.
- Organization/workspace installation scope and active workspace grants remain separate from user identity. `slackTeamId` may be null for an organization installation; the Slack user ID must not be used to infer a workspace.

### Developer-token subject resolution

- `src/server/token-profiles/store.ts` owns bearer-token resolution. Its query joins `prism_developer_tokens -> token_profiles -> slack_connections` using the Token profile's exact `slack_connection_id` and already selects `c.authed_user_id as slack_user_id`.
- `ResolvedDeveloperToken` in `src/server/token-profiles/local-tool-status.ts` already contains `slackUserId`, and `toResolvedDeveloperToken` already maps the selected value. No new SQL join, identity resolver, database column, or migration is needed.
- `src/server/token-profiles/local-tool-status.ts` owns `/v1/prism/status` response semantics. It currently exposes `application.clientId`, `subject.prismUserId`, and the effective Capability map only when both `clientId` and `prismUserId` are present. This client-bound gate is the correct place to add the canonical Slack user ID.
- `app/v1/prism/status/route.ts` is intentionally thin: it reads the bearer, delegates to `getPrismTokenStatus`, returns no-store JSON, and preserves request IDs.

### Generic local-app pairing

- `src/server/local-app-authorization/types.ts`, `service.ts`, and `postgres-store.ts` own the browser-approved public-client flow and copy-once token exchange.
- The exchange response already returns generic subject metadata: Prism subject, installation scope, team/enterprise IDs, and explicit workspace choices. It does not currently return the Slack user ID, even though the consent resolver already resolved and displayed it.
- `src/server/token-profiles/application-profile.ts` owns exact connection eligibility and application-profile issuance. It locks and verifies the approved `slackConnectionId + prismUserId`, requires a healthy connection with a user credential, and returns safe connection metadata. It is the transaction-safe extension point if the copy-once exchange response is also made identity-complete.
- Re-pairing the same Prism user and client ID rotates the developer token immediately. Application-profile rebinding therefore cannot leave the old bearer active with stale connection authority.

### Forwarding and audit

- `/v1/slack/api/{method}` continues to resolve the bearer and enforce Capability map, Method registry, execution identity, surface, exact workspace grant, reauth state, rate limits, and metadata-only audit on every call.
- Local owner filtering is a consumer-side authority check over inbound content. It does not replace Prism's server-side forwarding controls and does not authorize a caller to act as a different Slack user.
- Existing audit may record safe Slack identity metadata, but no new audit event is required merely because status returns the current token subject.

## Current and required interaction model

### Current

1. A local app begins generic device authorization using an unverified public `clientId` and the fixed `messages_only` / `user` policy.
2. The user reviews the exact Slack identity in Prism's browser page and approves the exact current Prism session and Slack connection.
3. The app receives one copy-once client-bound developer token plus workspace/installation subject metadata.
4. `/v1/prism/status` re-resolves that bearer and asserts its Prism subject, client binding, effective policy, Slack health, and execution-identity availability.
5. The local app can poll a configured Slack channel, but it currently has no public Prism contract by which to compare each Slack message's `user` field with the paired owner.

### Required

1. A newly paired app receives `subject.slackUserId` alongside the existing copy-once exchange subject metadata.
2. An already-paired app calls `/v1/prism/status` with its existing bearer and receives the same `subject.slackUserId` under the existing client-bound subject gate. No re-pair is required.
3. The local app persists the Slack user ID in its protected local connection record and refreshes/asserts it from status as needed.
4. For a selected workspace/channel, the app accepts a Slack root message or threaded control message only when `message.user === subject.slackUserId`. It ignores other users, bot/system messages without that exact user, and any message whose identity cannot be proven.
5. Workspace, channel, and task/thread state remain entirely local. Prism continues to receive only ordinary generic Slack API requests.

Recommended additive JSON shapes are:

```json
{
  "application": { "clientId": "example-local-app" },
  "subject": {
    "prismUserId": "<opaque Prism subject>",
    "slackUserId": "U12345678"
  }
}
```

and, for a successful local-app exchange:

```json
{
  "subject": {
    "prismUserId": "<opaque Prism subject>",
    "slackUserId": "U12345678",
    "installationScope": "workspace",
    "slackTeamId": "T12345678",
    "slackEnterpriseId": null,
    "workspaces": [{ "teamId": "T12345678", "teamName": "Example" }]
  }
}
```

The field name should remain `slackUserId`, matching existing Prism server-domain terminology and camel-case API responses.

## Existing extension points

### Required compatibility extension: `/v1/prism/status`

Extend `PrismStatusBody.subject` in `src/server/token-profiles/local-tool-status.ts` from `{ prismUserId }` to `{ prismUserId, slackUserId }` for active client-bound tokens.

Use `resolution.resolved.slackUserId`, which is already selected through the exact Token profile connection. Do not add a second identity lookup. Preserve the existing rule that generic, non-client-bound Token profiles return no `application`, `subject`, or application Capability-map assertion.

Because the database column is non-null, a normally resolved client-bound token has the value. At the TypeScript/domain boundary, require a non-empty `slackUserId` before emitting the existing application assertion block. If current or malformed fixture data omits it, omit `application`, `subject`, and the application Capability-map assertion together rather than fabricate or infer an owner. The local application must treat the missing subject as unavailable owner identity and decline inbound task/control actions.

### Recommended new-pair symmetry: token exchange

Also add `slackUserId` to the generic local-app exchange subject so newly paired clients receive the complete approved identity atomically with the copy-once token.

The narrowest transaction-safe implementation is to extend `ApplicationProfileResult` in `src/server/token-profiles/application-profile.ts` with `slackUserId`, select `c.authed_user_id` in its existing eligible-connection query, and pass that value through:

- `issueApplicationProfileToken` result;
- `LocalAppAuthorizationStore.exchange` issued-subject type;
- `src/server/local-app-authorization/postgres-store.ts` issued result;
- `app/v1/prism/local-app/authorizations/token/route.ts` no-store JSON response.

This uses the same exact locked connection that is authorized for issuance. Do not copy the browser consent identity into long-lived application state or accept any caller-supplied user ID.

The exchange addition is strongly recommended for a coherent generic pairing contract, but `/v1/prism/status` is the mandatory backward-compatibility path. A consumer must still be able to recover owner identity from an existing valid client-bound token.

### Documentation

Update the generic local-app and status descriptions in `README.md`, `docs/setup.md`, `docs/security.md`, and `app/api-reference/endpoint-catalog.ts` to say that client-bound status/exchange subject metadata includes the canonical Slack user ID. Explicitly state that it is safe identity metadata, is not a credential, and does not choose a workspace.

No endpoint, OAuth scope, Slack app manifest, database schema, global policy, Token profile policy, or Prism configuration change is warranted.

## Do-not-bypass systems and invariants

- Do not let the local app submit, override, or select `slackUserId`, `prismUserId`, `slackConnectionId`, Token profile ID, installation scope, or workspace authority.
- Do not infer the owner from a Slack display name, profile name, email, channel membership, first message, latest message, workspace/team ID, IP address, hostname, machine label, or `clientId`.
- Do not resolve identity by Prism user alone or by the latest Slack connection. Use the exact Slack connection already bound to the resolved Token profile.
- Do not expose subject metadata for invalid, expired, revoked, bootstrap, or generic non-client-bound developer tokens.
- Do not use the Slack user ID as proof that a workspace is allowed. Organization installs still require an explicit `X-Prism-Workspace-ID`, and Prism must still validate the exact active grant.
- Do not treat `slackUserId` as a bearer secret, forwarding credential, or authorization header. Never return Slack access tokens, refresh tokens, credential envelopes, developer-token material, hashes, peppers, or app credentials.
- Do not weaken or bypass the Method registry, Capability map, execution identity, surface, workspace, rate-limit, reauth, or metadata-audit gates.
- Do not add Remote Codex routes, tables, client IDs with special behavior, channel/thread bindings, Slack cursors, Codex task IDs, commands, approvals, process ownership, or agent state to Prism.
- Do not make Prism poll Slack or interpret conversation text. The local app owns polling and conversational semantics.
- Do not require reauthorization or re-pairing solely to learn this already-persisted identity.
- Do not log the bearer or include it in test snapshots/evidence while exercising the new response field.

## Narrow integration plan

1. Add red tests for an active client-bound resolved token with `slackUserId`, proving `/v1/prism/status` returns it under `subject`.
2. Extend the `PrismStatusBody.subject` type and client-bound projection using the existing resolved value. Keep every invalid/revoked/expired/generic branch unchanged.
3. Add red tests for the local-app exchange subject and extend the shared application-profile result to return `authed_user_id` from its already-authoritative eligible connection query.
4. Thread that safe value through local-app store/type/route response code without adding storage or accepting client input.
5. Update only the generic API/security/setup documentation needed to explain the additive identity field and its non-authorizing meaning.
6. Run focused Token profile status/store/application-profile and local-app exchange/route suites, then the full Prism test and production build gates.
7. Deploy only the Prism web container with existing environment and Postgres volume preserved. No migration is expected.
8. Validate an existing Remote Codex bearer through status without printing it, then validate one fresh pairing response. Confirm both identify the same Slack user expected in Slack `message.user` events.

## Compatibility for existing paired tokens

- The status response change is additive. Existing consumers that ignore unknown JSON fields continue to work.
- Existing valid client-bound developer tokens already resolve through `token_profiles.client_id` and the exact `slack_connections.authed_user_id`; they gain `subject.slackUserId` immediately after Prism deployment.
- No database backfill or token rotation is required because `authed_user_id` is already non-null on the bound connection.
- No Slack reauthorization is required because no new OAuth scope or Slack API call is introduced.
- A Remote Codex upgrade should hydrate a missing local owner ID from `/v1/prism/status` before enabling inbound channel control. If connected to an older Prism that does not return the field, it must fail closed with a clear update-required state rather than accept all channel users.
- Re-pairing remains immediate rotation. A successfully re-paired token reports the newly approved exact connection's Slack user ID; the superseded bearer remains unusable.
- Non-client-bound Token profiles retain their existing status shape and do not gain a subject.

## Regression checklist

- Active client-bound status returns exact `{ prismUserId, slackUserId }` from the resolved Token profile connection.
- Generic active Token profile status still omits `application`, `subject`, and application Capability-map assertion.
- Invalid, malformed, expired, revoked, and bootstrap token responses contain no owner identity.
- Reauth-required client-bound status may still assert the bound owner identity while accurately reporting Slack unavailable; the local app must not perform forwarding until normal health checks pass.
- Status remains `Cache-Control: no-store` with `X-Prism-Request-ID` and no token/credential material.
- Token resolution still updates `last_used_at` only for a known active token and still selects identity without credential-envelope columns.
- Fresh local-app exchange returns the Slack user from the exact eligible/locked approved connection, not from request content or a separate latest-connection lookup.
- Re-pair/rebind returns the new exact connection's Slack user and immediately revokes the previous bearer under existing semantics.
- Organization pairing still returns explicit workspace choices; Slack user identity does not infer the target workspace.
- Playtest or other client-bound application tokens tolerate the additive status subject field and retain their existing policy/issuance behavior.
- Local-app begin, browser consent, device polling, policy-aware expiry, copy-once issuance, and terminal-state behavior remain unchanged.
- Slack forwarding authorization, workspace grants, execution identity, rate limits, and audit remain unchanged.
- No new table/column, OAuth scope, migration, app-specific Prism state, Slack polling, or message interpretation is introduced.
- Secret scans show no raw Prism developer token, Authorization header, Slack access/refresh token, credential envelope, token hash, or pepper in responses, logs, docs, screenshots, or tests.

## Test plan

### Domain and route tests

- Extend `src/server/token-profiles/local-tool-status.test.ts` with a client-bound record containing `slackUserId: "U123"`; assert the exact subject contains both Prism and Slack IDs.
- In the same suite, retain the non-client-bound case and assert `subject` is absent even if the resolved record happens to contain a Slack user ID.
- Add a missing-Slack-user fixture and prove Prism does not synthesize an owner: the complete `application` / `subject` / application Capability-map assertion block is absent. Update existing Playtest application fixtures to include their real invariant, `slackUserId`, so their normal subject assertion remains covered.
- Extend `app/v1/prism/status/route.test.ts` so the mocked application row includes `slack_user_id`, the response asserts it, no-store/request-ID checks remain, and secret canaries remain absent.
- Strengthen `src/server/token-profiles/store.test.ts` to assert `resolveDeveloperToken` maps `slack_user_id` to `slackUserId` together with the exact client and connection.

### Pairing exchange tests

- Extend `src/server/token-profiles/application-profile.test.ts` (or its nearest existing application-token coverage) to prove the eligible connection query selects `authed_user_id` and the returned result includes that exact value.
- Extend `src/server/local-app-authorization/postgres-store-metadata.test.ts` to assert the issued subject uses the value returned by `issueApplicationProfileToken` and never copies untrusted request text or caller data.
- Extend `app/v1/prism/local-app/authorizations/token/route.test.ts` so a successful response contains `subject.slackUserId`, while pending/denied/expired/policy-denied/invalid responses do not.
- Retain copy-once, exact JSON shape, duplicate-key rejection, rate limit, policy-aware expiry, terminal state, atomic exchange, and no-secret tests.

### Targeted and full regression

- Run Token profile developer-token, store, local-tool-status, status-route, method-policy, execution-identity, capability, and application-profile tests.
- Run local-app types/service/store/metadata/validation/token-route/browser-authorization/presentation tests.
- Run existing Playtest first-party application-token and OIDC status assertions because they also use client-bound profiles.
- Run full `npm test` and `npm run build` after targeted suites pass.

### Live proof

1. Confirm Prism health and deployed commit without printing environment values or bearer material.
2. Using the already-paired Remote Codex credential from its protected local store, call `/v1/prism/status` through the app and confirm an active `application.clientId` plus non-empty `subject.slackUserId`. Do not paste or log the token.
3. Confirm the returned Slack user ID equals the `user` field on a Slack message posted by the paired person in the selected workspace/channel.
4. Post a root message as the paired owner and verify Remote Codex accepts it.
5. Post or arrange a bounded test message from a different Slack user and verify Remote Codex ignores it and creates no local task/binding. If a second human is unavailable, do not fake this as live proof; retain the automated mismatch test and label the live case pending.
6. Verify a fresh pairing also returns the same owner identity without a follow-up migration or manual token copy.
7. Verify normal `conversations.*` and `chat.*` requests still pass through existing surface/workspace/policy enforcement, and confirm no Prism application-state rows were added.

For the current private-HTTP pilot, this proves behavior only. Production token and identity transport still requires HTTPS.

## Risks and mitigations

- **Identity exposed too broadly:** Returning Slack identity for every developer token would expand the current API unnecessarily. Keep the field under the existing client-bound subject gate; generic Token profiles remain unchanged.
- **Incomplete mocks mistaken for runtime nullability:** Several status fixtures omit `slack_user_id`, while the production column is non-null. Add explicit fixtures and fail-closed behavior rather than weakening the production invariant or fabricating values.
- **Identity/workspace conflation:** An organization install can have multiple workspace grants. Keep `slackUserId` solely as the actor comparator and continue explicit team selection/grant enforcement.
- **Consumer treats local filtering as complete security:** A local app holding the bearer can still call allowed Prism methods. Owner filtering protects inbound conversational control; Prism's existing bearer/policy enforcement remains the actual forwarding authorization boundary.
- **Strict JSON consumers reject additive fields:** The API change is additive and conventional clients should ignore unknown fields. Document it, keep existing field names/status codes intact, and cover Playtest plus generic local-app consumers in regression tests.
- **Re-pair identity drift:** Application-profile rebind can change the exact Slack connection only after new browser approval and token rotation. Return identity from the same eligible connection and require Remote Codex to replace its stored subject with the new exchange/status value.
- **Slack subtype/system messages:** Not every Slack message has a human `user`. Remote Codex must require the exact string match and ignore absent/mismatched identities; Prism should not grow message interpretation logic.
- **Older Prism deployment:** Updated Remote Codex may encounter status without `slackUserId`. Surface a clear Prism-update requirement and keep Slack-root creation/control disabled until identity is available.

## Decision confidence

**Confidence: high.**

The canonical Slack user is already persisted on the exact Slack connection, selected by existing developer-token resolution, mapped into `ResolvedDeveloperToken`, and displayed during local-app consent. The missing public assertion is a narrow projection gap. Extending the existing client-bound `/v1/prism/status` subject gives already-paired applications a migration-free recovery path; adding the same field to the copy-once exchange keeps new pairing coherent.

No new state owner, identity resolver, database schema, OAuth scope, Slack API call, policy exception, or application-specific Prism behavior is needed. If implementation evidence suggests deriving identity from channel messages, returning it for generic tokens, choosing a workspace from it, or storing Remote Codex state in Prism, stop rather than diverge from this brief.
