# Prism Slack scope review packet

This packet prepares the Slack admin/security review for Prism v1. Prism is an internal Slack-compatible bridge: Slack administration approves the maximum app capability, and future Prism Token profiles/Capability maps narrow what each Local tool can do. Local tools must never receive Slack credentials.

## OAuth and redirect expectations

Prism v1 will use Slack OAuth for install/user authorization. Existing enterprise Okta-backed Slack login remains a Slack-owned identity flow; Prism must not duplicate Okta, SSO, or Slack administration.

Candidate redirect URLs for Slack App Management:

- Local Next.js development: `http://localhost:3732/v1/slack/oauth/callback`
- Pilot host VM: `http://10.62.240.10:3732/v1/slack/oauth/callback`
- HTTPS development tunnel placeholder: `https://<dev-tunnel-host>/v1/slack/oauth/callback`
- Hosted placeholder: `https://<prism-hostname>/v1/slack/oauth/callback`
- Alternative hosted placeholder: `https://prism.<internal-domain>/v1/slack/oauth/callback`

Issue #4 must ensure the OAuth authorize and token exchange requests use the same redirect URI selected in Slack App Management.

## Candidate v1 non-admin scopes

These are candidates, not final approval. Before any real installation, cross-check exact scopes against Slack's current method documentation, the future Prism Method registry, and Slack admin/security review.

### User-backed execution candidates

User-backed scopes are expected for methods that operate with the installing user's visible conversations and for search:

- Conversation list/read/history: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`
- Message write: `chat:write`
- Reactions: `reactions:read`, `reactions:write`
- Search: `search:read`
- File metadata discovery: `files:read`
- User information: `users:read`

### Bot-backed execution candidates

Bot-backed scopes are candidates only where the Method registry approves bot execution:

- Conversation list/read/history: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`
- Message write: `chat:write`
- Reactions: `reactions:read`, `reactions:write`
- File metadata discovery: `files:read`
- User information: `users:read`

Treat `search:read` as user-backed unless Slack's current method tables and admin review confirm bot-token support for the intended methods.

### Optional supporting scopes, not v1 defaults

Review separately if the Method registry requires them:

- `users:read.email` only if email address exposure is approved.
- `users.profile:read` only if profile fields beyond `users:read` are required.
- `team:read` only if workspace/team metadata is required.
- `chat:write.public` only with explicit approval; default Prism posting should not broaden beyond channel membership.

### Future v1.5 app-level Socket Mode

`connections:write` is an optional future app-level scope for Socket Mode via `apps.connections.open`. It is not a v1 default, must require Slack admin/security approval, and must not be activated until event delivery is implemented. The baseline manifest keeps `socket_mode_enabled: false`.

## File metadata risk

`files:read` can permit more than metadata discovery, including access paths for file content. Prism v1 treats file support as metadata-only. File content transfer, upload, deletion, and download behavior are deferred and must be blocked by the future Method registry/policy unless separately approved.

## Explicit v1 exclusions

Exclude these families from the v1 app review and manifest:

- Admin and organization governance: `admin.*`, `admin`, `auditlogs:read`, `discovery:*`, `ekm:*`, `scim:*`, org management, provisioning, app-management, authorization-management, and policy-management scopes.
- App/config management scopes that let Prism manage Slack installations or app configuration, including `apps:*` or `authorizations:*` style capabilities.
- Workspace/channel management and provisioning-style write scopes such as `channels:manage`, `groups:write`, `team:*` write/admin variants, and `usergroups:write` where used for provisioning or policy.
- Inbound surfaces deferred from v1: event subscriptions, slash commands, shortcuts, interactivity, workflows/functions, triggers, datastores, canvases, lists, and incoming webhooks.
- File transfer or mutation: file upload, write, delete, remote file mutation, or download/content-transfer capabilities.

## Review checkpoints

- Slack admin/security confirms candidate scopes remain non-admin and appropriate for the intended workspace or Enterprise Grid target.
- Prism engineering confirms final scopes map to approved Method registry categories before OAuth is implemented.
- Security confirms Slack credentials remain server-held by the Prism hosted service and are never issued to Local tools.
- If Sign in with Slack identity scopes are needed, issue #4 must design them separately because Slack distinguishes SIWS identity scopes from regular Web API OAuth scopes.
