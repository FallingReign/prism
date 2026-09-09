# Internal HTTPS: architecture integration brief

Date: 2026-09-04

Author: independent Architecture Scout. This review changes documentation only; it does not change product code, credentials, or production state.

**Current status:** superseded by the user's no-certificate-installation requirement. The local-CA trial is stopped; neither app's public URL was changed. See the final review and implementation status below before following the original rollout plan.

## Decision and scope

**D1 — Deploy a local HTTPS proxy using the existing application images.** The user has explicitly authorized HTTPS for Prism and Playtest, confirmed that there is no company certificate service, and requested an internal IP address solution. Use a persistent local certificate authority on the Linux VM and distribute only its public root certificate to clients. No public domain, hosted tunnel, or external certificate service is required. Caddy supports private IP certificates and local renewal; each client must trust its root. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

**D2 — Preserve existing Prism clients during migration.** Add HTTPS entry points first and keep the existing HTTP API listener temporarily. Move browser sign-in and Playtest to HTTPS together. Inventory other Prism clients before closing HTTP. This is a staged migration: HTTPS can be working while the residual HTTP exposure remains open and explicitly reported.

**D3 — Keep the HTTPS release separate from local feature changes.** The R2/R3/R5 changes reviewed in `enterprise-slack-reliability-architecture-integration.md` remain local. This brief supersedes that document's earlier R4 discussion-only scope, but does not authorize bundling those feature changes into this deployment. Use the current production image IDs, preserved data, and configuration changes. If an existing image cannot work behind the proxy, report the exact incompatibility and review the smallest required fix before changing the image.

## Verified starting point

The implementation owner inspected the live VM and supplied these facts. The scout inspected current source and the existing `docs/slack/internal-https.md`; runtime behavior takes precedence over local source where versions differ.

| Item | Current state |
| --- | --- |
| VM | `shgsylinux01`, private IP `10.62.240.10` |
| Prism deployment | `/home/shgsylinux01/docker/prism`; clean checkout `88cda8a` |
| Playtest deployment | `/home/shgsylinux01/docker/shg-playtest`; clean checkout `34f4e02` |
| Services | `prism-web-1`, `prism-socket-1`, `prism-postgres-1` (PostgreSQL 17), `shg-playtest` |
| Existing entry points | `http://10.62.240.10:3732` and `http://10.62.240.10:3847`, published on all interfaces |
| Available HTTPS ports | `8443` and `9443`; port `443` also available but unnecessary |
| Host permissions | Docker is available; passwordless sudo is unavailable |
| Slack callback | Explicit `.env.local` override `SLACK_OAUTH_REDIRECT_URI=http://10.62.240.10:3732/v1/slack/oauth/callback` |
| Known Prism client | Playtest; the running-container URL inventory found no other Prism clients, but external clients remain unverified |
| Data | Prism named PostgreSQL volume; Playtest `./data:/app/data` SQLite bind mount |

Do not treat a clean checkout or image tag as proof of the running image. Record container image IDs and labels immediately before changing configuration and verify the same IDs afterward.

## Existing ownership and extension points

| Owner | Existing extension point and migration responsibility |
| --- | --- |
| Deployment proxy | New dedicated deployment directory, proposed `/home/shgsylinux01/docker/internal-https`; terminates TLS and passes requests unchanged to existing HTTP services |
| Prism deployment URLs | `src/server/config.ts`, `getSlackOAuthDeploymentConfig()`; `PRISM_PUBLIC_BASE_URL` and explicit `SLACK_OAUTH_REDIRECT_URI` |
| Slack runtime configuration | `src/server/slack/app-configuration-factory.ts`, `resolveStored()`; combines encrypted database configuration with deployment URLs |
| Slack OAuth transaction | `src/server/slack/oauth-flow.ts`; binds state to the exact callback and active configuration, owns Slack browser cookies |
| Prism OIDC | `src/server/config.ts` and `src/server/oidc/*`; issuer derives from public base URL, Playtest callback is registered explicitly |
| Playtest login | `src/lib/auth/config.ts`, `prism-oidc.ts`, `session.ts`; validates app origin, discovery issuer and endpoints, verifies signed tokens, owns Playtest cookies |
| Playtest account and permissions | `src/lib/auth/users.ts` and SQLite; stable Prism subject resolves existing account and roles |
| Prism delivery authorization | `src/server/delegated-delivery/*`; exact registered callback, client proof, approved sender/workspace/message, expiry and receipt remain authoritative |
| Playtest delegation client | `src/lib/announcements/delegation/config.ts` and `client.ts`; callback derives from app origin, request proof binds the configured Prism URL |
| Playtest background worker | `scripts/announcement-worker.mjs`; default loopback URL `http://127.0.0.1:3847/api/automation/announcements`, authenticated with the existing worker secret |
| Container lifecycle and storage | Both compose files and entrypoint scripts; recreate with unchanged image IDs and persistent volumes, preserve the socket worker and scheduled worker |

**F1 — There is no Slack callback field to rewrite in the database.** Stored Slack configuration versions contain the client ID, encrypted client secret, scopes, and socket configuration. `resolveStored()` combines these with deployment settings. Update both URL environment variables because this VM has an explicit callback override; preserve the active database configuration version and encryption keys. Verify the runtime configuration reports the new callback without printing credentials.

**F2 — HTTPS changes the OIDC issuer.** Playtest checks discovery and signed token issuer exactly. Update Prism and Playtest coherently, restart their existing processes, and perform a fresh sign-in. Preserve signing keys, key IDs, subject identity, and SQLite account data; do not weaken issuer validation or merge accounts to compensate for an incorrect URL.

**F3 — Old transactions do not become new transactions.** Slack OAuth state and delegated approval requests bind their callback. An in-flight transaction started at HTTP may require restart after the cutover. Do not rewrite its callback, bypass state checks, or extend its approval/expiry. Already approved deliveries retain their original sender, workspace, message, receipt, and deadline; verify enabled queues before the cutover and preserve their state.

## Proposed proxy and certificate design

Use a pinned official Caddy image in a separate Compose project, with Linux host networking and explicit IP binding. This permits access to the existing host-published upstream ports without changing application networks. It requires neither privileged mode nor a host `/etc` mount. Persist dedicated `/data` and `/config` storage; mount the Caddyfile read-only. Do not run commands against unrelated containers or volumes.

The following is a reviewable starting configuration. Validate it with the chosen image before applying it:

```caddyfile
{
    admin off
    auto_https disable_redirects
    default_bind 10.62.240.10
    log {
        format filter {
            request>uri delete
            request>headers delete
            resp_headers delete
            wrap json
        }
    }
}

https://10.62.240.10:8443 {
    tls internal
    reverse_proxy 127.0.0.1:3732
}

https://10.62.240.10:9443 {
    tls internal
    reverse_proxy 127.0.0.1:3847
}
```

Disable automatic HTTP redirects to avoid opening an unplanned port 80 listener. Disabling the admin API means configuration changes use a controlled container restart. These options do not disable certificate issuance or renewal. [Caddy global options](https://caddyserver.com/docs/caddyfile/options).

Do not enable access logging, debug logging, or credential logging. The global logger filter also removes request URLs and headers from structured proxy error records, where callback codes, state, authorization headers, and cookies could otherwise appear. Prove this with synthetic canaries, including an upstream failure; inspect the pinned version's output rather than assuming a filter covers every error message. Keep useful status and error information. [Caddy log filtering](https://caddyserver.com/docs/caddyfile/directives/log#filter).

Caddy preserves the incoming Host header and sets forwarded host/protocol headers by default. Keep the external `Host`, `Origin`, paths, and query parameters intact. Do not rewrite Host to the loopback upstream. Do not add a blanket CSP or authentication layer: the applications own browser policy and callback validation. [Caddy reverse proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).

The local certificate must contain IP subject alternative name `10.62.240.10`. Keep the CA signing key private in persistent storage; back it up with restricted access. Export only the public root and its SHA-256 fingerprint. Windows trust installation for the operator's current user proves that user's browser only; other employees and unmanaged tools need their own trust installation. Never distribute a CA private key.

Application containers require their own trust configuration. Mount the public root read-only at a dedicated path, readable by Playtest's non-root process, and set `NODE_EXTRA_CA_CERTS` before process startup. Node 20 reads that PEM file at startup and extends its normal roots. A host or Windows certificate import does not configure the containers. [Node 20 additional CA certificates](https://nodejs.org/docs/latest-v20.x/api/cli.html#node_extra_ca_certsfile).

## URL and trust migration matrix

| Configuration | New value or action |
| --- | --- |
| Prism `PRISM_PUBLIC_BASE_URL` | `https://10.62.240.10:8443` |
| Prism `SLACK_OAUTH_REDIRECT_URI` | `https://10.62.240.10:8443/v1/slack/oauth/callback` |
| Slack Bridge app redirect list | Add that exact HTTPS callback, retaining the current HTTP entry during the rollback period; do not change scopes or reinstall |
| Prism `PRISM_OIDC_PLAYTEST_REDIRECT_URI` | `https://10.62.240.10:9443/api/auth/callback` |
| Prism `PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI` | `https://10.62.240.10:9443/api/announcements/delegation/callback` if currently configured; preserve feature enablement |
| Playtest `APP_BASE_URL` | `https://10.62.240.10:9443` |
| Playtest `PRISM_AUTH_ISSUER` and `PRISM_BASE_URL` | `https://10.62.240.10:8443` |
| Explicit Playtest OIDC authorization/token/JWKS overrides | Inventory and change any old-origin values to the corresponding HTTPS origin, or preserve their existing discovery-driven absence |
| App containers `NODE_EXTRA_CA_CERTS` | Read-only public-root PEM path inside each process that calls the HTTPS service |
| Playtest `ANNOUNCEMENT_AUTOMATION_INTERNAL_URL` | Preserve default loopback HTTP; investigate any explicit external override before changing it |
| HTTP opt-ins | Remove Playtest private-HTTP opt-ins once all its public URLs are HTTPS; remove Prism OIDC/delegated private-HTTP opt-ins once their configured URLs are HTTPS and verified. Do not remove unrelated client settings blindly |

Slack requires HTTPS for redirect URLs and binds the OAuth exchange to the callback supplied during authorization. A user's browser follows the redirect and must have internal network access and certificate trust. This does not make the service reachable for Slack server-initiated webhooks; those are a separate capability. [Slack OAuth requirements](https://docs.slack.dev/authentication/installing-with-oauth/).

## Do-not-bypass rules

- **I1 — Preserve authorization:** no global Slack scope change, token-profile expansion, shared Playtest token, automatic reinstall, membership change, sender fallback, or role change. Prism continues to own Slack credentials/grants; Playtest continues to own immutable announcement targets and account permissions.
- **I2 — Preserve secrets and data:** retain all Slack encryption keys, OIDC signing keys, token peppers, delegation keys, client IDs, active configuration versions, PostgreSQL data, SQLite data, and worker secrets. Do not print secret-bearing environment files or unredacted database rows.
- **I3 — Preserve validation:** no certificate-verification bypass, `NODE_TLS_REJECT_UNAUTHORIZED=0`, issuer relaxation, wildcard OAuth callback, transaction rewrite, or extended approval lifetime.
- **I4 — Preserve proxy boundaries:** do not enable application trust of arbitrary proxy headers as a shortcut. HTTPS does not require changing existing trust flags. Caddy should overwrite forwarding headers and the eventual backend restriction should prevent bypass.
- **I5 — Preserve deployment scope:** no `down -v`, volume deletion, database reset, application build from dirty local trees, unrequested image pull, or Jira credential replacement during this HTTPS rollout.
- **I6 — Preserve delivery state:** do not retry an uncertain delivery merely because a URL changed. Reuse existing delivery/grant/receipt identity; examine current queues before a restart.

## Safe rollout

1. **A1 — Record and preserve the current state.** Capture image IDs, revision labels, container health, compose configuration paths, volume names, active Slack configuration version, and enabled worker/queue status. Store restricted backups of deployment configuration and keys without displaying contents. Take a consistent PostgreSQL backup and a SQLite online backup or stopped-writer copy; copying only a live SQLite main file is insufficient when WAL contains changes. Record counts and file checksums appropriate to the backup method.
2. **A2 — Start the proxy beside the current apps.** Validate the Caddy configuration using the pinned image, create only its dedicated storage, and start it. Verify both HTTPS health endpoints with the public CA explicitly supplied. Confirm the certificate IP SAN, issuer, expiry, persistent root fingerprint, exact listeners, and healthy upstreams. Existing HTTP service behavior remains available during this stage.
3. **A3 — Establish trust before changing sign-in.** Install the public root into the operator's current-user Windows trust store and the actual app containers. Verify a normal browser request and Node fetch without an insecure override. Prepare a concise root-certificate installation handoff and fingerprint for other users. Do not describe one account's trust as company-wide deployment.
4. **A4 — Register the callback and switch URLs together.** Add the exact HTTPS Slack Bridge callback, preserving its existing callback for rollback. Pause new sign-in/approval attempts briefly if needed; allow users to restart old attempts. Apply only the URL/CA-mount/CA-env changes, recreate the relevant application containers with the same image IDs and no build, and keep all stateful volumes. Include the Prism socket container if its shared deployment environment changes. Leave the loopback Playtest worker endpoint intact.
5. **A5 — Verify real sign-in and service behavior.** Run the regression checklist below, including a fresh browser sign-in through the real Slack callback where the account is available. Verify recorded image IDs, account/role continuity, configuration version, and queue state after restart. If a source compatibility defect emerges, stop the cutover or roll back; do not silently deploy all local feature work.
6. **A6 — Migrate remaining clients, then close direct HTTP.** Keep legacy opaque-token APIs reachable during the inventory period; no promise is made that old-origin OIDC or DPoP clients survive an issuer change without configuration updates. Update each client base URL and CA trust explicitly. Do not rely on an HTTP redirect to preserve authorization headers or signed request proofs. Once clients are accounted for, bind application ports to loopback through their compose configuration or an approved equivalent and verify HTTPS still reaches them. Remove obsolete callback entries and compatibility settings only after the rollback window and client checks.

The runtime inventory finding only Playtest is insufficient evidence that no desktop/helper/MCP client uses Prism. Temporary HTTP compatibility preserves those callers but remains a recorded risk. Keep normal API authentication and narrow tokens unchanged throughout.

## Regression and acceptance checklist

| Gate | Required evidence |
| --- | --- |
| T1 — TLS and trust | Normal browser and actual Node-container requests to both HTTPS health endpoints succeed with verification enabled; untrusted clean client fails until the public root is installed; IP SAN and expiry correct |
| T2 — Proxy boundaries | Only intended IP/ports opened; Caddy admin API unavailable; public Host/protocol preserved; no unplanned port 80 listener or broad CSP; synthetic callback/header canaries absent from normal and upstream-error logs |
| T3 — Identity contract | HTTPS discovery issuer/endpoints, exact Slack callback and Playtest callback, unchanged client IDs/signing keys/config version; actual Secure, HttpOnly, SameSite cookie attributes after fresh sign-in |
| T4 — Browser flow | Fresh Slack-to-Prism-to-Playtest sign-in reaches the configured HTTPS origin; cancellation and stale HTTP transaction recover without an open redirect, repeated loop, or leaked provider data |
| T5 — Data and permissions | Existing user resolves to the same account and roles; current workspace/channel targets retained; user can see the expected permitted workspace without a broader token or membership change |
| T6 — Delivery continuity | Existing enabled worker still reaches its loopback endpoint; real HTTPS Prism requests verify the CA; pending/approved/scheduled jobs retain identifiers and deadlines. A live Slack announcement requires the separately authorized test context; do not create an unrequested post merely to test TLS |
| T7 — Client compatibility | Known Playtest client migrated; explicit inventory/status for other callers; no automatic HTTP-to-HTTPS credential redirect assumption |
| T8 — Restart and rollback | Same application image IDs, stable CA root across proxy restart, unchanged persistent data, healthy web/socket/worker processes, saved configuration rollback ready |

Browser sign-in acceptance and complete Enterprise acceptance are different checks. The wider task still needs the agreed non-collaborator account, expected workspace visibility, and authorized test announcement with the necessary Playtest role. HTTPS alone does not grant Slack workspace access or Playtest permissions.

## Rollback

Restore the saved application URL and certificate-mount configuration and recreate the same images without a build. Preserve the old Slack redirect registration until the rollback period ends. Restore the original HTTP port bindings if they were changed. Retain CA storage and backups, and do not replace PostgreSQL/SQLite with old copies merely to undo URL settings: that would discard legitimate writes. Only a separate confirmed data recovery need justifies a database restore.

A rollback is an explicit return to HTTP and must be reported. Transactions and sessions started against the HTTPS issuer may require fresh sign-in after rollback. Do not attempt to make both issuers valid or replay an old callback automatically. Check worker and delivery state before allowing retries.

## Risks and decision confidence

- **R4a — Trust distribution:** no company CA exists. Local root installation is required for every browser/client. High confidence in the mechanism; complete employee coverage remains unverified until each relevant client is covered.
- **R4b — Remaining HTTP clients:** external Prism consumers are not fully inventoried. Preserve the listener temporarily and report the remaining exposure; close it only after migration evidence. High confidence that keeping an opaque-token endpoint available preserves its transport path; medium confidence in overall compatibility until caller types are known.
- **R4c — Deployed version compatibility:** current source includes local reliability changes absent from the deployed images. Verify the actual images behind the proxy; confidence is high for configuration ownership but medium for full browser acceptance until live checks pass.
- **R4d — CA durability:** deleting Caddy data would replace the authority and break client trust. Persist and protect it, verify fingerprint after restart, and include it in restricted recovery backups.
- **R4e — In-flight authorization:** exact callback and issuer changes intentionally reject stale transactions. Drain or restart attempts; preserve approved delivery state. Do not weaken validation to conceal migration errors.

**Architecture disposition:** ready for the bounded HTTPS configuration implementation and staged rollout above. Trust and live acceptance are deployment gates, not reasons to request authorization again. This brief is not deployment evidence; the implementer must record actual results and an independent review must inspect the final configuration and preservation checks.

## Independent configuration review and changed user requirement

**RV1 — Configuration preservation reviewed; local-CA cutover stopped.** After proxy preparation, the user declined certificate installation and clarified that users must not have to install certificates. This supersedes D1's local-root distribution assumption. The local-CA approach does not meet that requirement; do not retry the certificate import or switch application origins to it. The implementation owner reports that the Windows import was canceled and the main application origins remain HTTP. The HTTPS Slack callback was added for preparation, but its saved state was still awaiting reload verification at this review point.

The independent review inspected `ops/internal-https/Caddyfile`, `compose.yaml`, `prism.override.yaml`, and `playtest.override.yaml` against the existing application compose files:

- **RV1a — Proxy boundary:** the official Caddy 2.11.4 image is pinned to digest `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648`. The container runs as UID/GID 1001, uses a read-only root filesystem, drops capabilities with only `NET_BIND_SERVICE` retained for the official binary, and enables `no-new-privileges`. Dedicated data/config mounts persist its CA. Host networking plus explicit `default_bind 10.62.240.10` limits configured HTTPS listeners to the intended private IP; the Caddy admin API and automatic HTTP redirects are disabled.
- **RV1b — Application preservation:** the two override files add only `NODE_EXTRA_CA_CERTS` and a read-only public-root mount to Prism web/socket and Playtest. They do not replace existing data/config mounts, change image tags, alter application URLs, remove HTTP ports, or change credentials/scopes. The overrides require the expected original Compose project/directory and explicit no-build deployment to preserve the intended image and relative volume resolution.
- **RV1c — Evidence limits:** the implementation owner reports TLS 1.3, the correct IP SAN, health HTTP 200, and successful verified Node fetches from one-off containers using the actual application images. These support the proxy/container trust path only. Browser trust, origin cutover, fresh HTTPS sign-in, and complete client migration were not completed. A planned isolated proxy-error logging canary was canceled before any test container was created; the global filter is present but its runtime coverage remains unverified. Only the identical pinned image was downloaded into the reviewer's local Docker for that canceled test.

**Current disposition:** no substantive preservation defect found in the reviewed configuration. The staged local-CA proxy is not an accepted final deployment because certificate installation conflicts with the clarified user requirement. The implementation owner is evaluating a browser-trusted certificate using an owned hostname and DNS validation while keeping network access internal. That option requires a revised architecture decision and evidence of hostname/certificate control; do not describe raw private-IP HTTPS with an untrusted local certificate as satisfying the requirement. No product or production state was modified by this independent review.

### Implementation owner: final trial state

The Caddy container is stopped and neither 8443 nor 9443 is listening. Both application's original environment files match their pre-trial backups, and the original containers retain their image IDs and start times. Both HTTP health endpoints return 200 and Prism's socket remains connected. The public-root overrides were renamed to `docker-compose.https-staged.yml`, outside automatic Compose loading. Slack Bridge's temporary HTTPS callback was removed; a reloaded Slack settings page shows only the original HTTP callback. Windows CurrentUser root-store inspection confirms zero entries for the trial authority. Restricted backups and inactive trial files remain available; no data restore was performed.
