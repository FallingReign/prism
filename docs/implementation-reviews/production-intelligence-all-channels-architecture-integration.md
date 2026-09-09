# Production Intelligence all-channel selection architecture integration

**Status:** Architecture Scout integration brief  
**Date:** 2026-09-01  
**Repositories inspected:** `C:\Development\slack apps\prism` and `C:\Development\ai-powered\production-system`  
**Prism baseline:** `881308bc913d1f645384bab340d793cd93b02914` (`codex/universal-delegated-consent-origin`)  
**Production Intelligence baseline:** uncommitted initial `main` working tree (no `HEAD` yet)

## Executive decision

The user must be able to connect Prism, inspect the complete set of joined public and private channels available through that exact Prism connection and workspace, and choose **Select all** once. A selected state is not proof of collected coverage. Production Intelligence may report Slack coverage healthy only after its connector has checked every selected channel within a complete, bounded sweep.

This slice should **not require a Prism deployment**. The installed Prism already exposes the policy-gated `conversations.list` method through `/v1/slack/api/[method]`. Production Intelligence currently fails because it tries to finish the whole company directory inside one request and stops after 16 pages. A live read-only check on 2026-09-01 returned `502` with `Prism has more channel pages than this product can safely load.` after approximately 13 seconds. That is a Production Intelligence page-ceiling failure, not evidence that Prism cannot enumerate the workspace.

Use the existing Prism contract page by page. Production Intelligence should own a resumable directory scan, validate every page, and materialize a complete current snapshot before enabling Select all. Select all persists the exact immutable channel IDs and surfaces from that completed snapshot. It is **not** a dynamic `all_joined` subscription and does not silently include channels joined in the future.

Do **not** add `users.conversations` to Prism's generic Method registry for this slice. If a later Prism deployment introduces a first-party directory resource, `users.conversations` should remain a server-side implementation detail behind a narrow versioned resource API, reusing the existing `src/server/playtest-directory` design. It should not become a raw generally forwarded method.

## Stable product intent

- Pair once through Prism; never ask the user to paste thousands of channel links.
- Show the complete current channel directory for the selected granted workspace, with names for recognition and immutable IDs for authority.
- Provide one action that selects every channel in that completed directory snapshot.
- Keep channel selection separate from source health. “3,412 channels selected” must not become “3,412 channels covered” until a complete connector sweep says so.
- Preserve the existing read-only promise. Production Intelligence does not send, react, invite, join, archive, rename, or otherwise mutate Slack.
- Preserve user and workspace identity. The directory and later history reads must use the developer token issued for the approved Prism user/connection, the explicitly selected workspace, and the exact public/private surface policy.
- Prefer current, member-visible channels. Archived channels, unjoined public channels, unavailable private channels, DMs, and MPIMs are outside this slice.
- Keep future scope expansion explicit. Joining a new Slack channel later does not silently add it to an already saved snapshot; the user can refresh the directory and save Select all again.

## Existing ownership and interaction model

### Prism owns

- Slack OAuth credential custody, refresh, and execution-identity selection.
- Developer-token resolution, revocation/expiry, capability policy, exact Slack connection, and organization workspace grants.
- Method classification in `src/server/slack/method-registry.ts`.
- Workspace and surface enforcement in `src/server/token-profiles/method-policy.ts`.
- Rate limits, forwarding, metadata-only audit, and upstream response diagnostics.
- The existing safe forwarding contract for `conversations.list`, `conversations.info`, `conversations.history`, and `conversations.replies`.

The current Method registry classifies `conversations.list` as `conversations.read`, requires `actions.read`, and requires an explicit surface. The route resolves `x-prism-workspace-id` against the exact connection and `x-prism-surface` against the Token profile before decrypting or forwarding a Slack credential.

### Production Intelligence owns

- The guided pairing UI and protected local pairing configuration.
- The producer's workspace/channel coverage choice.
- Complete page validation, deduplication, sorting, scan progress, and Select all semantics.
- Persisting the exact selected channel snapshot locally.
- Per-channel collection checkpoints, success watermarks, source health, evidence gating, and truthful coverage status.
- The exception-driven Production Inbox and its plain-language distinction between selected, checking, partial, healthy, and stale coverage.

### Current user path

`PrismOnboardingManager` pairs `clientId=production-intelligence` with a user execution identity, receives only an opaque Prism developer token plus granted workspace metadata, and stores only a user-protected token blob. The UI then calls `listChannels`, which currently loops both surfaces internally and retains a complete directory in memory. `saveSelection` validates selected entries against that in-memory directory and persists at most 32 channels. `PrismSelectedChannelConnector` also rejects more than 32 channels and starts each collection at the beginning of the array.

These three current assumptions conflict with the agreed slice:

1. one synchronous directory request cannot safely finish COD Dev;
2. a 32-channel cap makes Select all cosmetic;
3. a bounded connector that restarts from channel one can never finish a large selection.

## Required architectural decisions

### 1. Current snapshot, not dynamic `all_joined`

Select all means:

> Every joined, non-archived public or private channel returned by the complete directory scan saved at this time.

Persist the exact IDs, names-as-display-snapshots, and surfaces. The workspace ID and channel IDs are authoritative; names may change. Store the completed scan timestamp and a deterministic manifest hash. UI copy should say that newly joined channels require **Refresh channel list** and another save.

Reject a dynamic `all_joined` boolean for this slice because it would:

- expand the local read scope when future channels are joined without another visible choice;
- make a directory outage indistinguishable from channels being removed;
- require every collection to trust a newly completed directory before knowing its scope;
- make it possible to report “all” while only a partial directory was available.

A future explicit **Automatically include newly joined channels** option can be designed separately with its own consent copy and revocation semantics.

### 2. Existing `conversations.list` contract now; narrow resource later

For this release, use Prism's current generic forwarding route:

```text
GET /v1/slack/api/conversations.list
Authorization: Bearer <opaque Prism developer token>
X-Prism-Workspace-Id: <selected granted workspace ID>
X-Prism-Surface: public_channel | private_channel

types=public_channel | private_channel
exclude_archived=true
limit=200
cursor=<opaque Slack cursor when present>
```

Production Intelligence must validate `ok === true`, an array `channels`, strict bounded cursor metadata, and the selected workspace when Prism supplies workspace metadata. Include a channel only when:

- its ID is a valid Slack channel ID;
- `is_member === true` (do not treat an omitted membership flag as permission);
- it is not archived;
- its returned privacy metadata agrees with the requested Prism surface;
- its name is bounded and safe for display.

Both surface cursor chains must reach an empty terminal cursor. Repeated, missing, oversized, malformed, or cyclic cursors make the scan incomplete. Deduplicate by channel ID. If the same ID appears with conflicting surfaces, fail the scan rather than choosing one.

`users.conversations` should **not** be added to `supportedRegistry`:

- the generic policy API requires a caller-provided surface, while `users.conversations` can return mixed surfaces;
- exposing the raw method would widen the general proxy and its response beyond this product need;
- Prism already has the safer model in `src/server/playtest-directory`: bind the authenticated token to one connection/workspace, select the user credential internally, call `users.conversations`, return only ID/name/privacy, cache briefly, and re-check grants before cache use.

If a later Prism release generalizes that resource, extract shared directory code rather than duplicating Playtest. A suitable versioned endpoint is:

```text
GET /v1/prism/local-app/slack/workspaces/{teamId}/channels?cursor=...&limit=200
```

Its response should remain the existing narrow shape: `contract_version`, `team_id`, `channels[{channel_id,channel_name,is_private}]`, and `next_cursor`. Production Intelligence may adopt it after capability negotiation, but it is not a prerequisite for the present fix.

### 3. Server-owned directory scan and small browser requests

Do not send thousands of channel records through the current 64 KiB selection request. Add a short-lived, server-owned scan state inside `PrismOnboardingManager`:

```text
POST /api/prism/channel-directory/scans
body: { workspaceId }
-> { scanId, workspaceId, state: "loading", loadedCount: 0 }

POST /api/prism/channel-directory/scans/{scanId}/next
body: {}
-> { scanId, state: "loading" | "complete", loadedCount, page, nextSurface }

GET /api/prism/channel-directory/scans/{scanId}?offset=0&limit=200&query=...
-> { scanId, state, workspaceId, channels, totalCount?, loadedCount, completedAt? }

POST /api/prism/selection
body: { workspaceId, mode: "snapshot_all", scanId, includeReplies }
```

The exact local route spelling may vary to match the existing compact server, but these invariants may not:

- the local service, not the browser, owns Prism cursors and completeness;
- `scanId` is opaque, bounded, bound to the current paired connection and workspace, and expires after a short inactivity window;
- one `next` operation performs one bounded upstream page so the browser is never held by an unbounded company scan;
- a complete scan is immutable and can be paged/searched for display;
- Select all resolves the completed scan server-side and writes the exact snapshot; an incomplete, expired, wrong-workspace, or previous-pairing scan is rejected;
- the UI can keep requesting `next` automatically while showing `Loading channels — N found` and can cancel by closing the dialog;
- no developer token, Slack token, Authorization header, raw Slack object, topic, purpose, message, or cursor is returned to the browser.

Keep the existing direct-link resolver only as a secondary diagnostic escape hatch for a genuinely unavailable single channel. It is not the success path for Select all and must not be presented as the replacement for a failed complete scan.

### 4. Versioned selection persistence

Evolve `ProtectedPrismConfig` additively. A recommended version-2 selection is:

```ts
selection: {
  mode: "snapshot_all" | "explicit";
  workspaceId: string;
  channels: Array<{ id: string; surface: "public_channel" | "private_channel"; name?: string }>;
  selectedAt: string;
  coverageStartsAt: string;
  directoryCompletedAt?: string;
  directoryManifestHash?: string;
  includeReplies: boolean;
}
```

The protected developer token remains unchanged. Channel metadata is local configuration, not a second credential store. Write the complete replacement atomically through `writeProtectedConfig`.

Migrate version 1 in memory and write version 2 only on the next successful selection change. Existing explicit selections must retain their IDs/surfaces and behavior. Do not silently convert them to Select all.

Remove the 32-channel product and connector limit. Retain resource-abuse validation: unique valid IDs, two allowed surfaces for this UI, bounded names, a bounded serialized configuration size, and a documented high ceiling large enough for the completed directory. Reaching the ceiling must block with `This workspace contains more channels than this version can safely save`; it must never truncate and label the result Select all.

`setup()` should return a selection summary (`mode`, workspace, selected count, selected timestamp, and a small preview) rather than serializing thousands of channel names on every Inbox load. The complete inspectable list remains available through the local paged directory/snapshot endpoint.

### 5. Truthful broad collection within the current runtime

Directory completion and message collection are separate operations. Slack history is one channel-scoped API at a time; no current Prism endpoint can honestly turn thousands of channels into one complete message-history read. The connector therefore needs resumable sweeps.

Add an optional **attempt checkpoint** separate from the trusted success watermark:

- a success watermark advances only after every selected channel in the saved manifest completed history/reply pagination for the sweep;
- an attempt checkpoint records the manifest hash, sweep start, pending channel/page/reply tasks, per-channel latest timestamp/deduplication state, completed count, failure/retry state, and whether the sweep observed changes;
- partial runs update the attempt checkpoint and source-health counts but never the success watermark;
- service restart resumes the attempt checkpoint;
- a changed selection/manifest invalidates the attempt checkpoint and begins a new sweep;
- a complete sweep atomically promotes its accumulated per-channel state to the success watermark and clears/rolls the attempt checkpoint.

Extend the connector/store contract compatibly, for example with optional `resumeCheckpoint` input and `checkpoint` output plus a `source_health.attempt_checkpoint` column. Other connectors can omit it. Do not overload `successWatermark`; current trust code correctly treats it as proof of a complete successful run.

Collection scheduling must be deterministic and fair:

- sort selected channels by immutable ID for a stable base order;
- use a bounded queue and shared deadline/page budget;
- save the next task before returning partial;
- respect Prism and Slack `Retry-After` without busy waiting past the current budget;
- do not restart at channel one after a budget or rate limit;
- bound work per channel/pass so one high-volume channel or reply tree cannot starve every later channel;
- on initial selection, set `coverageStartsAt` explicitly and request no history older than that point. Historical backfill is a separate future user choice; do not call a forward-only sweep “all historical Slack.”

Partial channel evidence may be stored as last-known evidence, but current claims and outward briefs remain blocked while Prism source health is partial. `derivePilotClaims` must not turn a partial batch into verified communication coverage. At the end of a complete sweep, emit a metadata-only coverage evidence record containing the workspace ID, manifest hash, selected/checked counts, and sweep timestamps; it proves the check, not delivery, acknowledgement, understanding, or action.

Add explicit diagnostics:

- `selectedChannelCount`
- `checkedChannelCount`
- `pendingChannelCount`
- `failedChannelCount`
- `directoryCompletedAt`
- `sweepStartedAt`
- `oldestUncheckedAt` or an equivalent freshness signal

User-visible state should be:

- **Selected:** “All 3,412 channels from the 1 Sep directory snapshot.”
- **Checking:** “628 of 3,412 channels checked. Current Slack coverage is not ready yet.”
- **Partial:** exact failed/pending counts and the action to retry or refresh the directory.
- **Healthy:** only after `checkedChannelCount === selectedChannelCount`, no unresolved page/channel failures, and the full sweep is inside the configured freshness window.
- **Stale:** the last full sweep is older than the normal source freshness window, even if a newer partial sweep is in progress.

The existing 15-minute scheduler and refresh coalescing may drive resumable sweeps. An implementation may schedule an earlier bounded continuation after a rate-limit reset, but it must not create overlapping collections or a second unbounded scheduler. Selecting all is immediate; achieving first healthy coverage may take multiple bounded runs, and the product must say so.

## Existing extension points

### Prism (reuse unchanged for this slice)

- `src/server/slack/method-registry.ts`: existing `conversations.list` classification.
- `src/server/token-profiles/method-policy.ts`: exact connection/workspace and surface enforcement.
- `app/v1/slack/api/[method]/route.ts`: thin bearer-token policy and forwarding boundary.
- `src/server/slack/forwarding.ts`, `forwarding-credentials.ts`, `web-api-client.ts`, and `rate-limit.ts`: credential, execution, upstream, and rate-limit owners.
- `src/server/playtest-directory/*`: future shared narrow-resource implementation; do not copy it into another Prism-specific directory module.

### Production Intelligence

- `src/server/prism/onboarding.ts`: own scan lifecycle, normalized pages, complete snapshot, selection validation, and protected config projection.
- `src/server/prism/protected-config.ts`: versioned snapshot configuration and atomic persistence.
- `src/server/app.ts`: thin local scan/status/selection routes with the existing JSON/CSRF/body-limit rules.
- `src/web/App.tsx` and `styles.css`: progress, searchable inspectable channel list, Select all, selected count, and responsive behavior.
- `src/server/connectors/prism.ts`: resumable per-channel history/reply sweep and complete-sweep evidence.
- `src/server/connectors/types.ts`, `src/server/storage/production-store.ts`, and `src/server/production-service.ts`: optional attempt checkpoint and honest source-health projection.
- `src/server/rules/pilot-rules.ts`: verified Prism coverage only from a healthy complete sweep.

## Do-not-bypass systems

- Do not add Slack OAuth, Slack token storage, direct `slack.com/api` calls, or a parallel credential path to Production Intelligence.
- Do not bypass Prism's developer-token resolution, Method registry, capability map, workspace grant, surface gate, execution identity, rate limiter, or activity audit.
- Do not add `users.conversations` to the generic Method registry merely to make this UI easier.
- Do not use `conversations.list` without both the exact workspace header and exact surface header.
- Do not accept channels with `is_member` absent or false as coverable.
- Do not accept a partial/capped/repeated-cursor directory as Select all.
- Do not trust channel names for identity, merge same-name channels, or combine a channel from one workspace with another workspace.
- Do not post, join, invite, or probe by mutation to establish access.
- Do not equate “selected,” “directory complete,” “connector checked,” and “source healthy.”
- Do not advance the success watermark from a partial sweep.
- Do not log or return developer tokens, Slack tokens, raw Authorization headers, protected config bodies, Slack message bodies, topics, purposes, or directory cursors.
- Do not add Python source, dependencies, subprocesses, or test tooling. Prism's pre-existing Python helper is outside this slice and must not be invoked as part of this work.

## Integration plan

1. **Production directory state machine:** replace the all-pages `listChannels` call with a short-lived scan that fetches one existing Prism `conversations.list` page at a time, validates strict membership/surface/cursor rules, and produces an immutable complete snapshot.
2. **Local API:** add thin scan-start, scan-next, and paged-snapshot reads. Keep JSON bounds and local origin/CSRF protections. Add Select all by `scanId`, not a thousands-entry browser POST.
3. **Selection persistence:** version the protected config, save the exact completed snapshot, remove the 32-channel cap without introducing silent truncation, and project a compact selection summary.
4. **Product UI:** automatically progress the scan, show count/progress, expose search and a scrollable/paged list, provide one Select all action, and clearly separate selected count from checked coverage. Remove the paste-link fallback from the primary path.
5. **Connector checkpoint:** add a durable attempt checkpoint separate from the success watermark, resume large selections fairly across bounded refreshes, and emit complete-sweep diagnostics/evidence only when every selected channel finishes.
6. **Trust integration:** prevent partial Prism batches from producing a verified communication-coverage claim; keep the brief gate closed until a fresh complete sweep.
7. **Documentation/evidence:** replace docs that say large workspaces must paste links, record the actual snapshot semantics and first-sweep limitation, and update acceptance/release evidence only after live proof.
8. **Prism deployment:** none for this slice. If live behavior contradicts the inspected `conversations.list` policy/response contract, stop and use the narrow-resource follow-up rather than weakening validation.

## Regression checklist

- Existing Prism pairing, approval polling, private-VPN HTTP confirmation, protected token persistence, and disconnect remain unchanged.
- Workspace selection remains limited to workspaces returned for the approved Prism connection.
- Public and private surface policy remains explicit; DMs/MPIMs remain out of this UI.
- Existing small explicit selections migrate without becoming Select all.
- A completed scan contains every terminal-page member channel exactly once and no archived/unjoined channel.
- Missing, repeated, malformed, cyclic, or never-terminal cursors fail visibly and cannot be saved as Select all.
- Closing/reopening the dialog can restart or resume safely without leaking a cursor/token to the browser.
- Select all sends a small local request and persists the server-owned snapshot atomically.
- Selected counts above 32 remain valid in setup and connector configuration.
- Connected status does not serialize/render thousands of names by default.
- Channel rename changes display only; immutable ID remains selected.
- Selection change invalidates an in-progress collection checkpoint.
- Partial/budget/rate-limited collection resumes after restart instead of starting from the first channel.
- Partial collection never advances the success watermark or enables outward claims.
- Complete collection checks every selected channel and only then becomes healthy.
- A failed/revoked/wrong-workspace/wrong-channel response remains visible; no silent removal or scope shrink.
- Existing ai-reference connectors and their watermark behavior remain unchanged.
- Desktop, 640 px, and 320 px dialogs remain readable without page-level overflow.
- No secrets, raw Slack objects, message bodies, databases, logs, or protected local config enter Git.

## Test plan

### Production Intelligence automated tests

- `src/server/prism/onboarding.test.ts`
  - scan both surfaces through more than 16 pages and a terminal cursor;
  - strict `is_member === true`, archived filtering, name bounding, surface agreement, cross-workspace rejection, duplicate-ID dedupe, conflicting-surface rejection;
  - repeated/missing/cyclic/oversized cursor rejection;
  - scan expiry, wrong scan/workspace/pairing rejection;
  - Select all persists every channel from the complete snapshot and rejects incomplete snapshots;
  - version-1 explicit selection migration.
- `src/server/prism/onboarding-api.test.ts` and `src/server/app.test.ts`
  - bounded scan routes, small Select all body, no cursor/token/raw Slack leakage, invalid/extra fields, body limits, and local mutation protections.
- `src/web/App.test.tsx`
  - progressive loading count, complete searchable list, one Select all action, correct selected count, retry/cancel, no paste-link primary path, and selected-versus-checked copy.
- `src/server/connectors/prism.test.ts`
  - more than 32 selected channels;
  - checkpoint advances across budget exhaustion and process recreation;
  - rate-limit retry metadata and no busy wait;
  - selection hash invalidates checkpoint;
  - fair progress past a high-volume channel;
  - initial `coverageStartsAt` floor;
  - partial evidence does not claim complete coverage;
  - complete sweep count equality and success watermark promotion;
  - wrong workspace/channel and replies pagination remain fail-closed.
- `src/server/storage/production-store.test.ts` and `src/server/production-service.test.ts`
  - attempt checkpoint advances independently;
  - partial cannot advance success watermark;
  - complete sweep clears/promotes checkpoint atomically;
  - partial Prism runs cannot create a verified communication claim or unblock a brief.
- Run `npm run check` in Production Intelligence; it includes the no-Python guard, Vitest, typecheck, and both builds.

### Prism regression tests (no product change expected)

- Keep `src/server/slack/method-registry.test.ts`, `src/server/token-profiles/method-policy.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, forwarding, execution identity, workspace-grant, rate-limit, and no-secret tests green.
- Add a contract fixture only if needed to document multi-page `conversations.list`; do not change the production registry or route.
- If the future narrow resource is implemented, generalize `src/server/playtest-directory/directory.test.ts` and both Playtest routes rather than duplicating behavior.
- Use TypeScript Vitest and `npm run build` only for this slice. Do not invoke or add Python tooling.

### Live proof

1. Pair the installed Production Intelligence instance to the current VPN Prism connection without re-pairing or exposing credentials.
2. Select COD Dev and let the scan run past the previous 16-page boundary to an empty terminal cursor for both surfaces.
3. Record only safe proof: total joined channel count, public/private counts, scan completion time, no duplicates/conflicts, and request diagnostics without cursor/token values.
4. In the browser, search for channels near the beginning, middle, and end of the complete snapshot; confirm the total remains stable and no page-level overflow exists at desktop, 640 px, and 320 px.
5. Use Select all once. Confirm connected status reports the exact saved count and does not enumerate thousands of names.
6. Trigger refresh. Confirm the source reports checking/partial with exact checked and pending counts until the full sweep completes; it must not claim healthy early.
7. Restart the local service during a partial sweep and confirm progress resumes beyond the previous checkpoint.
8. After the first full sweep, confirm checked equals selected, the success watermark advances once, the source becomes healthy, and the metadata-only coverage evidence is inspectable.
9. Confirm the Production Inbox still never implies any Slack message was sent, acknowledged, understood, or acted on.

## Risks and mitigations

- **COD Dev is larger than expected.** A full directory can exceed ordinary UI and request sizes. Mitigation: server-owned page scan, paged/searchable rendering, small scan-ID selection request, explicit non-truncating safety ceiling.
- **Slack membership changes during pagination.** Slack cursors do not provide a durable atomic snapshot. Mitigation: describe it as the completed current scan, dedupe strictly, persist completion time/hash, and require refresh to include future changes.
- **Select all is mistaken for immediate coverage.** Mitigation: distinct selected/checked/healthy states and complete-sweep gating.
- **Thousands of history calls hit Prism or Slack limits.** Mitigation: durable checkpoint, fair bounded queue, Retry-After, forward-only coverage start, and partial source health. Instant historical coverage is not promised.
- **A partial sweep repeatedly starts at the first channel.** Mitigation: separate durable attempt checkpoint; this is a release blocker, not a performance polish item.
- **A high-volume channel starves later channels.** Mitigation: bounded page work per task/pass and persisted requeue.
- **Selection snapshot becomes stale after a channel is archived or access is lost.** Mitigation: channel failure remains visible and source partial; refresh/re-save directory rather than silently removing it.
- **The current Prism mock repeats a cursor.** Mitigation: Production Intelligence must fail the scan visibly. Do not add a repeated-cursor escape that would turn a mock/invalid first page into a complete directory.
- **Protected config and status payload grow excessively.** Mitigation: local atomic snapshot persistence with serialized-size guard; compact setup/status projection; paged detail endpoint.
- **A future Prism resource duplicates Playtest.** Mitigation: extract the existing directory service and add policy adapters, keeping `users.conversations` internal.
- **Current generic local-app preset is broader than this product uses.** Production Intelligence remains GET-only and the directory change adds no write path. Least-privilege read-only pairing is a separate Prism policy correction; this slice must not use its existence to add any mutation.

## Alternatives considered

### Increase `MAX_CHANNEL_PAGES` and return one giant directory

Rejected as the final architecture. It could cross the current live boundary, but it keeps one long browser request, repeats a full scan on save, risks the 60-second budget, returns a large payload, and still leaves the 64 KiB selection and 32-channel connector caps.

### Dynamic `all_joined`

Rejected for this slice because future membership silently expands local collection scope and every collection depends on a fresh complete directory. It can be offered later only as an explicit separately explained mode.

### Add `users.conversations` to the generic Method registry

Rejected. Mixed-surface output does not fit the current surface gate, and raw generic forwarding is broader than the product need. A narrow versioned resource is the correct future Prism boundary.

### Deploy a new narrow Prism resource now

Architecturally sound but not required. The current installed Prism contract can enumerate COD Dev; the observed failure is local page capping. Avoid a remote deployment dependency for this user-visible fix.

### Paste channel links or upload IDs

Rejected as a primary experience. It transfers directory labor and error risk to the user and cannot prove a complete Select all scope.

### Mark the connector healthy after checking a bounded sample

Rejected as fake coverage. Sampling may inform capacity planning, never a current all-channel claim.

### Collect all Slack history before saving selection

Rejected. Selection is a product choice; source collection is asynchronous operational work. Coupling them would make setup unbounded and would still not solve ongoing freshness.

### Add Slack Events/event storage to Prism

Potentially the right long-term scale mechanism for near-real-time all-channel updates, but it is a materially larger Prism product area with new scopes, event ingress, durable storage, replay, and privacy policy. It is not required to provide a complete directory or honest resumable coverage now.

## Decision confidence

**Confidence: high for directory and selection placement; medium-high for first-sweep throughput.**

Reasons:

- Live evidence identifies the immediate blocker precisely: Production Intelligence reaches its own 16-page ceiling while Prism continues returning valid next pages.
- Prism's current Method registry, workspace/surface policy, user execution identity, forwarding, rate-limit, and audit owners already enforce the required boundary.
- The Production Intelligence onboarding manager already owns an in-memory validated directory and selection; evolving it into a resumable complete scan is an extension, not a parallel subsystem.
- An explicit snapshot is the only Select all semantic that both avoids a Prism deployment and prevents silent future scope growth.
- Current source-health and success-watermark rules already fail closed; a separate attempt checkpoint preserves those semantics while allowing real progress across a studio-scale selection.

Remaining uncertainty is operational rather than architectural: the exact number of joined COD Dev channels, upstream Slack method rate limits for this installation, and how many bounded runs the first full sweep needs. The implementation must measure those safely and report honest progress. If the first sweep is too slow for the desired product freshness, the next architecture decision is Prism-owned event ingestion or another bulk authoritative source—not a false healthy state.
