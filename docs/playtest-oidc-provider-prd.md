# PRD: Slack-backed Playtest login through Prism

## Problem

Playtest managers need individual, attributable authentication. The temporary
developer-token bridge proves possession of a Token profile but is not a human
SSO experience and must not become a shared server identity. Prism already
authenticates people through Slack and holds a secure website session, but it
cannot yet issue an identity assertion to Playtest.

## Slice outcome

A Playtest user chooses **Log in with Slack (via Prism)**, authenticates in
Prism only when necessary, and returns automatically to Playtest as their own
stable Prism user. No Slack credential or reusable Prism credential enters
browser JavaScript, a URL, Playtest storage, or logs.

## Users

- Playtest requesters, managers, and administrators.
- Prism users with an existing Slack-backed Prism session.
- First-time/local QA users who must complete Prism's existing Slack OAuth.

## In scope

- One explicitly registered first-party Playtest OIDC client.
- Authorization code flow with mandatory S256 PKCE, state, and nonce.
- OIDC discovery, JWKS, authorization, token, and UserInfo endpoints.
- Reuse of the current Prism website session and stable `prism_users.id`.
- Automatic resume through the existing Slack OAuth flow when no eligible
  Prism session exists.
- RS256 ID tokens with stored display and Slack identity claims.
- Hash-only, expiring, single-use authorization codes and opaque access tokens.
- Security hardening required to trust the existing Slack callback as an OIDC
  authentication source.
- Mocked local end-to-end QA and one final real developer Slack authorization.

## Out of scope

- New Slack app approval or Sign in with Slack scopes.
- Dynamic OIDC client registration or JSON administration UI.
- Implicit/hybrid flow, refresh tokens, social-account linking, or popup login.
- Making OIDC/session credentials valid for Slack forwarding.
- Background Slack delegation or scheduled sender credentials.
- Broad redesign of Prism or Playtest.

## User journey

1. The user selects **Log in with Slack (via Prism)** in Playtest.
2. Playtest creates its state/nonce/PKCE transaction and redirects to Prism.
3. Prism validates the exact registered request.
4. If the Prism website session is eligible, Prism returns immediately.
5. Otherwise Prism runs its existing Slack OAuth, creates/rotates the Prism
   session, and resumes the bound Playtest request automatically.
6. Prism redirects with a one-time code and unchanged state.
7. Playtest exchanges the code server-side and verifies the signed ID token.
8. Playtest creates its own HttpOnly application session and displays the
   authenticated user/sending identity.

## Functional acceptance criteria

- Discovery and JWKS are available at stable issuer-relative endpoints.
- Only the configured Playtest client and exact callback URI are accepted.
- An active Prism session completes without any Slack network request.
- A missing session resumes automatically after Slack OAuth.
- A code can be exchanged exactly once with the correct verifier, client, and
  redirect URI and expires within five minutes.
- Playtest receives stable subject, display name fallback, Slack user ID, Slack
  team ID, and optional enterprise ID. Email is omitted unless Prism truly owns
  a verified value.
- The developer-token login remains an explicitly enabled local fallback only.

## Security acceptance criteria

- No raw Slack credentials, authorization code, verifier, access token, ID
  token, private key, or authorization header is logged or persisted outside
  its designed secret/hash boundary.
- Algorithms are fixed to RS256 for signing and S256 for PKCE.
- Redirects are exact registered values; no wildcard, prefix, alternate port,
  userinfo, fragment, backslash, encoded external target, or duplicate critical
  parameter is accepted.
- Pending requests, Slack state, codes, and access tokens expire and are
  replay-safe under concurrent requests.
- OAuth browser responses are no-store with no-referrer policy.
- A malformed Slack success response cannot create or update an identity.
- OIDC identity does not authorize `/v1/slack/api/*`.

## Verification

- Focused unit/service/route tests for every acceptance criterion.
- Existing production build remains green.
- Pre-existing unrelated test failures are recorded separately and are not
  changed to make this slice appear green.
- Mock end-to-end proof covers both first authentication and existing-session
  fast path with Playtest `/api/auth/me` success.
- One real developer Slack OAuth is completed only after mock/security checks.

## Deferred decisions

- Global Prism logout versus local Playtest logout.
- Consent UI for non-first-party clients.
- Multiple OIDC clients and administrative client registration.
- Delegated Slack sending grants for immediate/background Playtest delivery.
