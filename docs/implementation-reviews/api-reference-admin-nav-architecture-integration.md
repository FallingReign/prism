# Architecture Integration Brief: api-reference-admin-nav

## Existing ownership

- Package/component/module/library:
  - **Domain language and scope:** `CONTEXT.md` owns Prism vocabulary: Prism website is the setup/documentation surface, Prism admin console is a separate Prism-only administrative surface, Local tools use Prism developer tokens, and Slack-compatible endpoints live under `/v1/slack/*` (`CONTEXT.md:19-29`, `CONTEXT.md:39-45`, `CONTEXT.md:95-105`).
  - **Website rendering/navigation:** Next.js App Router pages under `app/` own product surfaces. The homepage `app/page.tsx` is a dynamic server component that reads `prism_session`, resolves Slack status, Token profiles, policy options, and activity, then renders the header/nav and panels with `app/ui.tsx` primitives (`app/page.tsx:1-19`, `app/page.tsx:25-66`, `app/page.tsx:117-145`). `app/layout.tsx` only owns root metadata/body (`app/layout.tsx:1-15`).
  - **UI primitives/design system:** `app/ui.tsx` owns local Prism wrappers around shadcn/Radix components (`LinkButton`, `Panel`, `StatusBadge`, `Notice`, `SummaryMetric`) and `app/globals.css` owns Tailwind/shadcn imports, OKLCH tokens, reduced-motion, and code font defaults (`app/ui.tsx:48-156`, `app/globals.css:1-3`, `app/globals.css:46-90`, `app/globals.css:124-140`).
  - **Endpoint behavior:** App Router route handlers under `app/v1/prism/**/route.ts` and `app/v1/slack/**/route.ts` own HTTP behavior. They delegate to server modules under `src/server/*`, set `dynamic = "force-dynamic"`, generate request IDs where applicable, and return no-store JSON or OAuth redirects (`app/v1/prism/status/route.ts:10-38`, `app/v1/prism/token-profiles/route.ts:12-105`, `app/v1/slack/api/[method]/route.ts:15-145`, `app/v1/slack/oauth/start/route.ts:8-38`).
  - **Local-tool API semantics:** `src/server/token-profiles/local-tool-status.ts`, `src/server/token-profiles/method-policy.ts`, `src/server/slack/forwarding.ts`, and `app/v1/slack/api/[method]/route.ts` own bearer-token status/capabilities and Slack-compatible forwarding; documentation must describe these, not reimplement them.
  - **Website/session management APIs:** Browser-session routes own Token profile lifecycle, activity audit, Slack OAuth/linking, and local Slack connection removal through `prism_session` cookies (`app/v1/prism/token-profiles/route.ts:14-69`, `app/v1/prism/token-profiles/[profileId]/rotate/route.ts:17-61`, `app/v1/prism/activity/route.ts:10-20`, `app/v1/prism/slack-connection/route.ts:12-35`, `app/v1/slack/oauth/callback/route.ts:13-47`).
  - **Admin authorization:** `src/server/admin/authorization.ts` owns admin decisions; `src/server/admin/allowlist.ts` owns server-only allowlist loading; `src/server/admin/postgres-store.ts` owns session-to-Slack-identity lookup. `/admin` and `/v1/prism/admin/*` reuse these modules (`authorization.ts:33-56`, `allowlist.ts:17-45`, `postgres-store.ts:7-36`, `app/admin/page.tsx:12-26`, `app/v1/prism/admin/session/route.ts:13-49`).
- Current owner rationale:
  - The API reference is a Prism website product surface, not a route-behavior owner or generated OpenAPI surface. It should live under `app/` and render a typed catalog that mirrors existing routes.
  - Admin console visibility is website navigation, but authorization remains server-owned in `src/server/admin/*` and `/admin` stays authoritative.
- Source evidence:
  - PRD #40 / issues #41-#43 require a website API reference, a maintainable catalog, and admin link gating without changing API behavior.
  - `README.md:39` currently states the website does not yet host a separate docs route; this is current-state documentation that implementation should update once the route exists.
  - Baseline command `npm test -- --run` exits 0 on the current tree. Existing uncommitted change observed: `M config/prism-admin-allowlist.example.json`; do not touch it unless the implementer owns that separate change.

## Existing interaction model

- User/system behaviors that already exist:
  - Homepage is server-rendered per request, uses HTTP-only `prism_session`, degrades to not-linked on Slack status errors, and only loads Token profiles/activity for linked sessions (`app/page.tsx:25-33`, `app/page.tsx:117-145`).
  - Main website header has a brand link, three in-page nav links, status badge, and conditional Slack OAuth action (`app/page.tsx:38-66`). Admin console header already links back to the user workspace (`app/admin/admin-shell.tsx:22-40`).
  - Local tools authenticate with `Authorization: Bearer prism_dev_...`; website/session APIs authenticate with the `prism_session` cookie. These are distinct auth models (`docs/setup.md:15-55`, `app/v1/prism/status/route.ts:14-23`, `app/v1/prism/token-profiles/route.ts:14-34`).
  - Slack-compatible forwarding supports GET/POST `/v1/slack/api/{method}`, preserves Slack-shaped method names, evaluates Method registry/policy, applies diagnostics headers, records metadata-only audit, and strips local `token` payload fields upstream (`app/v1/slack/api/[method]/route.ts:21-89`, `docs/setup.md:57-95`).
  - Admin pages and admin APIs fail closed: missing sessions become denied/401, non-admins become denied/403, malformed allowlists become generic unavailable states, and tests assert no allowlist/secret leakage (`app/admin/page.tsx:21-26`, `app/v1/prism/admin/session/route.test.ts:85-137`).
- Behaviors that must remain unchanged:
  - No endpoint behavior, auth semantics, route status codes, database schema, Slack OAuth, Token profile lifecycle, method policy, Slack forwarding, or audit persistence should change for this slice.
  - API docs examples must use placeholders only (`prism_dev_...`, fake IDs) and must never include Slack credentials, real Prism developer tokens, token hashes, peppers, allowlist paths/details, or Slack payload content.
  - Non-admin and unauthenticated homepage renders must not show the Admin console link, and failures while checking admin visibility must not break normal website access.
  - `/admin` and `/v1/prism/admin/*` must remain server-authorized even if a link is hidden or visible.
- Runtime or UX evidence:
  - Current UI primitives have tests for shadcn slots and secret-free rendering (`app/ui.test.tsx:6-26`).
  - Admin shell render test verifies authorized shell and denied state without secret/allowlist leakage (`app/admin/page.test.tsx:46-66`).
  - Route tests cover no-store/request-ID and secret-free behavior for status/capabilities/admin/session routes (`app/v1/prism/status/route.test.ts:58-88`, `app/v1/prism/admin/session/route.test.ts:42-60`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add the route as a Next App Router page, recommended `app/api-reference/page.tsx` or similarly product-facing. It can be a server component and should use semantic headings, lists, tables/cards, anchors, and existing `Panel`, `Notice`, `StatusBadge`, `LinkButton`, `SummaryMetric` as needed.
  - Add a small typed endpoint catalog as a deep module near the page or shared app code, recommended `app/api-reference/endpoint-catalog.ts`. Keep it pure/static TypeScript data, export stable types, and test it independently. Do not import route handlers or server-only modules into the catalog.
  - Add homepage API reference navigation in `app/page.tsx`'s existing header nav. Reuse current rounded link classes or extract only if it reduces duplication without broad redesign.
  - Add admin link visibility in `HomeContent` by reusing `cookies()`, `prismSessionCookieName`, `resolvePrismAdmin`, `loadAdminAllowlist`, `createPostgresAdminIdentityStore(database)`, and safe error handling already used by `app/admin/page.tsx` / `app/v1/prism/admin/session/route.ts`.
  - Keep docs rendering server-side/static data. The endpoint reference does not need client state, client fetching, hydration, markdown parsing, OpenAPI generation, or admin-session API calls.
  - Tests should follow existing Vitest patterns: `renderToStaticMarkup` for pages/components, `vi.mock("next/headers")` and mocked `database` for server pages, and pure assertions for catalog content (`app/admin/page.test.tsx:1-75`, `app/ui.test.tsx:1-26`).
- Relevant docs or library capabilities:
  - Next.js 16 App Router supports server components/pages and route handlers already in use; React 19 server rendering is available through current tests (`package.json:18-45`).
  - Tailwind/shadcn styling is already local; no new docs styling library is needed (`app/ui.tsx`, `app/globals.css`).
- Existing examples in this codebase:
  - `docs/setup.md` is the source content model for Local tool setup, headers, representative calls, failures, diagnostics, and deferred surfaces (`docs/setup.md:25-132`).
  - `src/server/docs-guard.test.ts` is the model for published-doc safety checks and should be extended or mirrored for the API catalog/page if examples become product docs (`docs-guard.test.ts:5-63`, `docs-guard.test.ts:101-118`).
  - `app/admin/admin-shell.tsx` demonstrates a separate admin-owned handoff surface and should remain the owner for detailed admin operations (`admin-shell.tsx:44-74`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a second admin permission model, client-side role flag, localStorage/sessionStorage admin state, middleware-only gate, Slack workspace role check, or direct allowlist parser in UI/client code.
  - Do not authorize Admin console link visibility through `/v1/prism/admin/session` client fetch when the homepage is already a server component with direct access to existing admin resolver modules.
  - Do not document detailed admin-only APIs in the main developer API reference. Use an admin-console-owned handoff only, e.g. “Admin operations live in the Prism admin console and require existing Prism admin authorization.”
  - Do not import product route handlers into docs/catalog code or use the catalog as runtime routing authority. Route handlers remain source of behavior; catalog is documentation data.
  - Do not add OpenAPI generation, SDK generation, Postman collections, docs search, markdown renderer, database-backed docs, or new dependencies for this slice.
  - Do not replace Prism UI primitives or introduce ad hoc inline styles/generic docs theme.
- Shortcuts or parallel paths to avoid:
  - Avoid broad “API explorer” behavior that makes live calls or accepts bearer tokens in the browser.
  - Avoid writing examples with concrete Slack message text/search query/file/canvas/list payloads; keep examples skeletal and placeholder-safe.
  - Avoid hiding server authorization errors by treating all admin lookup failures as admin=true or by surfacing allowlist parse details on the homepage.
  - Avoid broad README/docs rewrites beyond updating stale references directly affected by the new website route.
- Invariants:
  - Local tool bearer-token endpoints and browser-session endpoints stay clearly separated.
  - The admin link is convenience only; `/admin` remains the authoritative protection boundary.
  - API reference is safe, static/server-rendered product documentation with no secrets and no runtime endpoint coupling.

## Integration plan

- Insert the change at:
  - **Catalog:** create a typed static catalog module for endpoint docs. Suggested groups: “Local tool endpoints” (`GET /v1/prism/health`, `GET /v1/prism/status`, `GET /v1/prism/capabilities`, `GET|POST /v1/slack/api/{method}`), “Website/session management endpoints” (Token profile list/create/delete/revoke/rotate/policy, `GET /v1/prism/activity`, Slack OAuth start/callback, `DELETE /v1/prism/slack-connection`), and “Admin handoff” (link/description only; no detailed admin API entries).
  - **API reference page:** add a server-rendered page under `app/api-reference/page.tsx` (or another explicit Prism website docs path chosen by implementer) that renders the catalog using existing UI primitives. Include base URL, auth model, headers, response diagnostics, failure states, custody/metadata-only audit guidance, and deferred surfaces from `docs/setup.md`.
  - **Homepage nav:** update `app/page.tsx` header nav to include an API reference link for all users. Prefer a normal route link (`href="/api-reference"`) rather than in-page anchor.
  - **Admin link gating:** add a small server helper inside `app/page.tsx` or a server-only app-local helper that calls the existing admin resolver using the current `prism_session`. Return boolean `true` only for `decision.kind === "authorized"`; return `false` for unauthenticated, not_admin, missing/malformed allowlist, and recoverable lookup errors. Re-throw only unexpected infrastructure errors if consistent with current homepage behavior, or fail closed if the goal is to avoid breaking normal users.
  - **Docs update:** update `README.md:39` if implementation makes it stale. Consider extending `src/server/docs-guard.test.ts` published-doc list/checks only if repository Markdown becomes the tested source of product docs; otherwise add separate catalog/page safety tests.
- Why this is the correct integration point:
  - `app/page.tsx` already owns dynamic homepage session rendering and has server access to cookies/database; putting admin visibility there avoids client auth and duplicate routes.
  - `src/server/admin/*` already owns admin authorization, scope matching, and allowlist failure behavior. Reusing it preserves server-side authorization and keeps admin visibility aligned with `/admin`.
  - A static typed catalog fits the PRD’s maintainability requirement without pretending to be runtime truth or generating an API spec outside scope.
  - Server-rendered docs avoid unnecessary client JS, token-handling UI, hydration risk, and client-visible admin-check plumbing.
- Alternatives considered and rejected:
  - **Client-rendered API reference:** rejected because the content is static documentation and no interactivity/fetching is needed.
  - **Hybrid client docs:** rejected unless a tiny client affordance is later required; current slice can be fully server-rendered.
  - **Generated OpenAPI/spec:** rejected by PRD out-of-scope and because current routes are handwritten with mixed browser-session, bearer-token, and OAuth redirect semantics.
  - **Client fetch to `/v1/prism/admin/session` for nav:** rejected as a parallel visibility path around server-rendered homepage authorization.
  - **Detailed admin API catalog:** rejected because admin APIs are admin-console-owned and excluded from the main developer reference.

## Regression checklist

- Behavior: Full `npm test -- --run` remains green.
- Behavior: `/` still renders for not-linked, linked, reauth-required, unauthenticated, non-admin, and admin sessions without exposing secrets.
- Behavior: API reference link appears for all homepage users and does not remove existing Slack status, Token profiles, Metadata audit, or Slack OAuth links.
- Behavior: Admin console link appears only for sessions authorized by `resolvePrismAdmin`; non-admin, missing-session, expired-session, scope-mismatch, and allowlist-unavailable cases hide it.
- Behavior: `/admin` and `/v1/prism/admin/*` keep existing server-side deny/allow behavior and tests.
- Behavior: `/v1/prism/health`, `/v1/prism/status`, `/v1/prism/capabilities`, `/v1/slack/api/{method}`, Token profile routes, activity, OAuth start/callback, and Slack connection removal behavior/status codes/headers remain unchanged.
- Behavior: API reference content has no real-looking Prism developer tokens, Slack tokens, token hashes, peppers, credential names with values, allowlist internals, or Slack payload/content canaries.
- Behavior: Mobile and keyboard reading preserve semantic headings/anchors and 44px-ish nav/link targets consistent with current header links.

## Test plan

- Existing tests to keep green:
  - Full `npm test -- --run` suite.
  - Homepage-adjacent render/UI tests: `app/ui.test.tsx`, `app/slack-status-panel.test.tsx`, `app/token-profiles-panel.test.tsx`, `app/activity-audit-panel.test.tsx`, `app/website-overview.test.ts`.
  - Admin auth tests: `src/server/admin/authorization.test.ts`, `src/server/admin/allowlist.test.ts`, `src/server/admin/postgres-store.test.ts`, `app/admin/page.test.tsx`, `app/v1/prism/admin/session/route.test.ts`.
  - Route behavior tests for documented endpoints: `app/v1/prism/health/route.test.ts`, `status/route.test.ts`, `capabilities/route.test.ts`, `token-profiles/route.test.ts`, `activity/route.test.ts`, `slack-connection/route.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, OAuth route tests.
  - Guard tests: `src/server/docs-guard.test.ts`, `src/server/dependency-guard.test.ts`.
- New tests to add before/with implementation:
  - Catalog unit test asserting required groups/paths/methods/auth models/visibility classifications are present, admin-only detailed endpoints are absent, admin handoff text exists, and examples pass the same secret-safety regexes as docs guard.
  - API reference render test asserting base URL, bearer auth, browser-session distinction, headers (`X-Prism-Surface`, `X-Prism-Workspace-ID`, `X-Prism-Execution-Mode`, `X-Prism-Request-ID`, `X-Prism-Upstream-Called`, `Retry-After`), key failures, metadata-only audit, and deferred/non-goal surfaces appear.
  - Homepage render tests for admin nav gating: authorized admin sees `Admin console`; non-admin, missing session, expired session, scope mismatch, and malformed/missing allowlist do not. These should mock `next/headers` and `database` similarly to `app/admin/page.test.tsx`.
  - Optional README/docs guard update if `README.md` is changed to mention the new route.
- Live proof required:
  - Run the app and capture browser proof at desktop and mobile widths for `/api-reference` (or chosen route) showing readable endpoint groups and no console errors.
  - Capture homepage proof that API reference link is visible for normal users.
  - Capture admin-session proof that authorized admin sees Admin console link and non-admin/unauthenticated session does not.
  - Verify `/admin` direct access remains denied for non-admin and allowed for an allowlisted admin.

## Risk assessment

- Risk: Adding admin visibility to `app/page.tsx` may cause the homepage to fail if allowlist parsing or admin store lookup throws. Mitigation: fail closed for expected `AdminAllowlistUnavailableError` and deny decisions; add tests for these cases.
- Risk: Importing server-only admin modules into a client component would break builds or leak concepts. Mitigation: keep homepage/admin check in server component code; do not pass secrets to client components.
- Risk: Documentation catalog can drift from route behavior. Mitigation: keep it small, typed, tested for required paths, and treat route handlers/tests as behavior source of truth.
- Risk: Product docs can accidentally include secret-shaped examples or Slack payload content. Mitigation: reuse/extend docs guard regexes against catalog/page text.
- Risk: Main API reference could blur Local tool APIs with browser-session website APIs. Mitigation: explicit auth model per group and copy that admin APIs are console-owned, not part of developer Local tool docs.
- Risk: Header nav could become crowded on mobile. Mitigation: preserve existing flex-wrap pattern and minimum touch target classes.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing ownership is clear: App Router pages own product rendering, route handlers own endpoint behavior, `app/ui.tsx` owns UI primitives, and `src/server/admin/*` owns admin authorization.
  - The requested slice is additive documentation/navigation and can avoid API/data/schema changes.
  - Existing tests provide strong patterns for server render, route, no-secret, and admin authorization behavior.
- Open questions:
  - Exact route slug is not specified by PRD. Recommendation: `/api-reference` because it is explicit, product-facing, and avoids overloading repository `docs/` paths.
  - `docs/setup.md:124` says all Prism responses include `X-Prism-Request-ID` “where practical”; `GET /v1/prism/activity` currently sets `Cache-Control` but no request ID. Treat this as a doc/code nuance to document accurately, not a behavior change for this slice.
