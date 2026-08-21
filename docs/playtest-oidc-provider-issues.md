# Issue breakdown: Playtest OIDC provider

## 1. Provider contract, configuration, and signing

- Add strict issuer/client/redirect/signing configuration.
- Add direct JOSE dependency and local key-generation support.
- Add discovery and public-only JWKS routes.
- Tests: production HTTPS rules, malformed config/key, exact metadata, RS256
  key id and public JWK.

## 2. Durable authorization transactions and code exchange

- Add migration for pending requests, authorization codes, opaque access
  tokens, and the Slack-state resume reference.
- Add server-only Postgres store with hash-only persistence and atomic consume.
- Add authorization and token services with exact client/redirect validation,
  mandatory state/nonce/openid/S256, five-minute codes, and replay protection.
- Tests: duplicates, malformed requests, redirect attacks, PKCE mismatch,
  expiry, replay, and concurrent exchange.

## 3. Existing-session and Slack OAuth resume paths

- Resolve OIDC identity from an eligible Prism session.
- Fast path: issue a code without Slack when the session already exists.
- Resume path: bind the pending request to Slack state, complete Slack OAuth,
  rotate the website session, and resume the exact request.
- Harden Slack identity validation, callback cookie cleanup, response caching,
  and post-exchange persistence required for OIDC trust.
- Tests: no-Slack fast path, missing/expired/disconnected session, cancellation,
  malformed Slack identity, request mix-up, and secret-free outputs.

## 4. ID token, access token, and UserInfo

- Sign short-lived RS256 ID tokens with stable Prism subject and nonce.
- Issue short-lived opaque access tokens stored only as hashes.
- Add UserInfo with consistent subject and stored Slack identity claims.
- Tests: issuer/audience/azp/nonce/time claims, signature/kid, wrong key,
  access-token expiry/revocation, and claim consistency.

## 5. Playtest integration and live QA

- Configure Playtest for the local Prism issuer/client.
- Run migrations and an isolated mock Prism/Postgres instance.
- Prove Playtest -> Prism -> mock Slack -> Prism -> Playtest and the existing
  Prism-session fast path.
- Run an independent architecture/security review and all focused regression
  checks.
- With user interaction, complete one real developer Slack authorization and
  verify identity/automatic return without capturing token-bearing payloads.

Implementation order is 1 through 5. The surrounding task already authorizes
this focused end-to-end slice; any evidence that requires a new Slack scope,
changes the identity model, or expands delivery authority is a stop condition.
