# Architecture Integration Brief: admin-authorization-scoped-shell

## Existing ownership

- Package/component/module/library:
  - **Domain language:** `CONTEXT.md` owns the definitions for Prism admin console/admin scope. It defines Prism admin as Slack-authenticated, allowlisted by Slack user ID, optionally Enterprise Grid/workspace scoped, with global/enterprise/team least-privilege semantics (`CONTEXT.md:23-29`, `CONTEXT.md:133-134`).
  - **Website session and Slack identity:** `src/server/slack/oauth-flow.ts` owns `prism_session` cookie creation, session token hashing, and Slack OAuth callback identity capture (`oauth-flow.ts:8-10`, `oauth-flow.ts:126-157`, `oauth-flow.ts:160-185`). `src/server/slack/postgres-store.ts` owns `prism_sessions -> slack_connections` lookup and exposes the current Slack user/team/enterprise (`postgres-store.ts:153-193`).
  - **Session-scoped website behavior:** `app/page.tsx` owns current Prism website shell composition. It reads the HTTP-only `prism_session` cookie, resolves Slack status, and conditionally loads Token profiles/activity only for linked sessions (`app/page.tsx:23-31`, `app/page.tsx:81-108`, `app/page.tsx:113-132`).
  - **Website API route conventions:** `app/v1/prism/token-profiles/route.ts`, `app/v1/prism/status/route.ts`, and `app/v1/prism/slack-connection/route.ts` own the current Prism API pattern: route handlers generate request IDs, read either the session cookie or bearer token, delegate to server modules, return no-store JSON, and avoid secret-bearing fields (`token-profiles/route.ts:13-34`, `token-profiles/route.ts:36-69`, `status/route.ts:12-38`, `slack-connection/route.ts:12-35`).
  - **Local-tool authorization:** `src/server/token-profiles/local-tool-status.ts`, `src/server/token-profiles/method-policy.ts`, and `app/v1/slack/api/[method]/route.ts` own Prism developer-token resolution and Slack-compatible forwarding. This is not the admin auth owner but must remain unaffected (`local-tool-status.ts:160-180`, `method-policy.ts:61-112`, `app/v1/slack/api/[method]/route.ts:29-89`).
  - **Visual primitives:** `app/ui.tsx` wraps shadcn/Radix primitives into Prism-local `Button`, `LinkButton`, `Panel`, `StatusBadge`, `Notice`, and `SummaryMetric` components; `app/globals.css` owns Prism tokens and global visual language (`app/ui.tsx:48-156`, `app/globals.css:46-90`, `app/globals.css:101-140`).
  - **Persistence substrate:** ADR 0001 says Next.js route handlers and plain Postgres are the app/API substrate (`docs/adr/0001-nextjs-postgres-substrate.md:1-3`). The current schema stores users, sessions, Slack connections, encrypted credentials, Token profiles, developer-token verifiers, and metadata-only audit in Postgres (`db/migrations/0001_slack_oauth_custody.sql:1-54`, `0002_prism_developer_tokens.sql:122-139`, `0003_prism_activity_audit.sql:1-52`).
- Current owner rationale:
  - Admin authorization is a server-side website-session decision over existing Slack identity, not a Slack-compatible local-tool token decision and not Slack administration. It belongs in a new server-only admin identity module that reuses the existing `prism_session -> prism_user -> latest slack_connection` data boundary.
  - Admin shell UI belongs under the existing App Router website surface and must reuse local Prism UI primitives rather than introducing a second frontend/auth shell.
- Source evidence:
  - Issue #33 asks only for admin authorization and the first scoped shell; it explicitly excludes user directory data, policy editing, and cross-user mutations.
  - Issue #32 requires admin authorization, global policy, and admin action audit to be deep server modules and says admin console must reuse existing session, Slack connection, Token profile, and metadata-only audit boundaries.
  - Baseline investigation: `npm test -- --runInBand` fails because Vitest does not support Jest's `--runInBand`; `npm test` exits successfully on the current tree.

## Existing interaction model

- User/system behaviors that already exist:
  - Slack OAuth callback upserts a Prism user keyed by Slack team/user, upserts a Slack connection, stores encrypted Slack credentials, and creates an HTTP-only website session (`oauth-flow.ts:126-157`, `postgres-store.ts:31-84`).
  - Current website pages and website APIs treat missing/expired session as not linked or unauthenticated by resolving through the session cookie hash (`postgres-store.ts:153-193`, `token-profiles/store.ts:14-30`, `audit/postgres-store.ts:55-99`).
  - Website Token profile APIs return no-store JSON with request IDs, and tests assert no Prism developer tokens, token hashes, peppers, Slack tokens, credential envelopes, or client secrets leak in responses/queries (`token-profiles/route.test.ts:118-167`, `token-profiles/route.test.ts:169-242`).
  - Local-tool endpoints use `Authorization: Bearer prism_dev_...`, not the browser session, and distinguish invalid/expired/revoked bearer tokens without exposing secrets (`docs/setup.md:15-55`, `app/v1/prism/status/route.test.ts:58-88`, `app/v1/prism/status/route.test.ts:90-152`).
  - Slack-compatible `/v1/slack/api/{method}` preserves Slack-shaped responses and uses Prism diagnostics headers; Slack admin/app/team methods are unsupported via Method registry (`docs/setup.md:57-95`, `method-registry.ts:65-85`, `app/v1/slack/api/[method]/route.test.ts:140-170`).
  - Linked users may remove their local Slack connection through the existing Prism-local route; it records metadata-only audit and deletes only the current connection, relying on schema cascades (`connection-management.ts:23-84`, `app/v1/prism/slack-connection/route.ts:12-35`).
- Behaviors that must remain unchanged:
  - Non-admin Slack-authenticated users must still use the normal Prism website for Slack linking, Token profile management, connection removal, and metadata audit.
  - Missing/expired sessions must be denied for admin pages/APIs without revealing whether a Slack user ID is allowlisted.
  - Local-tool bearer-token flows (`/v1/prism/status`, `/v1/prism/capabilities`, `/v1/slack/api/*`) must continue to work for non-admin users and must not consult admin allowlist state.
  - Admin allowlist data, session token hashes, Slack credentials, credential envelopes, Prism developer tokens, developer-token hashes, peppers, Slack payloads, and raw allowlist internals must not be rendered, returned, logged, or persisted to audit.
  - Slack administration remains out of scope: no Slack admin methods, app uninstall/revoke APIs, SCIM, Audit Logs, workspace membership management, or Slack app scope management (`docs/security.md:62-67`, `method-registry.ts:65-85`).
- Runtime or UX evidence:
  - Current homepage has a Prism product header/nav/status badge pattern that the admin shell can reuse (`app/page.tsx:32-79`).
  - Current UI primitives render shadcn-backed cards/badges/alerts/buttons without style attributes or secret-like strings (`app/ui.test.tsx:6-26`).
  - Current Token profile client panel calls existing Prism website APIs directly and maintains copy-once token semantics in client state (`app/token-profiles-panel.tsx:25-67`, `app/token-profiles-panel.tsx:69-99`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a server-only admin identity module under `src/server/admin/`, e.g. `authorization.ts`, with a small public seam such as `resolveAdminDecision({ store, allowlist, sessionToken, now }) -> admin | non_admin | unauthenticated`. Start the file with `import "server-only";` and add it to dependency-guard coverage.
  - Add a Postgres-backed admin session store that reuses `hashSecret` and queries `prism_sessions` joined to `prism_users` and the latest `slack_connections` row, selecting only safe identity fields needed for authorization: Prism user ID, Slack user ID, team ID/name, enterprise ID/name, connection status, and expiry. The query should mirror existing `getSlackConnectionDisplayRecordForSession` / `resolveOwner` semantics (`postgres-store.ts:153-193`, `token-profiles/store.ts:14-30`).
  - Add allowlist config loading as server-only operational config. Use a committed example JSON file documenting global, enterprise-scoped, and team-scoped entries, and a gitignored local JSON file for real IDs. Reuse `src/server/config.ts` style for configured/required values where environment path override is useful (`config.ts:31-39`, `config.ts:111-120`, `config.ts:127-138`).
  - Add admin shell page(s) under the website namespace, recommended `app/admin/page.tsx`, with `dynamic = "force-dynamic"`, server-side cookie lookup through `cookies()`, and a redirect/not-found/403 UI branch based on the admin resolver. Do not use client-side fetch as the source of admin authorization.
  - Add at least one admin API route under a Prism namespace, recommended `app/v1/prism/admin/session/route.ts`, to prove route authorization and expose only the active admin decision/scope for future admin pages. Follow existing no-store/request-ID route conventions (`token-profiles/route.ts:13-34`, `status/route.ts:33-38`, `slack-connection/route.ts:30-35`).
  - Reuse `app/ui.tsx` primitives and shadcn components already present in `components/ui/*` for the admin shell, plus existing Prism header/card classes from `app/page.tsx`. `lucide-react` is available but optional (`package.json:18-32`).
  - Use Vitest with existing patterns: pure server unit tests with memory/fake stores, route tests with mocked `src/server/db`, and render tests with `renderToStaticMarkup` (`oauth-flow.test.ts:9-60`, `token-profiles/route.test.ts:4-17`, `ui.test.tsx:1-26`).
- Relevant docs or library capabilities:
  - Next.js App Router route handlers support `NextRequest`, `NextResponse`, cookies, dynamic server rendering, and `redirect`/`notFound` on server pages; existing code already uses these patterns (`app/page.tsx:1-25`, `app/v1/prism/*/route.ts`).
  - TypeScript has `resolveJsonModule: true`, but runtime JSON allowlist loading should avoid bundling real local files into client code and should stay in server-only modules (`tsconfig.json:16-18`).
- Existing examples in this codebase:
  - `src/server/slack/connection-management.ts` is the model for a narrow server-only service/store with explicit unauthenticated/not-linked/not-found outcomes (`connection-management.ts:7-36`).
  - `src/server/token-profiles/service.ts` is the model for resolving the current session owner before performing website-scoped operations (`service.ts:110-171`).
  - `app/slack-status-panel.tsx` and `app/page.tsx` are the model for showing safe Slack scope/user identity in a Prism-styled shell (`slack-status-panel.tsx:121-156`, `app/page.tsx:32-79`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a second browser/session/auth mechanism, client-visible session token, JWT, localStorage admin flag, Slack OAuth path, or Slack SDK/admin-auth path.
  - Do not use Prism developer tokens or `/v1/slack/api/*` forwarding to authorize admin console access; admin access is website-session + Slack identity allowlist only.
  - Do not bypass `prism_sessions` expiry checks or `hashSecret`; never compare raw session tokens in SQL or logs.
  - Do not duplicate Slack connection status enrichment/display logic just to show admin scope. Use the existing latest Slack connection/session model and safe display helpers where applicable.
  - Do not replace existing Token profile service/store/policy logic or Slack method registry for this slice.
  - Do not add a database admin role table or UI-editable allowlist in this slice; issue #33 chooses operational JSON allowlist, not user directory/policy editing.
- Shortcuts or parallel paths to avoid:
  - No client-side `fetch('/v1/prism/admin/session')` as the gate for rendering protected admin content. API authorization is needed, but page authorization must be server-side.
  - No broad admin directory, global policy editor, destructive cross-user actions, admin action audit, or cross-user mutation endpoints yet.
  - No committed real Slack user IDs. Example IDs should be clearly fake placeholders; real local IDs belong only in the gitignored local file.
  - No response fields that expose allowlist file paths, full entry sets, parse details, or whether a non-current Slack user would be authorized.
  - No Slack admin language implying Prism admin equals Slack admin. Use `Prism admin`, `admin scope`, `global`, `enterprise`, and `team` per `CONTEXT.md`.
- Invariants:
  - Admin decision is server-owned, deterministic, and reusable by future admin directory/policy/mutation slices.
  - Decision scope must distinguish `global`, `enterprise`, and `team`; enterprise/team decisions must include the matched scope ID for later scoping checks.
  - Scope match requires current session Slack identity: same Slack user ID plus matching enterprise/team if the allowlist entry is scoped.
  - Missing session, expired session, non-admin, and scope mismatch all deny admin pages/APIs without leaking allowlist internals.
  - Existing non-admin website and local-tool flows must behave exactly as before.

## Integration plan

- Insert the change at:
  - **Allowlist files:** add a committed example file such as `config/prism-admin-allowlist.example.json` with entries for `{ "slackUserId": "U...", "scope": { "kind": "global" } }`, enterprise scope, and team scope. Add a local runtime file such as `config/prism-admin-allowlist.local.json` to `.gitignore` for real IDs. If implementation chooses a different directory, keep it outside `app/` and only import/read it from server-only code.
  - **Config loading:** extend `src/server/config.ts` or add `src/server/admin/allowlist.ts` to load the local allowlist path from an env var with a safe default, validate shape, normalize entries, and treat missing local file as an empty allowlist. Parse errors should fail closed and be testable; route responses should map them to a generic setup/unavailable error without exposing contents.
  - **Admin resolver:** add `src/server/admin/authorization.ts` containing types for `AdminScope = global | enterprise | team`, the session identity store interface, and matching logic. Match by `slackUserId`; global matches any current team/enterprise, enterprise matches only when `current.enterpriseId === entry.enterpriseId`, team matches only when `current.teamId === entry.teamId`.
  - **Postgres store:** add a store under `src/server/admin/postgres-store.ts` or a clearly named sibling that performs the current-session lookup. Prefer a query based on `prism_sessions s join prism_users u join slack_connections c` with `s.session_token_hash = $1 and s.expires_at > $2`, ordered by `c.updated_at desc limit 1`, selecting safe identity/display fields.
  - **Admin page:** add `app/admin/page.tsx` as the first scoped admin console shell. It should call the resolver server-side from the `prism_session` cookie. Authorized admins see the Prism admin console shell, active scope badge/details, and clear placeholder/empty-state copy for future directory/policy areas. Missing/non-admin should render a generic denied/not found page or redirect that does not disclose allowlist internals.
  - **Admin API:** add `app/v1/prism/admin/session/route.ts` (or equivalent first admin API) that resolves the same decision and returns no-store JSON plus `X-Prism-Request-ID`. Authorized response may include `admin: true`, `scope.kind`, matched `teamId`/`enterpriseId` as applicable, and safe current Slack identity; denied response should be generic (`401` for missing/expired session, `403` for non-admin/scope mismatch) and secret-free.
  - **Tests:** add unit tests for allowlist parsing/matching and route/page behavior before or with implementation. Add dependency guard coverage so admin authorization/config/store modules remain server-only.
- Why this is the correct integration point:
  - Existing session and Slack connection modules already establish the current Slack identity trusted by the Prism website. Building admin auth on top of that avoids parallel auth and keeps Slack credential custody untouched.
  - A server-only admin module gives future admin directory, policy, and destructive-action slices one reusable decision object instead of scattering allowlist checks across routes/components.
  - App Router `app/admin/page.tsx` is the smallest website shell path that can use existing visual primitives and server-rendered session checks.
  - `/v1/prism/admin/*` correctly names Prism-local admin APIs and avoids Slack-compatible endpoint semantics.
- Alternatives considered and rejected:
  - **Database allowlist table now:** rejected because issue #33 requires local operational allowlist files and no admin directory/policy editing yet.
  - **Environment variable list only:** rejected as the only source because acceptance requires a committed example allowlist and gitignored local file; an env var may only override the local file path.
  - **Middleware-only gate:** rejected as the primary decision owner because future admin APIs/services need a testable reusable decision object. Middleware can supplement later, not replace resolver tests.
  - **Client-only admin shell gate:** rejected because it leaks route existence/HTML and creates a parallel auth path around server-rendered pages.
  - **Using Slack admin APIs or Slack workspace roles:** rejected as out of scope and contrary to Prism-admin allowlist semantics.

## Regression checklist

- Behavior: Existing `npm test` remains green; avoid Jest-only flags such as `--runInBand`.
- Behavior: `/` remains dynamic/session-scoped and still supports not-linked, linked healthy, and reauth-required states.
- Behavior: `/v1/slack/oauth/start` and callback continue to create website sessions and encrypted credential custody without exposing Slack secrets.
- Behavior: `/v1/prism/token-profiles*` still supports create/list/revoke/delete/rotate/policy for non-admin users and keeps copy-once token semantics.
- Behavior: `/v1/prism/status`, `/v1/prism/capabilities`, and `/v1/slack/api/*` continue using Prism developer-token bearer auth only; admin allowlist changes do not affect local-tool tokens.
- Behavior: `/v1/slack/api/*` still rejects unsupported Slack admin/app/team methods without upstream calls.
- Behavior: Admin pages/APIs deny missing sessions, expired sessions, non-admin sessions, and scope mismatches without revealing allowlist internals.
- Behavior: Global, enterprise, and team admin decisions are distinguishable in server tests and visible in the admin shell.
- Behavior: Example allowlist is committed with fake IDs; real local allowlist path is gitignored.
- Behavior: All new admin server modules are `server-only` and no allowlist/session logic imports into client components.
- Behavior: No Slack credentials, Prism developer tokens, token hashes, peppers, credential envelopes, Slack payloads, raw allowlist contents, or local file paths appear in UI/API responses/tests/logs.

## Test plan

- Existing tests to keep green:
  - Full `npm test` suite.
  - Current OAuth/session tests: `src/server/slack/oauth-flow.test.ts`, `app/v1/slack/oauth/start/route.test.ts`, `app/v1/slack/oauth/callback/route.test.ts`.
  - Current website/session route tests: `app/v1/prism/token-profiles/route.test.ts`, `app/v1/prism/slack-connection/route.test.ts`, `app/v1/prism/status/route.test.ts`, `app/v1/slack/api/[method]/route.test.ts`.
  - Current no-secret and guard tests: `app/ui.test.tsx`, `src/server/docs-guard.test.ts`, `src/server/dependency-guard.test.ts`.
- New tests to add before/with implementation:
  - Allowlist parser tests: accepts example/global/enterprise/team entries; rejects malformed, missing Slack user ID, unknown scope kind, empty scoped IDs, duplicate/conflicting entries if disallowed; missing local file resolves to empty allowlist; parse failure fails closed.
  - Admin resolver unit tests: global admin, enterprise admin, team admin, non-admin, missing session, expired session, scope mismatch, same Slack user with unmatched enterprise/team, and precedence when multiple entries match. Recommendation: if multiple entries match, choose the broadest effective scope (`global` over `enterprise` over `team`) for clarity and document/test that rule.
  - Postgres store tests or route-level SQL mocks proving only non-expired `prism_session` rows authorize and the latest Slack connection identity is used consistently with existing website semantics.
  - Admin API route tests for `401` missing/expired session, `403` non-admin/scope mismatch, `200` global/enterprise/team decisions, no-store headers, request ID header/body, and no secret/allowlist leakage.
  - Admin page/shell render tests for authorized global/enterprise/team scopes, generic denied state, existing Prism visual primitives, accessible headings/badges, and no secret-like strings.
  - Dependency guard update covering new `src/server/admin/*` modules with `import "server-only";`.
- Live proof required:
  - After implementation, run migrations/config setup as needed, start the app with `npm run dev` on port `3732`, and use mock/local Slack session setup if available.
  - Verify as a non-admin linked user that `/` and local-tool bearer endpoints still work while `/admin` and `/v1/prism/admin/session` deny access.
  - Add a local allowlist entry for the current Slack user ID, verify `/admin` shows active scope, then test global, enterprise-scoped, team-scoped, and scope-mismatch entries.
  - Capture browser proof of the admin shell and denial state; inspect console/network for no secret-like material and confirm no-store/request-ID headers on admin API responses.

## Risk assessment

- Risk: Introducing admin auth could accidentally create a parallel session/auth path. Mitigation: resolver must use existing `prism_session`, `hashSecret`, session expiry, and Slack connection identity only.
- Risk: Allowlist examples or tests could commit real Slack IDs or sensitive local config. Mitigation: use obvious fake IDs in committed example/tests and add the local allowlist file to `.gitignore` before real use.
- Risk: Route responses could reveal allowlist internals, local file paths, or whether a Slack user is administratively trusted. Mitigation: denied responses should be generic; detailed parse/match info should stay inside tests or safe server logs without contents.
- Risk: Enterprise/team matching may be ambiguous for Slack users with multiple connections or missing enterprise IDs. Mitigation: define resolver semantics over the current/latest website Slack connection, test null enterprise/team mismatch, and stop for product clarification if future multi-connection admin views need a different model.
- Risk: Admin page shell might accidentally import server-only allowlist logic into a client component. Mitigation: keep resolver calls in server pages/route handlers; pass only safe decision props to any client components.
- Risk: Existing local-tool token flows may be coupled to newly added config or guard tests. Mitigation: keep admin modules separate from token-profile/local-tool modules and run existing route tests.
- Risk: `.gitignore` currently ignores `.env*` but not an admin allowlist local JSON (`.gitignore:3-15`). Mitigation: implementation must add the specific local allowlist path to `.gitignore` as part of the acceptance criteria.
- Risk: Metadata-only audit/status constraints might be prematurely extended for admin actions. Mitigation: do not add admin action audit in this slice; reserve audit schema changes for destructive-action slices.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing ownership is clear: website sessions and Slack identity already exist server-side, while local-tool bearer auth is separate and should not be reused for admin.
  - Issue #33 scope is intentionally narrow: allowlist resolver, denial behavior, first admin shell, and tests; no directory/policy/mutations are needed.
  - Current route, service/store, no-store, request-ID, no-secret, and UI primitive patterns give concrete implementation examples.
  - Baseline `npm test` succeeds, providing a reliable regression target.
- Open questions:
  - Exact allowlist file path/name is not prescribed. Recommendation: `config/prism-admin-allowlist.example.json` committed and `config/prism-admin-allowlist.local.json` gitignored, with optional env override.
  - If multiple matching entries exist for one Slack user/current connection, precedence is not specified. Recommendation: choose broadest effective scope (`global`, then enterprise, then team) and test it.
  - Denied admin page UX is not specified. Recommendation: use a generic 404/403-style Prism page with no allowlist hints; API should use `401` missing/expired session and `403` authenticated non-admin/scope mismatch.
