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

**Token profile summary**:
A compact representation of one token profile in the Prism website, focused on name, current status, and immediate access removal. Deeper configuration, rotation, copy-once token display, and profile-specific audit belong behind the selected token profile.
_Avoid_: Full policy editor row, visible developer-token secret row

**Active Token profile list**:
The Prism website homepage list optimized for a small set of current token profiles, typically 0 to 12 items, without search, filters, or pagination in the core flow.
_Avoid_: Inventory table, admin directory, audit dashboard

**Token profile detail**:
A focused Prism website view for one selected token profile, where the user first manages Prism developer token lifecycle actions, then edits policy configuration, then reviews profile-specific metadata-only audit.
_Avoid_: Dashboard widget, homepage row expansion

**Remove access**:
The Prism website action that asks for compact confirmation, revokes the current Prism developer token for a token profile, and removes it from the default active list while preserving metadata and audit history.
_Avoid_: Hard delete, erase audit, delete Slack credentials

**Access status**:
The homepage status for a token profile summary, answering whether its local tool can use Slack through Prism right now.
_Avoid_: Policy preset label, usage freshness label

**Create Token profile modal**:
The focused Prism website flow for adding a new token profile from the clean homepage list and showing the copy-once Prism developer token immediately after creation.
_Avoid_: Inline homepage form, raw debug form, retrievable token vault

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

**Remove Slack connection**:
The Prism website action that hard-deletes Prism's local Slack connection after explicit warning, including server-held Slack credentials, dependent Token profiles, and local-tool access, so the user starts again from a fresh Slack authorization. It does not uninstall the Slack app or imply Slack-admin removal.
_Avoid_: Reauth, temporary disable, remove one Token profile, uninstall Slack app

**Expand Slack connection**:
The Prism website action, labelled as changing Slack authorization, that sends the user back through Slack authorization to choose a broader installation target, such as another workspace or an Enterprise Grid org-wide installation, without treating it as a delete/reset flow.
_Avoid_: Disconnect, delete connection, change Token profile policy

## Relationships

- A **Local tool** receives a **Prism developer token**, never **Slack credentials**.
- A **Prism developer token** maps to exactly one **Token profile**.
- A Slack-authenticated user owns zero or more **Token profiles**.
- A **Token profile** has one current **Prism developer token** secret, with optional temporary overlap during rotation.
- **Remove access** revokes a **Token profile**'s current **Prism developer token**; it does not erase historical **Metadata-only audit**.
- A **Capability map** belongs to exactly one **Token profile**.
- The **Prism hosted service** resolves the **Prism developer token**, evaluates the **Capability map**, chooses an **Execution identity**, and calls Slack with server-held **Slack credentials**.
- The **Method registry** classifies each **Slack-compatible endpoint** before policy enforcement.
- **Metadata-only audit** records Prism activity without storing Slack message bodies, search results, file contents, Block Kit payloads, canvases, or lists.
- Slack administration defines the maximum approved app capability; a **Token profile** narrows what one **Local tool** can actually use.
- **Remove Slack connection** is a destructive local Prism reset and starts the Slack link over; **Expand Slack connection** is a Slack-owned reauthorization path for broader Slack installation scope.

## Example dialogue

> **Dev:** "Can my MCP server use a Slack user token directly for `chat.postMessage`?"
> **Domain expert:** "No. The MCP server is a **Local tool** and only gets a **Prism developer token**. The **Prism hosted service** resolves its **Token profile**, checks the **Capability map**, chooses the **Execution identity**, then calls Slack with server-held **Slack credentials**."

## Flagged ambiguities

- "token" is overloaded. Use **Prism developer token** for local bearer secrets and **Slack credentials** for Slack-issued secrets.
- On the **Prism website**, a simple "token" list should mean **Token profile** summaries, not retrievable **Prism developer token** secrets.
- "full Slack bridge" does not include Slack admin methods, organisation policy methods, inbound events, slash commands, interactivity, canvases, lists, or file transfer in v1.
- "Slack-compatible" means preserving Slack method shape under Prism policy, not exposing an unmanaged raw proxy.
