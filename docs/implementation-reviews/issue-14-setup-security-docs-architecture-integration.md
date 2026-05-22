# Architecture Integration Brief: issue-14-setup-security-docs

## Existing ownership

- Package/component/module/library:
  - **Top-level self-serve docs:** `README.md` currently owns local development startup, health endpoint expectations, Slack app setup link-outs, OAuth/custody summary, and reference MCP adapter entry point (`README.md:5-45`). Issue #14 should expand this as the primary Prism v1 setup entry point, not create a disconnected parallel guide.
  - **Glossary and product semantics:** `CONTEXT.md` owns exact domain language for Prism, Local tool, Prism hosted service, Prism website, Slack credentials, Prism developer token, Token profile, Capability map, Execution identity, Method registry, Slack-compatible endpoint, Metadata-only audit, and Reauth required (`CONTEXT.md:7-81`). Setup/security docs must reuse these terms exactly.
  - **Slack-admin review artefacts:** `docs/slack/README.md`, `docs/slack/scope-review-packet.md`, `docs/slack/admin-installation-plan.md`, and the manifest template own Slack app/admin/scope-review guidance. They already state Local tools never receive Slack credentials, Socket Mode/events/interactivity/file transfer/canvases/lists are deferred, and Slack admin/security approvals happen outside source control (`docs/slack/scope-review-packet.md:1-80`, `docs/slack/admin-installation-plan.md:1-32`).
  - **Reference Local tool docs:** `examples/prism-mcp-adapter/README.md` owns MCP adapter setup, `PRISM_BASE_URL`/`PRISM_DEVELOPER_TOKEN` config, representative tool mappings, adapter failure behavior, live verification, and adapter non-goals (`examples/prism-mcp-adapter/README.md:1-87`). Issue #14 should link and summarize this, not duplicate all adapter internals.
  - **Runtime behavior owners:** Next.js routes and server modules own actual endpoint contracts: health (`app/v1/prism/health/route.ts`), status/capabilities (`app/v1/prism/status/route.ts`, `app/v1/prism/capabilities/route.ts`, `src/server/token-profiles/local-tool-status.ts`), Slack-compatible forwarding (`app/v1/slack/api/[method]/route.ts`, `src/server/slack/forwarding.ts`), Method registry (`src/server/slack/method-registry.ts`), Token profile lifecycle routes (`app/v1/prism/token-profiles/**/route.ts`), Metadata-only audit (`src/server/audit/activity.ts`), and rate limits (`src/server/slack/rate-limit.ts`).
  - **Test conventions:** Vitest behavior tests own regression protection. Existing tests use canary strings and negative assertions for secret/material leakage in runtime, UI, adapter, audit, forwarding, and dependency guard tests (`src/server/dependency-guard.test.ts`, `app/v1/prism/status/route.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, `examples/prism-mcp-adapter/src/redaction.test.ts`).
- Current owner rationale:
  - Issue #14 is documentation plus doc-safety tests. The existing system already has implemented runtime paths; docs must report those behaviors from current code/tests instead of inventing new API, policy, audit, rate-limit, storage, or UI behavior.
  - The source-of-truth split is clear: README for self-serve entry, `docs/slack/` for Slack admin/security artefacts, adapter README for Local tool example usage, and new dedicated docs for Local tool/API setup plus security review notes.
- Source evidence:
  - GitHub issue #14 PRD, `README.md:1-45`, `CONTEXT.md:1-81`, `docs/slack/*.md`, `examples/prism-mcp-adapter/README.md`, `package.json:9-16`, route/service files and tests listed above.

## Existing interaction model

- User/system behaviors that already exist:
  - Local development uses `npm install`, `.env.local` from `.env.example`, `npm run db:up`, `npm run db:migrate`, `npm run dev`, and port `3732`; health returns only `{ service, database }` with sanitized `ok`/`unavailable` states (`README.md:5-30`, `app/v1/prism/health/route.test.ts:17-40`).
  - Slack linking is exposed at `GET /v1/slack/oauth/start` and `GET /v1/slack/oauth/callback`; Slack access/refresh credentials are stored only as encrypted server-side envelopes and are not returned to Local tools or browser responses (`README.md:32-41`, `.env.example:19-34`).
  - Local tools authenticate to status/capabilities/Slack-compatible endpoints with `Authorization: Bearer <Prism developer token>`; missing or malformed bearer tokens fail before token/credential DB lookups (`app/v1/prism/status/route.ts:28-31`, `src/server/token-profiles/local-tool-status.ts:172-257`, route tests).
  - `GET /v1/prism/status` reports active/invalid/expired/revoked token status, Slack healthy/Reauth required status, execution identity availability, `Cache-Control: no-store`, and `X-Prism-Request-ID` without secret material (`app/v1/prism/status/route.test.ts:58-152`).
  - `GET /v1/prism/capabilities` returns effective Capability map, category/method availability, unsupported surfaces, and no secret material only for active tokens (`app/v1/prism/capabilities/route.test.ts:61-140`).
  - `/v1/slack/api/{method}` preserves Slack-compatible method names and Slack-shaped bodies where practical, applies Method registry and Token profile policy before forwarding, uses `x-prism-surface`, optional `x-prism-workspace-id`, optional `x-prism-execution-mode`, emits Prism diagnostics headers, strips local `token` payload fields, and never forwards/audits Local tool bearer secrets (`app/v1/slack/api/[method]/route.ts:29-147`, `src/server/slack/forwarding.ts:27-190`, route tests).
  - Current supported representative Slack methods include conversations read methods, `users.info`, `users.list`, `search.messages`, `chat.postMessage`, `chat.update`, `chat.delete`, reactions methods, `files.info`, and `files.list`. Admin, events, slash commands, interactivity, file transfer, canvases, lists, and unknown future methods are unsupported/deferred (`src/server/slack/method-registry.ts:50-155`).
  - Token profile lifecycle endpoints create/list/revoke/rotate/update policy, return copy-once Prism developer tokens only on create/rotation/broadening-confirmed update, require rotation for policy broadening, and do not make stored token material retrievable (`app/v1/prism/token-profiles/route.ts:13-118`, child routes, `route.test.ts:102-249`).
  - Metadata-only audit stores request metadata and selected Slack object IDs only; it deliberately excludes Slack message text, search queries/results, file contents, Block Kit, canvases/lists, Prism developer tokens, token hashes, peppers, Slack credentials, refresh tokens, and client secrets (`src/server/audit/activity.ts:29-120`, `src/server/audit/activity.test.ts:7-80`).
  - Prism-side rate limits default to 120 requests per 60 seconds per Token profile/method; Prism-side 429s have `X-Prism-Upstream-Called:false`, while upstream Slack 429s pass through `Retry-After`/`X-Slack-Req-Id` and `X-Prism-Upstream-Called:true` (`src/server/slack/rate-limit.ts:33-68`, `app/v1/slack/api/[method]/route.test.ts:309-370`).
  - Prism website currently provides Slack linking, Token profile management, audit review, copy-once token warnings, prompt-injection/local-execution warnings, rotate/revoke/update affordances, and no secret material in rendered HTML (`app/page.tsx:27-52`, `app/token-profiles-panel.test.tsx:7-46`, `app/activity-audit-panel.test.tsx:7-37`).
- Behaviors that must remain unchanged:
  - No runtime/API/schema/persistence/website behavior changes for this slice.
  - Docs must not describe Local tools as Slack credential holders or direct Slack clients; Local tools receive only Prism developer tokens.
  - Docs must not say Prism stores Slack payloads, message bodies, search queries/results, file contents, Block Kit payloads, canvases, or lists in audit.
  - Docs must preserve the distinction between Prism-side policy/rate-limit failures and upstream Slack failures.
  - Docs must keep v1 deferred surfaces explicit and avoid promising Slack admin/org APIs, events, Socket Mode, slash commands, interactivity, app mentions, file transfer, canvases, lists, payload logging, content moderation, production deployment automation, KMS integration, Supabase platform services, or Slack admin approval records.
- Runtime or UX evidence:
  - Existing Vitest suites assert status/capability/forwarding/lifecycle/audit/UI/adapter behaviors and secret-hygiene canaries. The docs should quote only these current contracts and link to owner docs rather than introduce new examples that look like real secrets or sensitive payloads.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - **Docs placement:** expand `README.md`; add dedicated `docs/setup.md` (or similarly named Local tool/API setup guide) and `docs/security.md` (or similarly named security review notes). Keep Slack-specific admin/scope content in `docs/slack/` and cross-link from security notes.
  - **Adapter link:** link to `examples/prism-mcp-adapter/README.md` for MCP setup rather than copying its full procedure. The adapter README already owns `PRISM_BASE_URL`, `PRISM_DEVELOPER_TOKEN`, representative tool mapping, failure table, and live verification details.
  - **Doc tests:** add a Vitest test under an existing test-owned area such as `src/server/docs-guard.test.ts` or `src/server/dependency-guard.test.ts` expansion. Prefer a focused docs guard test that reads committed Markdown files with `node:fs/promises`, following existing dependency guard patterns (`src/server/dependency-guard.test.ts:17-53`).
  - **Required-topic checks:** assert the published doc set contains the `CONTEXT.md` glossary terms, endpoint names, lifecycle controls, failure states, rate-limit distinctions, security posture topics, and v1 deferred-surface list from issue #14.
  - **Leak checks:** scan committed Markdown docs intended for publication for real-looking Prism developer tokens, Slack token formats (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, app-level token formats), client/refresh/access secret canaries, `Authorization: Bearer prism_dev_<long token>` examples, and sensitive payload canaries used in tests (`MESSAGE_TEXT_CANARY`, `BLOCK_KIT_CANARY`, `RAW_SEARCH_QUERY_CANARY`, etc.). Permit placeholder-only examples such as `prism_dev_...` and Slack credential placeholder names.
  - **Verification commands:** use existing scripts only: `npm test` and `npm run build`; package-local adapter tests already use `npm --workspace @prism/reference-mcp-adapter test` (`package.json:9-16`, adapter README).
- Relevant docs or library capabilities:
  - Next.js/route behavior does not need new framework integration. This slice is Markdown plus Vitest file-reading tests.
  - The test stack is Vitest 4 with TypeScript ESM; avoid new Markdown linting dependencies unless implementation finds a strong need. Native `fs` + assertions is enough.
- Existing examples in this codebase:
  - `src/server/dependency-guard.test.ts` reads files/package metadata to enforce architecture constraints.
  - Runtime and adapter tests consistently use canary values plus `not.toMatch` assertions for `prism_dev_`, `tokenHash`, `pepper-secret-canary`, `xox[bp]-`, `refresh`, `access_token`, and `client_secret` leakage.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not alter or duplicate Prism developer-token validation, Token profile lifecycle, Capability map policy, Method registry, Execution identity, Slack forwarding, rate limits, Metadata-only audit, Slack OAuth custody, or adapter behavior.
  - Do not add a runtime documentation route, generated docs system, custom markdown renderer, website navigation, or external publishing mechanism for this slice unless a later issue explicitly asks for it.
  - Do not replace Slack admin/scope docs; cross-link them from setup/security docs.
  - Do not add new dependencies for docs tests if native Node/Vitest assertions can enforce the safety requirements.
- Shortcuts or parallel paths to avoid:
  - Do not invent configuration flags, environment variables, endpoints, response fields, lifecycle operations, audit fields, storage controls, or rate-limit semantics that do not exist.
  - Do not imply non-local deployments already have managed KMS integration; the accurate current posture is local encrypted envelopes plus a requirement/recommendation for managed secret/KMS-equivalent controls outside local development.
  - Do not publish real-looking bearer tokens or Slack tokens. Use `prism_dev_...` only as a clearly non-copyable placeholder.
  - Do not include realistic Slack message bodies, search queries/results, file contents, Block Kit payloads, canvases, or lists as documentation examples; keep Slack-compatible call examples skeletal and payload-minimal.
  - Do not imply Prism moderates Slack content, makes coding agents safe, or trusts Slack content. State Slack content is untrusted input to Local tools/coding agents.
  - Do not claim Prism is a Slack administration product, unmanaged Slack proxy, Supabase-based platform, marketplace MCP package, or full Slack bridge for deferred v1.5 surfaces.
- Invariants:
  - Current code/runtime remains source of truth; docs must be adjusted to code, not code to docs.
  - Slack credentials stay only in the Prism hosted service.
  - Prism developer tokens are opaque bearer secrets resolved server-side to exactly one Token profile.
  - Metadata-only audit stores metadata, not payloads.
  - Policy enforcement and rate limits happen Prism-side before/around forwarding; upstream Slack behavior remains distinct.
  - Documentation tests must fail on required-topic drift and accidental secret/token/payload examples.

## Integration plan

- Insert the change at:
  - `README.md`: expand as the self-serve Prism v1 entry point. Include local setup, hosted/API base URL concept, bearer usage boundary, links to setup/security/Slack/admin/adapter docs, quick endpoint checklist, and explicit no-Slack-credentials-local rule.
  - `docs/setup.md` (recommended): Local tool/API setup guide covering `PRISM_BASE_URL`, `Authorization: Bearer <Prism developer token>`, health/status/capabilities checks, representative `curl` examples for `/v1/slack/api/{method}`, required Prism headers (`x-prism-surface`, optional workspace/execution mode), Token profile lifecycle user flow, common failures, and MCP adapter link.
  - `docs/security.md` (recommended): security review notes covering Slack credential custody, encrypted local envelope storage and non-local KMS-equivalent posture, Metadata-only audit, local execution risk, prompt-injection risk through Slack content, token theft mitigation/rotation/revocation/policy narrowing, rate-limit operations, operational controls, and deferred v1.5 surfaces.
  - `docs/slack/README.md`: add short cross-links to the new setup/security docs only if useful. Keep scope/admin approval detail in existing Slack docs.
  - `examples/prism-mcp-adapter/README.md`: avoid major edits; only add a backlink to the new setup/security docs if implementation needs navigability.
  - New `src/server/docs-guard.test.ts` (recommended) or a focused addition to dependency guard tests: read the published docs (`README.md`, `docs/setup.md`, `docs/security.md`, `docs/slack/*.md`, and adapter README as appropriate) and enforce required topics plus leak/payload guardrails.
- Why this is the correct integration point:
  - The issue explicitly asks for repo-controlled self-serve setup/security documentation and lightweight documentation tests, not product behavior changes.
  - `README.md` is already the first setup entry, `docs/slack/` already owns Slack review artefacts, and adapter README already owns Local tool example details. Dedicated setup/security docs prevent overloading Slack-admin docs while keeping the README concise.
  - A Vitest docs guard fits existing repo conventions and runs under `npm test` without adding new tooling.
- Alternatives considered and rejected:
  - **Only expanding README:** rejected because the issue requires substantial setup, token-risk, security-review, and operational guidance; one README would become too large and harder to test by topic.
  - **Putting all guidance under `docs/slack/`:** rejected because much of the scope is Local tool/API/security posture, not Slack app admin installation.
  - **Changing website UI to host docs:** rejected as a UX/runtime change outside issue #14.
  - **Adding markdown lint/docs generator dependencies:** rejected unless necessary; lightweight Vitest file scans satisfy the PRD.
  - **Using real-looking secrets in examples:** rejected due the core token-risk objective.

## Regression checklist

- Behavior: `npm test` remains green, especially status, capabilities, Slack-compatible route, Token profile lifecycle, audit, UI, adapter redaction/config, and dependency guard tests.
- Behavior: `npm run build` remains green; docs/test changes must not break Next app compilation or workspace resolution.
- Behavior: Existing README claims about local dev, port `3732`, health responses, Slack OAuth custody, and adapter location remain accurate.
- Behavior: Existing Slack admin/scope docs still state candidate scopes/exclusions accurately and do not imply v1 support for deferred surfaces.
- Behavior: Adapter README remains accurate for `PRISM_BASE_URL`, `PRISM_DEVELOPER_TOKEN`, representative tools, failure behavior, and live verification.
- Behavior: New docs do not contain real-looking Prism developer tokens, Slack tokens, Slack credential values, bearer secrets, token hashes, peppers, client secrets, refresh/access tokens, or sensitive Slack payload examples.
- Behavior: New docs preserve exact glossary terms from `CONTEXT.md` and do not reintroduce avoided terms such as treating Local tools as Slack app clients.

## Test plan

- Existing tests to keep green:
  - Full root `npm test`.
  - `npm run build` after docs/tests are added.
  - Pay special attention to `src/server/dependency-guard.test.ts`, `src/server/audit/activity.test.ts`, `app/v1/prism/status/route.test.ts`, `app/v1/prism/capabilities/route.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, `app/v1/prism/token-profiles/route.test.ts`, UI panel tests, and adapter tests.
- New tests to add before/with implementation:
  - A docs guard test that reads the published Markdown doc set and asserts required topics are present: glossary terms, `PRISM_BASE_URL`, `Authorization: Bearer`, `/v1/prism/health`, `/v1/prism/status`, `/v1/prism/capabilities`, `/v1/slack/api/{method}`, representative Slack methods, Token profile create/list/rotate/revoke/policy, Reauth required, policy denied, unsupported method, Prism-side rate limit, upstream Slack rate limit, Slack credential custody, encrypted envelopes, KMS-equivalent non-local guidance, Metadata-only audit, local execution risk, prompt-injection risk, token theft mitigation, operational controls, and deferred v1.5 surfaces.
  - A docs leak test that fails on real-looking Prism developer tokens longer than the placeholder, Slack token formats, `client_secret`/refresh/access secret examples, Authorization header values with non-placeholder bearer material, token hash/pepper canaries, and sensitive payload canaries (`MESSAGE_TEXT_CANARY`, `BLOCK_KIT_CANARY`, `RAW_SEARCH_QUERY_CANARY`, `SEARCH_RESULT_CANARY`, `FILE_CONTENT_CANARY`, `CANVAS_CONTENT_CANARY`, `LIST_CONTENT_CANARY`).
  - Optional link/reference assertions for key docs (`docs/setup.md`, `docs/security.md`, `docs/slack/README.md`, adapter README) if implementation can keep them stable without brittle Markdown parsing.
- Live proof required:
  - Not required for this documentation-only slice because no runtime behavior changes are allowed. Verification should be `npm test` plus `npm run build` and, if desired, manual inspection of rendered Markdown links. Do not require live Slack or local server QA for the scout-approved implementation.

## Risk assessment

- Risk: Documentation drifts from code by promising unsupported endpoints, methods, storage controls, KMS integration, Slack admin capabilities, payload logging/review features, or v1.5 surfaces.
- Risk: Examples accidentally normalize leaking Prism developer tokens, Slack credentials, Authorization headers, token hashes, peppers, message bodies, search queries/results, file contents, Block Kit, canvas/list content, or local agent prompts.
- Risk: Ambiguous “token” wording confuses Prism developer tokens with Slack credentials, undermining the core custody boundary.
- Risk: Security guidance could overstate Prism protection for prompt injection/local execution. Prism forwards Slack content; Local tools and coding agents must still treat returned content as untrusted.
- Risk: Rate-limit docs could merge Prism-side and upstream Slack 429 behavior, causing wrong retry/operational guidance.
- Risk: Docs guard tests could become brittle if they assert exact prose instead of stable required concepts and leak patterns.
- Mitigation:
  - Use `CONTEXT.md` glossary terms and cite existing owner docs/routes/tests when writing setup/security wording.
  - Keep examples placeholder-only and payload-minimal.
  - Make tests topic/pattern based, not line-number or prose-snapshot based.
  - Treat docs conflicts with current code as blockers for implementation; update docs to code or stop for user decision if product meaning is ambiguous.

## Decision confidence

- Confidence: high
- Reasons:
  - Issue #14 explicitly excludes runtime behavior changes, and current code/docs already provide strong owners for setup, Slack review, adapter usage, status/capability/forwarding/lifecycle/audit/rate-limit behavior.
  - Existing tests demonstrate the key contracts and provide prior art for lightweight guard tests using Vitest canaries and file reads.
  - The recommended doc split aligns with current repository structure and avoids duplicating Slack admin or adapter documentation.
- Open questions:
  - Exact file names are not mandated by existing docs. Recommendation is `docs/setup.md` and `docs/security.md`; any equivalent names are acceptable if README and tests make them discoverable.
  - Current README says Prism website is for setup docs in the glossary (`CONTEXT.md:19-20`), but the implemented website does not host docs yet. For issue #14, keep docs in repo Markdown and do not imply an implemented website docs route unless a later UX issue adds it.
