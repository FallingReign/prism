# Prism setup guide

This guide is for a **Local tool** author using Prism v1. A Local tool calls the **Prism hosted service** with a **Prism developer token**. It must not receive or use **Slack credentials** such as Slack app credentials, bot tokens, user tokens, refresh tokens, or app-level tokens.

## Configure the Prism base URL

For the fastest Windows-first agent setup, open the Prism website and use
**Install Prism skill**. The website copies a prompt containing its current
browser origin:

```text
Go to <prism-origin>/skills/install.md and follow the setup instructions.
```

The hosted instructions download the public, SHA-256-verified skill bundle,
ask whether the install is project-local or global, and then hand off to the
normal Prism onboarding flow. They are the canonical distribution path;
contributors can inspect the source skill at
[`../.agents/skills/prism-slack/SKILL.md`](../.agents/skills/prism-slack/SKILL.md).

Use `PRISM_BASE_URL` for the hosted Prism origin, for example:

```bash
export PRISM_BASE_URL=http://localhost:3732
```

Local development uses port `3732`. For a hosted or pilot environment, use the approved Prism origin from the deployment owner.

## Configure Slack through Prism

Slack app credentials and requested scopes are managed through Prism's guided
configuration screen for normal installs. They do not need to be copied into a
collection of local environment variables.

1. Run the database migrations and keep the deployment-owned database, public
   URL, and root credential-encryption key configured.
2. Run `npm run setup:bootstrap` on the Prism host. The one-time setup code is
   printed only to that terminal and expires after 15 minutes.
3. Open `/setup`, enter the code, and follow the structured form. Add the exact
   redirect URL displayed there to the existing Slack app.
4. Enter the Slack Client ID and Client Secret, review the explicit bot and
   user scope checklists, then choose **Verify and connect Slack**.

The Client Secret is encrypted before database storage and is never returned
to the browser. A saved configuration remains pending until Slack OAuth
succeeds. That callback activates the immutable configuration and makes the
signed-in Slack user the initial Prism configuration administrator.

Slack has no all-scopes wildcard. When no scope selection is supplied, Prism
defaults to every scope in its reviewed, typed catalogue and passes those
scope IDs explicitly. The setup page exposes the same checklist and warns that
selecting scopes in Prism does not configure or approve them in Slack. The
existing Slack app must already have the requested permissions.

A complete real `SLACK_CLIENT_ID` plus `SLACK_CLIENT_SECRET` environment bundle
remains supported for secret-manager deployments and takes precedence over the
database configuration. Prism shows that source as **Environment locked** and
does not let the browser replace it. Do not split one credential into the
environment and the other into Prism.

Mock OAuth is development-only. Prefer its Slack client, secret, and
`PRISM_SLACK_OAUTH_MOCK=1` overrides in ignored `.env.development.local`.
If `npm start` also loads the complete reserved development-mock bundle from a
shared `.env.local`, Prism treats that bundle as absent: it cannot be sent to
Slack, cannot lock `/setup`, and cannot override a verified database
configuration. A mock flag paired with a non-reserved real client, and every
partial real credential pair, still fails closed. Use
`npm run setup:bootstrap -- --recover` only as an explicit host-level
break-glass recovery after initial
setup.

Setup-code exchanges always use a Postgres-backed 1,000-attempt-per-minute
global circuit breaker. Prism ignores `X-Forwarded-For` and `X-Real-IP` by
default and does not apply the lower per-source bucket to unattributed traffic,
so a direct attacker cannot exhaust a shared 20-attempt source allowance. Set
`PRISM_SETUP_TRUST_PROXY_HEADERS=1` only when a trusted ingress overwrites those
headers and direct origin access is blocked. Trusted mode requires exactly one
valid, consistent address and applies a 20-attempt-per-minute source bucket;
Prism persists only a root-key-derived HMAC of that address, never the raw IP.

## Configure the Playtest OIDC provider

Prism exposes a single public client for Playtest at the issuer-relative
discovery and JWKS endpoints. Set `PRISM_OIDC_PLAYTEST_CLIENT_ID` and the exact
`PRISM_OIDC_PLAYTEST_REDIRECT_URI`; do not use wildcard or alternate callback
URLs. Production `PRISM_PUBLIC_BASE_URL` and the callback must use HTTPS. Local
or isolated-VPN HTTP requires the single explicit
`PRISM_OIDC_ALLOW_INSECURE_HTTP=1` opt-in and is accepted only for `localhost`,
loopback, or RFC1918/private IPv4 hosts (for example `10.62.240.10`).

Next's development request logger excludes `/oauth/authorize`,
`/v1/slack/oauth/start`, and `/v1/slack/oauth/callback` because their query
strings contain short-lived transaction material. Configure any reverse proxy
or hosting access logger to omit query strings for the same routes.

Generate a local RSA (2048-bit minimum) PKCS#8 signing-key env file with:

```bash
npm run oidc:keygen
```

The command writes `.env.oidc.local` without printing key material. Keep the
private-key value server-side and set it as
`PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64` with the stable
`PRISM_OIDC_SIGNING_KEY_ID` in the hosted environment.

Authorization persistence is protected by Postgres-backed fixed-window limits
and outstanding-request caps shared by all Prism processes. Defaults are 30
new authorizations per attributed source and 300 per client per 60 seconds,
with at most 10 outstanding pending requests per attributed source and 500 per
client. Each accepted authorization also deletes at most 100 expired rows from
each OIDC/Slack-state table. Override these with
`PRISM_OIDC_AUTHORIZE_RATE_WINDOW_SECONDS`,
`PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_SOURCE`,
`PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_CLIENT`,
`PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_SOURCE`,
`PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_CLIENT`, and
`PRISM_OIDC_CLEANUP_BATCH_SIZE` only after measuring real traffic.

Prism ignores `X-Forwarded-For` and `X-Real-IP` by default. In that mode the
per-client rate and outstanding cap remain the non-bypassable backstop, while
the per-source cap is not applied to unattributed traffic (so a small number of
direct requests cannot exhaust a service-wide ten-request source bucket). Set
`PRISM_OIDC_TRUST_PROXY_HEADERS=1` only when a trusted ingress overwrites those
headers and direct access to the Prism origin is blocked. Otherwise an attacker
could rotate a spoofed header to evade a source bucket.

## Configure Playtest delegated Slack delivery

Per-message Playtest delivery is a separate first-party registration, not a
Prism developer Token profile and not the public Playtest OIDC client. It is
disabled unless `PRISM_DELEGATED_SLACK_DELIVERY_ENABLED=1`; when disabled,
Prism does not require or load any delegation registration, JWK, or grant
pepper value.

Before enabling it, configure all of the following:

- `PRISM_PUBLIC_BASE_URL` as the exact Prism issuer origin.
- `PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID=shg-playtest-delegation`. No other
  client id is accepted.
- `PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI` as the one exact Playtest
  callback, without query parameters, fragments, wildcards, or alternate
  origins.
- `PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS` as a JWKS JSON object containing
  one to five public `EC`/`P-256`/`ES256` keys with unique `kid` values. Prism
  rejects private JWK parameters. Keep the corresponding private keys only in
  Playtest deployment secret storage.
- `PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER` and
  `PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID` as a dedicated grant-hash
  secret and stable key id. Neither value may reuse its Prism developer-token
  counterpart.

Production issuer and callback URLs must use HTTPS. For local or isolated VPN
testing only, set
`PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP=1`; Prism accepts HTTP only
outside production and only for localhost, loopback, or RFC1918/private IPv4
hosts. This opt-in is intentionally separate from the OIDC HTTP opt-in.

The default contract ceilings are a 10-minute approval, 5-minute code,
30-day scheduling horizon, delivery authority through 30 minutes after the
approved `not_before`, 30-day terminal status retention, and 60-second proof
lifetime/skew bounds. The corresponding `PRISM_DELEGATED_SLACK_DELIVERY_*`
timing variables in `.env.example` may shorten these limits; Prism rejects any
larger value. The code lifetime cannot exceed the approval lifetime, and the
post-`not_before` grant window must remain longer than the approval lifetime so
an immediate approval can still produce a usable grant. The rate,
outstanding-request, and cleanup variables are also
hard-bounded and backed by Postgres so they apply across Prism processes.
The delegated request route ignores forwarding headers by default. In that
mode, Prism omits the per-source bucket and relies on the mandatory client,
expected-user, channel, and outstanding caps rather than letting all direct
traffic share one attacker-exhaustible source bucket. Set
`PRISM_DELEGATED_SLACK_DELIVERY_TRUST_PROXY_HEADERS=1` only when a trusted
ingress overwrites `X-Forwarded-For` and `X-Real-IP` and direct access to the
Prism origin is blocked. Trusted mode requires one valid address (or identical
values in both headers) and rejects missing, multiple, malformed, oversized,
or disagreeing values before reading the request body.

Run `npm run db:migrate` before enabling the flag. Migration `0016` adds the
hash-only code/grant stores, encrypted request custody, DPoP replay protection,
delegated rate buckets, typed Slack OAuth continuations, ownership constraints,
and metadata-only audit lifecycle values. Enabling the Prism flag alone does
not authorize delivery: Playtest must use the matching callback and managed
private key, and the approved Prism Slack user connection must have a healthy
user credential with `chat:write`.

Schedule `npm run delegated-delivery:cleanup` at least every five minutes in
the Prism deployment (for example with the platform scheduler, Kubernetes
CronJob, or Windows Task Scheduler). The non-HTTP command performs one
transactional, bounded batch per lifecycle stage using the same retention and
cleanup limits as issuance. It expires pending/approved requests and active
grants, clears encrypted payload/state custody, removes expired authorization
codes, DPoP replay records, rate buckets, and delegated Slack OAuth continuation
states, then deletes grants and request metadata only after their configured
status-retention window. The command remains safe to run while issuance is
disabled and requires the database environment to be injected by the scheduler;
it never calls Slack. Run it more frequently or temporarily increase the
bounded batch size (within the documented ceiling) when draining a backlog.

Delegated API responses set `X-Prism-Request-ID` to a per-call correlation
UUID. On request-creation success, the JSON `request_id` is instead the stable
semantic `ddr_...` delegation id. On errors, JSON `request_id` is the same
correlation UUID as the header. Neither value is an approval handle, code, or
grant token. A `rate_limited` response may additionally carry integer
`retry_after_seconds` in the inclusive range 1 through 3600.

For the Windows-first agent workflow after installation, see the hosted
`/skills/install.md` instructions or the contributor copy of the [Prism Slack
agent skill](../.agents/skills/prism-slack/SKILL.md).

## Use bearer authentication

Call Local tool endpoints with:

```bash
Authorization: Bearer prism_dev_...
```

`prism_dev_...` is a placeholder. The Prism website shows a Prism developer token only at copy-once creation or rotation time. Store it in the Local tool's secret store and do not paste it into logs, documentation, screenshots, or prompts.

## Health, status, and capabilities

Check service health before debugging token or Slack policy issues:

```bash
curl -i "$PRISM_BASE_URL/v1/prism/health"
```

An available local service returns:

```json
{ "service": "ok", "database": "ok" }
```

Validate a Prism developer token and Slack connection state:

```bash
curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  "$PRISM_BASE_URL/v1/prism/status"
```

Discover the Token profile's **Capability map**, **Execution identity** availability, and **Method registry** projection:

```bash
curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  "$PRISM_BASE_URL/v1/prism/capabilities"
```

Use `/v1/prism/status` and `/v1/prism/capabilities` before exposing or attempting Local tool calls where practical. They distinguish active, invalid, expired, revoked, and **Reauth required** states without returning Slack credentials.

## Slack-compatible endpoint calls

Prism exposes each **Slack-compatible endpoint** under:

```text
/v1/slack/api/{method}
```

Representative calls:

```bash
curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  -H "X-Prism-Surface: public_channel" \
  "$PRISM_BASE_URL/v1/slack/api/conversations.list?limit=10"

curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  -H "X-Prism-Surface: public_channel" \
  "$PRISM_BASE_URL/v1/slack/api/conversations.history?channel=C123&limit=10"

curl -i \
  -H "Authorization: Bearer prism_dev_..." \
  "$PRISM_BASE_URL/v1/slack/api/search.messages?query=example"

curl -i \
  -X POST \
  -H "Authorization: Bearer prism_dev_..." \
  -H "Content-Type: application/json" \
  -H "X-Prism-Surface: public_channel" \
  -d '{"channel":"C123","text":"<message text>"}' \
  "$PRISM_BASE_URL/v1/slack/api/chat.postMessage"
```

Surface-gated methods require `X-Prism-Surface`, such as `public_channel`, `private_channel`, `dm`, or `mpim`. Optional `X-Prism-Workspace-ID` narrows workspace policy checks. Optional `X-Prism-Execution-Mode` may select `user` or `bot` when the Token profile's **Execution identity** is selectable.

Prism strips local `token` payload fields before forwarding. Local tools should still avoid sending Prism developer tokens or Slack credentials in request bodies.

Normal forwarding calls Slack's real Web API with server-held Slack credentials selected from the resolved Execution identity. On Enterprise Grid installs, pass `X-Prism-Workspace-ID` with the target Slack workspace ID; Prism forwards it to Slack as `team_id` when the payload does not already include `team_id`. For local-only mock QA, set `PRISM_SLACK_WEB_API_MOCK=1`; production ignores mock mode.

## Token profile lifecycle

A **Token profile** is the user-owned policy object for one Local tool. It narrows what Slack administration approved at the app level.

From the Prism website, users can:

- create a Token profile and copy its Prism developer token once
- list Token profiles and current token metadata
- rotate a Prism developer token immediately or with a bounded overlap
- revoke the current Prism developer token
- update policy; broadening requires confirmation and replacement token rotation

Use rotation for normal secret hygiene and revocation for suspected token theft. Use policy narrowing when a Local tool no longer needs a capability.

## Common failure states

| State | Meaning | Local tool action |
| --- | --- | --- |
| Invalid Prism developer token | Missing, malformed, or unknown bearer token. | Check configuration and secret storage. |
| Expired Prism developer token | Token or Token profile expiry has passed. | Create or rotate a Token profile token in the Prism website. |
| Revoked Prism developer token | Token or profile has been revoked. | Stop using the token and issue a replacement if appropriate. |
| Reauth required | Slack authorization must be renewed; Token profiles remain present. | Ask the user to relink Slack in the Prism website. |
| Policy denied | The Capability map does not allow the method, surface, workspace, or execution identity. | Check capabilities and adjust the Token profile if justified. |
| Unsupported method | The Method registry excludes or defers the Slack method in v1. | Do not retry as if transient; wait for a future slice. |
| Prism-side rate limit | Prism limited this Token profile and Slack method before upstream. | Back off using `Retry-After`; `X-Prism-Upstream-Called` is `false`. |
| Upstream Slack rate limit | Slack returned its own rate limit after Prism forwarded. | Back off using Slack's `Retry-After`; `X-Prism-Upstream-Called` is `true`. |

All Prism responses include `Cache-Control: no-store` and `X-Prism-Request-ID` where practical. Slack-compatible responses also include Prism diagnostics such as `X-Prism-Upstream-Called`, and may include `X-Prism-Execution-Mode`.

## MCP adapter

The reference MCP adapter lives in [`../examples/prism-mcp-adapter`](../examples/prism-mcp-adapter/). Configure it with `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`. It validates `/v1/prism/status` and `/v1/prism/capabilities`, exposes representative tools, and calls only Prism endpoints.

## Deferred v1 surfaces

Prism v1 does not include inbound events, Socket Mode, slash commands, interactivity, app mentions, file transfer, canvases, lists, payload logging, content moderation, Supabase platform services, or Slack administration. These are explicit deferrals, not hidden features.
