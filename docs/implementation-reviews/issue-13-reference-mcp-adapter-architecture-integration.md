# Architecture Integration Brief: issue-13-reference-mcp-adapter

## Existing ownership

- Package/component/module/library:
  - **Prism hosted service ownership:** the root `prism` Next.js app owns `/v1/*` API routes, Slack OAuth/callbacks, Slack credential custody, Prism developer-token verification, Token profile policy, Capability map projection, Execution identity, Slack-compatible forwarding, Prism-side rate limits, and metadata-only audit. Evidence: `CONTEXT.md:15-17`, `CONTEXT.md:61-68`, `README.md:36-42`, `app/v1/prism/status/route.ts`, `app/v1/prism/capabilities/route.ts`, `app/v1/slack/api/[method]/route.ts`.
  - **Status/capability ownership:** `src/server/token-profiles/local-tool-status.ts` owns Prism developer-token status and capability discovery bodies; route handlers only adapt HTTP headers and no-store responses. Evidence: `local-tool-status.ts:72-140`, status/capability route tests.
  - **Method/policy ownership:** `src/server/slack/method-registry.ts` owns supported/deferred/unsupported Slack method classification and `buildMethodAvailability`; `src/server/token-profiles/method-policy.ts` owns pre-forwarding policy decisions. Evidence: `method-registry.ts:50-155`, `method-policy.ts:61-112`.
  - **Forwarding/response/rate-limit/audit ownership:** `src/server/slack/forwarding.ts`, `response-adapter.ts`, `rate-limit.ts`, `postgres-rate-limit-store.ts`, and audit stores own Slack-shaped payload parsing, no-store diagnostics headers, rate limits, upstream header pass-through, and metadata-only audit. Evidence: `forwarding.ts:27-108`, `response-adapter.ts:18-31`, `rate-limit.ts:36-68`.
  - **Local tool ownership for this slice:** the new adapter is a separate Local tool example package. It should own MCP stdio process lifecycle, environment loading/redaction, Prism HTTP calls, and MCP tool registration/mapping. It must not own Slack credentials, Slack OAuth, Token profile policy, or Slack forwarding semantics.
  - **MCP library ownership:** the MCP TypeScript SDK should own MCP protocol framing, tool registration, schema validation, and stdio transport. For current stable v1 package conventions, use `@modelcontextprotocol/sdk` plus `zod`; v1 docs show `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
- Current owner rationale:
  - Prism's core model is deliberately server-owned: Local tools receive only a Prism developer token and call Prism; the hosted service resolves that token to one Token profile, evaluates the Capability map, chooses execution identity, forwards to Slack with server-held Slack credentials, and records metadata-only audit (`CONTEXT.md:61-68`).
  - A reference MCP adapter should demonstrate that boundary rather than move policy or credential custody into local code.
- Source evidence:
  - `CONTEXT.md:1-81`, `docs/adr/0001-nextjs-postgres-substrate.md:1-3`, GitHub issue #13 body/PRD, `README.md:1-42`, the route/service files listed above, and baseline `npm test` passing 33 files / 91 tests.

## Existing interaction model

- User/system behaviors that already exist:
  - Local tools authenticate with `Authorization: Bearer <Prism developer token>`; malformed/missing tokens fail before DB lookup (`local-tool-status.ts:172-180`, `route.test.ts` for status/capabilities/slack API).
  - `GET /v1/prism/status` returns active/invalid/expired/revoked token status plus Slack reauth and execution-identity availability, with `Cache-Control: no-store` and `X-Prism-Request-ID` (`app/v1/prism/status/route.test.ts`).
  - `GET /v1/prism/capabilities` returns effective Capability map, allowed/denied method availability, unsupported surfaces, and no secret material only for active tokens (`app/v1/prism/capabilities/route.test.ts`, `local-tool-capabilities.test.ts`).
  - `/v1/slack/api/[method]` accepts Slack-compatible method names and JSON/form/query payloads, applies Prism policy before forwarding, requires `x-prism-surface` for surface-gated methods, optionally uses `x-prism-workspace-id` and `x-prism-execution-mode`, and returns Slack-shaped bodies plus Prism diagnostics in headers (`app/v1/slack/api/[method]/route.ts`, route tests).
  - Representative currently supported methods are `conversations.list`, `conversations.info`, `conversations.history`, `conversations.replies`, `users.info`, `users.list`, `search.messages`, `chat.postMessage`, `chat.update`, `chat.delete`, `reactions.add/remove/get`, `files.info`, and `files.list`; admin/events/slash commands/interactivity/file transfer/canvases/lists are unsupported/deferred (`method-registry.ts`).
  - Prism-side rate limits return HTTP 429 with body `{ ok:false, error:"rate_limited" }`, `Retry-After`, and `X-Prism-Upstream-Called:false`; upstream Slack 429s pass through with Slack body/header evidence and `X-Prism-Upstream-Called:true` (`route.test.ts:309-370`, `forwarding.test.ts:202-240`).
  - Metadata-only audit records method/object metadata, never message/search/file/block contents or bearer secrets (`forwarding.test.ts:97-148`, route audit tests).
- Behaviors that must remain unchanged:
  - The adapter must not accept, store, print, or forward Slack app credentials, bot/user tokens, refresh tokens, app-level tokens, client secrets, or message payload contents in logs.
  - Prism status/capability/error semantics must be consumed as-is. Do not invent a parallel token validator, policy engine, method registry, rate limiter, Slack client, OAuth flow, audit path, or response wrapper.
  - Slack-compatible endpoint success/error body shapes should remain Prism-owned. The adapter may translate them into MCP `content`/`structuredContent`, but should preserve request IDs, retry headers, `X-Prism-Upstream-Called`, and Slack `ok/error` distinctions in structured output or tool error messages.
  - Existing root Next app behavior and tests must continue to pass; adding the example must not make the hosted service depend on MCP runtime packages at execution time.
- Runtime or UX evidence:
  - Baseline `npm test` passes. `npm test -- --runInBand` is not a valid Vitest option in this repo and should not be documented as a verification command.
  - Current Slack forwarding uses a `MockSlackWebApiClient` by default (`src/server/slack/web-api-client.ts`), so live local QA can validate real Prism endpoints without live Slack credentials once a local Prism developer token exists.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Prism HTTP APIs: `GET /v1/prism/status`, `GET /v1/prism/capabilities`, and `/v1/slack/api/{method}` are the only hosted-service integration points for the adapter.
  - Response headers: read `X-Prism-Request-ID`, `X-Prism-Policy-Decision`, `X-Prism-Upstream-Called`, `X-Prism-Execution-Mode`, `Retry-After`, and `X-Slack-Req-Id` where present.
  - Capabilities: use `capabilities.methods[method].status` and `capabilities.categories[...]` to decide which representative MCP tools to register/expose at startup, and re-check before each tool call to handle stale capabilities.
  - Tool context headers: include `x-prism-surface` from MCP tool input for surface-gated methods; include optional `x-prism-workspace-id` and `x-prism-execution-mode` from tool input only when users explicitly supply them. These are tool-call inputs, not adapter configuration.
  - Package boundary: create `examples/prism-mcp-adapter/` as a separate package. Prefer a root npm workspace entry so root installs/tests can resolve the example package dependencies without adding MCP SDK dependencies to root `dependencies`.
  - Testing convention: use Vitest (`vitest run`) and behavior-level tests with mocked `fetch`/mock Prism responses, matching existing repo conventions.
- Relevant docs or library capabilities:
  - MCP TypeScript SDK v1 supports local stdio servers with `McpServer` and `StdioServerTransport`; tools are registered with input schemas and can return `isError: true` for tool-level failures. Use the SDK instead of hand-rolling JSON-RPC over stdin/stdout.
  - SDK package metadata currently reports `@modelcontextprotocol/sdk` v1.29.0 and a required `zod` peer dependency. Use `zod/v4` or compatible Zod schema imports.
- Existing examples in this codebase:
  - No `examples/` directory exists yet. Existing `docs/implementation-reviews/` files establish the expected architecture-brief location and style.
  - Existing route/service tests provide response-shape fixtures and secret-redaction canaries that adapter tests should mirror.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate Prism developer-token hashing/resolution (`developer-token.ts`, stores, status route).
  - Do not duplicate or hard-code policy semantics beyond the bounded representative adapter method mapping; method availability must come from `/v1/prism/capabilities`.
  - Do not call Slack Web API directly, add Slack SDK clients, read Slack token env vars, run Slack OAuth locally, refresh Slack tokens locally, or store Slack credentials locally.
  - Do not bypass `/v1/slack/api/{method}` by importing server-only Prism modules from the example package. The adapter must remain a Local tool that talks over HTTP.
  - Do not reimplement MCP transport/protocol; use the MCP SDK stdio transport.
  - Do not write audit records, rate-limit state, or policy decisions from the adapter; those are Prism hosted-service responsibilities.
- Shortcuts or parallel paths to avoid:
  - Avoid adding MCP SDK dependencies to the hosted service root runtime dependencies. If workspaces are added, keep adapter dependencies scoped to `examples/prism-mcp-adapter/package.json`.
  - Avoid printing full URLs containing secrets, Authorization headers, env dumps, request bodies, or Slack payload contents. Use central redaction for all thrown/logged errors.
  - Avoid exposing denied tools as if usable. If MCP dynamic tool availability is awkward, fail the tool call clearly with Prism-derived denial and keep `listTools` descriptions honest.
  - Avoid treating every HTTP 429 as the same failure; distinguish Prism-side and upstream Slack rate limits using `X-Prism-Upstream-Called` and Slack headers/body.
- Invariants:
  - Adapter config is only `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN` unless a later issue explicitly approves optional knobs.
  - Startup must fail safely for missing/malformed Prism config or detected Slack credential-like environment variables.
  - Every outbound Prism request uses the Prism developer token as bearer auth and never includes a Slack credential or local `token` payload field.
  - Error and diagnostic output redacts `prism_dev_*`, `xox[baprs]-*`, refresh/access/client-secret-like values, and Authorization headers.
  - No root hosted-service behavior should change for issue #13.

## Integration plan

- Insert the change at:
  - Add `examples/prism-mcp-adapter/` as a separate Node/TypeScript package.
  - Recommended files/modules:
    - `package.json`: private/example package, `type: module`, bin entry, scripts `build`, `test`, `dev`/`start`, and optionally `verify:mock` if it is a real runnable check.
    - `tsconfig.json` and local `vitest.config.ts` if needed for package-local strict ESM tests.
    - `README.md`: setup, MCP client config snippet, representative tools, failure modes, security boundary, live QA steps, and explicit non-goals.
    - `src/config.ts`: read/validate only `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`; reject Slack credential-like env vars; normalize base URL.
    - `src/redaction.ts`: central secret redaction used by all errors/logging/tests.
    - `src/prism-client.ts`: fetch wrapper for status, capabilities, and Slack-compatible method calls; JSON parsing; selected header capture; timeout/error classification; no payload logging.
    - `src/capability-gate.ts`: interpret status/capability responses into startup/tool availability decisions and Prism-derived failures.
    - `src/tool-mappings.ts`: bounded representative MCP tools mapped to `conversations.list`, `conversations.history`, `search.messages`, and `chat.postMessage`; include required surface/workspace/execution-mode inputs where needed.
    - `src/mcp-server.ts`: create `McpServer`, register allowed tools with Zod schemas, return structured Slack-shaped results or `isError: true` failures.
    - `src/index.ts`: CLI/bin entry that builds config/client, performs startup status/capability gate, connects `StdioServerTransport`, and writes only redacted startup failures to stderr.
    - `src/*.test.ts` or `tests/*.test.ts`: behavior tests for config/redaction/client/gate/mappings/server.
  - Root package integration:
    - Prefer adding npm `workspaces: ["examples/prism-mcp-adapter"]` so `npm install` captures adapter deps in the root lockfile and root `npm test` does not fail due unresolved example dependencies.
    - Add a root script such as `test:examples` only if useful; keep root `npm test` green. Do not move existing Next/Vitest config in a way that changes current route tests.
- Why this is the correct integration point:
  - The issue explicitly requires a separate Local tool example outside the Prism hosted service, and Prism docs define Local tools as callers of Prism, not owners of Slack credential custody or policy.
  - `examples/prism-mcp-adapter/` makes the boundary inspectable and copyable while avoiding imports from `src/server/**`, whose dependency guard marks core server modules as `server-only`.
  - MCP stdio is a local process-spawned integration, matching the adapter's target usage for coding agents and local MCP clients.
- Alternatives considered and rejected:
  - **Inside Next app/app routes:** rejected because it blurs hosted service vs Local tool ownership and would add MCP dependencies to server runtime.
  - **Importing `method-registry.ts` into the adapter:** rejected because it bypasses `/v1/prism/capabilities`, duplicates server-owned policy projection, and violates `server-only` boundaries.
  - **Direct Slack SDK/Web API calls:** rejected; it would move Slack credential handling to the Local tool and defeat Prism.
  - **Hand-rolled stdio JSON-RPC:** rejected; MCP SDK already owns transport/protocol framing and validation patterns.
  - **Implementing every Slack method:** rejected by issue scope; use representative tools only.

## Regression checklist

- Behavior: Existing `npm test` remains green for all root hosted-service tests (baseline: 33 files / 91 tests passed).
- Behavior: `npm run build` for the root Next app still succeeds after package/workspace changes.
- Behavior: Existing status/capability routes keep no-store headers, request IDs, active/invalid/expired/revoked/reauth/missing-identity shapes, and no secret leakage.
- Behavior: Existing `/v1/slack/api/[method]` route continues policy-before-forwarding, surface/workspace checks, execution-mode handling, rate limits, metadata-only audit, and Slack-shaped body pass-through.
- Behavior: Hosted service dependencies remain free of Supabase/Auth/PostgREST and core `src/server/**` modules keep `import "server-only";`.
- Behavior: Adapter startup and tool failures never print plaintext Prism developer tokens or Slack credential-like strings.
- Behavior: Adapter tests/verification do not require real Slack credentials and do not depend on live third-party Slack calls.

## Test plan

- Existing tests to keep green:
  - Root `npm test` suite, especially `app/v1/prism/status/route.test.ts`, `app/v1/prism/capabilities/route.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, `src/server/token-profiles/local-tool-capabilities.test.ts`, `src/server/token-profiles/method-policy.test.ts`, `src/server/slack/forwarding.test.ts`, `src/server/slack/response-adapter.test.ts`, `src/server/slack/rate-limit.test.ts`, and `src/server/dependency-guard.test.ts`.
  - Root `npm run build` after dependency/workspace changes.
- New tests to add before/with implementation:
  - Config tests: requires `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`; normalizes base URL; rejects Slack credential-like env vars; rejects malformed Prism token values if the adapter validates format locally; all errors redacted.
  - Prism client tests: sends bearer Authorization to Prism only; preserves selected diagnostic/retry headers; classifies JSON parse, transport, status, capability, policy, Prism-rate-limit, and upstream-rate-limit failures; never includes Authorization/token/request body content in thrown messages.
  - Capability/status gate tests: active token enables only methods with `status:"allowed"`; invalid/expired/revoked tokens fail before tool registration; reauth required is distinct; denied/unsupported methods are not exposed or fail with Prism-derived clear messages.
  - MCP server/tool mapping tests with mocked Prism responses: `list_channels -> conversations.list`, `channel_history -> conversations.history`, `search_messages -> search.messages`, `post_message -> chat.postMessage`; surface/workspace/execution-mode headers are passed when supplied; Slack-shaped response content and request IDs are returned; `isError:true` is used for tool failures.
  - Secret hygiene tests: canary `prism_dev_*`, `xoxb-*`, `xoxp-*`, refresh/access/client-secret strings, message text/block canaries, and Authorization headers do not appear in logs/errors/test snapshots except where intentionally sent to mocked request headers and then asserted not logged.
  - Runnable verification: a package-local command such as `npm --workspace <adapter-package> test` or `npm --prefix examples/prism-mcp-adapter test` must pass without live Slack credentials.
- Live proof required:
  - Start local Prism (`npm run db:up`, `npm run db:migrate`, `npm run dev`) and use a locally generated Prism developer token/profile.
  - Run the adapter over stdio with `PRISM_BASE_URL=http://localhost:3732` and `PRISM_DEVELOPER_TOKEN=<local Prism developer token>` using either an MCP inspector/client or a package verification script.
  - Demonstrate: startup calls `/v1/prism/status` and `/v1/prism/capabilities`; allowed representative read/write calls reach `/v1/slack/api/{method}`; denied/unsupported/reauth/rate-limit cases surface distinctly; terminal output contains request IDs/retry guidance but no plaintext secrets.

## Risk assessment

- Risk: Adding a workspace/example package can alter root dependency resolution or make root Vitest discover example tests before dependencies are installed.
- Risk: Importing server-only Prism modules into the adapter would create a parallel in-process policy path and could break browser/server-only dependency guards.
- Risk: Registering tools solely at startup can make MCP tool availability stale if Token profile capabilities change while the process is running.
- Risk: Overzealous logging/redaction mistakes could leak Prism developer tokens, Authorization headers, Slack-shaped message/search/file contents, or Slack credential-like strings.
- Risk: Confusing Prism 429 vs upstream Slack 429 would mislead Local tool authors about retry ownership.
- Risk: Tool schemas may omit Prism-required surface context for methods like `conversations.history` and `chat.postMessage`, causing avoidable policy denials.
- Risk: MCP SDK package generation mismatch: current stable v1 uses `@modelcontextprotocol/sdk`, while main-branch v2 docs reference split `@modelcontextprotocol/server` packages. Accidentally mixing these conventions would break installs/imports.
- Mitigation:
  - Keep the example package isolated, test both package-local and root commands, and use npm workspace lockfile updates deliberately.
  - Treat `/v1/prism/capabilities` as the source of method availability; re-check or refresh capabilities before calls that might have become unavailable.
  - Centralize redaction and assert canaries in tests.
  - Preserve diagnostic headers in structured results/errors and document rate-limit distinctions.
  - Use v1 SDK imports unless implementation intentionally chooses and validates the newer split package generation.

## Decision confidence

- Confidence: high
- Reasons:
  - The issue/PRD, glossary, and current code agree on the key boundary: Prism hosted service owns credentials/policy/forwarding/audit; Local tools call Prism using only a Prism developer token.
  - Existing status, capabilities, and Slack-compatible routes already expose the integration contract the adapter needs.
  - MCP stdio server support is a standard SDK capability and maps directly to the requested local MCP adapter.
  - The implementation can be contained in a separate example package with behavior tests and without modifying hosted-service policy semantics.
- Open questions:
  - Whether maintainers prefer root npm workspaces or a completely standalone `examples/prism-mcp-adapter` install flow. Architecture recommendation is workspaces for dependency/test reliability while keeping dependencies scoped to the example package.
  - Whether the adapter should omit denied tools from `listTools` entirely or expose them with clear denial responses. Recommendation: omit denied tools after startup capability discovery where possible, and still guard each call for stale capability changes.
  - Whether optional non-secret config such as timeout/log level is acceptable. Given the current goal says configured only by `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`, recommendation is no optional config in this slice unless implementation finds a testability blocker.
