# Enterprise Slack reliability verification

Date: 2026-09-04. Local changes in Prism and SHG Playtest; no production deployment, production migration, credential replacement, or real Slack announcement was performed.

## Result by risk

| Risk | Result |
| --- | --- |
| R1 | Prism's global Slack scopes and Playtest's narrow, user-only sign-in token remain unchanged. Bot announcements use an explicit approval for the exact announcement. Server custody of encrypted Slack credentials remains part of Prism's architecture. |
| R2 | Bounded failure reasons survive Slack callback, OIDC continuation, and Playtest callback. Temporary failures, denial, invalid response, and persistence failure have separate recovery guidance. Startup errors retain the pending Playtest continuation. Login and destination selection provide in-app guidance; raw provider errors are not shown. |
| R3 | Organization identities allow a missing workspace ID and retain the enterprise claim. Workspace selection remains independent of login identity. Me and Slack Bridge bot are supported for immediate and scheduled announcements, preserving sender through consent, storage, execution, retries, and receipts. |
| R4 | [Internal HTTPS migration proposal](../slack/internal-https.md) prepared. Deployment and client certificate trust are not changed. |
| R5 | Stale strict-check fixtures repaired, Windows script line endings normalized, test concurrency made predictable, and dependency security updates applied. Cross-application browser tests added with real PostgreSQL and SQLite. |
| R6 | The reported exposed credential is Jira Tools' Slack bot token, not a Jira personal access token. Replacement remains an operator maintenance action. No exposed token was retrieved or repeated in this work. |

## Automated evidence

- Prism: 158 test files / 847 tests passed; Python helper 13 tests passed; strict TypeScript check and Next.js 16.3.4 production build passed.
- Playtest: 65 test files / 387 tests passed; strict TypeScript check, lint, and Next.js 15.5.25 production build passed.
- Cross-application E2E: all 27 child journeys passed, zero failures or skips, in 165.8 seconds. Node reports 28 tests when including the parent wrapper. The real PostgreSQL clock-skew regression, both scheduled senders, same-grant retry, and repeated-worker duplicate protection passed.
- E2E harness lint passed with zero warnings. Browser safety assertions found no unhandled exceptions, CSP violations, or unplanned external operations. Final recovery and sender screenshots were inspected at a 1280-pixel viewport.
- Historical Playtest dashboard package: 47 tests and its type check passed; no features were added there.
- Independent architecture review: no outstanding finding. The reviewer independently ran 54 delivery regression tests. See the [review record](enterprise-slack-reliability-architecture-integration.md#independent-implementation-review).
- Patched Sharp 0.35.4 passed a real image encode/decode check. Both lockfiles no longer match any vulnerable package ranges identified by the successful audits during this investigation. Subsequent full audit requests timed out at the npm advisory service, so a fresh all-packages clean audit is not claimed.

The browser harness starts copied application source with isolated configuration and disposable databases. Normal cross-application routes and stores are real. Slack is synthetic; one named test injects a network failure before a Playtest-to-Prism execution request is forwarded. The harness blocks external traffic and cannot send a real Slack announcement. See Playtest's `test/e2e/README.md` for commands and teardown rules.

## Defects found by the browser journeys

- Sign-in errors used Next's internal localhost address, producing a redirect loop instead of recovery guidance. Error redirects now use the validated Playtest address.
- Prism saved an announcement approval, but its consent-page browser policy blocked the return to Playtest. That page now permits the registered callback origin.
- Invalid Slack response bodies were reported as denied connections or network failures. Safe guidance now distinguishes malformed responses from denial and transport failure.
- A missing Location passed readiness and then failed message generation. Session overrides and inherited playtest Location now agree across the editor, readiness, preview, and delivery.
- Sender controls overflowed the announcement drawer. They now wrap within the drawer.
- PostgreSQL could create a grant a few milliseconds ahead of the application clock, causing its first delivery update to violate timestamp ordering. Lifecycle metadata now preserves the database timestamp floor without extending approval, delivery, lease, or proof deadlines. The original disposable-database failure recorded creation at `07:19:05.538875` and an attempted update at `07:19:05.535` UTC.

These defects were reproduced before their fixes; focused regression checks and independent review passed. The final complete browser run supplies the aggregate acceptance evidence.

## Retained browser evidence

Final run directory: `C:\Users\jfenech\AppData\Local\Temp\playtest-prism-e2e-KMDjQn`.

- `login-recovery-guidance.png`: visible recovery guidance after Slack denial.
- `workspace-selection.png`: permitted workspace and channel selection.
- `sender-bot-after-reload.png`: bot sender retained after approval and reload; controls fit the drawer.
- `source-snapshot.json`: SHA-256 evidence for 242 Playtest and 363 Prism source/configuration/package files. Generated `next-env.d.ts` is excluded; the pre-existing Prism declaration change was preserved.
- `process.log` and the synthetic Slack journal: local application and delivery evidence. The earlier timing failure is retained separately in `playtest-prism-e2e-jC16ME`.

The clock-skew journey moves only a test grant's lifecycle metadata 20 seconds ahead of the app clock. It asserts the approved delivery and expiry values remain unchanged, one message is delivered, and repeating the worker does not send it again.

Teardown verification found no remaining labeled E2E Docker containers or test Node processes. Optional removal of nine older temporary copies was rejected by automatic approval review with the reason `blocked by policy`; those copies were retained. The final successful run and timing-failure evidence remain available deliberately.

## Deployment and enterprise acceptance

Deploy Prism and migration `0029_delegated_announcement_sender.sql` before Playtest. Preserve both databases and existing secrets. Existing grants retain their user sender. Bot and scheduled delivery require the existing announcement approval connection to be enabled and registered in both applications.

The final enterprise check remains a fresh sign-in by an allowed non-collaborator, visibility of the intended workspace/channel, and one explicitly authorized test announcement with the chosen sender. That person needs the appropriate Playtest Manager or Admin role. Synthetic Slack tests cannot prove enterprise administrator settings.
