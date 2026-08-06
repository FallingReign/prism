# Architecture Integration Brief: prism-slack Agent Skill

## Scope and scout status

This brief covers the approved Prism slice only:

- `.agents/skills/prism-slack/SKILL.md`
- `.agents/skills/prism-slack/scripts/setup_credentials.py`
- one discoverability link from `docs/setup.md`

The skill is a reusable Local tool workflow. It accepts a Prism VM host, sends
the user to the Prism website for human Slack OAuth and Token profile creation,
stores the copy-once Prism developer token locally, and performs confirmed
Slack-compatible reads and sends through Prism. It does not change the Prism
hosted service, database, Slack OAuth implementation, or API routes.

The repository is brownfield but has no `architecture.map.yaml` or legacy
`architecture.md`; the architecture lookup therefore reports `unmapped` and
`bootstrap-required`. This scout did not bootstrap a map because the approved
destination explicitly limits the change to the skill, helper, and setup-guide
link. Ownership below is inferred from current code and existing briefs rather
than from a curated architecture map.

## Existing ownership

### Prism hosted-service ownership

The root Next.js application owns the hosted Prism contract:

- `app/v1/prism/health/route.ts:7-12` owns the unauthenticated health probe.
- `app/v1/prism/status/route.ts:9-34` and
  `app/v1/prism/capabilities/route.ts:9-34` adapt the status and capability
  services to HTTP, including request IDs and `Cache-Control: no-store`.
- `src/server/token-profiles/local-tool-status.ts:3-257` owns developer-token
  resolution, active/expired/revoked status, Slack reauthentication state,
  execution-identity availability, and capability projection.
- `src/server/token-profiles/method-policy.ts:61-112` owns bearer-token policy
  evaluation, workspace/surface checks, capability checks, and execution
  identity gating.
- `src/server/slack/method-registry.ts:50-155` owns supported, denied,
  unsupported, and deferred method classification. The current relevant
  methods are `users.list`, `conversations.list`, and `chat.postMessage`
  (`method-registry.ts:50-60`).
- `app/v1/slack/api/[method]/route.ts:29-147` and
  `src/server/slack/forwarding.ts:27-190` own the Slack-compatible HTTP
  boundary, policy-before-forwarding order, surface/workspace headers,
  metadata-only audit, rate limits, and upstream response handling.

Prism's hosted service also owns Slack OAuth and Slack credential custody.
`src/server/slack/oauth-flow.ts:47-169` exchanges OAuth codes and stores
encrypted server-side credential envelopes; `src/server/slack/forwarding-credentials.ts:15-54`
decrypts and refreshes those credentials only when forwarding to Slack. The
Local tool must receive only a Prism developer token, consistent with
`CONTEXT.md:7-81` and `docs/security.md:5-17`.

### Local skill and helper ownership

The new skill is a Local tool integration, not a Prism server module. It owns:

- user-facing setup and confirmation sequencing;
- direct HTTP/PowerShell examples against the public Prism routes;
- target lookup and confirmation policy;
- safe response projection and redacted diagnostics;
- invoking the helper without placing a token in command-line arguments or
  JSON.

`setup_credentials.py` owns local Prism-developer-token custody for this
workflow. It must not own Slack OAuth, Slack credentials, Token profile policy,
the Method registry, rate limits, audit writes, or direct Slack API calls.
The helper is deliberately placed under the skill so another Local tool can
reuse its storage/request seam without importing `src/server/**`.

### Documentation ownership

`docs/setup.md:1-130` already owns the Prism API setup procedure, bearer
boundary, health/status/capabilities checks, Slack-compatible call examples,
Token profile lifecycle, failure states, and MCP adapter link. The new link
must make the skill discoverable without copying that procedure into the setup
guide. `docs/security.md:5-62` remains the owner of credential custody,
metadata-only audit, local execution/prompt-injection risk, rate-limit
distinctions, and v1 deferrals.

The Agent Skills packaging research is the source for the skill shape:
`docs/research/prism-slack-skill-packaging.md:5-24` requires the matching
`.agents/skills/prism-slack/SKILL.md` directory/frontmatter and a concise,
progressively disclosed skill; `:29-44` says the setup guide should link to the
skill rather than duplicate it. The Windows Credential Manager research is the
source for the native backend and custody constraints:
`docs/research/prism-slack-windows-credential-manager.md:5-18,26-42,45-56`.

## Existing interaction model

The integration must preserve this end-to-end interaction:

1. **Accept and normalize the host.** The skill accepts a Prism VM origin or
   bare host. A bare host requires explicit user confirmation before it is
   normalized to unencrypted `http://<host>:3732`; scheme-bearing URLs reject
   userinfo/query/fragment input, remove trailing slashes, and use the
   normalized host for both requests and credential scoping. The helper target is
   `Prism/<lowercase IDN host>/developer-token`, as specified by
   `docs/research/prism-slack-windows-credential-manager.md:11-18`.
2. **Check service reachability before requesting a secret.** Call
   `/v1/prism/health` without authorization and project only HTTP status plus
   `service`/`database` health. Do not ask the user to paste a token into chat
   when the host is unreachable.
3. **Use the Prism website for human setup.** The skill directs the user to
   the supplied host's website to complete Slack OAuth and create a dedicated
   Token profile with the minimum required capabilities. It must explicitly
   distinguish Slack OAuth/Slack credentials (server-owned) from the
   copy-once Prism developer token (Local tool-owned). It must not implement a
   local OAuth callback or ask for Slack bot/user/refresh/app tokens.
4. **Capture the copy-once token locally.** The skill invokes the helper's
   masked setup command. The token is entered locally, never as a chat value,
   environment assignment, command-line argument, transcript, or JSON field.
   The helper may validate the token with `/v1/prism/status` before committing
   it, but output is limited to redacted status/request metadata.
5. **Validate status and capability before exposing actions.** Use
   `/v1/prism/status` and `/v1/prism/capabilities` as documented at
   `docs/setup.md:25-55`. Only an active token, healthy Slack state, available
   execution identity, and `status: "allowed"` method entry permit an action.
   Treat expired, revoked, invalid, reauthentication-required, denied, and
   unsupported results as actionable states, not retryable generic failures.
6. **Resolve and confirm a target.** A channel name/ID is resolved through
   `conversations.list`; a username is resolved through `users.list`. Matching
   must be exact after documented normalization, and ambiguous/no matches must
   stop for user choice. The confirmation displays only safe identity metadata
   such as ID, name/display name, channel type, and selected surface. Slack
   names and message content are untrusted data and must not be treated as
   instructions.
7. **Send only after explicit confirmation.** The setup/test path uses one
   fixed, safe, non-user-supplied test message and asks for confirmation after
   target resolution. It calls `chat.postMessage` with the resolved ID, the
   required `X-Prism-Surface`, and JSON containing only Slack payload fields.
   Future sends remain confirmation-gated; the skill must not silently reuse
   Slack-derived text or send arbitrary content discovered in a response.
8. **Project responses safely.** Do not print whole Slack-shaped bodies,
   headers, request payloads, or exceptions. Project status/capability fields,
   target IDs/names, `ok`, error class, Prism request ID, upstream-called
   boolean, and retry metadata. Do not echo message bodies, search results,
   file contents, Authorization values, or token-like fields. Preserve the
   distinction between Prism-side and upstream Slack rate limits using
   `X-Prism-Upstream-Called`, `Retry-After`, and `X-Slack-Req-Id`, matching
   `src/server/slack/response-adapter.ts:18-31` and
   `docs/security.md:47-60`.

There is no self-identity endpoint and no `auth.test` in the current Prism
surface. The skill must not infer or claim the authenticated Slack actor. It
should resolve only the requested target and report the execution mode exposed
by status/capabilities. This is especially important when a username is a
target or when `user`/`bot` execution identity is selectable.

## Extension points

### Prism HTTP contract

Use only the existing public HTTP routes and headers:

- `GET /v1/prism/health`
- `GET /v1/prism/status`
- `GET /v1/prism/capabilities`
- `GET /v1/slack/api/users.list`
- `GET /v1/slack/api/conversations.list`
- `POST /v1/slack/api/chat.postMessage`

Surface-gated calls must send `X-Prism-Surface` with a value supported by the
current capability map (`public_channel`, `private_channel`, `dm`, or `mpim`).
Pass `X-Prism-Workspace-ID` and `X-Prism-Execution-Mode` only when the user
explicitly supplies or confirms them. `docs/setup.md:57-95`,
`src/server/slack/method-registry.ts:50-60`, and the route tests are the
contract; do not import or duplicate server modules.

The existing reference adapter demonstrates the correct client seam:
`examples/prism-mcp-adapter/src/prism-client.ts:3-72` sends the bearer header,
uses query parameters for GET, JSON for POST, strips local `token` payload
fields, and selects only safe diagnostic headers. Its
`adapter.ts:13-73` performs status/capability gating and preserves rate-limit
diagnostics. The skill/helper should use the same boundary in Python/PowerShell,
not add another Slack client.

### Helper design: library plus setup CLI

The Python file should be both:

- an importable, small standard-library library with explicit interfaces for
  host normalization, credential backends, masked setup, and a request wrapper;
  and
- a thin `main()` setup CLI used by `SKILL.md`.

The approved first version intentionally does not add user-facing status,
rotation, or removal subcommands. Those lifecycle actions remain in the Prism
website; the importable request seam is used for status and capability checks
without exposing the raw credential.

This is preferable to a CLI-only script because the skill needs a testable
request/custody seam, future confirmed sends need the same no-leak request
path, and backend behavior can be tested without scraping terminal output.
The CLI remains the only user-facing entry point; the library must not expose a
`get_token()` function or return the raw token to callers.

The request seam should accept `(host, method, path, safe_payload, surface,
workspace, execution_mode)` and internally:

1. load the credential into a local variable;
2. construct `Authorization: Bearer <token>` in memory;
3. send the request over HTTPS/HTTP to the normalized host; and
4. return a status plus a deliberately projected response, never the token.

The token must never appear in JSON, request bodies, command-line arguments,
URLs, environment dumps, tracebacks, logs, or return values. Avoid generic
HTTP debug logging and do not serialize the request object after headers are
attached. Use `getpass`/masked input for Python setup, or the documented
PowerShell `Read-Host -AsSecureString` path when the skill uses direct
PowerShell. Microsoft documents `Invoke-RestMethod` custom headers and masked
input; the repository research records those constraints at
`docs/research/prism-slack-windows-credential-manager.md:32-42`.

### Credential custody

Implement a backend protocol with the following custody-preserving operations:

- `write(host, token)` validates locally and stores without returning it;
- `request(host, ...)` performs the authenticated request internally;
- `exists(host)` returns metadata only; and
- `delete(host)` removes the scoped credential.

The first backend is Windows Credential Manager through native
`Advapi32.dll` P/Invoke (`CredWriteW`, `CredReadW`, `CredDeleteW`) with
`CRED_TYPE_GENERIC`, using the host-scoped target above. Retrieval must call
`CredFree` for the allocated read buffer. Keep retrieval and HTTP request in
the same process, as required by
`docs/research/prism-slack-windows-credential-manager.md:5-10,26-36`.

The fallback is not automatic. It requires an explicit opt-in flag and a
strong warning that `%APPDATA%\\Prism\\credentials.json` contains a bearer
secret. If selected, create the directory/file with user-only ACLs, verify
the ACL before writing, use restrictive file attributes where available, and
fail closed if the ACL cannot be established or verified. Never put this file
in the repository, skill directory, current working directory, or a path
provided through an unvalidated URL. The fallback remains a Windows-local
escape hatch; non-Windows hosts fail closed until a separately approved
backend exists.

Credential-manager failure, missing credential, malformed token, invalid host,
non-Windows execution, failed ACL verification, and API failure must all
produce redacted actionable errors. Rotation should validate a new token before
replacing the old credential, following
`docs/research/prism-slack-windows-credential-manager.md:45-56`.

### Skill packaging and setup discoverability

`SKILL.md` must use the `prism-slack` frontmatter name and a description that
mentions both configuration and sending. Keep it under the approximately
500-line/5,000-token guidance in
`docs/research/prism-slack-skill-packaging.md:12-24`; place implementation
detail in the helper rather than turning the skill into a code catalogue.

Add one short link in `docs/setup.md` near the existing Local tool
authentication/setup material, for example a “Windows Agent Skill” link to
`../.agents/skills/prism-slack/SKILL.md`. The link should say what the skill
adds (masked local token setup and confirmed Slack actions), then defer to the
skill. Do not copy OAuth, credential-manager, target-resolution, or send
procedures into `docs/setup.md`; its current API and security sections remain
the canonical contract.

## Systems not to bypass

- Do not implement Slack OAuth locally or handle Slack app credentials, bot
  tokens, user tokens, refresh tokens, app-level tokens, or client secrets.
  Prism website/OAuth flow and encrypted server-side custody remain owned by
  `src/server/slack/oauth-flow.ts:47-169` and the hosted service.
- Do not call Slack directly, use a Slack SDK, or forward a Slack credential.
  All Slack actions go through `/v1/slack/api/{method}`.
- Do not reimplement developer-token hashing/resolution, Token profile policy,
  Capability map semantics, Method registry, execution identity, rate limits,
  metadata-only audit, response diagnostics, or Slack credential refresh.
- Do not import `src/server/**` into the skill/helper. The boundary is direct
  HTTP, matching the Local tool definition in `CONTEXT.md:7-81` and the
  reference adapter brief.
- Do not use `cmdkey` as a generic-credential retrieval mechanism; the
  Microsoft research notes it cannot retrieve generic blobs safely and warns
  against command-line secret handling (`docs/research/prism-slack-windows-credential-manager.md:34-42`).
- Do not expose raw response bodies or use Slack content as trusted
  instructions. `docs/security.md:29-45` makes metadata-only audit and
  prompt-injection/local-execution boundaries explicit.
- Do not introduce a website route, database migration, Node dependency,
  architecture map, test framework, or generated documentation for this slice.

## Integration plan

1. Create `.agents/skills/prism-slack/SKILL.md` with matching frontmatter and
   concise imperative instructions for host validation, health check, human
   OAuth/Token profile setup, helper invocation, status/capability gating,
   target resolution, confirmation, fixed safe test send, future confirmed
   sends, failure handling, and safe projections.
2. Create `.agents/skills/prism-slack/scripts/setup_credentials.py` as the
   importable library plus CLI described above. Keep all secret-bearing work
   inside one process; default to Windows Credential Manager and require an
   explicit fallback flag.
3. Add only a discoverability link from `docs/setup.md`; do not duplicate the
   procedure or alter existing API examples.
4. Validate the changed files and existing Prism contracts before live QA.

### Regression checklist

- `SKILL.md` frontmatter name and directory name are exactly `prism-slack`;
  the skill stays within the packaging guidance and contains no real-looking
  token or Slack credential.
- The helper accepts no raw token argument, never prints/returns/serializes
  one, never includes it in JSON or a URL, and never logs an Authorization
  header. Search the file and CLI output for `prism_dev_`, `xox`, bearer
  values, token dumps, and exception payloads.
- Windows Credential Manager is the default; fallback requires explicit
  opt-in and verified user-only ACL; non-Windows and custody failures fail
  closed.
- Host normalization prevents credential-target collisions and unsafe
  userinfo/path/query/fragment input.
- Status/capability checks precede target lookup and sends; denied,
  unsupported, expired, revoked, invalid, reauth-required, and missing
  identity states are not treated as success.
- Target matching is exact/unique and confirmation shows safe metadata only;
  no self-identity/auth.test claim is introduced.
- `chat.postMessage` is called only after explicit confirmation with a fixed
  safe setup message; future sends remain confirmation-gated.
- Requests use existing Prism routes/headers and no Slack credentials; POST
  bodies contain only Slack payload fields and never a local `token`.
- Projections preserve request ID, retry metadata, and upstream-called
  diagnostics without echoing message/search/file content.
- Existing `docs/setup.md`, `docs/security.md`, the reference adapter, and
  current API semantics remain accurate; no unrelated files are changed.

## Test plan

### Static and repository checks

- Verify the three approved destinations and the single setup-guide link with
  `git diff --check` and a path-scoped diff.
- Check Agent Skills frontmatter, matching name, line/token budget, and
  absence of secret-like examples with a small repository scan.
- Run the existing targeted Prism contract tests for status, capabilities,
  method policy, Slack forwarding, route diagnostics, and adapter redaction;
  then run `npm test` and `npm run build` because the setup-guide link is
  repository documentation consumed with the existing suite.
- Compile/import the helper without generating bytecode, e.g.
  `PYTHONDONTWRITEBYTECODE=1 python -m py_compile ...` and
  `PYTHONDONTWRITEBYTECODE=1 python ... --help`. Do not add a Python
  dependency or a second test framework for this slice.

### Helper behavior checks

Exercise the importable backend/request seams with a fake HTTP response and
fake credential backend, without placing a raw token in test output. Cover:

- host normalization and credential target derivation;
- masked setup and local token-format validation;
- default Windows backend selection and explicit fallback refusal/opt-in;
- missing credential, ACL failure, non-Windows, malformed token, and API error
  redaction;
- request construction with an in-memory bearer header and no JSON token;
- status/capability safe projection and suppression of arbitrary response data;
- rotation validation before replacement and deletion by host scope.

### Live QA

Live QA is blocked until the skill and helper exist. From a Windows machine
that can reach the target VM:

1. Probe `http://10.62.240.10:3732/v1/prism/health` and record only HTTP
   status plus `{service,database}`. The supplied current evidence is
   `200`/database `ok`; a scout-environment probe timed out, so reachability
   must be confirmed from the actual user/VM network before treating a failure
   as a Prism regression.
2. Complete human Slack OAuth in the Prism website and create a dedicated
   Token profile with the smallest capability/surface set needed for the test.
   Confirm an available execution identity; do not collect Slack credentials.
3. Run the helper's masked setup CLI with the host. Confirm success through
   redacted status output, then verify that a second process can use the
   credential without displaying it. Inspect Credential Manager metadata only;
   never print the blob. If testing fallback, opt in explicitly, verify the
   user-only ACL, and remove the file afterward.
4. Run status and capabilities. Confirm active token, healthy/connected Slack,
   allowed `users.list`, `conversations.list`, and `chat.postMessage`, plus
   expected surface/execution identity. Capture request IDs and safe
   projections only.
5. Resolve one known channel by name and ID, and one known user by username;
   verify exact/unique confirmation and ambiguity/no-match handling.
6. With explicit user confirmation, send the fixed safe test message to an
   agreed disposable target. Verify the safe `ok`/ID/timestamp projection and
   Prism diagnostics; do not echo the message body or token.
7. Exercise at least one policy-denied/unsupported case, a missing/revoked
   credential case, and a reauthentication or rate-limit response where
   available. Confirm no upstream call occurs for policy/unsupported failures
   and Prism/upstream 429s remain distinguishable.
8. Sweep terminal output, helper diagnostics, request captures, and generated
   files for token-like strings, Authorization values, Slack credentials, and
   message content. Remove any opted-in fallback credential and re-run a
   no-credential failure check.

## Risks

- **Secret leakage through Python/PowerShell plumbing:** process arguments,
  command history, debug logging, tracebacks, JSON serialization, or generic
  response dumps could expose the bearer. Mitigate with masked input,
  in-process request closure, no generic logging, allowlisted projections,
  and negative leak checks.
- **Fallback file exposure:** ACLs can be misconfigured or weakened by the
  user. Make fallback opt-in, warn strongly, verify ACLs before writing, and
  fail closed rather than silently downgrade.
- **Credential target collision:** raw or non-canonical host strings could
  cause credentials to be used for the wrong Prism VM. Normalize scheme/IDN
  host/port deterministically and reject ambiguous URL forms.
- **Capability drift:** a Token profile can change after setup. Re-check
  status/capabilities before actions and honor the current Method registry;
  do not cache policy as a local authority.
- **Untrusted Slack content:** names and response content may contain prompt
  injection. Project minimal metadata and require confirmation independent of
  Slack-derived instructions.
- **No self-identity contract:** a user-targeted send can be misinterpreted as
  acting-as identity. Clearly report target and configured execution mode, but
  do not claim the current Slack user without an endpoint.
- **Network/runtime reachability:** the supplied live host evidence may not be
  reachable from every Windows client. Separate network timeout, Prism health,
  token state, policy denial, and upstream Slack failures in diagnostics.
- **Documentation duplication/drift:** copying the setup procedure into
  `docs/setup.md` or the skill will create competing instructions. Keep API
  contract in `docs/setup.md` and workflow specifics in `SKILL.md`, with one
  link between them.

## Decision confidence

**High, conditional on the implementation following this brief.**

Confidence is high because the current routes, tests, security guidance, and
reference adapter already define the required HTTP and custody boundary:
`docs/setup.md:25-95`, `app/v1/slack/api/[method]/route.ts:29-147`,
`src/server/slack/forwarding.ts:27-190`, and
`examples/prism-mcp-adapter/src/{prism-client,adapter,redaction}.ts`.
The Agent Skills and Microsoft credential API research notes independently
support the proposed packaging and Windows-first custody design.

The main conditions are that the helper never exposes a token-returning API,
fallback storage is explicit and ACL-verified, target resolution remains
confirmation-gated, and live QA is performed from a network that can actually
reach the Prism VM. If implementation evidence conflicts with these
conditions or the current API behavior, stop and revisit this brief rather
than adding a parallel integration path.
