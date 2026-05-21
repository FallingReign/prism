# Architecture Integration Brief: issue-2-substrate

## Existing ownership

- Package/component/module/library:
  - Today no product package owns this behavior. The repository has only `.gitignore`, `AGENTS.md`, `CONTEXT.md`, `docs/adr/0001-nextjs-postgres-substrate.md`, and `prism_slack_bridge_brief.docx`; there is no `package.json`, Next.js app, Docker Compose file, database module, or tests yet.
  - The architectural owner to establish is the **Prism hosted service**: a TypeScript full-stack Next.js application whose App Router route handlers own the website and `/v1/*` API boundary.
  - Database connectivity should be owned by a small server-only Postgres module built on plain `pg`/node-postgres, not by Supabase/Auth/PostgREST or an ORM introduced without a separate decision.
- Current owner rationale:
  - ADR 0001 states that Prism starts as a TypeScript full-stack hosted service using Next.js route handlers for the website and `/v1/*` API, backed by plain Postgres in Docker for local development.
  - Issue #2 is explicitly the substrate slice: prove the hosted service boundary, plain Postgres local substrate, non-sensitive health surface, and config separation before Slack OAuth, Prism developer token verification, capability maps, or Slack-compatible endpoints.
- Source evidence:
  - `docs/adr/0001-nextjs-postgres-substrate.md`: Next.js route handlers plus plain Postgres in Docker; Supabase optional later.
  - `CONTEXT.md`: Prism hosted service owns Slack OAuth callbacks, Slack credential custody, policy enforcement, Slack API forwarding, rate limits, and metadata-only audit; Prism website is the user-facing surface.
  - GitHub issue #1: child issues must respect ADR 0001; no Supabase Auth, Realtime, Storage, or PostgREST dependency in v1.
  - GitHub issue #2: local dev must start Prism hosted service and plain Postgres together without Supabase platform services; health/readiness must prove required substrate without exposing secrets.
  - Current runtime/code evidence: no package or app exists yet, so ownership conventions must be created in this slice rather than integrated into an existing implementation.

## Existing interaction model

- User/system behaviors that already exist:
  - There is no runnable local application yet: no Next.js dev server, no Postgres compose service, no health route, and no automated tests.
  - Documentation already establishes the conceptual behavior: Local tools call Prism with opaque Prism developer tokens; Slack credentials remain only in the Prism hosted service; the Prism website is the user-facing web surface.
- Behaviors that must remain unchanged:
  - Do not represent Prism as a local bridge, admin console, Slack administration product, LLM runtime, or unmanaged raw Slack proxy.
  - Do not expose Slack credentials, Postgres credentials, Prism token secrets, or connection strings in responses, logs, frontend bundles, query strings, or docs examples that encourage unsafe patterns.
  - Do not introduce Supabase platform dependencies or an alternate API substrate alongside Next.js route handlers.
  - Preserve `/v1/*` as the service API namespace for Prism APIs; later Slack-compatible endpoints belong under `/v1/slack/*` per the glossary/product brief.
- Runtime or UX evidence:
  - Current runtime cannot start because no app/package files exist. This is expected for the first implementation slice and should be converted into a minimal working substrate.
  - The only existing UX evidence is terminology in `CONTEXT.md` and the product brief: use **Prism hosted service** and **Prism website** in user-facing text.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use **Next.js App Router**. Website pages belong under `app/...`; API/health endpoints belong in `app/.../route.ts` route handlers.
  - Use a route handler for the health/readiness endpoint. Next.js route handlers are defined by `route.ts` files in the `app` directory and support standard Web `Request`/`Response` APIs plus `NextRequest`/`NextResponse` helpers.
  - Avoid placing a `route.ts` at the same segment level as a `page.tsx`; Next.js docs state `route` and `page` conflict at the same route segment.
  - Use plain `pg`/node-postgres for database connectivity. `Pool` is the right primitive for application queries; `pool.query` is sufficient for a single health `select 1` probe; attach an idle `error` listener to avoid unhandled pool errors.
  - Use Docker Compose for local Postgres. Compose service definitions are the standard way to define container-backed app resources; this slice should create a `postgres` service and, if useful, wire the app via npm scripts rather than requiring Supabase.
  - Use environment variables for server-only database config. node-postgres supports libpq-style env vars and connection URI; prefer one server-only `DATABASE_URL` or explicit `PG*` variables plus safe `.env.example`. Keep Slack credential placeholders separate from Prism developer token secret placeholders.
- Relevant docs or library capabilities:
  - Next.js route handlers support `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`; unsupported methods get `405` from Next.js.
  - Next.js route handlers are not cached by default, but health endpoints that query runtime substrate should still explicitly avoid static assumptions if needed, e.g. dynamic runtime route config if implementation/build behavior requires it.
  - node-postgres pools are lazy, support `pool.query`, and can report idle client errors through `pool.on('error', ...)`.
  - Vitest is a lightweight first test stack for pure/server modules and route handler response tests; tests are discovered via `.test.`/`.spec.` files and can run once via `vitest run`.
- Existing examples in this codebase:
  - None. Establish conventions now: server-only modules for config/database/health, App Router folders for website and `/v1` APIs, tests colocated or under a test directory, and Docker Compose for local Postgres.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not use Next.js Pages Router API routes (`pages/api`) alongside App Router route handlers for this slice.
  - Do not add Supabase Auth, Supabase client/server SDKs, Realtime, Storage, PostgREST, Prisma/Drizzle, or a migration framework unless a separate architecture decision approves them.
  - Do not create a custom Node/Express/Fastify server for health; Next.js route handlers own the HTTP surface.
  - Do not use a mock-only or file-based database path as the real local substrate; local development must prove plain Postgres connectivity.
- Shortcuts or parallel paths to avoid:
  - Do not make the website call the database directly from client components; health and DB probes must remain server-side.
  - Do not accept credentials via query strings. Use `Authorization` headers for future Prism developer tokens and environment variables for service config.
  - Do not return raw database errors, environment variable names with values, host/user/password/database, connection strings, stack traces, or Slack credential placeholders from health responses.
  - Do not hard-code secrets into source or compose files. Use non-secret local defaults where safe and `.env.example` placeholders for required secrets.
- Invariants:
  - Health surface proves service status and database reachability without leaking secrets.
  - Slack credentials stay server-side and are not needed for this slice.
  - Prism developer tokens are opaque future local-tool bearer secrets, not JWTs and not Slack tokens.
  - User-facing text says **Prism hosted service** and **Prism website**.
  - `/v1/slack/*` remains available for future Slack-compatible methods; this slice should not preempt it with incompatible routing.

## Integration plan

- Insert the change at:
  - Initialize a minimal TypeScript Next.js App Router project at the repository root, because the repo is greenfield and ADR 0001 makes the hosted service the root package.
  - Add a minimal Prism website shell at `app/page.tsx` (and required layout/global styling only as necessary) using approved terminology.
  - Add a health/readiness route handler under a Prism-owned API namespace, recommended `app/v1/prism/health/route.ts` or `app/v1/prism/status/route.ts`. Given the product brief already reserves `/v1/prism/status` for token/Slack connection status later, prefer **`GET /v1/prism/health`** for substrate readiness now to avoid overloading future token status semantics. If issue wording or maintainers prefer readiness naming, keep the response contract identical.
  - Add server-only modules such as `src/server/config.ts`, `src/server/db.ts`, and `src/server/health.ts` (exact names may vary) so route handlers delegate business logic and tests can exercise healthy/unavailable states without spinning up Next.js.
  - Add `docker-compose.yml` with a plain `postgres` service, local database/user/password defaults suitable only for development, and a persistent named volume. Include `.env.example` with separated groups for database config, Slack credential placeholders, and future Prism developer token hashing/pepper placeholders without real secrets.
  - Add npm scripts for `dev`, `build`, `test`, and a local compose helper if desired. Do not add package files until implementation; this brief only directs placement.
- Why this is the correct integration point:
  - It directly implements ADR 0001 and avoids parallel HTTP/database substrates.
  - It establishes server-owned seams before later Slack OAuth, encrypted credential custody, Prism token verification, rate limits, and metadata-only audit build on the same config/database modules.
  - Keeping health logic in a server module avoids tying tests to Next internals while still using route handlers for the public HTTP contract.
- Alternatives considered and rejected:
  - `pages/api/health`: rejected because ADR 0001 and Next.js current docs point to App Router route handlers.
  - `/api/health`: rejected because the product/ADR reserve `/v1/*` as the Prism API namespace; using `/api` creates a parallel API convention.
  - `/v1/prism/status` for this slice: viable, but less preferred because the product brief defines status as authenticated token/Slack connection status. A separate unauthenticated/non-sensitive `/v1/prism/health` keeps substrate readiness distinct.
  - Supabase local stack: rejected by ADR 0001 and issue acceptance criteria.
  - Full ORM/migrations/auth foundation now: rejected as overbuilding for a greenfield substrate proof; schema/migration decisions can come with the first persisted domain model.

## Regression checklist

- Behavior: `npm run dev` starts the Next.js Prism hosted service without requiring Supabase services.
- Behavior: Docker Compose can start plain Postgres for local development with documented non-secret defaults and no checked-in real secrets.
- Behavior: `GET /v1/prism/health` returns a small JSON object with service status and database status when Postgres is reachable.
- Behavior: The same health path returns a non-2xx readiness response when the database is unavailable or unconfigured, without raw stack traces or secrets.
- Behavior: The website shell renders and uses **Prism hosted service** / **Prism website** terminology.
- Behavior: Environment examples distinguish Slack credentials from Prism developer token secrets and do not encourage query-string credential patterns.
- Behavior: No Supabase/Auth/PostgREST dependency appears in package manifests or runtime configuration.
- Behavior: Existing docs (`CONTEXT.md`, ADR 0001, AGENTS workflow) remain semantically consistent; no broad product scope is introduced.

## Test plan

- Existing tests to keep green:
  - None exist today. Baseline is documentation-only plus an unrunnable empty substrate.
- New tests to add before/with implementation:
  - Unit tests for config loading/validation: missing database config produces a controlled unavailable/degraded state or startup/test error as designed, never exposing secret values.
  - Unit tests for health service logic with a fake/provided query function or pool adapter:
    - database reachable: returns `service: "ok"`, `database: "ok"` (or equivalent stable shape) and an HTTP 200 route response.
    - database unavailable/query fails: returns `service: "ok"`, `database: "unavailable"` (or equivalent), HTTP 503, and sanitized error classification only.
  - Route handler tests for `GET /v1/prism/health` that assert status codes, content type, stable keys, and absence of sensitive fields such as password, token, secret, connection string, host/user if considered sensitive, stack traces, or raw error messages.
  - A dependency/config assertion can be a small test or script check that package manifests do not include `@supabase/*`, `supabase`, `postgrest`, or Supabase Auth dependencies.
  - Build/typecheck test through `npm run build` or `next build` once the package exists.
- Live proof required:
  - From a clean checkout after implementation: install dependencies, copy `.env.example` to `.env` if needed, start Postgres via Docker Compose, run the Next.js dev server, and `curl` the health endpoint.
  - Capture healthy proof: `curl -i http://localhost:<port>/v1/prism/health` returns 200 with only non-sensitive service/database status.
  - Capture unavailable proof: stop the Postgres container or point `DATABASE_URL` to an invalid local port and `curl` the same endpoint; it returns 503/sanitized unavailable state.
  - Run `npm test` and `npm run build` or equivalent scripts and record outputs.

## Risk assessment

- Risk: Choosing the wrong health path could conflict with later `/v1/prism/status` token health semantics.
  - Mitigation: Use `/v1/prism/health` for unauthenticated substrate readiness; reserve `/v1/prism/status` for future authenticated token/Slack connection status unless the implementer explicitly documents a compatible split.
- Risk: Health route may leak credentials through raw errors or config echoing.
  - Mitigation: Return a fixed response schema with enum statuses and optional sanitized error codes only; tests must assert absence of secret-like substrings/fields.
- Risk: Next.js route handler could be accidentally statically optimized or tested only through mocked logic.
  - Mitigation: Make the route dynamic/runtime-bound as needed and include live curl proof against real Docker Postgres.
- Risk: Adding an ORM, auth framework, Supabase, or custom server now would create parallel architecture and constrain later slices.
  - Mitigation: Keep dependencies minimal: Next.js/React/TypeScript, `pg`, test tooling, and Docker Compose Postgres.
- Risk: Environment conventions could blur Slack credentials and Prism developer token secrets.
  - Mitigation: `.env.example` should clearly group `DATABASE_URL`, future `SLACK_*` credential placeholders, and future `PRISM_*` token-secret/hash/pepper config; no query-string credential examples.
- Risk: The current working tree contains only untracked files, so implementation commits could accidentally omit docs or overwrite greenfield decisions.
  - Mitigation: Check `git status` before implementation, preserve existing docs, and stage intentionally.
- Risk: Version choice may drift with newest Next.js/Vitest requirements.
  - Mitigation: Use current stable versions compatible with the installed Node version; Vitest documentation notes Node >=20 for current Vitest.

## Decision confidence

- Confidence: high
- Reasons:
  - Current repo state is genuinely greenfield, so there is little existing code ownership to conflict with.
  - ADR 0001, issue #1, issue #2, `CONTEXT.md`, and the product brief all align on Next.js route handlers plus plain Postgres in Docker and no Supabase platform dependency.
  - Next.js App Router route handlers and node-postgres Pool are direct library matches for the required HTTP and database substrate.
  - The main design choice is endpoint naming; `/v1/prism/health` cleanly separates substrate readiness from the future `/v1/prism/status` token/Slack status endpoint described in the product brief.
- Open questions:
  - Whether maintainers prefer `/v1/prism/health`, `/v1/prism/readiness`, or reusing `/v1/prism/status`. Recommendation remains `/v1/prism/health` unless issue comments specify otherwise.
  - Whether to include a Docker Compose `app` service in this first slice or only a `postgres` service plus npm dev server. Acceptance says local development can start hosted service and Postgres together; a compose `app` service gives the strongest proof, while `docker compose up postgres` plus `npm run dev` is simpler. The implementer should choose the least overbuilt option that satisfies the issue and live verification.
  - Whether to introduce a migration tool now. Recommendation: no migration framework until the first durable domain schema; health can use `select 1`.

## Explicit scout flags for issue #2

- Next.js App Router and route handlers: **Yes.** Use App Router and `app/**/route.ts`; do not use Pages Router API routes or a custom server.
- Docker Compose for Postgres local dev: **Yes.** Use Docker Compose with a plain `postgres` image and no Supabase services.
- Minimal health endpoint shape: recommended unauthenticated `GET /v1/prism/health` returning fixed JSON such as `{ "service": "ok", "database": "ok" }` with HTTP 200 when healthy and `{ "service": "ok", "database": "unavailable" }` with HTTP 503 when the database probe fails. Optional fields may include `timestamp` and `version`; do not include connection strings, host/user/password, raw errors, stack traces, Slack credential names/values, or Prism token secrets.
- Test stack: use Vitest for first-slice unit/route-handler tests because it is lightweight for TypeScript server logic and avoids browser/E2E overbuild. Add live `curl` verification separately after starting Next.js and Docker Postgres.
- Contradictions found:
  - No substantive contradiction between ADR, issues, glossary, and product brief.
  - Minor scope nuance: the prompt says tests verify healthy and database-unavailable states; GitHub issue #2 allows tests **or documented verification** for startup/unavailable cases. Prefer tests for both states because the prompt and quality bar require them.
  - Minor endpoint nuance: product brief names `/v1/prism/status` for token health/Slack connection status, while issue #2 asks for a health/readiness path. Use `/v1/prism/health` now to avoid semantic collision, or document any different choice.
  - Current repo state has no package/app/tests at all, so implementation must establish conventions rather than preserve existing runtime behavior.
