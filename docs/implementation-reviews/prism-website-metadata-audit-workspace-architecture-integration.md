# Architecture Integration Brief: prism-website-metadata-audit-workspace

## Existing ownership

- Package/component/module/library:
  - `app/activity-audit-panel.tsx` owns the current website Metadata-only audit panel rendering for recent Prism activity.
  - `src/server/audit/activity.ts`, `src/server/audit/postgres-store.ts`, and `src/server/audit/presentation.ts` own audit record construction, persistence/listing, and browser-safe summary shape.
  - `app/page.tsx` owns homepage placement and passes current-session activity into `ActivityAuditPanel`; `app/v1/prism/activity/route.ts` owns the current JSON read API.
  - `app/ui.tsx` and `app/globals.css` own the local shadcn-style primitive substrate, OKLCH tokens, panel/notice/status-badge styling, and activity-list CSS.
- Current owner rationale:
  - This slice is a UI/workspace redesign of an existing audit surface, not a new audit backend or data flow.
  - The audit data model already exposes the required safe metadata fields: method/action, status, object type/id, execution mode, request ID, timestamp, token profile, category, HTTP status, and upstream-called flag.
  - Product/design docs define the website as the audit review surface and require dense scannable audit rows with metadata-only/no-content behavior.
- Source evidence:
  - `CONTEXT.md:19-21` defines the Prism website as the surface for Slack linking, Token profile management, audit review, and setup documentation.
  - `CONTEXT.md:51-53` and `PRODUCT.md:13-15` define Metadata-only audit as request metadata without Slack payloads.
  - `DESIGN.md:75-85` requires local product components, text-plus-color status badges, and audit rows with method, outcome, object, identity, request ID, and time.
  - `app/activity-audit-panel.tsx:5-69` renders the panel today.
  - `src/server/audit/presentation.ts:3-20` exposes the safe UI summary, including `requestId`.
  - `app/page.tsx:153-155` loads recent activity via `createPostgresActivityAuditStore(...).listRecentActivityForSession`.

## Existing interaction model

- User/system behaviors that already exist:
  - When Slack is linked, the homepage loads recent activity server-side and renders `ActivityAuditPanel` in the supporting workspace column.
  - When no linked Slack session is present, `app/page.tsx:102-110` shows a simpler "Metadata audit starts after activity" panel instead of querying/displaying audit rows.
  - `ActivityAuditPanel` always leads with a "Metadata only" notice that says methods, policy outcomes, object identifiers, request IDs, and timestamps are stored, while Slack message text, search queries, file contents, and tokens are not stored.
  - Populated rows currently show method/action label, status badge, token profile/session, timestamp, category, object type/id, execution mode, and error class where available.
- Behaviors that must remain unchanged:
  - Do not change audit recording, retention, session scoping, route diagnostics, Slack forwarding, token profile lifecycle behavior, or the JSON shape from `/v1/prism/activity` unless implementation evidence proves the UI cannot satisfy the slice with the existing summary.
  - The website must remain session-scoped to `prism_session`; do not introduce client-side polling, local storage, browser credential handling, or a second auth/session path.
  - Status must remain textual and not rely on color alone; status labels should continue to render as visible text inside local `StatusBadge` or a substrate-backed equivalent.
  - The panel must never render Slack payload text, raw search queries, file contents, Block Kit/content structures, Prism developer tokens, token hashes, peppers, Slack access/refresh tokens, OAuth code/state, client secrets, credentials, or authorization material.
- Runtime or UX evidence:
  - `npm test` passes locally: 45 files, 123 tests.
  - `app/activity-audit-panel.test.tsx:6-39` currently verifies lifecycle-event rendering and no common token/secret canaries.
  - `src/server/audit/activity.test.ts:8-80`, `src/server/audit/postgres-store.test.ts:12-71`, and `app/v1/prism/activity/route.test.ts:46-75` already protect backend/API no-content/no-secret behavior.
  - `app/design-system.test.ts:6-23` guards against inline styles and enforces OKLCH/shared design-system use.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use `ActivityAuditSummary` from `src/server/audit/presentation.ts` as the UI input; it already has `requestId`, so the missing request-ID display is a rendering gap, not a data-model gap.
  - Use `formatUtcDateTime` from `app/date-format.ts` for timestamps to avoid hydration/date-format drift.
  - Use local primitives from `app/ui.tsx` (`Panel`, `Notice`, `StatusBadge`, and `cx` if useful) rather than importing Tailwind, shadcn, Radix, or a table library.
  - Add or refine CSS in `app/globals.css` using existing OKLCH tokens, panel/list/badge classes, tabular numerals, responsive breakpoints, and no inline styles.
  - Keep render tests with `renderToStaticMarkup` and Vitest; add assertions to `app/activity-audit-panel.test.tsx` and, if placement copy changes, `app/website-overview.test.ts` or page-adjacent tests.
- Relevant docs or library capabilities:
  - React/Next server-rendered components are enough for this static audit workspace; no client component, state hook, effect, polling, or browser storage is needed for acceptance criteria.
  - Semantic HTML options that fit this data: keep the existing `article` + `dl` pattern and make it denser, or use an accessible table/list hybrid. If using a table, preserve responsive behavior and avoid hiding required fields.
  - CSS `font-variant-numeric: tabular-nums` is already used for `.activity-list dd` and should continue for timestamps/request IDs.
- Existing examples in this codebase:
  - `app/token-profiles-panel.tsx` shows guided copy, status badges, substrate-backed forms, no-secret copy-once treatment, and accessible status/error messaging.
  - `app/slack-status-panel.tsx` and `app/ui.test.tsx` show compact no-secret panel rendering with primitives.
  - `app/globals.css:778-862` contains the current shared profile/activity metadata-list styles to extend rather than duplicate.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a parallel audit API, new audit store, new summary DTO, new database query, or client-side fetch path for this slice.
  - Do not duplicate `Panel`, `Notice`, `StatusBadge`, button, or token/profile UI primitives with one-off components or inline styles.
  - Do not add Tailwind/shadcn dependencies; recent work intentionally created local primitives and OKLCH CSS tokens to avoid a parallel styling path.
  - Do not change Slack method registry, policy evaluation, execution identity, forwarding, rate limit, token profile lifecycle, OAuth, or credential custody behavior for a website rendering change.
- Shortcuts or parallel paths to avoid:
  - Do not render generic `JSON.stringify(entry)` or iterate over all entry keys; explicitly whitelist display fields.
  - Do not show `endpoint` by default if it risks looking like payload logging; method/action/category/request ID are enough unless product explicitly asks for endpoint.
  - Do not infer or synthesize content-like labels from request bodies, Slack responses, search terms, filenames, or message/file text.
  - Do not use color-only status chips, hover-only reveal, hidden required metadata, or desktop-only layouts.
- Invariants:
  - Metadata-only/no-secret rendering is a hard invariant: only render safe `ActivityAuditSummary` fields and test canaries for Slack content and secrets.
  - Object, identity, request, method/action, category, timestamp, token profile/session, and status metadata must remain visible where available.
  - Status communication must be color-blind safe: visible status text plus tone/color, and preferably stable labels such as "Forwarded", "Denied", "Rate limited".
  - The empty state must teach what will appear later and restate that payloads/content/tokens are not stored.

## Integration plan

- Insert the change at:
  - Primary implementation: `app/activity-audit-panel.tsx`.
  - Styling: extend the existing activity classes in `app/globals.css`.
  - Tests: extend `app/activity-audit-panel.test.tsx`; keep backend/API audit tests unchanged unless a test reveals a real rendering/data mismatch.
  - Optional placement copy: only touch the not-linked fallback in `app/page.tsx:102-110` if needed to keep empty-state messaging consistent.
- Why this is the correct integration point:
  - The existing backend and presentation layer already provide the necessary metadata safely; the acceptance criteria target how the audit panel is scanned and understood.
  - `ActivityAuditPanel` is the existing owner of populated and empty linked audit states, so redesigning there preserves the server-owned session/data flow.
  - `globals.css` is the established design-system substrate; extending `.activity-list`, `.activity-row`, or new `activity-*` classes keeps the website on the same local primitive/token path.
- Alternatives considered and rejected:
  - New `/v1/prism/activity` client fetch/polling: rejected because current server-rendered data already works and a client path would duplicate session/data ownership.
  - New audit schema/store fields: rejected because `ActivityAuditSummary` already contains request ID and required metadata.
  - Generic key/value renderer over all summary fields: rejected because it increases accidental leakage risk if summary shape expands.
  - Standalone table library or shadcn install: rejected because the repo intentionally uses local primitives/CSS tokens and has no Tailwind/shadcn dependency.

## Regression checklist

- Behavior: Linked sessions with no activity still render an instructional empty audit state and metadata-only copy.
- Behavior: Populated activity shows method/action, status text, token profile/session identity, timestamp, category, object ID, execution identity, request ID, HTTP/upstream/error metadata where available without hiding existing fields.
- Behavior: Statuses remain text plus color/tone and are understandable without color.
- Behavior: No Slack message text, DM/search query, file content, Block Kit/content JSON, Prism developer token, token hash, pepper, Slack credential, OAuth code/state, client secret, or authorization material is rendered.
- Behavior: Current-session scoping, audit API shape, forwarding diagnostics, token profile lifecycle, and no-store headers are unchanged.
- Behavior: Mobile/narrow layouts remain readable and required metadata is not hover-only or desktop-only.
- Behavior: Existing design-system guard continues to pass with no inline styles.

## Test plan

- Existing tests to keep green:
  - `app/activity-audit-panel.test.tsx`
  - `app/design-system.test.ts`
  - `app/ui.test.tsx`
  - `app/website-overview.test.ts`
  - `app/v1/prism/activity/route.test.ts`
  - `src/server/audit/activity.test.ts`
  - `src/server/audit/postgres-store.test.ts`
  - Full `npm test` suite and `npm run build`.
- New tests to add before/with implementation:
  - Empty state test: renders clear "what will appear" copy and explicitly says Slack message text/search queries/file contents/tokens are not stored.
  - Populated state test: one or more audit rows render method/action, status text, token profile/session, timestamp, category, object type/id, execution identity, request ID, HTTP/upstream/error metadata where available.
  - No-secret guarantee test: pass canaries through every displayable and non-displayable field and assert no raw Slack payload text, search query, file content, Block Kit/content terms, `prism_dev_`, `tokenHash`, `pepper`, `xoxb-`, `xoxp-`, `refresh-secret`, `access_token`, `client_secret`, OAuth code/state, or authorization material appears.
  - Status accessibility/design test: assert status text is present and status badges use known substrate classes/tones instead of color-only markers.
- Live proof required:
  - Run `npm test`.
  - Run `npm run build`.
  - Start the local app with existing dev flow, open the homepage in a linked/mock-linked state containing both empty and populated audit data if available, and capture visual proof that request ID, timestamp, object, identity, method/action, category, and status are scannable.
  - Inspect rendered HTML or browser text to verify metadata-only/no-secret copy and absence of canary secrets/content.

## Risk assessment

- Risk: Accidentally rendering all fields or future fields could expose content or secrets if the presentation shape expands.
- Risk: Dense redesign could reduce accessibility, especially if status meaning relies on hue, metadata is hidden on small screens, or rows become hard to navigate.
- Risk: Changing `app/page.tsx` data loading or `/v1/prism/activity` for a UI need could regress session scoping/no-store/no-secret guarantees.
- Mitigation:
  - Keep an explicit field whitelist inside `ActivityAuditPanel`.
  - Use substrate primitives and semantic labels (`dl`/headings/table headers) with visible text for every status and metadata label.
  - Add canary-based tests for empty and populated states before/with implementation.
  - Keep backend/API files unchanged unless tests prove a true missing field; request ID is already available in `ActivityAuditSummary`.

## Decision confidence

- Confidence: high
- Reasons:
  - The behavior already has clear ownership and the required metadata is already present in the safe presentation type.
  - The slice is primarily a rendering/styling/test expansion inside an existing component with established design-system primitives.
  - Existing tests already protect backend no-secret behavior and the full suite passes.
- Open questions:
  - Whether the not-linked homepage fallback should be redesigned along with the linked empty `ActivityAuditPanel` empty state, or left as supporting setup copy.
  - Whether `httpStatus` and `upstreamCalled` should be first-class visible columns/chips in the dense workspace or secondary metadata after the required method/status/object/identity/request/timestamp/category fields.
  - Whether object metadata should render partial values when only `objectType` or only `objectId` is present; current code renders object only when both are present.
