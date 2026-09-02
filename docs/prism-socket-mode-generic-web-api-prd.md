# PRD: Generic Slack Web API and interactive local applications

## Problem

Prism currently forwards only a manually listed subset of Slack Web API
methods. Adding a Slack method therefore requires a Prism release even when
the method uses the same authenticated HTTP contract. Prism also cannot receive
Block Kit interactions, so local applications such as Remote Codex must ask
people to type project names or numbers instead of selecting a project.

## Slice outcome

An explicitly authorised Full Web API Token profile can call any syntactically
valid Slack Web API method supported by its stored Slack credential. Existing
Token profiles keep their current authority. Prism can also receive Block Kit
actions through Socket Mode and make the normalised action available to the
exact local application that posted the interactive message. Remote Codex uses
that path for a project dropdown while retaining a conversational text fallback.

## Stable ownership

- Prism owns Slack credentials, Slack installation configuration, workspace and
  identity authorization, generic API forwarding, Socket Mode transport,
  interaction routing, delivery cursors, rate limits, and metadata-only audit.
- Local applications own their prompts, projects, tasks, action meaning, and all
  application state.
- Slack owns the final permission decision for every Web API method based on the
  stored credential and approved OAuth scopes.

## In scope

- Generic `GET` and `POST` forwarding to the fixed
  `https://slack.com/api/{method}` origin.
- Strict Slack method-name validation; no caller-controlled upstream URL.
- An explicit Full Web API capability that is granted only through new or
  rotated Token profiles.
- Existing reviewed method policy for all profiles without Full Web API access.
- JSON, form, and query payloads with caller-supplied Slack tokens removed.
- Socket Mode configuration using one Prism-owned app-level token.
- Durable, duplicate-safe ingestion of `block_actions` envelopes.
- Immediate Slack acknowledgement after a durable normalised action write.
- A short-lived Route bound to the posting Token profile, Slack connection,
  workspace, channel, Slack user, and supported interaction kind.
- An authenticated HTTP endpoint through which the posting local application
  reads only its own normalised actions.
- Remote Codex project selection through a Block Kit static dropdown.
- Existing project-name and project-number replies as a fallback.
- Socket Mode status in operational health without exposing secrets.

## Out of scope

- Arbitrary URL proxying, incoming webhooks, OAuth endpoints, SCIM, Audit Logs,
  or caller-supplied Slack credentials.
- Persistent Slack message contents, arbitrary event bodies, or Remote Codex
  application state in Prism.
- General Events API subscriptions beyond the interaction transport required by
  this slice.
- Binary file relay. Slack's external upload URL remains a separate transfer.
- Automatically creating an app-level Slack token or changing Slack app settings.
- Slack Marketplace distribution.

## User journey

1. A person posts a new top-level task in the configured Slack channel.
2. Remote Codex posts one Block Kit project dropdown through Prism and registers
   that message for interaction delivery.
3. The person chooses a project.
4. Slack sends the action to Prism through Socket Mode.
5. Prism durably records and acknowledges the normalised action.
6. Remote Codex reads the action through Prism's existing authenticated HTTP
   boundary, validates the local pending task, and starts Codex in that project.
7. Remote Codex updates Slack conversationally and continues the task.

## Functional acceptance criteria

- Existing Prism HTTP API callers work unchanged with Socket Mode disabled or
  enabled.
- Existing Token profiles do not gain new Web API methods after deployment.
- A newly created or rotated Full Web API profile can call an unlisted valid
  Slack Web API method; Slack still returns `missing_scope` when appropriate.
- Invalid method names, arbitrary hosts, multipart payloads, and supplied Slack
  tokens never reach Slack.
- Interactive messages use an opaque Route key without Prism interpreting the
  application's selected value.
- A Delivery is visible only to the Token profile that owns the Route and the
  same connected Slack identity/workspace.
- Duplicate Socket Mode envelopes produce one stored action.
- Remote Codex posts at most one project picker per task.
- Selecting a dropdown project and replying with its name produce the same local
  task binding and original prompt.
- With Socket Mode unavailable, Remote Codex explains the text fallback once and
  does not retry or spam.

## Security acceptance criteria

- The app-level token exists only as an encrypted credential envelope in Prism
  configuration. Plaintext never enters logs, HTTP responses, local
  applications, browser JavaScript, or unencrypted database fields.
- Prism acknowledges only envelopes it has durably accepted or intentionally
  rejected as malformed/unauthorised.
- Stored actions contain only bounded routing fields, action identifiers, and
  selected values; message text and the raw Slack envelope are not retained.
- Workspace grants, exact Slack owner identity, Token profile state, execution
  identity, global policy, audit, and rate limits remain enforced.
- Full Web API broadening follows the existing rotate/reissue rule.
- Unknown future Slack methods are available only to Full Web API profiles.

## Operational acceptance criteria

- Prism starts normally when Socket Mode is not configured.
- When configured, the web service and Socket Mode worker have coordinated
  shutdown and a visible non-secret health state.
- A worker failure makes the container unhealthy or exits it for normal Docker
  restart behaviour.
- Existing Slack HTTP callback configuration is not required. Slack's saved
  callback can be restored by disabling Socket Mode.

## Live verification

- Verify current Prism HTTP methods before and after deployment.
- Verify a reviewed profile still rejects an unlisted Web API method.
- Verify a newly rotated Full Web API profile reaches that method.
- Enable Socket Mode, add the app-level token, and verify connection health.
- Post one Remote Codex task, select a project from the dropdown, and verify the
  original prompt starts once in the chosen local project.
- Disable or interrupt the worker and verify the text fallback remains usable
  without repeated picker messages.
