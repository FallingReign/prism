# Prism

Prism is an internal Slack-compatible bridge for developer-owned local tools. It centralizes Slack credential custody and policy enforcement while preserving Slack-shaped API usage for MCP servers, CLIs, coding agents, and custom applications.

## Language

**Prism**:
An internal hosted Slack bridge that local tools call instead of calling Slack directly.
_Avoid_: Slack agent, LLM runtime, Slack administration product, unmanaged Slack proxy

**Local tool**:
A developer-owned MCP server, CLI, coding agent, or custom application that calls Prism with a Prism developer token.
_Avoid_: Slack app client, Prism user

**Prism hosted service**:
The confidential server-side service that owns Slack OAuth callbacks, Slack credential custody, policy enforcement, Slack API forwarding, rate limits, and metadata-only audit.
_Avoid_: Local bridge, desktop app

**Prism website**:
The user-facing web surface for Slack linking, token profile management, audit review, and setup documentation.
_Avoid_: Admin console

**Slack credentials**:
Slack app credentials, bot tokens, user tokens, refresh tokens, and app-level tokens held only by the Prism hosted service.
_Avoid_: Developer token, local token

**Prism developer token**:
An opaque bearer secret issued by Prism for a local tool and resolved server-side to one token profile.
_Avoid_: Slack token, JWT, shared team token

**Token profile**:
A user-owned policy object that defines what a local tool may do through Prism.
_Avoid_: Team profile, shared service account

**Capability map**:
The allowed Slack method categories, surfaces, workspaces, destructive-action setting, search setting, expiry, and execution identity options for a token profile.
_Avoid_: Slack scope list

**Execution identity**:
The upstream Slack identity Prism uses for a permitted request: user-backed, bot-backed, or automatic.
_Avoid_: Caller identity

**Method registry**:
The server-owned classification of Slack Web API methods used to decide policy before forwarding a request to Slack.
_Avoid_: Raw proxy allow-all list

**Slack-compatible endpoint**:
A Prism endpoint under `/v1/slack/*` that preserves Slack method names, request payloads, pagination, errors, and successful response shapes wherever practical.
_Avoid_: Prism-wrapped Slack endpoint

**Metadata-only audit**:
An audit record that stores request metadata such as user, token profile, workspace, method, category, status, error class, and request ID without storing Slack payloads.
_Avoid_: Payload log, message archive

**Reauth required**:
A Slack connection state where Prism keeps token profiles but requires the user to renew Slack authorization before affected calls can succeed.
_Avoid_: Deleted profile, revoked Prism token

## Relationships

- A **Local tool** receives a **Prism developer token**, never **Slack credentials**.
- A **Prism developer token** maps to exactly one **Token profile**.
- A Slack-authenticated user owns zero or more **Token profiles**.
- A **Token profile** has one current **Prism developer token** secret, with optional temporary overlap during rotation.
- A **Capability map** belongs to exactly one **Token profile**.
- The **Prism hosted service** resolves the **Prism developer token**, evaluates the **Capability map**, chooses an **Execution identity**, and calls Slack with server-held **Slack credentials**.
- The **Method registry** classifies each **Slack-compatible endpoint** before policy enforcement.
- **Metadata-only audit** records Prism activity without storing Slack message bodies, search results, file contents, Block Kit payloads, canvases, or lists.
- Slack administration defines the maximum approved app capability; a **Token profile** narrows what one **Local tool** can actually use.

## Example dialogue

> **Dev:** "Can my MCP server use a Slack user token directly for `chat.postMessage`?"
> **Domain expert:** "No. The MCP server is a **Local tool** and only gets a **Prism developer token**. The **Prism hosted service** resolves its **Token profile**, checks the **Capability map**, chooses the **Execution identity**, then calls Slack with server-held **Slack credentials**."

## Flagged ambiguities

- "token" is overloaded. Use **Prism developer token** for local bearer secrets and **Slack credentials** for Slack-issued secrets.
- "full Slack bridge" does not include Slack admin methods, organisation policy methods, inbound events, slash commands, interactivity, canvases, lists, or file transfer in v1.
- "Slack-compatible" means preserving Slack method shape under Prism policy, not exposing an unmanaged raw proxy.
