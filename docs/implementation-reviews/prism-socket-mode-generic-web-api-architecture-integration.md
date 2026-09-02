# Prism Socket Mode and Full Web API architecture integration

Date: 2026-09-02  
Status: Architecture gate brief; no product code changed by this review  
Prism evidence commit: `340fb365e05d9f2768b25165e6739474377b4395`  
Remote Codex evidence commit: `74871b43fa28f31639cef46d3da79d6e9a923505`

## Outcome

Implement this as two generic Prism capabilities and one Remote Codex use of those capabilities:

- **D1 — Full Web API:** keep Prism's existing fixed Slack destination, credential custody, workspace checks, Token profiles, rate limits, and metadata-only audit. Add an explicit **Full Web API** Token profile mode that forwards any syntactically valid Slack Web API method. Do not broaden existing Token profiles.
- **D2 — Prism Inbox:** add a separate Socket worker that receives Slack Socket Mode envelopes and places authorized, short-lived deliveries into a generic **Prism Inbox**. Local applications read the Prism Inbox over authenticated HTTP; they do not connect to Slack and do not expose callbacks.
- **D3 — Remote Codex dropdown:** Remote Codex posts a Block Kit project dropdown and consumes its `block_actions` delivery from the Prism Inbox. Its current Slack message polling remains in place for top-level messages and task replies during this slice.

This keeps Prism a Slack bridge. Prism gains generic delivery state, not Codex task, project, prompt, or session state.

## Evidence inspected

### Current code and tests

- Prism dynamic Slack route: `app/v1/slack/api/[method]/route.ts`
- Prism method policy and forwarding: `src/server/slack/method-registry.ts`, `src/server/token-profiles/method-policy.ts`, `src/server/slack/forwarding.ts`, `src/server/slack/web-api-client.ts`
- Token profile and global policy ownership: `src/server/token-profiles/presets.ts`, `src/server/token-profiles/service.ts`, `src/server/token-profiles/global-policy.ts`, `src/server/token-profiles/store.ts`
- Local application authorization: `src/server/local-app-authorization/*`, migration `0023_generic_local_app_device_authorization.sql`
- Slack app configuration and OAuth scope catalog: `src/server/slack/app-configuration.ts`, `src/server/slack/oauth-*`, `docs/slack/*`
- Deployment: `Dockerfile`, `docker-compose.yml`, `scripts/docker-entrypoint.mjs`
- Remote Codex Slack transport and project flow: `src-tauri/src/prism_client.rs`, `src-tauri/src/controller.rs`, `src-tauri/src/local_store.rs`
- Both repositories' current tests and architecture documentation.

### Runtime evidence

- `GET http://10.62.240.10:3732/v1/prism/health` returned HTTP `200` with `{"service":"ok","database":"ok"}` on 2026-09-02.
- SSH authentication to `work-vm` was unavailable in this review environment, so the running container configuration and Slack App Management settings were not inspected.
- Prism source contains no Slack event, interaction, or slash-command HTTP ingress route. There is therefore no repository-supported Slack callback behavior to preserve today.

### Current Slack platform contract

- Slack Web API methods use the fixed `https://slack.com/api/METHOD_FAMILY.method` form: <https://docs.slack.dev/apis/web-api/>.
- Socket Mode carries Events API and interactive payloads without a public Request URL. While Socket Mode is enabled, the same Slack app receives those payloads over Socket Mode, not its Slack callback URL: <https://docs.slack.dev/apis/events-api/using-socket-mode/>.
- Slack recommends its Socket Mode SDK for connection lifecycle and acknowledgements. `@slack/socket-mode` exposes an `interactive` listener and `ack`: <https://docs.slack.dev/tools/node-slack-sdk/socket-mode/>.
- A Block Kit `static_select` supports up to 100 options; `action_id` is limited to 255 characters: <https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/>.
- Option text is limited to 75 characters and option values to 150 characters: <https://docs.slack.dev/reference/block-kit/composition-objects/option-object>.
- `chat.postMessage` must not combine `markdown_text` with `blocks`; use `text` as the accessible fallback when blocks are present: <https://docs.slack.dev/reference/methods/chat.postmessage>.

## Findings

### F1 — The outbound route is already generic at the HTTP boundary

`/v1/slack/api/[method]` already accepts a method segment and `FetchSlackWebApiClient` already constructs a fixed `https://slack.com/api/{method}` destination. The manually maintained `supportedRegistry` is the feature restriction. The correct extension is in Token profile policy, not a new route per method.

### F2 — Prism already owns the controls that must remain in front of every method

The current route resolves a Prism developer token, verifies the exact Slack connection and workspace grant, chooses a user or bot execution identity, applies a per-Token-profile/per-method rate limit, strips a caller-supplied Slack token, retrieves the server-held Slack credential, and writes metadata-only audit. Full Web API must pass through this same path.

### F3 — Existing Token profiles cannot be silently reinterpreted

The current `full_slack_bridge` preset means the curated v1 method registry. Changing its meaning to every Slack method would silently broaden active tokens and bypass the existing token-rotation rule. Full Web API must be a new explicit mode and preset.

### F4 — Generic forwarding does not grant Slack permission

Slack has no wildcard OAuth scope. Full Web API can forward every Web API method, but Slack will still return `missing_scope`, `not_allowed_token_type`, or other normal Slack errors when the stored user or bot token lacks permission. Admin, Audit Logs, SCIM, binary download, and non-Web-API surfaces are separate products or transports and are not made available by a generic `/api/{method}` route.

### F5 — The current Slack app configuration is also an allowlist

`SLACK_SCOPE_CATALOG` only accepts the current curated user and bot scopes. Supporting future approved scopes without a Prism release requires a validated additional-scope field in Slack app configuration. Slack administration still has to add those scopes to the Slack app and users must reauthorize.

### F6 — Socket Mode needs a long-running worker

The Next.js request process is not the owner of a persistent connection. Socket Mode reconnects and periodically refreshes its WebSocket URL. A separate worker process using the official `@slack/socket-mode` package is the matching deployment unit.

### F7 — Socket Mode and Slack callback delivery are mutually exclusive for one Slack app

Enabling Socket Mode does not disable Prism's HTTP API, OAuth routes, website, or applications calling Prism over HTTP. It does stop Slack from sending Events API and interactive payloads to the callback URL configured for that same Slack app. Slack retains the callback setting for use if Socket Mode is disabled later.

### F8 — Remote Codex is currently pull-based and must remain locally owned

Remote Codex polls `conversations.history` and `conversations.replies`, stores Slack-to-Codex bindings and project choices in local SQLite, and uses a `messages_only` user-backed Token profile. Prism must not learn local project paths, prompts, Codex task IDs, or project-selection state.

### F9 — A dropdown click is not a Slack thread reply

The current project flow only observes message replies. A `static_select` generates a `block_actions` payload, so Remote Codex needs an inbound delivery path in addition to its existing message polling. The Prism Inbox provides this without making the local computer publicly reachable.

### F10 — The current project count already fits Block Kit

Remote Codex limits project choices to ten. This is safely below Slack's 100-option static-select limit.

## Existing ownership

| Owner | Keeps ownership of |
|---|---|
| Slack administration | Slack app features, Socket Mode toggle, app-level token, OAuth scopes, event subscriptions, workspace or organization approval |
| Prism Slack app configuration | Slack client credentials, approved user/bot scopes, encrypted app-level token, Socket Mode enablement |
| Prism Token profile | One local application's outbound method mode, inbound capability, workspace boundary, execution identity, expiry, rotation, and revocation |
| Prism outbound bridge | Method validation, Prism authentication, workspace grants, execution identity, Slack credential custody, rate limits, Slack call, metadata-only audit |
| Prism Socket worker | Socket connection lifecycle, envelope acknowledgement, envelope deduplication, generic route matching, and Prism Inbox insertion |
| Prism Inbox | Short-lived generic delivery state, lease, retry, acknowledgement, expiry, and isolation by Token profile |
| Remote Codex | Projects, option-to-project mapping, prompt, Codex task, Slack binding, local idempotency, and selection outcome |

## Interaction model

```text
Remote Codex
  | 1. authenticated HTTP: register a short-lived block-action Route
  v
Prism Route + Token profile
  | 2. authenticated HTTP: chat.postMessage with Block Kit dropdown
  v
Slack thread
  | 3. user selects a project
  v
Slack Socket Mode
  | 4. envelope
  v
Prism Socket worker
  | 5. validate Route, identity, workspace, channel; persist delivery; ACK Slack
  v
Prism Inbox
  | 6. authenticated HTTP long poll
  v
Remote Codex
  | 7. local idempotency and option mapping; start task once; ACK delivery
  v
Existing Remote Codex task path
```

The Slack acknowledgement confirms only that Prism durably accepted the envelope. It does not claim that the local application completed the action.

## Required architecture decisions

### D4 — Keep Standard and Full Web API separate

Add an explicit `full_web_api` preset and an explicit outbound mode:

```ts
webApi: { mode: "curated" | "all_methods" }
```

- Every existing Token profile migrates to `curated` with unchanged behavior.
- Existing `full_slack_bridge` remains `curated`.
- Only `full_web_api` uses `all_methods`.
- `curated -> all_methods` is a capability broadening and requires Prism developer-token rotation.
- `all_methods -> curated` narrows immediately.
- Full Web API is never the default local-application authorization profile.

The Capability map and Global Token profile policy need a schema/version migration so this mode is represented, validated, displayed, and compared. Do not infer it only from the preset name because the current broadening comparison only examines capability fields.

### D5 — Full Web API still uses a fixed origin

Accept only one route segment matching a Slack method grammar such as:

```text
^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$
```

Reject slashes, backslashes, percent-encoded separators, URL schemes, query fragments, control characters, and overlong names before policy or upstream work. Always build the destination from the fixed `https://slack.com/api` base. Never accept an arbitrary URL, host, protocol, or caller-supplied Slack `Authorization` header.

### D6 — Full Web API bypasses enumeration, not Prism controls

For `webApi.mode === "all_methods"`:

1. Validate the method grammar.
2. Resolve the Prism developer token.
3. Require the exact `X-Prism-Workspace-ID` and verify the workspace or organization grant.
4. Resolve the configured execution identity.
5. Apply the existing per-method rate limiter.
6. Parse GET query, JSON POST, or form POST using the current bounded path.
7. Strip `token` and all Prism headers from the upstream request.
8. Call the fixed Slack Web API origin with the server-held user or bot token.
9. Return Slack's body/status and selected retry/request headers unchanged where practical.
10. Record method, workspace, profile, status, and request ID only; never payload content.

Standard profiles continue to use `classifySlackMethod`. Full Web API should use one generic audit category such as `web_api.full`; the exact Slack method remains in `slack_method`.

### D7 — Scope configuration is separate from method forwarding

Preserve the typed scope catalog for the normal setup experience. Add an administrator-only `additionalBotScopes` and `additionalUserScopes` list to the versioned Slack app configuration:

- Validate each value with a narrow Slack scope-name grammar and length limit.
- Canonicalize, deduplicate, and sort before storage and OAuth construction.
- Display additional scopes as unlabelled advanced scopes with an explicit warning.
- Never treat an additional scope as proof that a Slack method will work.
- Reauthorization remains required after Slack scope changes.

Do not scrape Slack documentation at runtime and do not create an automatic "all scopes" action.

### D8 — Add an explicit inbound capability

Token profile policy must distinguish outbound Slack calls from inbound Slack delivery. Add:

```ts
inbound: {
  blockActions: boolean;
  events: boolean;
  slashCommands: boolean;
}
```

All existing Token profiles migrate to `false` for all inbound fields. Remote Codex requests `blockActions: true` during generic local-app authorization and the approval page states that it can receive clicks from controls it posts. This broadening requires a new Prism developer token for an already paired installation.

Full Web API does not automatically enable inbound delivery.

### D9 — Use a separate Socket worker

Add a dedicated worker entrypoint using the current Node 20 runtime and the official `@slack/socket-mode` package version compatible with Node 20. The worker:

- loads the active Slack app configuration;
- decrypts the app-level `xapp-` token server-side;
- obtains and refreshes Socket Mode connections through the SDK;
- handles `interactive`, `events_api`, and `slash_commands` envelopes through one generic ingress service;
- never logs envelope bodies or the WebSocket URL;
- writes a connection heartbeat and last error class for health diagnostics;
- uses a Postgres advisory lock keyed by Slack app configuration so accidental duplicate workers do not become competing active owners;
- relies on a unique envelope-delivery constraint as the final duplicate guard.

The app-level token belongs in encrypted, versioned Slack app configuration. It must not be stored in per-user `slack_credentials`, returned by an API, or made available to Full Web API callers. An environment value may remain a bootstrap fallback, but the normal configured state should use the existing encrypted Slack app configuration system.

### D10 — Deploy the worker independently of the web server

Add a `socket` service to `docker-compose.yml` using the same built image. It waits for the web service health check so migrations have completed, then runs the Socket worker. `restart: unless-stopped` remains appropriate.

Do not run the worker from a Next.js route, module import, or React/Next instrumentation hook. Do not make the web container unhealthy when Socket Mode is intentionally disabled. When Socket Mode is enabled, health must show the Socket worker state without removing the existing `service` and `database` fields used by current callers.

### D11 — Use a generic Route and Prism Inbox

Use these canonical words:

- **Route:** an authorized, short-lived inbound filter owned by one Token profile.
- **Delivery:** one Slack envelope projected to one Route.
- **Prism Inbox:** authenticated HTTP access to pending Deliveries.

A Route contains only generic Slack routing constraints:

- Token profile and Slack connection IDs derived from the bearer token;
- workspace ID and optional channel ID;
- allowed Slack envelope type and interaction action kind;
- exact paired Slack user when the Route is user-owned;
- random opaque public route key;
- status and expiry.

A Route never contains a project path, project name mapping, Codex task ID, prompt, or Remote Codex state.

Recommended endpoints:

```text
POST   /v1/prism/slack/inbound-routes
DELETE /v1/prism/slack/inbound-routes/{routeId}
GET    /v1/prism/slack/inbox?wait=25&limit=10
POST   /v1/prism/slack/inbox/{deliveryId}/ack
```

Every endpoint resolves the existing Prism developer token and Token profile, returns `Cache-Control: no-store`, emits `X-Prism-Request-ID`, and never returns another Token profile's Route or Delivery.

`GET /inbox` should lease a Delivery before returning it. An unacknowledged lease becomes available again. `ack` is idempotent. Keep the local application responsible for its own idempotency before applying an action.

### D12 — Persist before acknowledging Slack

For a matched envelope:

1. Validate the Socket envelope shape and configured `api_app_id`.
2. Extract the opaque Route key from the action identifier.
3. Load the active Route and verify Token profile, Slack connection, workspace, channel, Slack user, envelope type, and action type.
4. Insert the Delivery transactionally with a unique `(envelope_id, route_id)` key.
5. Acknowledge Slack only after the insert commits.

If the insert fails, do not acknowledge; allow Slack to retry. Duplicate inserts are success and can be acknowledged. Unmatched or expired Routes are acknowledged and discarded with metadata-only diagnostics so Slack does not retry an action Prism will never deliver.

### D13 — Minimize inbound payload storage

For `block_actions`, store only the fields a generic local application needs:

- delivery/envelope ID and received time;
- payload type and `api_app_id`;
- team/enterprise, user, channel, container/message timestamps;
- block ID, action ID, action type, and selected option value;
- Route ID and lease/ack/expiry state.

Do not store `response_url`, trigger tokens, the complete message, option display text, message text, state from unrelated controls, or the raw envelope.

Future Events API payload support must add an explicit normalizer per approved event family or use separately approved encrypted short-retention payload storage. "Generic ingestion" does not authorize plaintext storage of arbitrary Slack content.

Recommended default retention is 24 hours for pending Deliveries and immediate payload removal on acknowledgement, retaining only metadata needed for duplicate protection and audit.

### D14 — Keep Remote Codex message polling during this slice

Do not migrate `conversations.history` or `conversations.replies` to Events API yet. Existing polling is the known recovery path and keeps Slack messages available when the local application is offline. The Socket worker can support `events_api` envelopes generically, but the Slack app should initially enable only Interactivity for the Remote Codex dropdown.

This avoids two simultaneous sources for the same message and prevents duplicate Codex turns.

### D15 — Use one short-lived Route per pending project choice

Remote Codex should:

1. Generate random opaque option IDs locally and store `option ID -> local project` in `ProjectSelectionFlow`.
2. Register a Route for exact workspace, channel, paired Slack user, and `block_actions`, with a bounded expiry.
3. Store the Route and option map locally before posting the picker.
4. Post one Block Kit message in the original Slack thread.
5. Continue accepting a typed project name or number as a fallback.
6. Read the Prism Inbox and validate Route, workspace, channel, user, root message, picker message, action ID, and selected option ID.
7. Claim the Delivery locally before starting the task.
8. Use the existing `start_selected_task` path so task ownership, binding, and prompt behavior do not fork.
9. Update the picker with `chat.update` to show the selected project and remove the dropdown.
10. Acknowledge the Delivery and delete the Route after the local binding is durable.

The Block Kit message uses `text` as the complete accessible fallback. It must not include `markdown_text` because Slack rejects `markdown_text` combined with `blocks`.

Recommended shape:

```json
{
  "channel": "C...",
  "thread_ts": "...",
  "text": "Codex: Choose a project for this task. You can also reply with the project name or number.",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Codex*\nChoose a project for this task" },
      "accessory": {
        "type": "static_select",
        "action_id": "prism.route.<opaque-route-key>",
        "placeholder": { "type": "plain_text", "text": "Choose a project" },
        "options": [
          { "text": { "type": "plain_text", "text": "remote-codex" }, "value": "<opaque-option-id>" }
        ]
      }
    }
  ]
}
```

No local path is sent as an option value. Project labels remain visible because the user must choose between them and they are already visible in the current list.

## Extension points

| Change | Extend here | Preserve |
|---|---|---|
| Full Web API method decision | `method-policy.ts` and Capability map | Token resolution, workspace grants, identity resolution |
| Generic method upstream call | `forwarding.ts` and `web-api-client.ts` | Fixed origin, token stripping, rate limits, response adapter, audit |
| Full Web API profile | `presets.ts`, global policy, service/store, UI, migrations | explicit broadening rotation and expiry |
| Additional Slack scopes | `app-configuration.ts`, app configuration store/UI, OAuth construction | versioned encrypted configuration and admin ownership |
| Socket credentials | Slack app configuration factory/store | do not use per-user Slack credential rows |
| Socket lifecycle | new worker and generic ingress service | web server and existing HTTP routes remain independent |
| Route and Delivery persistence | new Postgres migration and service/store | database transactions, bounded cleanup, metadata-only audit |
| Prism Inbox HTTP | new `/v1/prism/slack/*` routes | bearer-token resolver, no-store responses, request IDs |
| Remote Codex Block Kit | `prism_client.rs` | Prism developer token and custom workspace/surface headers |
| Remote Codex selection | `controller.rs`, `local_store.rs` | local project/task ownership and one-start idempotency |

## Systems that must not be bypassed

- **B1:** Do not let Full Web API skip the Token profile, global policy, workspace grant, execution identity, rate limiter, credential provider, response adapter, or audit path.
- **B2:** Do not forward a caller-supplied Slack token, Prism header, arbitrary `Authorization`, URL, host, protocol, redirect, or multipart stream.
- **B3:** Do not put the Socket app-level token in a Prism developer token, local application, per-user Slack credential, response, log, or audit row.
- **B4:** Do not use delegated Slack delivery for inbound events. That subsystem authorizes an application request to send a message; it has different ownership and proof semantics.
- **B5:** Do not put Remote Codex state in Prism. Route and Delivery state must remain generic.
- **B6:** Do not let one Token profile receive another Token profile's Delivery, including profiles owned by the same Prism user.
- **B7:** Do not acknowledge a matched Slack envelope before durable insertion.
- **B8:** Do not enable Events API message subscriptions for Remote Codex while its polling path is active.
- **B9:** Do not replace existing Prism HTTP APIs or require local applications to open a listener or WebSocket.
- **B10:** Do not broaden an existing token in place. Capability broadening still requires rotation and clear user approval.

## Compatibility findings

### Prism HTTP compatibility

- Existing local-application authorization, status, capabilities, Slack Web API forwarding, OAuth, website, OIDC, delegated delivery, and admin HTTP routes are independent of Slack's inbound transport and should remain unchanged.
- Keep all existing route paths, headers, response bodies, request IDs, and health fields.
- Standard Token profiles continue receiving `method_not_supported` for methods outside the curated registry.
- Existing Remote Codex polling remains valid after Socket Mode is enabled because it is Remote Codex calling Prism over HTTP, then Prism calling Slack's Web API over HTTP.

### Slack callback compatibility

- The same Slack app cannot receive Events API or interactive payloads through both Socket Mode and a Slack HTTP Request URL at the same time.
- Enabling Socket Mode sends those payloads only over the Socket Mode connection.
- The callback URL remains saved in Slack and becomes active again if Socket Mode is disabled.
- Current Prism code has no callback ingress route, so this change does not remove a working Prism callback path visible in the repository.
- An application using Prism's HTTP API continues to work. An unrelated application using a different Slack app is unaffected. An undocumented application relying on the same Prism Slack app's callback URL would be affected and must be identified in Slack App Management before the toggle.

### Full Web API compatibility

- Current curated behavior remains the default.
- Existing active `full_slack_bridge` profiles remain curated.
- `full_web_api` is opt-in and should default to a destructive-capable expiry no longer than 30 days under the current global policy.
- A Slack `missing_scope` response is a normal Full Web API outcome, not a Prism forwarding defect.
- `files.getUploadURLExternal` and `files.completeUploadExternal` can pass through as ordinary Web API calls. Uploading bytes to Slack's returned upload URL is a separate operation. Authenticated file downloads, SCIM, Audit Logs, and non-Web-API arbitrary URLs remain outside this route.

## Integration plan

### A1 — Capability and policy migration

1. Add Capability map fields for `webApi.mode` and inbound capabilities.
2. Add the `full_web_api` preset.
3. Migrate every stored Capability map to `curated` plus all inbound fields `false`.
4. Migrate the Global Token profile policy and database preset constraint.
5. Update broadening/narrowing comparison and rotation behavior.
6. Update capability discovery and the Token profile UI.

### A2 — Full Web API forwarding

1. Add method grammar validation.
2. Branch policy by `webApi.mode` while reusing the current route and forwarding service.
3. Require an explicit workspace for Full Web API.
4. Keep fixed-origin construction, payload parsing, token stripping, identity, rate limiting, response forwarding, and audit.
5. Extend Slack app configuration with validated additional scopes.

### A3 — Socket Mode platform

1. Extend encrypted Slack app configuration with Socket Mode enablement and app-level token.
2. Add Route, Delivery, and worker-health migrations/stores.
3. Add a generic envelope normalizer and dispatcher.
4. Add the separate Socket worker using `@slack/socket-mode`.
5. Add the Prism Inbox HTTP routes.
6. Add bounded cleanup and optional Postgres notification for low-latency long polling.
7. Add the worker service to Docker Compose and preserve web-only health behavior when disabled.

### A4 — Remote Codex dropdown

1. Add Prism Inbox and Route methods to `PairingManager`.
2. Extend local project-flow state with Route ID, picker timestamp, expiry, and opaque option mapping.
3. Post the accessible Block Kit dropdown once.
4. Consume `block_actions` Deliveries and reuse `start_selected_task`.
5. Remove the picker controls after selection.
6. Preserve typed selection and existing Slack message polling as fallback.
7. Require re-pairing or an explicit token rotation to obtain `inbound.blockActions`.

### A5 — Documentation and operator setup

Update Prism `README.md`, `CONTEXT.md`, `PRODUCT.md`, `DESIGN.md`, `docs/security.md`, `docs/setup.md`, `docs/slack/*`, `.env.example`, and API reference. Update Remote Codex `README.md` and `docs/architecture.md`.

Slack administrator steps:

1. Create an app-level token with `connections:write`.
2. Add it to Prism's active Slack app configuration.
3. Enable Interactivity.
4. Enable Socket Mode only after the deployed worker reports ready.
5. Add approved OAuth scopes separately; reinstall or reauthorize affected workspace/organization installations.
6. Do not enable Remote Codex message event subscriptions in this slice.

## TDD plan

### Prism outbound tests

- **T1:** Method validator accepts representative multi-family methods and rejects URL/path/control injection before upstream.
- **T2:** A Standard Token profile still allows and denies the exact existing curated methods.
- **T3:** A Full Web API profile forwards representative currently unknown methods such as `auth.test` and `team.info` without adding them to the method registry.
- **T4:** Full Web API still requires the correct workspace, execution identity, active token, and Slack connection.
- **T5:** Caller `token`, `Authorization`, Prism headers, payload text, blocks, credentials, and app-level token never appear in audit or logs.
- **T6:** Per-method Prism rate limits and Slack 429 forwarding still work for unknown methods.
- **T7:** Migration leaves every existing profile curated and requires token rotation to move to Full Web API.
- **T8:** Additional scopes are strictly validated, canonicalized, stored encrypted with the app configuration, and included in OAuth only when approved.

### Prism Socket worker and Inbox tests

- **T9:** A valid `block_actions` envelope for an active Route inserts one normalized Delivery, then acknowledges Slack.
- **T10:** A duplicate envelope inserts no second Delivery and is acknowledged.
- **T11:** A database failure prevents acknowledgement so Slack can retry.
- **T12:** Wrong app, workspace, channel, user, action type, Route, expired Route, revoked profile, and disabled inbound capability never produce a Delivery.
- **T13:** Unmatched/expired actions are acknowledged and discarded without payload logging.
- **T14:** Inbox authentication, Token profile isolation, lease retry, idempotent acknowledgement, expiry, and cleanup work.
- **T15:** Socket reconnect, refresh request, worker advisory lock, graceful shutdown, and health heartbeat work under mocked SDK events.
- **T16:** Existing health clients still receive `service` and `database`; Socket status is additive.
- **T17:** Existing Prism route-surface and documentation guards include the new routes and do not weaken prior routes.

### Remote Codex tests

- **T18:** The picker body has one accessible `text` fallback, one `static_select`, at most ten options, and no `markdown_text` conflict.
- **T19:** Action and option values contain no local path, developer token, prompt, project mapping, Slack credential, or Codex task ID.
- **T20:** A valid Delivery starts the original prompt in the selected local project exactly once through the existing task-start path.
- **T21:** Duplicate, wrong-user, wrong-workspace, wrong-channel, wrong-root, wrong-picker, wrong-Route, expired, and unknown-option Deliveries do not start a task.
- **T22:** A typed name or number still selects a project.
- **T23:** Restart recovers the local flow and pending Inbox Delivery without reposting the picker.
- **T24:** Successful selection removes the dropdown and leaves a readable selected-project result.
- **T25:** Progress projection, conversational approval, stop, task fork, and message reply polling retain current behavior.

## Live test plan

Use the COD Dev workspace and `#jfenech-codex` only after unit/integration tests pass.

1. **L1 — Pre-toggle:** confirm live Prism web/database health and run existing authenticated HTTP smoke tests for local-app status, `conversations.history`, and `chat.postMessage`.
2. **L2 — Worker ready:** deploy migrations/web/worker with Socket Mode still disabled; confirm the worker reports configured/ready without a Slack connection.
3. **L3 — Slack setup:** add the encrypted app-level token and enable Interactivity, then enable Socket Mode. Confirm connected state and no secret/payload logs.
4. **L4 — HTTP regression:** repeat the same Prism HTTP smoke tests. Confirm OAuth and local-app authorization routes still respond.
5. **L5 — Generic method:** use an explicit Full Web API test profile to call `auth.test` through the existing dynamic route. Confirm upstream was called without adding the method to the registry. Call a method with a missing scope and confirm Slack's error passes through.
6. **L6 — Standard isolation:** call the same unlisted method with a Standard profile and confirm Prism returns `method_not_supported` without upstream work.
7. **L7 — Dropdown:** send one top-level Slack task. Confirm exactly one project picker, select one option, confirm exactly one Codex task starts in that project, and confirm the dropdown is removed.
8. **L8 — Fallback:** start another task and reply with a project name. Confirm it still works.
9. **L9 — Identity:** attempt selection from a different Slack user and confirm no task starts and no Delivery reaches Remote Codex.
10. **L10 — Recovery:** stop Remote Codex, click a fresh picker, restart Remote Codex, and confirm the queued Delivery starts the task once. Restart the Socket worker and repeat to prove reconnection and deduplication.
11. **L11 — Existing clients:** exercise any known Prism HTTP consumer, including Playtest/delegated delivery if configured. No client should require Socket Mode awareness.
12. **L12 — Rollback:** disable Socket Mode and confirm Prism HTTP remains healthy. If a Slack callback URL was previously configured, confirm Slack retains it before declaring rollback ready.

Do not claim live completion until the user performs the dropdown selection in Slack and Remote Codex starts the corresponding local task.

## Regression checklist

- [ ] Existing Standard Token profiles have unchanged method access.
- [ ] Existing `full_slack_bridge` profiles remain curated.
- [ ] Full Web API is explicit and token-rotated.
- [ ] Workspace and organization grants still fail closed.
- [ ] Execution identity selection still uses server-held user/bot credentials.
- [ ] Prism and Slack rate-limit behavior is unchanged.
- [ ] Audit remains metadata-only.
- [ ] No arbitrary URL or caller Slack token can reach upstream.
- [ ] Local-app pairing remains generic and consent reflects inbound capability.
- [ ] OIDC, delegated delivery, admin routes, website, and OAuth keep their existing contracts.
- [ ] Socket app token is encrypted and never leaves Prism.
- [ ] Only one active Socket worker owns a Slack app configuration.
- [ ] Matched envelopes persist before Slack acknowledgement.
- [ ] Inbox Deliveries cannot cross Token profiles.
- [ ] Delivery payloads expire and are removed on acknowledgement.
- [ ] Remote Codex keeps all project paths, prompts, and Codex task state locally.
- [ ] Project picker posts once and can be completed by dropdown or text.
- [ ] One selection starts one task.
- [ ] Existing message polling does not duplicate Socket events.
- [ ] Prism HTTP health and current callers continue during Socket Mode.
- [ ] Documentation no longer says Socket Mode/interactivity are deferred after release.

## Risks

- **R1 — Slack callback exclusivity:** Socket Mode replaces Slack callback delivery for the same Slack app. Audit Slack App Management before toggling it.
- **R2 — Full Web API authority:** one Full Web API token can call newly added or destructive Slack methods without a Prism release. Keep it explicit, expiring, audited, revocable, and non-default.
- **R3 — Scope misunderstanding:** method forwarding and Slack permission are different. Product text must show Slack `missing_scope` as an installation permission issue.
- **R4 — Silent broadening:** reusing `full_slack_bridge` or failing to compare `webApi.mode` would grant existing tokens new access without rotation.
- **R5 — Duplicate/lost actions:** acknowledging before persistence loses clicks; missing deduplication can start a Codex task twice.
- **R6 — Cross-user delivery:** routing only by action ID or workspace can expose one user's interaction to another local application. The Route must bind the exact Token profile, connection, workspace, channel, and Slack user.
- **R7 — Payload retention:** raw Socket envelopes can contain Slack content and short-lived URLs. Normalize the approved interaction fields and delete them promptly.
- **R8 — Worker topology:** running the Socket client inside Next.js can create duplicate connections during reload/deploy. Use the separate worker plus advisory lock.
- **R9 — UI dead end:** Slack can display the dropdown before Remote Codex is online. The durable Prism Inbox and typed reply fallback cover this.
- **R10 — Re-pairing:** existing Remote Codex tokens lack the new inbound capability. Release notes and the local UI must explain one reconnect/approval step.
- **R11 — User-token Block Kit behavior:** source and documentation support `chat.postMessage` blocks with user tokens, but the exact live Prism user-token interaction must be proven in COD Dev before release.
- **R12 — Unverified deployment state:** this review could not inspect the live container or Slack App Management configuration over SSH.

## Unresolved decisions

- **Q1 — Full Web API availability:** should Prism admins globally allow users to create Full Web API profiles, or should only Prism admins issue them? **Recommendation:** allow creation only when the Global Token profile policy explicitly enables `all_methods`; default the migrated global policy to disabled, then enable it deliberately for this deployment.
- **Q2 — Full Web API expiry:** what maximum should apply? **Recommendation:** treat it as destructive-capable and use the existing 30-day maximum, with 24-hour and 7-day experiment choices.
- **Q3 — Delivery retention:** how long should an offline local application have to collect an interaction? **Recommendation:** 24 hours pending, delete normalized action data on acknowledgement, retain metadata-only duplicate/audit records under the existing audit policy.
- **Q4 — Initial Events API subscriptions:** should Slack message events be enabled now? **Recommendation:** no. Implement the generic envelope type but enable only Interactivity for Remote Codex until message polling is replaced in a separate tested slice.
- **Q5 — Slack callback inventory:** does the live Prism Slack app currently have a Request URL used outside this repository? **Recommendation:** inspect Slack App Management before enabling Socket Mode. Repository and live HTTP evidence do not prove the external setting.
- **Q6 — App token bootstrap:** should the first deployment use environment configuration or the active database configuration? **Recommendation:** implement encrypted active-configuration storage as the target; permit an environment fallback only for bootstrap/recovery.

## Confidence

- **High:** ownership boundaries, generic fixed-origin forwarding, explicit Full Web API isolation, current HTTP compatibility, separate worker placement, and Remote Codex local-state requirements.
- **High:** current code has no implemented Slack callback ingress and the existing dynamic route can support unlisted methods without route proliferation.
- **Medium:** final Socket worker configuration and live user-token Block Kit behavior until the actual Slack App Management settings and COD Dev interaction are tested.
- **Blocked evidence:** SSH access to `work-vm` and Slack App Management inspection were unavailable to this scout. These do not block implementation, but they block the Socket Mode toggle and final compatibility claim.

Implementation may proceed with D1-D15. Stop before the live Socket Mode toggle if Q5 has not been resolved.
