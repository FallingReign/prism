# Architecture Integration Brief: Playtest OIDC provider

## Slice and outcome

Prism will act as the identity provider for SHG Playtest without adding a new
Slack app or exposing Slack credentials. Playtest sends the browser to Prism;
Prism reuses an active website session or completes the existing Slack OAuth
flow, then returns a one-time authorization code. Playtest exchanges that code
with S256 PKCE and validates an RS256 ID token through Prism's JWKS endpoint.

This is an authentication slice only. It does not make a Prism website session
or OIDC token valid for Slack forwarding, and it does not solve background
Slack delegation.

## Existing ownership

- `app/v1/slack/oauth/start/route.ts` and
  `app/v1/slack/oauth/callback/route.ts` own the Slack OAuth HTTP boundary.
- `src/server/slack/oauth-flow.ts` owns Slack state, callback persistence, and
  the opaque Prism website session cookie.
- `src/server/slack/postgres-store.ts` and plain SQL migrations own durable
  Slack identity, connection, credential, and session state.
- `src/server/credentials/*` owns encrypted Slack credential custody. OIDC must
  not read, copy, return, or log those credentials.
- `prism_sessions` already stores only a SHA-256 hash of a random browser
  session and resolves to a stable `prism_users.id`.
- `prism_users.id` is the OIDC `sub`. Slack display and workspace identifiers
  are signed identity metadata, not alternate primary keys.
- The new `src/server/oidc/*` boundary will own client validation, pending
  authorization requests, authorization codes, access tokens, ID-token
  signing, discovery metadata, and UserInfo.

## Existing interaction model

1. Prism currently authenticates its website through Slack Web API OAuth.
2. Slack credentials are encrypted server-side; the browser receives only the
   `prism_session` cookie.
3. Website session queries join `prism_sessions`, `prism_users`, and the latest
   `slack_connections` row.
4. Local tools authenticate separately with profile-bound Prism developer
   tokens. That path remains unchanged and is never used as OIDC identity.
5. Playtest already implements an OIDC authorization-code client with state,
   nonce, S256 PKCE, issuer/audience checking, and JWKS verification.

The desired user journey is a same-tab redirect. An existing Prism session
returns immediately to Playtest; a missing session runs Slack OAuth and resumes
the exact validated request automatically. No reusable token appears in browser
JavaScript, HTML, logs, or a URL.

## Extension points

- Add App Router routes:
  - `GET /.well-known/openid-configuration`
  - `GET /.well-known/jwks.json`
  - `GET /oauth/authorize`
  - `POST /oauth/token`
  - `GET /oauth/userinfo`
- Add server-only modules under `src/server/oidc/` for provider behavior,
  Postgres persistence, HTTP response policy, and signing/JWKS.
- Extend `src/server/config.ts` with one explicit first-party Playtest client,
  exact redirect URI, issuer validation, and signing-key configuration.
- Add a direct `jose` dependency for maintained JOSE primitives rather than
  implementing JWT/JWK behavior by hand or relying on a transitive package.
- Extend `slack_oauth_states` with a nullable reference to a validated pending
  OIDC request. Do not accept an arbitrary continuation URL.
- Reuse the existing Slack callback/session service; after Slack succeeds it
  resumes the referenced OIDC request and redirects to Playtest.

## Do-not-bypass systems and invariants

- Do not add Sign in with Slack scopes or request a second Slack app approval.
- Do not mix Slack SIWS scopes into the existing Web API OAuth grant.
- Do not use a Token profile, developer token, Slack access token, display name,
  email address, client input, or cookie claim as the canonical subject.
- Do not accept wildcard, prefix, user-supplied, or alternate-port redirect
  URIs. The Playtest callback is an exact configured value.
- Do not permit `plain` PKCE, implicit flow, hybrid flow, dynamic client
  registration, refresh tokens, or client-selected signing algorithms.
- Do not make `prism_session` or an OIDC access token valid for
  `/v1/slack/api/*`.
- Store only hashes of authorization codes and access tokens. Codes are
  single-use and expire within five minutes.
- Keep authorization, callback, token, JWKS, discovery, and UserInfo responses
  non-cacheable where appropriate and set `Referrer-Policy: no-referrer` on
  browser OAuth responses.
- Do not log query strings, codes, state, nonce, code verifier, authorization
  headers, signed tokens, signing keys, or Slack credentials.
- Production issuer and redirect URLs require HTTPS. Explicit HTTP is allowed
  only in non-production localhost or isolated-VPN development.

## Integration plan

### 1. Focused contract and configuration

Configure one public first-party client:

- `PRISM_OIDC_PLAYTEST_CLIENT_ID=shg-playtest`
- `PRISM_OIDC_PLAYTEST_REDIRECT_URI=http://localhost:3847/api/auth/callback`
- `PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64=<base64 PKCS8 PEM>`
- `PRISM_OIDC_SIGNING_KEY_ID=<stable key id>`

Derive the issuer from a strictly validated `PRISM_PUBLIC_BASE_URL`. Discovery
advertises authorization-code flow, `query` response mode, S256, RS256, and
`none` token-endpoint authentication for this public client.

### 2. Durable OIDC state

Add migration `0014_prism_oidc_provider.sql` with:

- `oidc_authorization_requests`: opaque request id/hash, validated client,
  redirect, state, nonce, scope, S256 challenge, expiry, consumed timestamp.
- `oidc_authorization_codes`: code hash, client, Prism user/Slack connection,
  redirect, nonce, scope, challenge, authentication time, expiry, used time.
- `oidc_access_tokens`: token hash, client, Prism user/connection, scope,
  expiry, revocation timestamp.
- nullable OIDC request reference on `slack_oauth_states`.

All one-time state transitions use a transaction and row lock or a conditional
update so concurrent consumers cannot both succeed.

### 3. Authorization endpoint

Strictly parse one value for each parameter. Require exact registered client
and redirect, `response_type=code`, scope containing `openid`, nonempty state
and nonce, a valid 43-character S256 challenge, and
`code_challenge_method=S256`.

With a current eligible Prism session, issue the code and redirect immediately
with only `code` and the unchanged client state. Without one, persist the
validated request and bind its internal id to the existing Slack OAuth state.

### 4. Slack resume

The Slack callback consumes its existing state, validates nonempty Slack app,
team, and user identifiers, persists user/connection/credentials/session in a
transaction after the external exchange, clears its state cookie on every
terminal path, and resumes only the bound OIDC request. Slack cancellation
returns a generic OIDC `access_denied` response to the already validated client.

### 5. Token, signing, JWKS, and UserInfo

The token endpoint requires form encoding, the exact client and redirect, a
valid 43-128 character verifier, and a live unused code. It compares
`BASE64URL(SHA256(ASCII(verifier)))` in constant time and atomically consumes
the code.

Return a short-lived opaque bearer access token and a short-lived RS256 ID
token containing exact issuer, stable Prism user subject, audience/authorized
party, issue/expiry/authentication times, original nonce, stored display name,
and signed Slack user/team/enterprise claims. Do not invent email.

JWKS exposes only the public RSA key and stable `kid`. UserInfo resolves only a
hashed, unexpired, unrevoked access token and returns the same subject-bound
claims.

### 6. Required prerequisite hardening

Before real Slack QA:

- reject malformed Slack success responses before identity persistence;
- clear Slack correlation cookies on every callback result;
- validate/canonicalize `PRISM_PUBLIC_BASE_URL`;
- make post-exchange callback persistence atomic;
- require an explicit approved Slack scope set for live setup;
- add exact-origin/Fetch-Metadata protection to cookie-authenticated mutation
  routes separately from the OIDC token endpoint;
- add a local Prism session logout/revocation path without automatically
  revoking the global Slack authorization.

## Regression checklist

- Existing Slack OAuth still links Prism and stores only encrypted Slack
  credentials.
- Existing Prism website sessions and admin authorization continue to work.
- Existing developer-token status, capability, forwarding, policy, and audit
  behavior remains unchanged.
- OIDC never grants Slack forwarding authority.
- The homepage, API responses, redirects, logs, database rows, and test output
  contain no credential, code-verifier, signing-key, or token canaries.
- `/v1/prism/health` and port 3732 behavior remain unchanged.
- Existing build remains green. Pre-existing unrelated test failures are
  recorded rather than silently rewritten as part of this slice.

## Test plan

- Configuration: exact issuer/client/redirect validation; HTTPS production
  enforcement; malformed key/config fails closed without exposing values.
- Discovery/JWKS: exact endpoints and issuer, RS256/S256 metadata, public key
  only, stable `kid`.
- Authorization: reject duplicate/unknown/invalid parameters, redirect prefix,
  wildcard, alternate port, credentials, fragments, backslashes, controls,
  missing state/nonce/openid, and plain PKCE.
- Session behavior: existing eligible session skips Slack; missing/expired or
  disconnected session enters Slack OAuth and resumes only its bound request.
- Slack callback: missing/malformed identity, cancellation, replay, expiry,
  cookie clearing, no-store headers, atomic persistence, and no-secret output.
- Code exchange: hash-only storage, five-minute expiry, exact client/redirect,
  S256 verifier, replay rejection, and exactly one winner under concurrent
  exchange.
- ID token: RS256 signature and `kid`, issuer, audience, azp, nonce, subject,
  iat/exp/auth_time, stable Slack claims, key rotation, unknown key failure.
- UserInfo: bearer parsing, token hash/expiry/revocation, subject consistency.
- Cross-origin cookie mutations are rejected; OIDC token requests do not use
  browser session cookies as authority.
- End-to-end mocked flow: Playtest login -> Prism -> mocked Slack -> Prism
  callback -> Playtest callback -> `/api/auth/me`.
- End-to-end existing-session flow proves no Slack request occurs.
- One real developer Slack authorization only after mock and security checks.

## Risks

- **Account/session swapping:** mitigated by Playtest state/nonce, Prism
  one-time request state, exact client/redirect matching, PKCE, and session
  rotation after Slack callback.
- **Replay/races:** mitigated by hashed state/code storage and atomic consume.
- **Key leakage or algorithm confusion:** mitigated by direct JOSE use, RS256
  allowlisting, public-only JWKS, stable key id, and secret-free errors/logs.
- **OAuth becoming Slack delegation:** mitigated by strict separation between
  OIDC identity, Prism website sessions, Token profiles, and Slack forwarding.
- **Stale Slack identity:** OIDC eligibility must explicitly define connection
  status. This slice requires an extant healthy connection; disconnected or
  reauth-required users relink.
- **Baseline drift:** the repository currently has unrelated policy/API
  reference test failures. New focused tests and the production build must be
  green without concealing those failures.

## Decision confidence

Confidence is high. Current code already owns Slack authentication, encrypted
credential custody, stable Prism users, and opaque website sessions in the
correct Next.js/Postgres layers. OIDC is a bounded server-only extension around
those systems. The open operational dependencies are writable workspace access,
a local Postgres runtime, signing/client configuration, and one final real
developer Slack authorization after mock QA.
