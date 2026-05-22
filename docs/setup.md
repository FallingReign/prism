# Prism setup guide

This guide is for a **Local tool** author using Prism v1. A Local tool calls the **Prism hosted service** with a **Prism developer token**. It must not receive or use **Slack credentials** such as Slack app credentials, bot tokens, user tokens, refresh tokens, or app-level tokens.

## Configure the Prism base URL

Use `PRISM_BASE_URL` for the hosted Prism origin, for example:

```bash
export PRISM_BASE_URL=http://localhost:3732
```

Local development uses port `3732`. For a hosted or pilot environment, use the approved Prism origin from the deployment owner.

## Use bearer authentication

Call Local tool endpoints with:

```bash
Authorization: Bearer prism_dev_...
```

`prism_dev_...` is a placeholder. The Prism website shows a Prism developer token only at copy-once creation or rotation time. Store it in the Local tool's secret store and do not paste it into logs, documentation, screenshots, or prompts.

## Health, status, and capabilities

Check service health before debugging token or Slack policy issues:

```bash
curl -i "$PRISM_BASE_URL/v1/prism/health"
```

An available local service returns:

```json
{ "service": "ok", "database": "ok" }
```

Validate a Prism developer token and Slack connection state:

```bash
curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  "$PRISM_BASE_URL/v1/prism/status"
```

Discover the Token profile's **Capability map**, **Execution identity** availability, and **Method registry** projection:

```bash
curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  "$PRISM_BASE_URL/v1/prism/capabilities"
```

Use `/v1/prism/status` and `/v1/prism/capabilities` before exposing or attempting Local tool calls where practical. They distinguish active, invalid, expired, revoked, and **Reauth required** states without returning Slack credentials.

## Slack-compatible endpoint calls

Prism exposes each **Slack-compatible endpoint** under:

```text
/v1/slack/api/{method}
```

Representative calls:

```bash
curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  -H "X-Prism-Surface: public_channel" \
  "$PRISM_BASE_URL/v1/slack/api/conversations.list?limit=10"

curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  -H "X-Prism-Surface: public_channel" \
  "$PRISM_BASE_URL/v1/slack/api/conversations.history?channel=C123&limit=10"

curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  "$PRISM_BASE_URL/v1/slack/api/search.messages?query=example"

curl -i \
  -X POST \
  -H "Authorization: Bearer prism_dev_..." \
  -H "Content-Type: application/json" \
  -H "X-Prism-Surface: public_channel" \
  -d '{"channel":"C123","text":"<message text>"}' \
  "$PRISM_BASE_URL/v1/slack/api/chat.postMessage"
```

Surface-gated methods require `X-Prism-Surface`, such as `public_channel`, `private_channel`, `dm`, or `mpim`. Optional `X-Prism-Workspace-ID` narrows workspace policy checks. Optional `X-Prism-Execution-Mode` may select `user` or `bot` when the Token profile's **Execution identity** is selectable.

Prism strips local `token` payload fields before forwarding. Local tools should still avoid sending Prism developer tokens or Slack credentials in request bodies.

## Token profile lifecycle

A **Token profile** is the user-owned policy object for one Local tool. It narrows what Slack administration approved at the app level.

From the Prism website, users can:

- create a Token profile and copy its Prism developer token once
- list Token profiles and current token metadata
- rotate a Prism developer token immediately or with a bounded overlap
- revoke the current Prism developer token
- update policy; broadening requires confirmation and replacement token rotation

Use rotation for normal secret hygiene and revocation for suspected token theft. Use policy narrowing when a Local tool no longer needs a capability.

## Common failure states

| State | Meaning | Local tool action |
| --- | --- | --- |
| Invalid Prism developer token | Missing, malformed, or unknown bearer token. | Check configuration and secret storage. |
| Expired Prism developer token | Token or Token profile expiry has passed. | Create or rotate a Token profile token in the Prism website. |
| Revoked Prism developer token | Token or profile has been revoked. | Stop using the token and issue a replacement if appropriate. |
| Reauth required | Slack authorization must be renewed; Token profiles remain present. | Ask the user to relink Slack in the Prism website. |
| Policy denied | The Capability map does not allow the method, surface, workspace, or execution identity. | Check capabilities and adjust the Token profile if justified. |
| Unsupported method | The Method registry excludes or defers the Slack method in v1. | Do not retry as if transient; wait for a future slice. |
| Prism-side rate limit | Prism limited this Token profile and Slack method before upstream. | Back off using `Retry-After`; `X-Prism-Upstream-Called` is `false`. |
| Upstream Slack rate limit | Slack returned its own rate limit after Prism forwarded. | Back off using Slack's `Retry-After`; `X-Prism-Upstream-Called` is `true`. |

All Prism responses include `Cache-Control: no-store` and `X-Prism-Request-ID` where practical. Slack-compatible responses also include Prism diagnostics such as `X-Prism-Upstream-Called`, and may include `X-Prism-Execution-Mode`.

## MCP adapter

The reference MCP adapter lives in [`../examples/prism-mcp-adapter`](../examples/prism-mcp-adapter/). Configure it with `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`. It validates `/v1/prism/status` and `/v1/prism/capabilities`, exposes representative tools, and calls only Prism endpoints.

## Deferred v1 surfaces

Prism v1 does not include inbound events, Socket Mode, slash commands, interactivity, app mentions, file transfer, canvases, lists, payload logging, content moderation, Supabase platform services, or Slack administration. These are explicit deferrals, not hidden features.
