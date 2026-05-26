# Architecture Integration Brief: activity-audit-compact-view

## Existing ownership

- Package/component/module/library:
  - `app/activity-audit-panel.tsx` owns the Recent Prism activity/Metadata-only audit panel row rendering, empty state, status mapping, safe display whitelist, and credential-shaped redaction.
  - `src/server/audit/presentation.ts` owns the browser-facing `ActivityAuditSummary` shape; audit persistence/query ownership remains in `src/server/audit/*` and page loaders.
  - `app/page.tsx` places the panel on the homepage; `app/token-profiles/[profileId]/page.tsx` and `app/token-profile-detail-panel.tsx` place the same panel in Token profile detail/profile events.
  - `app/ui.tsx` owns local shadcn-backed primitives (`Panel`, `Notice`, `StatusBadge`, `Button`, `cn`); `components/ui/*` owns the underlying shadcn-style primitives.
- Current owner rationale:
  - The request changes visual density of an existing metadata-only presentation surface, not audit data capture, session scoping, Slack forwarding, or Token profile management.
  - The existing `ActivityAuditSummary` already includes the required dense audit fields: method/action, status, profile, timestamp, category, object, identity, request ID, HTTP status, upstream-called flag, and error class.
- Source evidence:
  - `PRODUCT.md:13-15` says the website helps users inspect metadata-only activity and quickly answer what Prism forwarded/blocked.
  - `DESIGN.md:75-85` requires familiar restrained controls and dense but scannable audit rows with method, outcome, object, identity, request ID, and time.
  - `app/activity-audit-panel.tsx:5-72` renders the current panel; populated rows use spacious `article` rows with `gap-3 p-4` and a metadata `dl`.
  - `app/activity-audit-panel.test.tsx:21-58` verifies safe metadata fields; `app/token-profile-detail-panel.test.tsx:11-63` verifies the shared panel remains part of Token profile detail behavior.

## Existing interaction model

- User/system behaviors that already exist:
  - Homepage: when Slack is linked, `app/page.tsx` server-loads up to 20 current-session activity summaries and passes them to `ActivityAuditPanel`; when not linked, it renders setup copy instead.
  - Token profile detail: `app/token-profiles/[profileId]/page.tsx` server-loads up to 20 profile-scoped activity summaries and `TokenProfileDetailWorkspace` renders `ActivityAuditPanel` under Profile events.
  - The panel always displays a `Metadata only` notice before activity/empty content.
  - Empty linked state teaches the future metadata shape: method/category, outcome/request ID, object/identity/time, and no stored content/tokens.
  - Populated rows show explicit, whitelisted fields only; `safeAuditText` redacts credential-shaped canaries before rendering.
- Behaviors that must remain unchanged:
  - Preserve the metadata-only safety model: do not render Slack message text, search queries, file contents, tokens, credentials, token hashes, peppers, authorization material, or generic future fields.
  - Preserve server-side session/profile scoped data loading; no client fetch/polling or alternate audit source is needed for density.
  - Preserve StatusBadge text labels; status must not become color-only.
  - Preserve Token profile manager behavior, forms, actions, profile detail placement, and shared `ActivityAuditPanel` reuse.
  - Preserve `titleId="activity-audit-title"` for homepage navigation and panel region labeling unless callers are adjusted deliberately.
- Runtime or UX evidence:
  - Focused baseline passed: `npm test -- --run app/activity-audit-panel.test.tsx app/design-system.test.ts app/ui.test.tsx --reporter=dot` => 3 files, 9 tests passed.
  - Production build baseline passed: `npm run build`.
  - Conflict: docs ask for dense audit rows, and the test name says “renders dense safe metadata”, but the current code uses relatively spacious card/list spacing (`gap-3`, `p-4`, multi-row header + `dl`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Continue accepting `ActivityAuditSummary[]` in `ActivityAuditPanel`; do not add data fields unless a required metadata item is absent.
  - Continue using `formatUtcDateTime` from `app/date-format.ts` for deterministic UTC timestamps.
  - Continue using local primitives from `app/ui.tsx`, especially `Panel`, `Notice`, `StatusBadge`, and `cn` for class composition.
  - Use Tailwind utility classes in existing app components; `app/design-system.test.ts` guards no inline styles and shadcn/Tailwind substrate use.
  - Keep `renderToStaticMarkup` + Vitest component tests beside the owner in `app/activity-audit-panel.test.tsx`.
- Relevant docs or library capabilities:
  - React server components can render a compact default with no client state, hydration cost, persistence, or browser storage.
  - Native semantic structures fit the data: keep `article` + `dl`, or convert to an accessible table if responsive behavior is preserved. A table is acceptable only if all required metadata stays visible/readable on narrow screens.
  - If a toggle is explicitly required, use an accessible `<button aria-pressed>` via local `Button`/shadcn primitives in the existing owner; avoid persistence unless separately specified.
- Existing examples in this codebase:
  - `app/ui.tsx` wraps shadcn primitives and tone classes for consistent Panels, Notices, Badges, and Buttons.
  - `app/token-profile-detail-panel.tsx` uses shared primitives and accessible form/status behavior; this slice must not disturb those Token profile flows.
  - `app/activity-audit-panel.test.tsx` already has field presence and secret-canary coverage that should be extended rather than replaced.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a new audit panel component outside `app/activity-audit-panel.tsx` for the same rows.
  - Do not create a parallel audit API, store, query, DTO, client fetcher, polling loop, or local-storage state path.
  - Do not bypass `ActivityAuditSummary`, `formatUtcDateTime`, `Panel`, `Notice`, `StatusBadge`, or local shadcn/Tailwind primitives.
  - Do not change Slack OAuth, Slack forwarding, policy evaluation, Token profile lifecycle, developer-token handling, or audit persistence for a visual-density change.
- Shortcuts or parallel paths to avoid:
  - Do not render `JSON.stringify(entry)`, iterate over arbitrary object keys, or add a generic metadata renderer that could display future unsafe fields.
  - Do not hide required fields behind hover, desktop-only columns, truncated inaccessible text, or a collapsed-by-default disclosure.
  - Do not add a compact toggle that creates a second untested layout path unless product explicitly chooses that behavior.
  - Do not add inline styles, new UI dependencies, or one-off controls instead of local primitives.
- Invariants:
  - Method/action, outcome/status, object, identity, request ID, and time must remain visible where available.
  - Metadata-only notice and no-secret/no-content rendering remain hard blockers.
  - Status remains visible text plus tone.
  - The same compact presentation must work for homepage activity and Token profile detail/profile events.

## Integration plan

- Insert the change at:
  - Primary: `app/activity-audit-panel.tsx`, by tightening the populated activity row layout/classes and, if useful, extracting small row/metadata helpers within the same file.
  - Tests: extend `app/activity-audit-panel.test.tsx`; add Token profile detail assertions only if shared panel props/placement change.
  - Avoid touching page loaders, audit server modules, Token profile service/store/routes, and API handlers.
- Why this is the correct integration point:
  - All current Recent Prism activity rows flow through `ActivityAuditPanel`, including homepage and Token profile detail usage.
  - The safe data and redaction helpers are already colocated with the rendering path, so density can improve without new data flow or leakage risk.
  - A compact default aligns directly with `DESIGN.md` and keeps the surface simple and server-rendered.
- Alternatives considered and rejected:
  - **Recommended: compact by default, no toggle.** Evidence supports making rows dense everywhere: product goal says “as compact as possible,” design says audit rows should be dense, and the current layout conflicts with that. This avoids extra client state and duplicate layouts.
  - **Toggle button:** reject unless explicitly requested after seeing compact default. It would require a client state island or equivalent and would create two density paths to test. If later required, implement it inside `ActivityAuditPanel` with local `Button`/`aria-pressed`, no storage by default, and tests for both states.
  - **Separate table/library:** reject; native semantic HTML plus Tailwind/local primitives is sufficient and avoids a parallel design-system path.
  - **Backend/API changes:** reject; `ActivityAuditSummary` already has the fields needed for compact metadata.

## Regression checklist

- Behavior: Homepage linked state still renders Recent Prism activity with `activity-audit-title` and current-session activity only.
- Behavior: Token profile detail still renders Profile events using profile-scoped activity and preserves lifecycle/policy controls.
- Behavior: Empty activity still teaches metadata shape and metadata-only/no-content/no-token guarantees.
- Behavior: Populated rows still show method/action, status text, profile/session, timestamp, category, object, identity, request ID, HTTP, upstream, and error when available.
- Behavior: Secret/content canaries remain redacted or absent across all visible fields.
- Behavior: Mobile/narrow layouts remain readable without hover-only or color-only affordances.
- Behavior: Design-system guards remain green: no inline styles, no bypassed primitives, no added generic styling substrate.
- Behavior: `npm test` and `npm run build` pass after implementation.

## Test plan

- Existing tests to keep green:
  - `app/activity-audit-panel.test.tsx`
  - `app/token-profile-detail-panel.test.tsx`
  - `app/design-system.test.ts`
  - `app/ui.test.tsx`
  - Relevant backend/API audit tests if touched, though implementation should not touch them.
  - Full `npm test` and `npm run build`.
- New tests to add before/with implementation:
  - Add structural/class assertions in `app/activity-audit-panel.test.tsx` that populated rows use the intended compact row/list structure (for example smaller padding/gaps or a compact grid/table marker), without overfitting every utility class.
  - Add/keep assertions that all required audit fields remain present after compaction, especially request ID and time.
  - Extend no-secret canary coverage if any new visible field/order is introduced.
  - If a toggle is implemented despite recommendation, add tests for default state, toggled compact/comfortable state, `aria-pressed`, and field parity across both states.
- Live proof required:
  - Run `npm test`.
  - Run `npm run build`.
  - Start production `next start` using the repo’s existing flow and use Playwright to inspect homepage and a Token profile detail page with activity if test data is available.
  - Capture screenshot/user-visible proof that rows are materially denser while method, status, object, identity, request ID, and time remain readable.
  - Inspect rendered browser text/console to confirm no content/token canaries and no client errors.

## Risk assessment

- Risk: Over-compaction could make rows hard to scan, especially with long methods, object IDs, request IDs, or mobile widths.
- Risk: A table conversion could harm responsive layout or hide metadata columns on small screens.
- Risk: Adding a toggle could introduce client hydration/state bugs, duplicate layout paths, or untested accessible-control behavior.
- Risk: Refactoring metadata rendering could accidentally remove `safeAuditText` or broaden rendering to unsafe/future fields.
- Risk: Changing shared panel title/id/actions could affect homepage anchor navigation or profile detail semantics.
- Mitigation:
  - Prefer compact default within the current `article` + explicit `Metadata` whitelist unless a table clearly improves scan density.
  - Keep wrapping/overflow protections like `[overflow-wrap:anywhere]`; consider tabular/mono treatment for request/time where appropriate.
  - Preserve `safeAuditText` on every rendered metadata value and keep no-secret canary tests.
  - Keep changes scoped to `app/activity-audit-panel.tsx` and its tests unless evidence requires otherwise.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership is clear and all current Recent Prism activity rows use the same component.
  - Docs and product intent strongly favor compact default; a toggle is optional complexity, not required by current evidence.
  - Existing safe summary data already contains the necessary fields, so no backend or Token profile behavior change is needed.
  - Focused tests and production build pass at baseline.
- Open questions:
  - Whether product wants a persistent user preference for density later; current evidence does not justify adding persistence now.
  - Whether implementation should keep the current `article` + `dl` semantics or move to a responsive table; decide based on smallest safe diff and mobile readability during implementation.
