# Prism reference MCP adapter

This example is a **Local tool** MCP stdio server for Prism. It calls the Prism hosted service with a Prism base URL and a Prism developer token only; it never handles Slack app credentials, bot tokens, user tokens, refresh tokens, app-level tokens, or Slack client secrets.

## Setup

```bash
npm install
npm --workspace @prism/reference-mcp-adapter run build
PRISM_BASE_URL=http://localhost:3732 \
PRISM_DEVELOPER_TOKEN=prism_dev_... \
npm --workspace @prism/reference-mcp-adapter start
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "prism-slack": {
      "command": "npm",
      "args": ["--workspace", "@prism/reference-mcp-adapter", "start"],
      "env": {
        "PRISM_BASE_URL": "http://localhost:3732",
        "PRISM_DEVELOPER_TOKEN": "prism_dev_..."
      }
    }
  }
}
```

## Tools

The adapter calls `/v1/prism/status` and `/v1/prism/capabilities` on startup, then exposes only representative tools allowed by the Token profile's Capability map:

| MCP tool | Prism Slack-compatible method |
| --- | --- |
| `slack_list_channels` | `conversations.list` |
| `slack_channel_history` | `conversations.history` |
| `slack_search_messages` | `search.messages` |
| `slack_post_message` | `chat.postMessage` |

Surface-gated tools require a `surface` input such as `public_channel`, `private_channel`, `dm`, or `mpim`. Optional `workspaceId` and `executionMode` inputs become Prism headers for the specific tool call.

## Failure behavior

| Case | Adapter behavior |
| --- | --- |
| Invalid Prism developer token | Startup fails before tools are exposed. |
| Expired or revoked Prism developer token | Startup fails before tools are exposed. |
| Reauth required | Startup fails with `slack_reauth_required`; renew Slack authorization in the Prism website. |
| Policy denied | Denied tools are omitted after capability discovery where practical; stale denials return an MCP tool error. |
| Unsupported method | Unsupported methods are not exposed by this reference adapter. |
| Prism-side rate limit | Tool result is an error with `error: "rate_limited"`, `Retry-After`, and `upstreamCalled: false`. |
| Upstream Slack rate limit | Tool result is an error with Slack's error body, `Retry-After`, optional Slack request ID, and `upstreamCalled: true`. |

All startup errors are redacted before printing. Do not put Slack credential-like variables such as `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_REFRESH_TOKEN`, `SLACK_APP_TOKEN`, or `SLACK_CLIENT_SECRET` in this adapter's environment; startup rejects them.

## Verification

Mocked behavior tests:

```bash
npm --workspace @prism/reference-mcp-adapter test
```

Live local Prism verification without real Slack calls:

```bash
npm run db:up
npm run db:migrate
PRISM_SLACK_OAUTH_MOCK=1 npm run dev

PRISM_BASE_URL=http://localhost:3732 \
PRISM_DEVELOPER_TOKEN=prism_dev_... \
npm --workspace @prism/reference-mcp-adapter run verify:live
```

The live verification uses Prism's existing mock Slack forwarding path and prints tool names, request ID, and upstream-called diagnostics only. It does not print the Prism developer token.

## Non-goals

- No Slack OAuth or Slack credential custody in the adapter.
- No direct Slack Web API client.
- No full Slack Web API coverage.
- No inbound Slack events, slash commands, Block Kit interactivity, file transfer, canvases, lists, or admin/org APIs.
