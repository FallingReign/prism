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
_Avoid_: Slack administration console, unmanaged proxy dashboard

**Prism admin console**:
A Prism-only administrative surface where trusted Prism admins can view Prism users, inspect a target Prism user, perform audited local Prism access actions, and set organization-wide Prism defaults and limits. It does not grant Slack scopes, manage Slack workspace membership, or perform Slack administration.
_Avoid_: Slack admin console, workspace admin panel, app management console

**Prism admin**:
A trusted Slack-authenticated user allowed to use the Prism admin console by a server-side allowlist keyed by Slack user ID with optional Enterprise Grid or workspace scope. Admin scope is least-privilege: global entries apply to all Prism users, enterprise-scoped entries apply within that Slack organization, and team-scoped entries apply within that workspace.
_Avoid_: Slack admin, app admin, local tool owner

**Prism user**:
A local Prism record for a Slack-authenticated person who has connected Slack to Prism. Admin views of Prism users show safe metadata such as Slack identity, workspace or organization, connection status, Token profile counts, and recent activity, not Slack payloads or token secrets.
_Avoid_: Slack workspace member directory, local tool, developer token

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

**Policy preset**:
A named capability template that fills the Token profile capability checkboxes. Selecting a preset applies its checkbox state; manually changing a capability checkbox makes the Token profile policy Custom.
_Avoid_: Hidden policy mode, ignored checkbox state

**Execution identity**:
The upstream Slack identity Prism uses for a permitted request: user-backed, bot-backed, or automatic.
_Avoid_: Caller identity

**Global Token profile policy**:
The deployment-wide Prism admin-defined defaults and maximums for Token profile creation and updates. Defaults prefill user choices; maximums constrain allowed presets, capabilities, expiry, execution identity options, and broadening/rotation rules. Existing Token profiles that exceed a newer maximum are flagged for review instead of silently revoked. Only globally scoped Prism admins edit this policy.
_Avoid_: Slack scope approval, rate-limit policy, audit-retention policy, Slack workspace allowlist, hidden token rewrite, silent access removal

**Outside global policy**:
The state of an existing Token profile whose capabilities, expiry, or execution identity exceed the current Global Token profile policy maximums. Existing tokens continue until normal expiry or revocation, but broadening, rotation, or reissue is blocked until the profile is narrowed.
_Avoid_: Silent revoke, hidden non-compliance, automatic policy rewrite

**Method registry**:
The server-owned classification of Slack Web API methods used to decide policy before forwarding a request to Slack.
_Avoid_: Raw proxy allow-all list

**Slack-compatible endpoint**:
A Prism endpoint under `/v1/slack/*` that preserves Slack method names, request payloads, pagination, errors, and successful response shapes wherever practical.
_Avoid_: Prism-wrapped Slack endpoint

**Metadata-only audit**:
An audit record that stores request metadata such as user, token profile, workspace, method, category, status, error class, and request ID without storing Slack payloads.
_Avoid_: Payload log, message archive

**Admin action audit**:
A metadata-only audit record for a Prism admin action against another Prism user or their Prism-owned access. It identifies the admin actor, target Prism user, target object, action, request, and a short required reason without storing Slack payloads, token secrets, or Slack credentials. It is visible to both the target Prism user and Prism admins.
_Avoid_: Payload log, secret log, unaccountable admin action

**Reauth required**:
A Slack connection state where Prism keeps token profiles but requires the user to renew Slack authorization before affected calls can succeed.
_Avoid_: Deleted profile, revoked Prism token

**Remove Slack connection**:
The Prism website action that hard-deletes Prism's local Slack connection after explicit warning, including server-held Slack credentials, dependent Token profiles, and local-tool access, so the user starts again from a fresh Slack authorization. It does not uninstall the Slack app or imply Slack-admin removal.
_Avoid_: Reauth, temporary disable, remove one Token profile, uninstall Slack app

**Disconnected Prism user**:
A Prism user whose local Slack connection has been removed while the Prism user record and session owner remain. Prism admins can still see the user in scoped admin directory/detail surfaces when retained Slack identity metadata or Admin action audit metadata places the user inside the admin's scope.
_Avoid_: Deleted user, anonymous orphan, unscoped audit subject

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
- A **Global Token profile policy** provides defaults and maximums for Token profiles, while each **Token profile** remains the local-tool-specific policy object.
- The **Prism hosted service** resolves the **Prism developer token**, evaluates the **Capability map**, chooses an **Execution identity**, and calls Slack with server-held **Slack credentials**.
- The **Method registry** classifies each **Slack-compatible endpoint** before policy enforcement.
- **Metadata-only audit** records Prism activity without storing Slack message bodies, search results, file contents, Block Kit payloads, canvases, or lists.
- Slack administration defines the maximum approved app capability; a **Token profile** narrows what one **Local tool** can actually use.
- **Remove Slack connection** is a destructive local Prism reset and starts the Slack link over; **Expand Slack connection** is a Slack-owned reauthorization path for broader Slack installation scope.
- A **Prism admin** is identified by Slack identity for Prism authorization purposes; being a **Prism admin** does not imply Slack administration authority.
- A **Prism admin** may revoke or delete another **Prism user**'s visible retained Token profiles and remove that user's current local Slack connection only through explicit confirmation and **Admin action audit**.
- Removing a **Prism user**'s local Slack connection produces a **Disconnected Prism user**, not a deleted user, when retained Prism metadata still proves admin scope.

## Example dialogue

> **Dev:** "Can my MCP server use a Slack user token directly for `chat.postMessage`?"
> **Domain expert:** "No. The MCP server is a **Local tool** and only gets a **Prism developer token**. The **Prism hosted service** resolves its **Token profile**, checks the **Capability map**, chooses the **Execution identity**, then calls Slack with server-held **Slack credentials**."

## Flagged ambiguities

- "token" is overloaded. Use **Prism developer token** for local bearer secrets and **Slack credentials** for Slack-issued secrets.
- On the **Prism website**, a simple "token" list should mean **Token profile** summaries, not retrievable **Prism developer token** secrets.
- "full Slack bridge" does not include Slack admin methods, organisation policy methods, inbound events, slash commands, interactivity, canvases, lists, or file transfer in v1.
- "Slack-compatible" means preserving Slack method shape under Prism policy, not exposing an unmanaged raw proxy.
