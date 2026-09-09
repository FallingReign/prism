# Enterprise Slack reliability: architecture integration brief

Date: 2026-09-04

Author: independent Architecture Scout; product and test code were not modified.

## Agreed scope

- R2: retain safe sign-in failure information across Slack, Prism, and Playtest, and provide recovery guidance in the application.
- R3: support both existing workspace and organization Slack installations, including organization identity without a workspace ID; preserve the user's choice of granted workspace and channel in Playtest. The user subsequently clarified that announcements must also offer Me (default) or Slack Bridge bot as the sender.
- R5: repair the complete static and runtime quality checks and add meaningful coverage of the cross-application behavior.
- R1 permission expansion and R4 HTTPS are questions/proposals in this turn, not authorization to change their product behavior or deployment. R6 credential replacement is outside these repositories and must not be attempted here.

The user clarified that Prism serves multiple applications. Preserve the global Slack scope catalogue, default requested Slack permissions, and existing grants. Any sender capability change must stay inside Playtest's narrow app policy: no message reading, direct messages, search, files, destructive operations, or full Slack Bridge preset. Sender selection is explicit and never falls back to another sender.

## Current evidence and ownership

| Concern | Existing owner and extension point |
| --- | --- |
| Slack authorization correlation, credential storage, installation identity | `src/server/slack/oauth-flow.ts`, `oauth-client.ts`, `postgres-store.ts`; callback HTTP boundary at `app/v1/slack/oauth/callback/route.ts` |
| Safe Slack failure reason | `OAuthFailureReason` in `oauth-flow.ts` already distinguishes authorization denial, unavailable runtime, provider rejection, invalid response, and persistence failure. Reuse and extend this bounded vocabulary rather than inventing a separate error pipeline. |
| Prism authorization requests and signed identity | `src/server/oidc/provider.ts`, `service.ts`, `postgres-store.ts`, `signing.ts`; real routes under `app/oauth/` |
| Playtest transaction validation and account/session creation | `src/lib/auth/callback.ts`, `prism-oidc.ts`, `users.ts`, `session.ts`; real routes at `src/app/api/auth/login/route.ts` and `callback/route.ts` |
| Playtest sign-in recovery UI | `src/app/login/page.tsx`; currently a bounded message map but only generic sign-in failure survives the callback |
| Granted workspace/channel discovery | Prism `src/server/playtest-directory/*`, `src/server/slack/organization-workspaces.ts`, and grant persistence; Playtest `src/lib/slack/directory.ts` and `/api/slack-directory/workspaces` routes |
| Workspace/channel selection | Already implemented in Playtest `src/components/admin/PlaytestsManager.tsx` and `src/components/dashboard/SessionOverrideEditor.tsx` |
| App credential restrictions | `src/server/token-profiles/first-party-app.ts` issues an 8-hour, connection-bound Playtest token governed by the global token policy. It does not grant general reading, direct messages, search, or files. `application-profile.ts` owns durable app-token rotation and profile rebinding. |
| Immediate sender resolution | `src/server/token-profiles/execution-identity.ts` resolves `X-Prism-Execution-Mode`; `local-tool-status.ts` reports availability; method policy and forwarding credential provider enforce the result. Playtest `src/lib/prism.ts` owns the outgoing request. |
| Announcement authorization and durable delivery | Playtest `src/lib/announcements/*`, including delegation, jobs, and the announcement worker; Prism `src/server/delegated-delivery/*`. Keep the existing receipt/idempotency and user consent paths. |
| Durable data | Prism `src/server/db.ts` uses real PostgreSQL and transactions plus `db/migrations/`; Playtest `src/lib/db/index.ts` uses `better-sqlite3`, WAL, foreign keys, and `initSchema`. |

### Verified gaps

1. Slack callback currently maps every unsuccessful linked OIDC continuation to `access_denied`, even though `oauth-flow.ts` already returns a bounded `failureReason`. OIDC resume accepts only `access_denied`. Playtest then parses but discards the provider error and always displays `authentication_failed`.
2. Prism OIDC `OidcSessionIdentity`, `OidcAccessTokenIdentity`, `SessionIdentityRow`, and `AccessTokenRow` all require `teamId`/`team_id: string`. The Slack connection and directory contracts correctly allow null for organization installs. Identity claims currently emit `slack_team_id` directly. Playtest already accepts an absent/non-string team claim as no workspace metadata.
3. A granted workspace is already selected independently from login identity. Playtest stores its destination as a workspace/channel pair and resets the channel when the workspace changes. Prism verifies the authenticated token's connection and current workspace grant before channel cache use. Do not replace this behavior with a new login-time workspace binding.
4. Existing OIDC route and store tests generally use fake database query results. They cannot prove migration SQL, transaction behavior, nullable PostgreSQL row handling, encrypted credential persistence, or that the two real applications interoperate.
5. Prism includes JavaScript script tests through Vitest's default discovery. Playtest explicitly includes `scripts/**/*.test.mjs`; those are not excluded by the current configuration. Playtest does exclude several legacy `node:test` TODO-only route/component files. Those placeholders must not be represented as working end-to-end coverage.
6. Parent investigation reproduced 158 TypeScript errors in outdated fixtures and two script-test import failures. Native Node import of `scripts/setup.mjs` passes; it has a CRLF shebang, while `start-local.mjs` imports it. This supports a runner/transform investigation before changing setup product behavior. The homepage timeout passed unchanged when isolated, so no product change is justified by that failure alone.

This scout inspected source, test organization, package/configuration, prior OIDC integration rules, and current dirty files. Runtime test baselines above come from the implementer's current investigation. No new deployed-runtime claim is made by this brief.

## Interaction model to preserve

1. Playtest creates a state/nonce/PKCE-protected transaction and sends the browser to Prism.
2. Prism reuses a valid session or completes Slack authorization, stores the Slack credentials encrypted on its server, and resumes the previously validated Playtest request.
3. Playtest validates the signed identity and creates its own session/account with its own role. An organization install may have no login workspace ID.
4. A manager/admin chooses one of the workspaces granted to the authenticated Slack connection, then one of that user's visible channels. A zero-workspace result is a valid connection state that needs guidance, not an invented workspace ID.
5. A manager/admin chooses Me (default) or Slack Bridge bot. Announcement delivery uses the existing authorized delivery path with that explicit sender. Slack visibility and a successful login do not grant a Playtest manager/admin role.

## Do-not-bypass rules

- Preserve constant-time state comparison, exact registered redirects, PKCE, nonce and signed-identity verification, one-time consumption, issuer/audience checks, and secure cookie behavior.
- Error guidance may use only a reviewed enum plus an opaque support reference. Never relay Slack's raw error description, upstream response body, credentials, arbitrary URL, request query, authorization code, nonce, or verifier.
- Do not clear a valid transaction cookie because an unrelated or malformed callback was supplied. Trusted terminal callbacks clear only their matched transaction.
- Keep standard OIDC `error` values intact. If product-specific guidance is necessary, use a separately named bounded extension. Validate duplicates, length, and allowed values at each boundary.
- A public URL error parameter is untrusted display input, not proof of an administrative state. Use conditional guidance for causes that Slack does not explicitly confirm. Some Slack rejection pages never call Prism back; the application cannot truthfully identify that precise failure automatically.
- Preserve `prism_users.id` as stable identity. Do not substitute a workspace, channel, display name, or app token profile ID for the subject.
- Workspace grants authorize targets, not login identity. Do not merge grants from another connection owned by the same user, automatically grant another workspace, infer COD Dev from its name, or expose another user's cached channels.
- Preserve encrypted credential custody, app-token capability limits, global policy enforcement, token renewal/refresh rules, and existing delivery consent/idempotency behavior.
- Sender choice must survive preparation, approval, storage, retries, execution, audit, and receipt. Never report a previously sent message as a successful send by a newly selected sender when the actual sender differs.
- A selectable token's unspecified execution mode currently chooses bot for writes. Therefore every Playtest announcement must request an explicit sender, including the default Me case, before issuing any selectable Playtest token.
- Changing a shared application profile policy must not broaden already issued overlapping tokens. Policy broadening must rotate and invalidate the old authority; normal same-policy login rotation may retain its existing overlap.
- Do not fix tests by disabling strictness, excluding failing test files, applying blanket `any`/`@ts-ignore`, weakening runtime contracts, or replacing behavior assertions with snapshots of their implementation.
- Preserve unrelated dirty files: `next-env.d.ts` and `docs/implementation-reviews/production-intelligence-all-channels-architecture-integration.md`.
- All harness data and credentials must be synthetic, isolated, and disposable. Do not run migrations, seed operations, cleanup, or fixture resets against production or the user's normal local database.

## Integration plan

### R5: restore a trustworthy baseline first

1. Capture TypeScript errors and test discovery by file/category. Add a `typecheck` script to Prism and an aggregate check only after the actual checks it invokes are known.
2. Repair stale fixtures at their contract owners. Shared factories belong under the existing test support boundary; required fields should have realistic safe defaults, with explicit scenario overrides. Generic database mocks must satisfy the real `Database` generic query/transaction contract; keep unavoidable adaptation casts narrowly inside a reusable mock adapter.
3. Reproduce the two `.mjs` import failures in isolation. Compare native import and Vitest; normalize only the affected file's shebang/line ending if that resolves the demonstrated transform issue. Do not rewrite startup behavior for a test-loader problem.
4. Run full Prism application/server/script tests, helper tests, strict type check, and production build. Run full maintained Playtest tests, strict type check, and production build. Run the separate dashboard test package if it remains an active package; identify what its checks cover rather than counting an excluded placeholder as a pass.
5. Add cross-app behavior coverage below. Report unit, integration, browser, and actual Slack acceptance separately.

### R2: preserve the failure and show a recovery action

1. Promote the existing Slack failure enum to a reusable contract at its current auth boundary. Map only known Slack errors into safe categories; retain a neutral category when the cause is unknown.
2. Carry the safe category from the bound Slack callback through validated OIDC resume and Playtest callback matching. Prefer server-persisted failure context on the existing pending authorization record if it avoids trusting resume query input; otherwise use a bounded extension that remains informational only and cannot change authorization decisions.
3. Add recovery copy at Playtest's existing login page: retry a cancelled/expired attempt, reconnect when needed, show that Prism is unavailable, or ask a Slack administrator to check app approval/workspace access/member restrictions when access is denied. Phrase administrative causes as checks unless the provider explicitly proves them.
4. Preserve the intended internal `returnTo` through a failed trusted transaction where practical, using the existing return-to sanitizer. Do not accept an external retry target.
5. For a connected user with no workspaces, use the existing directory/selector surface to explain workspace grants and refresh/reconnect actions. Translate bounded directory errors into useful messages instead of showing raw error codes. Do not claim a missing workspace proves Member Permissions are misconfigured.

### R3: complete existing installation support

1. Change the four OIDC identity/database row types to `string | null`, matching stored Slack organization identity. Decide and consistently test whether absent `slack_team_id` is omitted or explicitly null; omitting absent optional metadata is the simpler consumer contract. Retain `slack_enterprise_id` when present.
2. Add workspace and organization fixtures at service, store, token route, UserInfo, and Playtest consumer boundaries. Cover organization identities with zero, one, and multiple workspace grants.
3. Preserve existing workspace/channel selectors and ID pair persistence. Cover switching workspace, clearing stale channel choice, grant removal, and an identity moving from workspace to organization without changing its stable subject or Playtest role.
4. Do not let installation support broaden a requester's Playtest permissions. A role denial remains distinct from Slack access guidance.

### R3 clarification: explicit announcement sender

#### Additional current evidence

- The current Playtest announcement route calls `useDelegatedApproval(enabled, action)`, which returns true only for scheduled sends. Immediate sends call `src/lib/prism.ts` and the real generic Prism `chat.postMessage` forwarding route with the signed-in user's app credential.
- `SessionAnnounceButton.tsx` owns the immediate confirmation and schedule controls. Its current wording describes an older approval-only rollout even though the immediate path sends directly; align the wording with the tested path while adding the sender selector.
- `AnnouncementSenderMode` (`shared_prism` / `delegated_prism`) means delivery mechanism, not Slack sender. Do not overload it to mean user/bot. Add a separate explicit execution/sender field.
- Immediate job idempotency currently hashes session plus message content, excluding workspace, actor, and selected sender. The selected sender must be stored and compared on reuse; otherwise choosing bot can return a user-send receipt and imply the choice was honored.
- `executionIdentityStatus` currently requires both user and bot credentials for a selectable profile to be available. Method policy rejects unavailable execution identity before resolving the requested header. A simple default switch to selectable breaks Me for a connection that lacks a bot credential.
- `application-profile.ts` updates the capability map of the existing shared profile before adding a token. Playtest requests `rotation: until_expiry`, so old token holders share the updated policy. A simple user-to-selectable map change can give old header-less clients bot authority and change their sender without consent.
- Scheduled delegation is explicitly user-only in both applications. It includes a PostgreSQL CHECK (`0016_delegated_slack_delivery.sql`), request validation and immutable digest, request/grant row mappings, user-only credential joins, consent preview, execution, audit, and Playtest grant response validation. Do not treat the new selector as a cosmetic change for scheduled sends.

#### Chosen implementation path

Keep Playtest's existing user-only application credential unchanged. Me immediate sends use direct forwarding with an exact explicit user header. Slack Bridge bot sends, both immediate and scheduled, use the existing one-message delegation consent; Me scheduling continues to use that consent. When delegation is unavailable, the application explains the setup requirement and never substitutes a sender. This avoids any application-profile policy upgrade and therefore avoids broadening existing or overlapping tokens. The selectable-token upgrade requirements below remain constraints for a future alternative, not changes needed for this path. An exact mode matching a fixed-identity token is permitted without enabling a different mode.

#### Integration requirements

1. Define the product sender as `user | bot`, default `user`; expose labels Me and Slack Bridge bot. Put the choice next to announcement preparation, include it in confirmation and receipt, and pass it through the existing dashboard handler/client/route interfaces. Reject invalid values at the HTTP boundary.
2. Keep the app credential user-owned and connection-bound. Reuse the existing selectable execution mechanism while keeping the Playtest action/surface map unchanged. If a bot choice requires a new selectable credential, use a guided same-tab renewal and explicit choice; do not widen all existing credentials in place.
3. At a policy upgrade, compare the previous capability map and rotate without overlap for authority broadening. The internal `classifyPolicyChange` in token-profile service is the existing classification owner; extract/reuse its relevant policy comparison if needed instead of introducing inconsistent semantics. Preserve ordinary same-policy renewal behavior and other applications' profiles. Test a pre-upgrade token and a header-less old client.
4. Support an explicit available Me choice when the bot credential is unavailable. Either keep that caller on the existing user policy until bot is requested, or make explicit-mode policy evaluation check the requested mode instead of requiring both selectable modes. If modifying common execution evaluation, preserve the semantics of automatic callers and cover unrelated profiles. A missing/unusable bot produces guidance to reconnect/check Slack Bridge installation or channel membership, not a fallback send.
5. Persist selected sender separately from delivery mechanism in the Playtest announcement job and safe job projection. Add a schema migration/default for older jobs (`user` for known per-user/delegated jobs; do not invent an actual sender for legacy owner-token receipts). Include selected sender in immutable preparation/binding and audit. A sender change after prior delivery must require a new explicit send/reapproval or show a clear existing-delivery conflict; it must not silently duplicate.
6. Immediate sends must include an explicit `X-Prism-Execution-Mode: user|bot`. Legacy user-only credentials cannot accept override headers under the current resolver, so support them deliberately (renew or permit an exact matching mode without broadening); do not remove the header on failure and retry automatically. Read the verified Prism execution-mode response into the receipt when available.
7. For scheduled sends, extend the existing delegation contract end to end before offering bot scheduling: validate `execution_mode`, bind it into the immutable digest and stored request, migrate the database constraint, copy it through grant/execution binding, select the corresponding credential and scope check, display the sender in consent, and return/verify it in token and execution metadata. Keep approver Slack user identity separate from the bot sender; approving as a person does not mean the message posts as that person.
8. Preserve the requested sender on reapproval and retry. Changing sender invalidates old approval just like changing channel/content. Existing version-1 user-only grants remain user-only. If a temporary implementation supports bot only for immediate sends, explicitly disable/reject bot scheduling with in-app guidance and report that limitation; do not call the full requested sender feature complete.
9. Preserve workspace/channel authorization for bot sends. The visible target remains one granted to this user's authenticated connection; possessing a bot credential does not authorize other workspaces or automatically invite the bot. Surface missing bot channel membership as a recovery action.

Additional required tests: Me sends with user credentials; bot sends with bot credentials; no missing-header bot default; no fallback when the selected credential fails; unavailable bot leaves Me usable; pre-upgrade tokens are not broadened; requester cannot send as bot; same-content/sender-change reuse is explicit; scheduled approval/worker/receipt retain the sender; tampered sender metadata fails; expired/revoked bot authority is rejected before Slack is called.

#### Implemented sender contract (local changes, 2026-09-04)

- Playtest sends `executionMode: user|bot` from the Post as control. Immediate Me uses the existing narrow user credential and an explicit user header. Bot immediate and either scheduled sender use existing bounded delegation; the Playtest application profile and Prism's global Slack scopes are unchanged.
- Prism migration `0029_delegated_announcement_sender.sql` accepts user/bot requests and adds an immutable sender to grants. Existing grants default to user. Consent, credential selection, workspace authorization, execution, and audit use that sender. Consent selects the exact Slack connection authenticated in the browser session.
- To keep old strict user-only clients compatible, user token/execution responses retain their original shape. Bot responses include `execution_mode: bot`; updated Playtest accepts both shapes, interprets omission only as user, and rejects sender mismatch before storing a grant or reporting delivery.
- Playtest stores selected and confirmed sender separately. Known historical per-user jobs remain user; old shared-token receipts without evidence remain unknown. Active controls use the stored sender after reload. Browser return starts immediate delegated delivery; the existing worker handles scheduled sends and transient retries with the same grant.
- Receipt reuse checks actor, sender, and workspace as well as session/content. A changed binding produces a visible conflict. Same-content active/approved deliveries are not replaced by new grants. Immediate pending approval retries keep the same request even when retried later; schedule preparation still binds the approved time. Worker due-time comparison handles both ISO and SQLite timestamp formats.
- Playtest's user guidance is in `docs/announcements.md`. These are local source changes; migrations, service configuration, deployment, and real Slack acceptance are separate rollout work.

## Cross-application behavior harness

Minimum credible automated acceptance uses both real route stacks and both real storage engines. Calling each service function with a fake store is useful focused coverage but is not this gate.

Suggested ownership: a dedicated integration/e2e test folder and explicit command in Playtest, since Playtest starts the journey. Accept the Prism repository path through a test command option/environment setting; fail clearly if unavailable. Avoid embedding this Windows machine's absolute paths.

Harness approach:

1. Create a temporary Playtest SQLite file through `PLAYTEST_DB_PATH` and a dedicated disposable PostgreSQL database (or container) for Prism. Apply the real Prism migrations and Playtest schema. Use synthetic app configuration, encryption keys, signing keys, and subjects. Use explicit test database names and validate the cleanup target.
2. Start the actual Next applications as separate processes on reserved test ports with isolated environment/build output. Separate processes avoid alias and Next 15/16 dependency collisions. Do not edit either normal `.env.local` or reuse the live services' database URLs.
3. Mock only the Slack network boundary. A test-only Node preload/interceptor or injected Slack HTTP client can return scenario-specific `oauth.v2.access`, `auth.teams.list`, `users.info`, `users.conversations`, and announcement responses. Record/redact calls and fail on unexpected Slack methods; block real Slack network calls. Keep OIDC discovery, token signing/exchange, HTTP routes, app credential issuance, database stores, sessions, directory authentication, and delivery state real.
4. Use an HTTP cookie-jar driver for the full redirect/endpoint path, then a browser driver for recovery messages and workspace/channel choices. A browser-only Slack request interception is insufficient: Slack code exchange and Web API calls occur on the Prism server.
5. Existing `PRISM_SLACK_OAUTH_MOCK` and `PRISM_SLACK_WEB_API_MOCK` can support a smoke test, but their canned workspace-only fixture does not prove organization behavior. Do not add an unrestricted production mock endpoint or server-configurable arbitrary Slack URL. Scenario injection must remain test-only.
6. Use finite waits, capture sanitized process output, and stop only test processes. On Windows start background helpers without visible windows. Database cleanup must be scoped to the validated temporary target.

### Required behavior assertions

| Case | Expected user/result evidence |
| --- | --- |
| Fresh workspace sign-in | Real Playtest login -> Prism -> synthetic Slack -> both callbacks -> `/api/auth/me`; correct stable user and stored role; secrets absent from browser content/logs |
| Existing Prism session | Playtest signs in without another Slack exchange; new Playtest transaction still validates |
| Organization sign-in, no team ID | Signed identity and UserInfo accept absence; real PostgreSQL and SQLite persist it; sign-in succeeds |
| Organization grants 0/1/2 | Empty state gives recovery guidance; permitted workspace choices appear; selecting workspace 2 loads only workspace 2 channels |
| Wrong/missing/replayed state, bad PKCE, reused code | No session/account swap; no improper transaction clearing; no credential returned; one-time state/code behavior holds |
| Provider cancelled/rejected, runtime/network failure | Safe category survives every real redirect boundary and the page gives the matching recovery action |
| Unknown or malicious error metadata | Neutral guidance, no arbitrary text/URL rendering, no secrets, no authorization change |
| Requester versus manager | Requester signs in but cannot manage destinations/send; manager can use its authorized destinations |
| Unrelated connection/grant or revoked grant | No directory data or delivery access, including after a channel cache has been filled |
| Workspace selection changes | Prior channel clears; saved destination contains the chosen immutable workspace/channel IDs |
| Announcement preparation and delivery | Existing approval path runs, fake Slack receives exactly one approved payload, receipt/job state persist, retry does not duplicate delivery |
| Me and Slack Bridge bot | UI choice reaches the real forwarding/delegation path; synthetic Slack sees the expected credential kind; receipt records that sender; no alternate sender call on failure |

The harness proves application behavior against a controlled Slack boundary. Real enterprise acceptance still requires a non-collaborator's actual sign-in, COD Dev visibility, the correct Playtest role, and one explicitly approved announcement. Do not send a real announcement under a generic testing instruction.

## Regression checklist

- Existing local-app authorization, delegated delivery resumes, setup verification, and ordinary Prism sign-in keep their own continuation semantics.
- Existing workspace and organization users retain stable account identity and granted destinations.
- Global Slack permissions and other applications' policies do not change. Only the explicitly consented Playtest sender choice can expand its execution identity; its action/surface restrictions remain unchanged.
- Production configuration, public URLs, deployment, credentials, and data remain unchanged by this local repair.
- All tests are discoverable through documented commands; no formerly failing file silently disappears from the checks.
- Strict type check, maintained runtime tests, helper tests, build, cross-app HTTP coverage, and browser acceptance each have explicit results.
- Existing dirty files are retained; generated changes are reviewed instead of blindly reverted.

## Risks and decision confidence

- **Error diagnosis limits:** Slack may stop before returning a callback. Conditional in-app guidance is appropriate; claiming automatic diagnosis of organization policy is not. Confidence: high.
- **Identity compatibility:** null team identity is real supported state; changing claim presence should be checked against existing consumers. Playtest already tolerates absent/null values. Confidence: high for the targeted fix.
- **Test database availability:** a disposable PostgreSQL runtime and optional browser driver may need installation/startup. This is an environment prerequisite, not a reason to relabel fake-store tests as end-to-end. Confidence: medium until the harness runs.
- **Baseline fixture volume:** fixing all 158 static errors may expose additional stale assumptions. Resolve them against current contracts without broadening product behavior. Confidence: high for the approach, exact effort unknown.
- **Browser integration scope:** implementing a full new test framework can overwhelm a bounded reliability fix. Start with the smallest real route/storage journey, then add browser checks for the user-visible changes. Confidence: high.
- **Sender contract breadth:** immediate selection has an existing forwarding extension point, but scheduled selection spans a versioned consent/grant contract and two databases. Confidence: high in the identified ownership; medium until both legacy and new grant journeys pass. A UI-only change or unconditional default profile broadening is not acceptable.

The implementer may begin R5 repairs and the targeted R2/R3 extensions, including the clarified Me/bot choice, under the user's existing authorization. No new approval is needed for these reversible local changes. If evidence requires changing login identity semantics, global Slack permissions, another application's authority, deployment, or actual Slack access, surface that conflict before proceeding.

## Independent implementation review

Review date: 2026-09-04. The Architecture Scout reviewed the completed R2/R3 source changes in both repositories independently of the implementers. The review also examined the browser harness architecture and its current journeys. Product and test source were not edited by the reviewer.

Decision: the reviewed changes follow this brief and preserve its authorization boundaries. No unresolved architecture or authorization finding remains in the reviewed scope after the corrections below. This decision is a source-review result; full-suite results, production rollout, and real enterprise Slack acceptance remain separate gates.

| Review | Finding and disposition |
| --- | --- |
| RV1 — Sign-in guidance | Slack network/service failures now use a neutral `provider_unavailable` category instead of implying an access denial. OAuth startup failures resume through the stored OIDC authorization request. Callback destinations, state, one-time transactions, safe internal return paths, and duplicate/malformed metadata checks remain owned by the existing auth flow. Display text comes from bounded message maps; raw provider descriptions are not reflected. |
| RV2 — Organization identity | OIDC session, access-token, and database-row contracts now allow a missing workspace ID. Optional `slack_team_id` is omitted when absent while organization identity is retained. Existing granted-workspace/channel selection and role enforcement remain separate from login identity. |
| RV3 — Sender authority | The implemented path keeps Playtest's existing narrow user-only app credential and Prism's global Slack permissions unchanged. Me immediate sends use an explicit user mode; bot immediate sends and both scheduled modes use the existing exact-message consent. Migration 0029 preserves old grants as user, and request, grant, consent, credential selection, execution, and receipt metadata retain the selected sender. PostgreSQL joins use the exact authenticated Slack connection and selected credential kind. Missing authority does not trigger another sender. |
| RV4 — Delivery lifecycle | Review found and the implementer repaired duplicate-send paths across direct and delegated delivery. Shared transactional preparation now checks pending, approved, scheduled, sending, delivered, and uncertain prior work as appropriate. Expired unused approvals are retired and their callback transaction consumed before a replacement send; an active exchange or uncertain prior attempt is retained. A fresh grant cannot bypass an uncertain direct send's idempotency key. Receipt reuse checks actor, sender, and workspace; retries retain the grant; the sender control and outcome text reflect stored state after reload. |
| RV5 — Browser harness | The harness copies application source into a validated temporary directory, uses disposable PostgreSQL plus isolated SQLite, generates synthetic credentials/keys, starts real loopback Next servers, and excludes normal environment files. Browser and server requests block external network access except synthetic Slack. Normal inter-application routes, signed identity, storage, consent, and delivery remain real. One explicit transport-failure scenario drops an execution request before forwarding to Prism; it does not fabricate a Prism handler result. Cleanup targets only test processes, the named disposable container, and the validated temporary directory. |
| RV6 — Verification evidence | The reviewer independently ran the final Playtest announcement-job and delegation-service regression suites: 54 tests passed across 2 files. These cover cross-path pending/active/uncertain deliveries, expired approval retirement and delayed callback rejection, receipt reuse, and sender/workspace binding. The reviewer inspected PostgreSQL migration names, column mappings, SQL parameters, and mode/connection joins. Full PostgreSQL/browser execution and complete quality-gate results are owned by the main implementation run and must be reported from that run. |

Current browser journeys exercise fresh and existing-session sign-in, organization identities with zero/one/two workspaces, saved destination switching, cached grant revocation, requester restrictions, state/PKCE/code replay, safe failure guidance, both immediate senders, both scheduled senders, unavailable bot guidance without fallback, same-grant transport retry, uncertain Slack outcomes, and repeat-delivery prevention. Test-only role/configuration seeding is confined to the disposable databases; the subsequent actions use actual HTTP routes.

This review does not certify live installation or deployment. The remaining enterprise acceptance is a fresh non-collaborator sign-in, COD Dev visibility, the required Playtest role, and one explicitly authorized announcement. HTTPS configuration and the exposed Jira Tools Slack bot credential remain separate operational work; the review did not change them.

### Follow-up review of browser-discovered defects

The main browser run exposed additional integration defects after the initial review. The Architecture Scout independently reviewed the resulting fixes on 2026-09-04. No unresolved finding remains in these changes.

| Review | Disposition |
| --- | --- |
| RV7 — Browser origin on sign-in failure | Playtest now builds error redirects from the validated application origin rather than Next's internal request origin, which can differ behind a proxy or in development. `getAppBaseUrl` is independent of the remaining auth configuration so a broken issuer or session-secret setting cannot prevent recovery guidance. An invalid application URL produces a fixed relative `/login` redirect. Callback matching, trusted return paths, transaction clearing, and no-store headers remain intact. |
| RV8 — Location readiness and inheritance | Readiness, server announcement construction, and the Message details display share the same trimmed session-location override with recurring-playtest fallback. Both session queries expose the inherited field without replacing the stored override. A missing Location produces actionable 409 guidance before delivery preparation or preview generation; other incomplete previews remain available. The editor shows when Location is inherited and explains how to override it. This satisfies the generator's existing internal Studio requirement without creating another user-facing field. |
| RV9 — Consent return to Playtest | Successful Prism consent pages now permit the registered Playtest callback origin in CSP `form-action`, allowing the browser to follow the post-consent redirect. The only production caller supplies the validated server configuration, never request parameters or preview text. The policy includes the parsed origin, not arbitrary callback text; default source, framing, base-URL, and error-page restrictions remain unchanged. Exact callback validation and grant/transaction binding remain authoritative. |
| RV10 — E2E assertion propagation | The sequential step helper resolves its sequencing promise in `finally` but rethrows assertion failures inside the native `node:test` subtest. An independent deliberate-failure probe on Node 24.0.0 failed both child and parent and exited with status 1, confirming the helper does not turn an assertion failure into a successful test run. |

Independent follow-up verification passed: 30 Playtest auth/config/callback tests (including the five real-route origin regressions), 11 Playtest readiness and real-route SQLite tests, and 24 Prism HTTP/validation/presentation tests. The complete browser run still supplies the final evidence that consent reaches Playtest's callback and delivery; these focused results do not replace it.

### Final bounded review before source freeze

| Review | Disposition |
| --- | --- |
| RV11 — Malformed Slack OAuth responses | The OAuth client now classifies invalid JSON, non-object bodies, a non-boolean result flag, and invalid successful-installation shapes as `malformed_oauth_response`; the existing safe guidance contract maps this to `invalid_provider_response`. Review identified that a failed response-body read could otherwise be misclassified. The corrected code treats only JSON `SyntaxError` as malformed and retains connection-reset/abort failures as `network_error` / `provider_unavailable`. Provider text remains private; successful credential, installation, scope, and refresh-authority rules are unchanged. Unknown refresh errors remain unavailable rather than forcing credential replacement. The reviewer independently reran client, flow, refresh, and callback tests: 51 tests passed across 4 files. |
| RV12 — Announcement controls fit the drawer | The sender display fix changes three layout class lists in `SessionAnnounceButton.tsx`: helper text and controls remain vertically arranged, can shrink within the drawer, and controls wrap onto additional lines. It changes no sender selection, disabled state, confirmation, or delivery behavior. Source review found no remaining issue. The final browser run owns the screenshot and right-edge visibility assertion at the affected viewport. |

The final bounded source review has no unresolved findings. Complete-suite and final-browser results must still be recorded from their actual runs; this review does not substitute for those results or live enterprise acceptance.

### PostgreSQL timestamp-order follow-up

**RV13 — Database and application timestamp precision:** A real browser delivery exposed a PostgreSQL time-order constraint failure when the stored grant creation time was a few milliseconds later than the application's captured request time. The independent review checked every constrained update in `delegated-delivery/postgres-store.ts`. Lifecycle metadata now uses the greatest of the stored creation time, previous update time, and supplied event time; one-time code usage uses its stored creation time as the floor. This preserves PostgreSQL precision for request approval/denial/expiry, grant claim/upstream/terminal transitions, cleanup, and rate-limit metadata.

The change leaves authorization predicates and all `not_before`, approval, delivery, grant, lease, proof, and rate-window deadlines unchanged. It does not extend an approval or authorize an earlier send. Cleanup aliases and SQL parameter ordering were reviewed with no remaining finding. The reviewer independently ran the store, execution, and service suites: 23 tests passed across 3 files.

The added real-PostgreSQL browser regression moves only one scheduled bot grant's creation/update metadata 20 seconds ahead before invoking the actual worker. It checks one delivery, ordered completion metadata, unchanged grant expiry, and no repeat post on another worker run. Its execution result belongs to the final browser run; the focused SQL/store tests alone do not prove the database constraint repair.
