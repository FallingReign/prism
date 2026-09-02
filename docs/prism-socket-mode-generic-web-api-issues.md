# Issue breakdown: Generic Slack Web API and interactive local applications

## 1. Explicit Full Web API authorization

- Add a backward-compatible Full Web API capability to Token profiles.
- Grant it only when a Full Web API profile is newly created or rotated.
- Keep existing profile JSON and existing reviewed method policy unchanged.
- Allow valid unlisted Slack Web API methods only when that capability is true.
- Preserve fixed-origin forwarding, credential injection, workspace checks,
  execution identity, rate limits, and metadata audit.
- Tests: legacy profile denial, explicit full-profile allowance, invalid method
  rejection, supplied-token stripping, and Slack `missing_scope` passthrough.

## 2. Generic Route, Delivery, and Prism Inbox

- Add a migration for short-lived Routes, normalised Deliveries,
  duplicate envelope protection, and bounded retention.
- Bind a Route to the exact Token profile, Slack connection, workspace, channel,
  Slack user, and supported envelope/action kind.
- Add authenticated create/close Route and lease/ack Prism Inbox endpoints.
- Keep application message timestamps and action meaning in the local
  application; Prism stores only bounded generic routing fields.
- Tests: identity/workspace/profile isolation, duplicate delivery, malformed
  fields, rotation/revocation, lease/ack behavior, and secret/content canaries.

## 3. Socket Mode worker and operations

- Add strict app-level token configuration without logging its value.
- Add a dedicated long-running worker using Slack's Socket Mode protocol.
- Normalise and durably store supported `block_actions`, then acknowledge.
- Add reconnect handling, coordinated container lifecycle, and health heartbeat.
- Keep Prism fully operational when Socket Mode is unconfigured.
- Tests: hello/action/disconnect envelopes, acknowledgement ordering, retries,
  storage failure, reconnection, shutdown, and redacted diagnostics.

## 4. Remote Codex project dropdown

- Extend Prism message posting to send deterministic Block Kit JSON after
  creating a short-lived Route.
- Store the picker message timestamp with the pending local project flow.
- Poll the authenticated Prism Inbox alongside conversational replies.
- Match an opaque project identifier to the locally stored project list; never
  send local working-directory paths to Slack or Prism.
- Preserve project-name and project-number replies as the fallback.
- Update the picker after selection so it cannot be selected twice.
- Tests: block shape, identifier bounds, owner/workspace/root matching,
  duplicate action handling, fallback selection, and no repeated picker.

## 5. Configuration, deployment, and end-to-end proof

- Update Prism setup, manifest documentation, API reference, security notes, and
  environment templates for Full Web API and Socket Mode.
- Inventory the live Slack app before toggling Socket Mode.
- Run Prism migrations and all automated checks.
- Deploy Prism without recreating PostgreSQL or losing existing environment
  configuration.
- Enable Socket Mode and store the app-level token on the VM.
- Build, install, and leave Remote Codex closed for user-led onboarding.
- Complete the live HTTP compatibility and dropdown acceptance checks.
- Run an independent post-implementation architecture review.

Implementation order is 1 through 5. The surrounding task authorizes this
focused slice. A required new Slack admin permission, an existing direct HTTP
callback consumer, or a need to persist raw Slack content is a stop condition.
