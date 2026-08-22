# Architecture Integration Brief: Slack OAuth mock client under production startup

## Scope and conclusion

This slice prevents a production `npm start` process from ever turning local Slack OAuth mock configuration into a real redirect to `https://slack.com/oauth/v2/authorize`. Local mock QA under `npm run dev` remains supported. The change belongs in Prism's existing server configuration boundary, with a small website setup-error integration and documentation clarification; it does not require a second OAuth flow, a Slack SDK, schema changes, or changes to credential custody.

The product bug is real and deterministic once production URL validation passes:

- `package.json:14` runs `next start -p 3732`; the installed Next CLI defaults every non-`dev` command to `NODE_ENV=production` when the caller did not set it (`node_modules/next/dist/bin/next:45-67`).
- The installed Next environment loader uses production precedence `.env.production.local`, `.env.local`, `.env.production`, `.env` (`node_modules/@next/env/dist/index.js:1`). Only `.env.local` exists locally from that production list.
- The ignored local file currently classifies `SLACK_CLIENT_ID` as the known reserved mock ID at `.env.local:31`, has a configured secret at line 32, configured user scopes at line 37, and enables `PRISM_SLACK_OAUTH_MOCK` at line 47. No value other than the already reported non-secret mock identifier was printed or copied during inspection.
- `getSlackOAuthConfig` reads and returns the client ID unchanged (`src/server/config.ts:182-210`). It computes `mockOAuth` as `flag === "1" && NODE_ENV !== "production"` (`src/server/config.ts:196`), so production silently changes the requested mock configuration into real mode instead of rejecting it.
- `createSlackOAuthStart` persists one-time OAuth state first and then copies `config.clientId` into the Slack authorize URL (`src/server/slack/oauth-flow.ts:89-110`). The callback similarly selects the real fetch client whenever `mockOAuth` is false (`app/v1/slack/oauth/callback/route.ts:22-35`).
- A redacted, no-network diagnostic using HTTPS `.invalid` URLs reproduced the unsafe combination: configuration was accepted with the known mock ID, the mock flag requested, and `effectiveMockOAuth:false`; URL construction then selected Slack's authorize origin, performed one fake-store persistence write, and did not include the client secret.

There is one runtime evidence limit that implementation and QA should preserve honestly. Port 3732 has no current listener and there is no surviving `npm start` log, so the exact stopped process environment cannot be inspected. The surviving `.artifacts/playtest-qa.out.log` records `next dev` and `.env.local`, not `next start`. Also, the current local public/callback URLs are HTTP, so a fresh current-shell production config evaluation fails earlier with sanitized `setup-required:PRISM_PUBLIC_BASE_URL_HTTPS`. The user-observed Slack URL therefore required either the prior dev listener or a production launch with an HTTPS URL override. That uncertainty does not change the config flaw or the required invariant.

## Existing ownership

- `src/server/config.ts#getSlackOAuthConfig` owns Slack OAuth environment parsing, URL/scopes validation, and the live-versus-mock decision. It is the authoritative extension point.
- `app/v1/slack/oauth/start/route.ts` owns the browser start boundary. It already calls `getSlackOAuthConfig()` before continuation parsing, database-store construction, or `createSlackOAuthStart` (`route.ts:12-30`), and maps setup errors to `/?slack=setup_required` (`route.ts:40-44`, `route.ts:79-83`).
- `src/server/slack/oauth-flow.ts#createSlackOAuthStart` owns state generation/hash persistence and authorize URL construction. It must continue to accept only a validated config; it should not duplicate environment policy.
- `app/v1/slack/oauth/callback/route.ts` owns callback adapter selection. It must continue using the validated `mockOAuth` field rather than re-reading environment flags.
- `app/page.tsx` and `app/slack-status-panel.tsx` own the local website setup-error UX. The status component already models and renders `setup_required` (`slack-status-panel.tsx:5-35`), but the homepage currently accepts no `searchParams` and maps status-read failures to `not_linked` (`page.tsx:25-38`, `page.tsx:138-143`). Consequently, the route's `?slack=setup_required` redirect is not currently surfaced.
- `.env.local` and other `.env.*` files are operator-owned, ignored local configuration (`.gitignore:3-5`). Product code and committed docs must never print or embed their secret values.

## Existing interaction model

- Real flow: a browser requests `/v1/slack/oauth/start`; Prism validates config, stores only a hash of one-time state, sets the secure state cookie, and redirects to Slack. The callback validates/consumes state, selects the real OAuth client, encrypts returned Slack credentials, creates a Prism session, and redirects to the website.
- Mock flow: README currently instructs local QA to set `PRISM_SLACK_OAUTH_MOCK=1`, request the start route to create state/cookie, and directly invoke the callback with synthetic code/state without contacting Slack (`README.md:59-64`). Preserve this non-production test path and its normal persistence/security model.
- Setup failure: start/callback redirect to the local website with `slack=setup_required`, clear or avoid sensitive cookies as appropriate, and apply no-store/no-referrer/frame protections. The UI must show only generic operator guidance; it must not disclose which secret, client ID, URL, or scope failed.

## Do-not-bypass list and invariants

- Do not move live/mock selection into the route, OAuth flow, callback client factory, browser code, or a new environment loader. `getSlackOAuthConfig` remains the single decision point.
- Do not silently coerce a requested production mock into real mode. Production mock configuration is invalid configuration and must throw a sanitized `setup-required:*` error.
- Do not guess a broad Slack client-ID format that Slack's documentation does not normatively guarantee. Retain the existing `replace-with` placeholder rejection and add a narrow reserved/synthetic-ID rejection covering the known Prism mock identifier and explicitly documented mock fixture namespace.
- Do not log or render `SLACK_CLIENT_SECRET`, OAuth code/state, cookies, access/refresh tokens, `.env` values, or full authorize/callback query strings. Tests use canaries and assert absence; runtime diagnostics report only classifications and correlation IDs.
- Do not change OAuth state hashing, one-time consumption, callback CSRF binding, encrypted Slack credential custody, session creation, scopes, delegated/OIDC continuation types, or Slack Web API forwarding mode.
- Do not modify ignored `.env.local` as part of the product patch. Provide operator instructions to move mock-only overrides to `.env.development.local`; real production values come from managed process environment or an ignored `.env.production.local` when locally smoke-testing production.
- Invariant: explicit dev mock remains available under `NODE_ENV=development`.
- Invariant: under `NODE_ENV=production` (including `npm start`), mock flag or reserved mock/placeholder client ID fails before OAuth state persistence and before any Slack `Location` is emitted.
- Invariant: valid production real config still generates the existing Slack authorize URL and callback behavior.

## Integration plan

1. In `src/server/config.ts#getSlackOAuthConfig`, compute whether mock was requested before reading the rest of the Slack OAuth configuration. If `NODE_ENV === "production"` and the flag is `1`, throw a sanitized setup error such as `setup-required:PRISM_SLACK_OAUTH_MOCK` rather than returning `mockOAuth:false`.
2. After `requiredConfiguredValue` reads `SLACK_CLIENT_ID`, reject the reserved `mock-playtest-client` value and a small, documented synthetic fixture namespace in production with `setup-required:SLACK_CLIENT_ID`. Keep the existing `replace-with` placeholder behavior in `configuredValue` (`config.ts:570-580`). Do not echo the rejected value.
3. Keep the returned `SlackOAuthServerConfig` shape and callback selection unchanged. This minimizes risk to OIDC/delegated continuations and preserves the existing dev mock adapter.
4. Keep the start route's ordering: `getSlackOAuthConfig` must finish before `createPostgresOAuthFlowStore`/`createSlackOAuthStart`. Existing setup-error handling should return the local generic setup redirect with no Slack location, state cookie, or database write.
5. Wire the existing homepage setup state to the exact `slack=setup_required` redirect signal, with strict scalar/allowlisted parsing. Prefer a generic setup notice while preserving any durable linked identity display; do not show the internal `setup-required:*` key or accept arbitrary copy from the query string. Keep unknown/repeated query parameters inert.
6. Update README and `.env.example` comments: `PRISM_SLACK_OAUTH_MOCK=1` is development-only; put mock client/secret/flag overrides in ignored `.env.development.local`. Keep common local DB/encryption settings in `.env.local`. For local production smoke tests, use real Slack credentials from the process environment or ignored `.env.production.local`, with the mock flag absent/zero.

Why this insertion point is correct: the start and callback routes already fail closed on `isSetupRequiredError`, and both obtain config before side effects/client selection. Tightening config closes both boundaries without duplicating policy or altering the OAuth protocol.

Alternatives rejected:

- Ignoring the production mock flag, as today: rejected because it silently promotes test credentials into a real Slack request.
- Fixing only the current `.env.local`: rejected because it removes one local trigger but leaves every deployment vulnerable to the same misconfiguration.
- Route-local string checks: rejected because callback selection and any other config consumers could still diverge.
- Enforcing an undocumented numeric/dotted client-ID regex: rejected as unnecessary compatibility risk; use explicit reserved synthetic identifiers plus the production mock-mode guard.
- Removing dev mock support: rejected because mock callback QA is the current safe, no-Slack regression path.

## Regression checklist

- `npm run dev` with explicit mock config still creates one-time state and completes the injected mock callback path without real Slack.
- `npm start`/production with `PRISM_SLACK_OAUTH_MOCK=1` reaches only local setup-required UX; it emits no `slack.com` Location, writes no OAuth state, sets no new OAuth state cookie, and creates no real Slack OAuth client.
- Production with mock flag absent/zero but the reserved mock client ID also fails before persistence/redirect.
- Existing `replace-with-*` placeholder rejection remains sanitized.
- Production with valid real client ID, HTTPS public/callback URLs, approved scopes, and mock disabled retains the current Slack authorize/callback contract.
- Development without mock and without scopes still fails as today; development mock may still omit scopes as today (`src/server/config.test.ts:205-220`).
- OIDC and delegated Slack OAuth continuations retain exact query validation and typed state persistence.
- Setup/error redirects keep `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, CSP frame protection, `X-Frame-Options: DENY`, and `X-Prism-Request-ID` (`app/v1/slack/oauth/start/route.ts:69-76`).
- No response, rendered HTML, captured log, thrown error, snapshot, or committed doc contains any secret canary or `.env` value.

## Test plan

- `src/server/config.test.ts`:
  - production plus mock flag throws exactly the sanitized mock setup error even with otherwise valid HTTPS config;
  - production plus reserved mock ID and flag absent/zero throws sanitized `setup-required:SLACK_CLIENT_ID`;
  - neither thrown error contains client-secret or rejected-value canaries;
  - development plus explicit mock remains `{ mockOAuth:true }` with empty scopes;
  - valid production real fixture remains `{ mockOAuth:false }`.
- `app/v1/slack/oauth/start/route.test.ts`:
  - for both production-invalid cases, assert 302 to the local `/?slack=setup_required`, no Slack origin in `Location`, no OAuth-state `Set-Cookie`, `mockDb.query` not called, and all security/correlation headers retained;
  - retain a valid-production route case proving Slack Location only after config passes;
  - retain OIDC/delegated continuation tests and assert invalid config wins before persistence.
- `app/v1/slack/oauth/callback/route.test.ts`:
  - production mock config follows setup-required redirect, clears the state cookie, and performs no database, mock-adapter, fetch-client, or token-exchange work;
  - explicitly set `NODE_ENV=development` in existing mock callback tests so ambient test mode cannot hide the contract.
- `app/page.test.tsx` and `app/slack-status-panel.test.tsx`:
  - exact setup signal renders escaped generic setup guidance with no reconnect attempt or secret/config-key disclosure;
  - unknown/repeated values cannot inject content; durable linked identity is not erased by a forged query.
- No-secret canary scan across response `Location`, cookies, rendered HTML, captured errors, and test output for client secret, OAuth code/state, `xox*`, refresh/access token, and delegated handles.
- Run focused tests for config, start, callback, page, status panel, and OAuth flow; then the full suite and `npm run build`.

## Live regression proof

1. Without printing values, classify loaded env file names and whether mock/real keys are present.
2. Run a production server with intentionally synthetic config and HTTPS `.invalid`/local test origin as appropriate. Request `/v1/slack/oauth/start` without following redirects; prove the Location is local setup-required, the security headers are present, and there is no new OAuth-state row. Never print a query string or cookie value.
3. Render the resulting local page and verify visible generic setup guidance. Capture no `.env` values or OAuth handles.
4. Run `npm run dev` with mock-only values in `.env.development.local`; complete the documented synthetic callback path and prove the linked mock session still works without contacting Slack.
5. Only with separately supplied real Slack app credentials and approved live-QA authorization, run `npm start` using HTTPS production config and prove the authorize URL uses the configured real client class. Report only host/path and classification, never the identifier, secret, state, code, or full URL.
6. Scan captured logs/artifacts for secret canaries and OAuth query-bearing paths after redaction. A live real Slack authorization remains a distinct external gate, not implied by mock QA.

## Risk assessment

- Risk: a production guard breaks intentional local mock QA. Mitigation: key it specifically to `NODE_ENV=production`, explicitly set development in tests, and document `.env.development.local` precedence.
- Risk: client-ID validation rejects a future legitimate Slack ID. Mitigation: reject only explicit Prism synthetic/reserved identifiers and existing placeholders; do not infer a broad format.
- Risk: the setup redirect looks like a normal unlinked state and users retry indefinitely. Mitigation: connect the already-modeled `setup_required` UI to the route's exact signal with generic, actionable local guidance.
- Risk: configuration diagnostics leak credentials. Mitigation: error keys and tests contain names/classifications only; no values, full URLs, cookies, codes, states, or OAuth response bodies.
- Risk: only start route is fixed while callback still selects real fetch. Mitigation: central config rejection is shared by both routes and callback gets its own no-side-effect regression.
- Risk: current runtime observation is misattributed because the original process is gone. Mitigation: keep the evidence limit explicit and validate both dev and fresh production launches after implementation.

## Decision confidence

- Confidence: high for ownership, cause, and extension point.
- Confidence: medium for attribution of the one historical browser observation because no active process or `npm start` log remains.
- Implementation should proceed through `getSlackOAuthConfig`, the existing setup redirect/UI seam, and docs/tests above. If live evidence shows Next is receiving a different higher-precedence process environment, stop and resolve that operator-owned source rather than adding another code path.
