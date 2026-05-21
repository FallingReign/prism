# Architecture Integration Brief: issue-3-slack-app-scope-packet

## Existing ownership

- Package/component/module/library:
  - Product ownership sits with repository documentation and Slack configuration artefacts, not runtime code. This slice should add a Slack app configuration packet under a docs-owned location and must not implement OAuth, token custody, route handlers, or Slack Web API forwarding.
  - The existing runtime substrate is a Next.js App Router Prism hosted service with `/v1/prism/health`, plain Postgres, `.env.example`, and `package.json` scripts from issue #2. That substrate establishes future server ownership for OAuth callbacks but does not yet own Slack app configuration files.
  - Recommended owner today: `docs/slack/` for human/admin-facing Slack app setup, with `docs/slack/prism-slack-app-manifest.template.yml` as the checked-in manifest template and companion docs for scope review/admin installation.
- Current owner rationale:
  - `CONTEXT.md` says the Prism hosted service owns Slack OAuth callbacks, Slack credential custody, policy enforcement, Slack API forwarding, rate limits, and metadata-only audit; Slack administration defines maximum approved app capability; Local tools never receive Slack credentials.
  - Issue #3 is explicitly a pre-OAuth configuration/review artefact slice. It prepares the external Slack app baseline before issue #4 implements OAuth/credential custody.
  - Slack app manifests are YAML or JSON configuration bundles that can be created/updated through Slack App Management and are safe to share when they contain no secure values, though request URLs may still be sensitive in some organizations.
- Source evidence:
  - `CONTEXT.md`: internal Slack-compatible bridge, not Slack administration product; Slack credentials held only by Prism hosted service; `/v1/slack/*` preserves Slack method shapes later; admin/org/event/slash/interactivity/canvases/lists/file transfer are out of v1.
  - `docs/adr/0001-nextjs-postgres-substrate.md`: Next.js route handlers own website and `/v1/*` APIs; plain Postgres substrate.
  - `docs/implementation-reviews/issue-2-substrate-architecture-integration.md`: preserve `/v1/*`; future Slack-compatible endpoints under `/v1/slack/*`; do not expose Slack credentials; `.env.example` separates future Slack credential placeholders.
  - `README.md`: local Next dev server runs on `localhost:3000` and exposes `/v1/prism/health`.
  - GitHub issue #3: requires OAuth redirect expectations, Enterprise Grid/workspace installation notes, candidate non-admin scope families, explicit exclusions, final scope cross-check against Method registry and Slack admin/security review, and no committed Slack secrets/tokens.
  - Slack docs: OAuth uses `https://slack.com/oauth/v2/authorize`; bot scopes are passed as `scope`, user scopes as `user_scope`; multiple redirect URLs require the same `redirect_uri` in authorize and access steps; `oauth.v2.access` should keep client secrets secure and preferably use HTTP Basic auth; `redirect_uri` must match the authorize value when supplied.
  - Slack manifest docs/schema: manifests can be YAML or JSON; `oauth_config.redirect_urls`, `oauth_config.scopes.bot`, `oauth_config.scopes.user`, `user_optional`, `bot_optional`, `settings.socket_mode_enabled`, `settings.org_deploy_enabled`, and `settings.token_rotation_enabled` are valid manifest fields.

## Existing interaction model

- User/system behaviors that already exist:
  - Local development starts with `npm run dev` on Next's default port `3000`; health proof is `curl -i http://localhost:3000/v1/prism/health`.
  - `.env.example` has placeholder-only `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` grouped as future Slack credentials held only by the Prism hosted service.
  - The Prism website copy already states Slack credentials stay with the Prism hosted service and Local tools call Prism with Prism developer tokens.
- Behaviors that must remain unchanged:
  - No product code, OAuth route, token exchange, encryption, database schema, method registry, Slack client, or credential custody should be implemented in issue #3.
  - No real Slack client secret, bot token, user token, refresh token, app-level token, Slack app ID, workspace/team ID, enterprise ID, signing secret, or generated Slack config token should be committed or printed.
  - Prism remains internal-only, developer-oriented, and Slack-compatible; it is not a Slack admin product, app-management console, org policy tool, LLM runtime, or unmanaged raw proxy.
  - Local tools receive only opaque Prism developer tokens in later slices; they never receive Slack credentials.
  - Slack administration/security approval defines maximum app capability; Prism Token profiles and Capability maps narrow that capability locally after OAuth/registry work exists.
  - v1 docs must not imply event delivery, slash commands, interactivity, canvases, lists, or file transfer support.
- Runtime or UX evidence:
  - Current runtime only proves substrate health; no Slack runtime behavior exists.
  - Product brief states user clicks Slack sign-in via the Prism website, Slack may redirect through Okta as Slack-owned identity, Prism completes OAuth, and later Local tools call Prism with `Authorization: Bearer <prism_token>`.
  - Product brief names future Slack-compatible endpoint shape such as `/v1/slack/chat.postMessage`, making `/v1/slack/oauth/callback` the least surprising future callback route under the same hosted-service namespace while not being a Slack-compatible method endpoint itself.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add docs/config artefacts only. Recommended docs namespace: `docs/slack/`.
  - Recommended manifest format/location: YAML at `docs/slack/prism-slack-app-manifest.template.yml`; YAML is human-reviewable, matches Slack manifest examples, and can be pasted into Slack App Management. Keep it as a template with placeholders, not an exported real app manifest.
  - Recommended companion docs:
    - `docs/slack/scope-review-packet.md` for v1 candidate scopes, scope rationale, explicit exclusions, and Method registry/security review checkpoints.
    - `docs/slack/admin-installation-plan.md` for Slack admin/human approval steps, Enterprise Grid vs workspace installation notes, Okta-backed Slack login acknowledgement, and final checklist.
    - Optional `docs/slack/README.md` only if implementer wants an index; avoid duplicating long scope content across files.
  - Recommended README touchpoint: add a short link from `README.md` to the Slack app setup packet, without expanding README into the packet.
  - Recommended `.env.example` touchpoint: only add non-secret URL placeholders if issue #3 docs need them for issue #4 continuity, e.g. `PRISM_PUBLIC_BASE_URL=http://localhost:3000` and/or `SLACK_OAUTH_REDIRECT_URI=http://localhost:3000/v1/slack/oauth/callback`. Do not add any token values or real IDs.
- Relevant docs or library capabilities:
  - Slack App Manifests support `display_information`, `features.bot_user`, `oauth_config.redirect_urls`, `oauth_config.scopes.bot`, `oauth_config.scopes.user`, `settings.org_deploy_enabled`, `settings.socket_mode_enabled`, and `settings.token_rotation_enabled`.
  - Slack OAuth v2 uses separate bot and user scope parameters. Slack warns that Sign in with Slack identity scopes conflict with non-SIWS scopes in the same OAuth flow; the packet should avoid promising a single combined SIWS + Web API flow unless later OAuth design verifies it.
  - Slack Socket Mode replaces Events API Request URLs with WebSocket URLs from `apps.connections.open`; Socket Mode requires an app-level token with `connections:write`, but v1 event delivery is deferred. The v1 manifest should keep `socket_mode_enabled: false` unless human admin explicitly approves a future/optional variant.
  - Slack `oauth.v2.access` can return bot and authed-user token material; this slice must only document that those future credentials are server-held, never implement or store them.
- Existing examples in this codebase:
  - `docs/adr/0001-nextjs-postgres-substrate.md` and `docs/implementation-reviews/issue-2-substrate-architecture-integration.md` are concise architecture docs under `docs/`.
  - `.env.example` already demonstrates placeholder-only Slack credential naming.
  - `README.md` is intentionally short and should remain an entry point rather than a full Slack admin packet.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create product runtime code, OAuth routes, database tables, encryption/custody modules, Slack SDK wrappers, Method registry code, or tests for runtime behavior in this slice.
  - Do not introduce a Slack CLI dependency, app manifest API automation, or config-token workflow as required local development. Slack UI/admin review is sufficient for this packet.
  - Do not create a separate `/api/*` OAuth convention; future hosted-service callbacks should follow the `/v1/*` API namespace established by ADR 0001/issue #2.
- Shortcuts or parallel paths to avoid:
  - Do not commit real secrets, generated app IDs, generated redirect domains, workspace IDs, enterprise IDs, Slack tokens, signing secrets, or config tokens.
  - Do not include admin/org/provisioning/app-management/policy scopes because they make Prism look like a Slack administration product.
  - Do not add `commands`, interactivity request URLs, event subscriptions, slash commands, shortcuts, workflow steps, canvases, lists, incoming webhooks, or file upload/write scopes for v1 unless a later approved issue adds those capabilities.
  - Do not treat Slack scopes as Prism Token profile policy. The packet must state that Slack scopes are the maximum approved capability and future Token profiles/Capability maps narrow Local tool behavior.
  - Do not use `chat:write.public` as a default; it broadens posting beyond channel membership and should require explicit security approval if ever needed.
  - Do not describe file content transfer as v1. `files:read` can allow file download; if included for metadata discovery, mark the file-content risk and say Prism v1 must enforce metadata-only behavior in the future Method registry/policy.
- Invariants:
  - No secrets or generated external identifiers in source control.
  - Admin/organization-management capabilities are excluded.
  - OAuth/credential custody implementation is deferred to issue #4.
  - Events/interactivity/slash commands/file transfer/canvases/lists are deferred.
  - Human Slack admin/security approval is required before any real workspace/org installation.

## Integration plan

- Insert the change at:
  - Create `docs/slack/prism-slack-app-manifest.template.yml` as the canonical Slack manifest template.
    - Use `_metadata.major_version: 2`/`minor_version: 1` or omit metadata if Slack validation rejects the version; keep the template schema-compatible with Slack's current manifest reference.
    - Include `display_information` and, if bot-backed calls are part of v1, `features.bot_user` with neutral internal naming such as `Prism`/`Prism Bridge`.
    - Include `oauth_config.redirect_urls` with placeholders:
      - recommended local: `http://localhost:3000/v1/slack/oauth/callback` matching current Next dev port and future App Router route `app/v1/slack/oauth/callback/route.ts`.
      - recommended local HTTPS tunnel if Slack/admin policy rejects localhost HTTP: `https://<dev-tunnel-host>/v1/slack/oauth/callback`.
      - recommended hosted placeholder: `https://<prism-hostname>/v1/slack/oauth/callback` or `https://prism.<internal-domain>/v1/slack/oauth/callback`; do not commit a real production domain unless one is already approved.
    - Include `oauth_config.scopes` with candidate v1 scopes only; put risky/optional/future scopes in comments or the review packet rather than active YAML if Slack parser rejects comments near arrays.
    - Set `settings.org_deploy_enabled: false` in the baseline unless Slack admins explicitly approve org-wide deployment; document Enterprise Grid org-wide deploy as an admin decision.
    - Set `settings.socket_mode_enabled: false` for v1. Do not configure event subscriptions or interactivity.
    - Set `settings.token_rotation_enabled: true` if the admin review accepts token rotation for OAuth credentials; otherwise flag as a security recommendation requiring Slack admin confirmation. Issue #4 will implement custody/refresh behavior.
  - Create `docs/slack/scope-review-packet.md` with:
    - v1 candidate non-admin user scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `chat:write`, `reactions:read`, `reactions:write`, `search:read`, `files:read`, `users:read`, and optionally `users:read.email` only if admin/security approves email address exposure.
    - v1 candidate non-admin bot scopes where bot-backed execution is required: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `chat:write`, `reactions:read`, `reactions:write`, `files:read`, and `users:read`. Treat `search:read` as user-backed unless Slack current docs/admin review confirms bot-token support for the intended methods.
    - Optional supporting scopes to review, not default: `team:read` for workspace/team metadata and `users.profile:read` if profile fields beyond `users:read` are required.
    - Future optional v1.5 app-level Socket Mode: `connections:write` for app-level token used by `apps.connections.open`, only after admin approval and only when event delivery is implemented. Keep v1 manifest Socket Mode off.
    - Exact excluded scope families: `admin.*`, `admin`, `auditlogs:read`, `discovery:*`, `ekm:*`, `scim:*`, `usergroups:write` if used for provisioning/policy, app-management/config scopes such as `apps:*`/`authorizations:*` where they manage installations, `channels:manage`, `groups:write`/management-style scopes, `team:*` write/admin scopes, `commands`, workflow/function scopes, trigger scopes, datastore scopes, interactivity/shortcut/slash-command scopes, event-only subscriptions for v1, canvases/lists scopes, and file write/upload/delete scopes. The implementer should word these as families and verify Slack's current scope names during the packet.
    - A method-registry warning: final exact scopes must be cross-checked against the future Method registry, Slack's current method scope tables, and Slack admin/security review before real installation.
    - A Sign in with Slack/OAuth note: existing enterprise Okta login is Slack-owned; Prism should rely on Slack's OAuth flow and not duplicate Okta/SSO. If separate SIWS identity scopes are needed, design them in issue #4 because Slack warns SIWS scopes conflict with non-SIWS scopes in the same OAuth flow.
  - Create `docs/slack/admin-installation-plan.md` with:
    - Steps for Slack admin/security review: review packet, validate non-admin scope list, create or update Slack app from manifest, set local/dev/hosted redirect URLs, decide workspace vs Enterprise Grid org deploy, approve installation, record approved scopes/installation target outside source control, hand client ID/secret/signing secret/token material to secure deployment secret storage only.
    - Human approvals required: Slack admin/security owner approves scopes and deployment target; developer/security owner confirms no local tools receive Slack credentials; issue #4 implementer confirms OAuth custody design before any token exchange.
    - Enterprise Grid note: org-wide deployment is Slack-admin controlled; workspace installation is acceptable for initial dev if security chooses it. Prism docs must not imply Prism can override Slack governance.
  - Add a concise `README.md` link to the Slack packet if desired.
  - Consider `.env.example` additions only for non-secret URL placeholders needed by docs; no real domains or IDs.
- Why this is the correct integration point:
  - It keeps external Slack app configuration close to project docs, separate from runtime code that does not exist yet.
  - It gives issue #4 stable callback/scope assumptions without prematurely implementing OAuth or credential custody.
  - It preserves ADR 0001's `/v1/*` service boundary and `CONTEXT.md`'s Slack-admin-vs-Prism-policy boundary.
- Alternatives considered and rejected:
  - Put the manifest at repository root: rejected because it increases clutter and separates it from the review/admin packet.
  - Use JSON manifest: viable, but YAML is easier for human Slack admin review and comments in a template. If automated validation becomes important, add a generated/validated JSON copy later, not now.
  - Implement `/v1/slack/oauth/callback` now: rejected because issue #3 is pre-OAuth docs/config; issue #4 owns OAuth/custody.
  - Use `/api/slack/oauth/callback`: rejected because ADR 0001 and issue #2 establish `/v1/*` as the service API namespace.
  - Enable Socket Mode and event subscriptions now: rejected because v1 event delivery is deferred; keep `connections:write` as future optional/admin-approved only.
  - Close issue only after a real Slack admin installs the app: rejected for this slice unless maintainers explicitly require it. Issue #3 acceptance is artefact preparation; human admin approval steps must be documented, but actual approval/installation can remain an external prerequisite for issue #4/live deployment.

## Regression checklist

- Behavior: Existing Next.js substrate files, health route, tests, `package.json`, Docker Compose, and README local dev flow remain unchanged except optional docs links/non-secret env placeholders.
- Behavior: The manifest template contains only placeholders and no real Slack credentials, app IDs, team IDs, enterprise IDs, domains, or tokens.
- Behavior: Manifest redirect URLs include current local/dev expectation for port `3000` and a hosted placeholder without committing an unknown production domain.
- Behavior: Scope packet lists non-admin v1 candidates and clearly marks optional/future scopes separately.
- Behavior: Admin, organisation-management, provisioning, app-management, policy-management, inbound events, slash commands, interactivity, canvases, lists, and file transfer are explicitly excluded/deferred.
- Behavior: Packet states final exact scopes must be cross-checked against the future Method registry and Slack admin/security review.
- Behavior: Slack OAuth/Okta language says Okta-backed Slack login remains Slack-owned and Prism does not implement SSO/admin identity flows.
- Behavior: No OAuth implementation, token exchange, Slack SDK dependency, database migration, or product route is added in this slice.
- Behavior: README/env changes, if any, do not leak secrets and do not imply local tools receive Slack credentials.

## Test plan

- Existing tests to keep green:
  - Run `npm test` and `npm run build` after docs/env changes if package files remain unchanged; docs-only changes should not break the existing issue #2 substrate.
- New tests to add before/with implementation:
  - No runtime tests required for this docs/config slice.
  - If YAML validation tooling is already available, parse the manifest template as YAML. Do not add a new dependency solely for validation unless implementation chooses a small script using an existing runtime capability.
  - If no YAML parser exists, perform lightweight textual checks: required manifest sections exist (`display_information`, `oauth_config`, `redirect_urls`, `scopes`, `settings`), expected redirect placeholders exist, `socket_mode_enabled: false` exists, and no excluded active sections (`slash_commands`, `interactivity`, `event_subscriptions`) are enabled.
  - Secret grep checks: search for token prefixes and known secret names/values, e.g. Slack token prefixes (`xox...`, `xapp...`), manifest secret fields by name, and concrete Slack token environment variables, and any non-placeholder `https://` production domain if not approved.
- Live proof required:
  - Docs-only verification is enough to close issue #3 if the manifest template, scope review packet, and admin installation plan are complete and reviewed.
  - Human Slack admin approval/installation should be documented as a required external step before real OAuth/custody operation, but it should not block issue #3 closure unless the issue owner explicitly changes acceptance criteria.
  - Optional stronger proof: paste the template into Slack App Management manifest validation in a dev workspace after replacing placeholders, without committing any resulting app IDs or secrets.

## Risk assessment

- Risk: Slack scope names and token-type compatibility may drift or be more nuanced than the initial candidate list.
  - Mitigation: Packet must label scopes as candidates and require final cross-check against Slack's current method docs, Method registry, and admin/security review before installation.
- Risk: `files:read` may permit file content download, while v1 only wants file metadata.
  - Mitigation: Include it only with an explicit risk note; future Method registry/policy must allow metadata methods and block file transfer/download behavior unless separately approved.
- Risk: `search:read` exposes broad search over content visible to a user token.
  - Mitigation: Keep search capability controlled by future Token profiles/Capability maps, include admin review warning, and avoid bot default if unsupported/unnecessary.
- Risk: Local `http://localhost:3000` redirect may conflict with Slack/admin HTTPS policy.
  - Mitigation: Include an HTTPS tunnel/reserved dev-host option and hosted HTTPS placeholder; document that Slack/admin validation is source of truth.
- Risk: Enabling Socket Mode now could accidentally imply v1 event delivery.
  - Mitigation: Keep `socket_mode_enabled: false`; document `connections:write` only as future optional v1.5/admin-approved.
- Risk: Admin reviewers may interpret broad Web API scope candidates as an admin/governance product.
  - Mitigation: Packet must foreground Prism as internal developer bridge, non-admin only, Slack-admin-governed, and narrowed by future Prism Token profiles.
- Risk: README or env additions could blur Slack credentials and Prism developer tokens.
  - Mitigation: Keep changes minimal and preserve existing wording that Slack credentials are held only by the Prism hosted service and local tools use Prism developer tokens.

## Decision confidence

- Confidence: high
- Reasons:
  - Issue #3 is a docs/config preparation slice with clear boundaries and no need to change product runtime.
  - Current repo conventions already separate docs under `docs/`, use `/v1/*` for service APIs, and reserve Slack credentials for the hosted service.
  - Slack manifest/OAuth docs support a YAML manifest with redirect URLs and bot/user scopes; Socket Mode docs support deferring app-level `connections:write` until future event delivery.
  - The recommended `/v1/slack/oauth/callback` path aligns with ADR 0001 and future Slack namespace expectations while avoiding implementation.
- Open questions:
  - Whether the organization has an approved hosted Prism domain. Until known, use `https://<prism-hostname>/v1/slack/oauth/callback` or `https://prism.<internal-domain>/v1/slack/oauth/callback` as a placeholder.
  - Whether Slack admins prefer workspace install first or Enterprise Grid org-wide deploy. Baseline should default to workspace/dev install and `org_deploy_enabled: false` unless admin approval says otherwise.
  - Whether issue #4 will use a single Slack OAuth install/user authorization flow or separate Sign in with Slack identity flow. Slack warns SIWS scopes conflict with non-SIWS scopes in the same OAuth flow, so issue #3 should document the nuance without resolving implementation.
  - Whether `users:read.email`, `team:read`, `users.profile:read`, and any destructive write methods are truly needed for v1. Treat them as optional/admin-reviewed, not automatic defaults.
