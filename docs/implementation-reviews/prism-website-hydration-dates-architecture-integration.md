# Architecture Integration Brief: prism-website-hydration-dates

## Existing ownership

- Package/component/module/library:
  - **Prism website App Router surface** owns this behavior today. `app/page.tsx` is the server component that reads the current `prism_session`, fetches linked-session Token profile and activity data, serializes date fields to ISO strings, and passes compact props to website panels (`app/page.tsx:21-25`, `65-95`).
  - **Token profile date display** currently lives inside the client component `app/token-profiles-panel.tsx`. It owns profile creation, rotation, revoke, and policy-update UI state and renders profile lifecycle dates through local `formatDate` / `formatDateTime` helpers (`app/token-profiles-panel.tsx:23-35`, `36-140`, `240-256`, `354-360`).
  - **Activity audit date display** currently lives inside the server component `app/activity-audit-panel.tsx`, which renders recent metadata-only activity and formats `occurredAt` inline (`app/activity-audit-panel.tsx:3-29`).
- Current owner rationale:
  - `CONTEXT.md` defines the Prism website as the user-facing web surface for Slack linking, Token profile management, audit review, and setup documentation (`CONTEXT.md:19-21`). These dates are website presentation concerns, not token policy, audit persistence, Slack forwarding, or database concerns.
  - The server-side domain layers already normalize Date objects to ISO strings before UI rendering: Token profile summaries in `app/page.tsx` call `.toISOString()` for `expiresAt`, `createdAt`, and developer-token dates (`app/page.tsx:71-88`); audit summaries call `.toISOString()` in `src/server/audit/presentation.ts:22-40`.
- Source evidence:
  - The hydration mismatch is consistent with the only website display code using environment-dependent locale formatting: `new Date(value).toLocaleDateString()`, `new Date(value).toLocaleString()`, and `new Date(entry.occurredAt).toLocaleString()` (`app/token-profiles-panel.tsx:354-360`, `app/activity-audit-panel.tsx:27-28`).
  - `TokenProfilesPanel` is a client component (`"use client"` at `app/token-profiles-panel.tsx:1`), so React hydrates server-rendered markup and then immediately recomputes these strings in the browser timezone/locale.
  - `ActivityAuditPanel` is currently a server component, but it still server-renders locale-formatted text. If it later becomes a client component or is nested differently, it has the same non-deterministic formatting risk.

## Existing interaction model

- User/system behaviors that already exist:
  - The homepage is dynamic and session-scoped (`export const dynamic = "force-dynamic"` in `app/page.tsx:14`), showing Token profiles and Activity audit only for linked Slack sessions (`app/page.tsx:51-52`).
  - Token profile users can create profiles, copy a developer token once, rotate, revoke, and update policy without a page reload; returned profiles are normalized through `toSummary` and inserted/replaced in local client state (`app/token-profiles-panel.tsx:36-140`, `320-330`).
  - Token profile date fields are informational labels for expiry, last used, overlap-until, and revoked states (`app/token-profiles-panel.tsx:240-256`). Empty values intentionally render `No expiry` or `Not used yet`.
  - Activity audit shows safe metadata only: profile/session, timestamp, category, object ID, identity, and error class; it must not expose Slack payloads, search text, file contents, or token material (`app/activity-audit-panel.tsx:8-10`, `21-56`).
- Behaviors that must remain unchanged:
  - Keep the existing `TokenProfilesPanel` forms/actions and copy-once token behavior; do not move lifecycle behavior into a new panel or route just to fix formatting.
  - Keep `ActivityAuditPanel` as a compact recent-activity website view; do not broaden it into an admin console.
  - Keep passing ISO strings across the server/client boundary. Do not pass `Date` objects into client props or re-query date values from the browser.
  - Preserve null/empty fallback text (`No expiry`, `Not used yet`) and no-secret rendering guarantees in both panels.
- Runtime or UX evidence:
  - `npm test` passes at baseline after rerunning without unsupported Jest flags; current tests use `renderToStaticMarkup` and verify the panels render expected safe metadata without secret material (`app/token-profiles-panel.test.tsx:7-46`, `app/activity-audit-panel.test.tsx:7-37`).
  - `npm run build` passes with Next.js App Router routes under `/`, `/v1/prism/*`, and `/v1/slack/*`.
  - The reported deterministic Playwright repro against `http://localhost:3732/` with browser timezone UTC and a linked session shows React hydration failure caused by server/client timezone divergence for the same ISO instant.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Reuse the existing website component boundary: update the date rendering used by `app/token-profiles-panel.tsx` and `app/activity-audit-panel.tsx` instead of changing stores, route handlers, database schema, or service models.
  - Prefer a small shared website presentation helper colocated under `app/` (for example `app/date-format.ts`) or exported local helper reused by both panels. It should accept ISO strings/nulls and use `Intl.DateTimeFormat` or `Date` methods with explicit locale and `timeZone` options.
  - Keep the server component -> client component contract as ISO strings from `app/page.tsx` and `src/server/audit/presentation.ts`.
- Relevant docs or library capabilities:
  - React hydration requires the client render to produce the same initial output as the server for the same props. Environment-dependent values such as dates formatted with the host default locale/timezone are common mismatch sources.
  - Next.js hydration guidance treats browser-only or time-dependent rendering as a mismatch source. `useEffect`, disabling SSR, and `suppressHydrationWarning` exist, but they are escape hatches; for this slice the better fit is deterministic SSR/client formatting because date text is normal initial content.
  - ECMAScript `Intl.DateTimeFormat` supports explicit `locale` and `timeZone`, which lets Node SSR and browser hydration render the same string for an ISO instant.
- Existing examples in this codebase:
  - Existing panel tests already use `renderToStaticMarkup`, so adding assertions for deterministic timestamp text fits current test style without adding a UI test framework.
  - Existing server presentation modules (`src/server/audit/presentation.ts`, `app/page.tsx`) already convert date values to ISO strings, which is the right extension seam for deterministic display helpers.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate `TokenProfilesPanel`, `ActivityAuditPanel`, `app/page.tsx` data loading, Token profile service/store, audit store, or Slack session resolution.
  - Do not introduce a new website auth/session, API fetch path, client-only data loader, global state store, date library, or dashboard surface for this fix.
  - Do not change the persisted date semantics in Postgres, Token profile services, audit services, or route response schemas.
- Shortcuts or parallel paths to avoid:
  - Avoid `suppressHydrationWarning`; it would hide the reported mismatch rather than making the rendered output deterministic.
  - Avoid making the affected panels `dynamic(..., { ssr: false })` or rendering dates only after `useEffect`; that would remove useful SSR content and create a flash/blank date path for a simple formatting problem.
  - Avoid relying on `process.env.TZ`, server locale, browser locale, or the deployment host timezone.
  - Avoid one-off fixes in only `TokenProfilesPanel` while leaving `ActivityAuditPanel` with the same unsafe pattern.
- Invariants:
  - The same ISO input must produce the same initial text in Node SSR and browser hydration.
  - Date-only expiry must not shift calendar day based on the executing environment's timezone.
  - Date-time output should make its timezone explicit enough that users do not mistake UTC for local time.
  - No secrets, token hashes, Slack credentials, payloads, or audit content may be introduced into tests, docs, or rendered output.

## Integration plan

- Insert the change at:
  - Add or centralize a deterministic website date-formatting helper in the `app/` presentation layer, then replace the current default-locale formatting calls in `app/token-profiles-panel.tsx` and `app/activity-audit-panel.tsx`.
  - Recommended helper behavior: format ISO instants with an explicit stable locale and timezone, preferably UTC with a visible timezone label for date-times (for example via `Intl.DateTimeFormat("en-US", { timeZone: "UTC", ... })`). Use an explicit UTC date-only formatter for expiry dates to prevent off-by-one calendar changes during SSR/hydration.
  - Keep the existing fallback decisions at call sites: helper returns `null` for nullish values, and components continue rendering `No expiry` / `Not used yet` as they do today.
- Why this is the correct integration point:
  - The mismatch is a website presentation problem at the point where ISO strings become text. The domain and API layers already provide stable ISO values, so changing them would be broader and riskier than necessary.
  - A shared helper prevents parallel date-formatting paths and makes future website date displays inherit hydration-safe behavior.
  - Explicit timezone/locale formatting preserves SSR content and initial client markup while avoiding the reported server Australia/Sydney vs browser UTC divergence.
- Alternatives considered and rejected:
  - **Set server timezone to UTC:** rejected because it depends on deployment/runtime configuration and does not protect against browser locale/timezone differences.
  - **Client-only local formatting:** rejected for this slice because it avoids hydration by withholding SSR date text and changes loading behavior; it can be reconsidered later if product explicitly wants user-local time.
  - **`suppressHydrationWarning`:** rejected because it masks React's warning and can still show stale server timezone text until client render.
  - **Pre-format dates in `app/page.tsx`:** partially viable, but insufficient alone because `TokenProfilesPanel` also receives updated profile objects from client-side create/rotate/revoke/policy API calls and must format those deterministically too.

## Regression checklist

- Behavior: `npm test` remains green.
- Behavior: `npm run build` remains green.
- Behavior: The linked-session homepage hydrates without React hydration mismatch errors when server and browser timezones differ.
- Behavior: `TokenProfilesPanel` still creates, rotates, revokes, updates policy, displays copy-once tokens only on immediate success, and preserves existing fallback labels.
- Behavior: `ActivityAuditPanel` still lists recent metadata-only activity and does not expose payloads or secrets.
- Behavior: `app/page.tsx` continues passing ISO strings from Token profile and audit summaries; no database/API schema changes occur.
- Behavior: Date-time labels are deterministic and clearly timezone-scoped; date-only labels do not vary by runtime timezone.

## Test plan

- Existing tests to keep green:
  - `app/token-profiles-panel.test.tsx`
  - `app/activity-audit-panel.test.tsx`
  - `app/slack-status-panel.test.tsx`
  - API/service tests covered by `npm test`, especially Token profile and audit tests that protect no-secret behavior.
  - `npm run build` for Next.js/TypeScript/hydration-relevant compilation.
- New tests to add before/with implementation:
  - Unit tests for the deterministic date helper covering date-only, date-time, null input, invalid/edge ISO handling if supported, and expected timezone label.
  - Panel render tests asserting stable text for known ISO timestamps in Token profile expiry/last-used/overlap/revoked rows and Activity audit `When` rows.
  - A regression test or static guard that prevents no-argument `toLocaleString()` / `toLocaleDateString()` in website SSR/client-rendered components, at least for the affected `app/*panel*.tsx` files.
- Live proof required:
  - Run the existing deterministic Playwright repro against `http://localhost:3732/` with a linked session and browser timezone UTC while the server environment remains non-UTC or otherwise different.
  - Capture that the page renders linked Token profile and Activity audit dates, browser console has no React hydration failure, and the visible date text is identical before/after hydration for the same ISO instant.

## Risk assessment

- Risk: User-visible timestamps will change from implicit environment-local formatting to explicit deterministic formatting, likely UTC. Users in Australia/Sydney may see a different clock time than before.
- Risk: If the helper chooses a terse format without a timezone label, users may misinterpret UTC as local time.
- Risk: Over-centralizing into domain/server modules could couple presentation formatting to API models and make client-side profile updates awkward.
- Risk: A helper that parses invalid strings differently on server and browser could reintroduce nondeterminism; inputs are currently ISO strings from existing services, but tests should cover expected behavior.
- Mitigation: Keep the change in website presentation only, use explicit `Intl.DateTimeFormat` options, include a visible timezone label for date-times, preserve null fallbacks, and add tests plus live Playwright proof under mismatched timezones.

## Decision confidence

- Confidence: high
- Reasons:
  - The reported mismatch maps directly to the only default-locale date formatting in the website panels.
  - Current data flow already uses ISO strings, which are the right stable substrate for deterministic formatting.
  - React/Next hydration constraints strongly favor identical SSR/client initial output over hiding the warning.
  - The fix can be inserted surgically in existing website presentation components without changing persistence, API shape, auth, Token profile lifecycle behavior, or audit semantics.
- Open questions:
  - Product may later prefer user-local time after hydration. If so, that should be treated as a separate UX decision with an explicit two-phase rendering design; it should not be mixed into this hydration bug fix.
