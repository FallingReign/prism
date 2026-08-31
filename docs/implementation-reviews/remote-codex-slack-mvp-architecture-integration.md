# Remote Codex through Slack MVP - current-main reconciliation brief

Date: 2026-08-31
Status: architecture gate; reconciliation required before merge/deploy
Prism authority: `origin/main` at `598cd1b`
Feature base: `625ddf6` (29 commits behind at inspection)
Companion: `C:\Development\harness\remote-codex`

## Decision

Retain the Tauri 2/Rust/NSIS companion and the status-only private-Slack-thread MVP, but selectively port the Prism work onto current main. Do not mechanically rebase or merge the old-base diff.

The current slice is intentionally limited to:

- install once, tray/autostart, local Codex App Server over stdio;
- browser-approved pairing to the user's exact Prism/Slack identity;
- sanitized recent local-session catalog in Slack App Home;
- **Attach to Slack** in App Home and **Share to Slack** on the machine;
- one durable owner-private DM thread per Codex session;
- status mirroring only. Slack replies, commands, approvals, output, shared channels, shortcuts, and slash commands remain disabled.

## Current evidence and ownership

Current main already owns systems that the old feature base did not have:

- Migration `0022` binds each `prism_session` to one exact `slack_connection_id`.
- Migration `0021` makes organization installs explicit: `slack_connections.team_id` is nullable and target workspaces come from active `slack_connection_workspace_grants`.
- Slack app configuration may be environment-backed or database-backed through `src/server/slack/app-configuration-factory.ts`.
- `src/server/http/browser-mutation-csrf.ts` already protects cookie-authenticated browser mutations.
- `src/server/slack/forwarding-credentials.ts`, `web-api-client.ts`, rate-limit stores, and metadata-only audit own outbound Slack safety.
- `src/server/delegated-delivery/*` is a Playtest-specific, approved user-mode one-shot delivery flow. Reuse its source-attribution, proof, lease, and abuse-control patterns; do not route Remote Codex through its grant product.

The dirty feature implementation has useful code to preserve: key-bound pairing, hashed/rotating runner credentials, replay nonces, raw Slack signatures, immediate ACK with Next `after()`, reclaimable receipts, transactional binding reservation/stale recovery, App Home projection, private-DM attach, and 30-second companion catalog/status sync.

The deployed `work-vm` repository is clean on current main. Prism is exposed directly as `http://10.62.240.10:3732`; there is no Prism ingress on 80/443. PostgreSQL is at migration `0022`. This private HTTP origin is not a production-safe credential transport and is not a Slack-reachable Events API/interactivity request URL.

## Target ownership model

```text
website prism_session
  -> exact prism_user_id + exact slack_connection_id
      -> Remote Codex installation + explicit default team
          -> sanitized Codex sessions
              -> one active Slack binding per session
```

Rules:

- Pairing derives the exact connection with `c.id = s.slack_connection_id` and `c.prism_user_id = s.prism_user_id`; it never lists arbitrary same-owner connections or chooses the most recent one.
- For a workspace install, `default_team_id` is the connection's sole `team_id`.
- For an organization install, the pairing page selects one explicit target from that exact connection's active workspace grants. Persist it as `approved_team_id` on the pairing and `default_team_id` on the installation. This is a workspace choice, not an identity choice.
- Machine-side **Share to Slack** uses and revalidates the installation's default team/grant. Slack App Home attach uses the signed event's explicit team after validating that exact connection's active grant. Never derive the target workspace from organization login identity.
- A binding stores its target `team_id` independently of `slack_connections.team_id`.
- Only the signed Slack actor matching the paired connection may attach. `unavailable` sessions cannot be newly attached.
- Slack messages are not Codex commands in this slice.

## Interaction model

Machine-first: install, choose **Connect to Prism**, confirm the matching phrase and exact Slack identity in the browser, then use **Share to Slack**. Organization users make one clear workspace choice during pairing. The companion creates or reopens the same private thread and opens its HTTPS Slack permalink.

Slack-first: App Home shows the user's eligible recent sessions and **Attach to Slack**. If no computer is paired, the action must link to a real `/remote-codex` installer/setup page. The current dirty feature points at that missing route, so a 404 is a release blocker. If pairing begins while signed out, OAuth must safely return to the same pairing page without code copying or restarting.

## Do-not-bypass systems

- Reuse current main's `rejectCrossOriginBrowserMutation`; remove the feature replacement, scoped HMAC token, and `PRISM_BROWSER_CSRF_SECRET`.
- Keep `SLACK_SIGNING_SECRET` server-only. Verify Slack signatures over the exact raw body before JSON/form parsing.
- Construct credential refresh through `createConfiguredSlackOAuthClient`/`createOptionalConfiguredSlackOAuthClient`, not synchronous old-base `getSlackOAuthConfig()`, so active DB-backed Slack configuration works.
- Reuse the configured cipher, refresh store, forwarding credential provider, Web API client, Slack error handling, credential reauthentication marking, and metadata-only audit.
- Do not forge developer tokens or add Remote Codex to developer-token capabilities.
- A Remote-Codex internal bot-call service may own owner/method rate buckets, because public forwarding and delegated delivery have different semantics, but it must record audit before upstream, inject explicit organization workspace context, honor Slack 429/errors, and never log payloads.
- Preserve all current activity/status audit values. The Remote Codex migration must append its types to the full current-main constraint rather than recreate the old `0013` list.
- Existing OAuth, OIDC, delegated delivery, Slack configuration, first-party Playtest token, global-admin, organization-grant, and developer-token behavior must not change.

The current Slack scope catalog does not contain `im:write`. Private bot DMs require bot `im:write` and bot `chat:write`. Add bot `im:write` to the central `SLACK_SCOPE_CATALOG`, configuration UI/tests/docs, and manifest. Do not add user `im:write` without a separate user-token need. Detect missing bot scopes and show reauthorization/setup instead of repeatedly attempting Slack calls.

## Mandatory current-main conflicts

| Conflict | Required resolution |
| --- | --- |
| Remote migrations are named `0014`-`0016`, which already exist | Start after current `0022` (`0023`-`0025` if still free immediately before commit); update tests/docs. |
| Feature audit migration has the old activity list | Use the full cumulative current-main list plus Remote Codex and test preservation. |
| Feature replaces the current CSRF helper | Keep current main's helper; remove extra secret/config. |
| Pairing lists every owner connection | Derive the exact session-bound connection; only organization workspace grant is selectable. |
| Catalog/binding/status require `c.team_id` | Support workspace connection or active organization grant and persist explicit target team. |
| Internal Slack service calls old env-only OAuth config | Make construction async and use configured app/OAuth factories. |
| Inbound routing trusts only team/user | Validate signed `api_app_id`, team/enterprise/authorization context, actor, exact connection, and grant; fail on ambiguity. |
| Manifest adds `im:write` but central config rejects it | Add required bot scope centrally and prove reauthorization. |
| App Home links to missing `/remote-codex` | Implement the installer/connect landing page or use an approved real distribution URL. |
| Status projection excludes `unavailable` and stops at 20 | Reconcile every active binding in bounded pages, including unavailable/older sessions. |
| Pair creation has one low global bucket | Add trusted per-source and canonical signing-key limits while retaining a high global circuit breaker. |
| Companion requires HTTPS but VM is private HTTP | Provision approved HTTPS or use only the explicitly bounded pilot exception below. |
| Slack callbacks point to a private host | Add Slack-reachable HTTPS ingress or stop for a separate Socket Mode architecture decision. |

## P2 closure: pairing abuse limits

The unauthenticated pairing endpoint must enforce, transactionally:

1. a high-volume global circuit breaker and total pending cap;
2. a per-source rate and outstanding-pending cap using a keyed HMAC of the source address, never a raw IP;
3. a per-signing-key rate and outstanding-pending cap using a fingerprint of canonical validated Ed25519 DER, so PEM formatting cannot create aliases.

Reuse the fail-closed proxy-header parsing pattern in `delegated-delivery/request-source.ts`. Trust forwarding headers only when an explicit Remote Codex setting is enabled and a trusted ingress overwrites them while blocking direct origin access. Malformed/disagreeing headers fail before persistence. An unattributed request must not enter one low shared bucket that an attacker can exhaust. Return a generic 429/`Retry-After` without naming the bucket.

Tests must prove independent sources, same-key exhaustion, PEM canonicalization, new-key source enforcement, untrusted header spoof rejection, malformed trusted headers, bounded cleanup, and the final global cap.

The current direct-origin VM cannot provide trustworthy source attribution. Production pairing must remain disabled until the ingress trust boundary exists.

## P2 closure: complete bound-status projection

The recent picker and bound-thread reconciliation are different workloads:

- The companion may keep a 50-session recent catalog, and App Home may display a smaller recent subset.
- Catalog replacement may mark omitted known sessions `unavailable`.
- After catalog commit, enumerate every active binding for the installation in bounded cursor/pages; `LIMIT 20` may be a page size, never the total.
- Include `unavailable` sessions and project **Not currently available on computer**. Never map them back to `ready`.
- Run Slack updates after the runner response with bounded concurrency. Failed updates remain eligible on the next 30-second sync.
- Revalidate the binding's exact connection and target workspace/grant before every update.

Test 0, 1, 20, 21, 50, and more-than-50 bindings; an omitted old binding; unavailable then recovered; Slack failure then retry; and revoked organization grants.

## Migration port

Assuming `0022` remains latest:

- `0023_remote_codex_pairing.sql`: pairing requests with source key and signing fingerprint; rate/outstanding controls; installations with exact owner/connection and `default_team_id`; hashed access/refresh families and nonce replay tables. Use a composite FK to `slack_connections(id, prism_user_id)`. For organization defaults, require an existing `(slack_connection_id, team_id)` grant and revalidate `status='active'` in services.
- `0024_remote_codex_sessions.sql`: `(installation_id, codex_thread_id)` identity; safe labels, normalized status, catalog/activity/seen timestamps; no path/content.
- `0025_remote_codex_slack.sql`: internal Slack rate buckets, reclaimable inbound receipts, bindings with exact owner/connection/install/session/target team, partial unique indexes for active session and Slack-thread bindings, composite ownership FKs, and the cumulative audit constraint.

Apply both a fresh `0001`-through-latest schema and an upgrade from actual `0022`. Tests must prove current OIDC/delegated/configuration/admin/organization/session-connection objects and activity types remain intact.

## TLS/private HTTP

Release builds must require HTTPS for every non-loopback Prism origin. Signatures provide integrity, not confidentiality for pairing/access/refresh credentials.

Preferred deployment is an approved hostname/certificate with HTTPS ingress, direct port 3732 blocked from clients, trustworthy source headers, and a request URL reachable by Slack. Companion and browser should use the same exact origin.

A separate pilot-only artifact may compile one exact origin such as `http://10.62.240.10:3732` only if it is visibly marked **insecure VPN pilot**, accepts no runtime URL, permits only exact loopback/RFC1918 origin, rejects cross-origin redirects, is restricted to the approved VPN cohort, and has a removal date. Normal/release builds and updater metadata stay HTTPS-only. This accepts VPN-dependent confidentiality risk; it does not make Slack callbacks or trusted per-source limiting work.

If Slack-reachable HTTPS is forbidden, Socket Mode is a separate slice with app-level-token custody, outbound connection lifecycle/reconnect, deduplication, supervision, and live QA. Do not improvise it into this port.

## Reconciliation order

1. Port onto current main with current files winning add/add conflicts.
2. Renumber/harden migrations and ownership/team constraints.
3. Replace pairing approval with exact session connection, organization workspace selection, and current CSRF.
4. Port runner auth/refresh/catalog and add disabled-by-default Remote Codex configuration. Do not implicitly reuse the OIDC insecure-HTTP flag.
5. Build the current-main-compatible internal Slack service and central workspace/grant resolver.
6. Add bot `im:write` centrally and missing-scope handling.
7. Port signed inbound routes, immediate ACK/deferred work, receipts, and app/install-context validation.
8. Close both P2s, then implement the missing installer landing/OAuth return flow.
9. Run current-main regression/build and disposable `0022` upgrade before any work-vm deployment.

## Regression and test gate

- [ ] Existing Slack OAuth/configuration/rotation and exact session-to-connection binding pass.
- [ ] Workspace and organization installs pass with active grants; revoked/missing grants fail closed.
- [ ] Target team always comes from explicit pairing choice or signed callback, never login inference.
- [ ] Existing OIDC, delegated delivery, Playtest, admin, forwarding, token policy, and audit behavior passes.
- [ ] Current CSRF semantics remain intact and protect pairing approval.
- [ ] Raw Slack signature, clock, callback app/install context, actor, retry/reclaim, and immediate ACK tests pass.
- [ ] DB-backed and environment-backed Slack app configuration both refresh credentials.
- [ ] Required bot scopes and reauthorization state are tested.
- [ ] Pairing source/key/global abuse matrix passes.
- [ ] Binding race/stale/failure recovery and all-binding status matrix passes.
- [ ] No prompt, output, path, diff, transcript, Slack token, pairing secret, access token, or refresh token reaches DB, audit, logs, errors, or browser state.
- [ ] Companion release/pilot origin policy, secure store, request proofs, refresh, 50-session sync, reboot/autostart, and packaged NSIS path pass.
- [ ] `/remote-codex` is a real non-technical setup path.

Run all existing current-main tests and `npm run build`, recording the baseline so no new regression is hidden among known unrelated failures. Live QA must cover workspace and organization identities, pair/reboot/share/App-Home attach idempotency, old-session unavailability/recovery, outage retry, and canary inspection. Keep commands/approvals/output/shared channels disabled.

## Risks and confidence

| Risk | Resolution | Confidence |
| --- | --- | --- |
| Old feature base conflicts with nine newer migrations/systems | Selective port plus full migration/regression gate | High |
| Organization routing is absent from feature queries | Exact connection + explicit default team + active-grant resolver | High |
| DB-backed Slack configuration is bypassed | Configured async OAuth client factory | High |
| Pairing global bucket is exhaustible | Trusted-source, canonical-key, and global controls | High design; ingress-dependent |
| Older/unavailable threads remain stale | All-binding paged reconciliation | High |
| Work-vm is private HTTP and Slack-unreachable | HTTPS ingress preferred; bounded pilot and Socket Mode are explicit alternatives | High on constraint; deployment decision open |

Decision confidence is high for Tauri/Rust/NSIS, exact session-bound pairing, explicit organization workspace selection, current-main system reuse, migration numbering after `0022`, and both P2 fixes. Confidence is medium-high for the status-only private-DM MVP once ingress and reconciliation are complete. Implementation may resume only by following this current-main port plan; conflicting runtime evidence must stop the port rather than recreate old-base behavior.
