# Prism

Prism is an internal Slack-compatible bridge for developer-owned **Local tools**. The **Prism hosted service** owns Slack credential custody, Token profile policy, Slack-compatible endpoint forwarding, rate limits, and Metadata-only audit. Local tools receive only opaque **Prism developer tokens**, never **Slack credentials**.

## Local development

```bash
npm install
npm start
```

`npm start` runs Prism on the host. It starts only Prism's PostgreSQL dependency
with Docker, applies pending migrations, and then starts the hot-reloading web
server on port `3732`. It never starts or manages Playtest.

On first use, `npm start` opens a short terminal setup. The wizard creates the
ignored `.env.local` shared by host and Docker runs, then offers to run Prism on
the host, run the complete stack with Docker in the background, or stop after
configuration. Later `npm start` calls go straight to the host runtime without
asking again.

To reconfigure Prism, run:

```bash
npm run setup
```

Existing generated security keys are preserved by default, as are the
PostgreSQL database and Slack connections. Setup never launches Playtest.

`npm run dev` remains available when PostgreSQL is already running and migrated.

## Docker Compose startup (automatic migrations)

```bash
npm run setup
# Choose "Not now" if this machine will run Compose later.
docker compose --env-file .env.local up -d --build
```

The setup wizard can also choose Docker for you; it runs the same Compose stack
detached and waits for its health checks. Container startup is deliberately
noninteractive. If configuration is incomplete, it exits with a message to run
`npm run setup` on the host. Compose waits for PostgreSQL, runs migrations, and
starts Prism without requiring an attached terminal. The production-mode Docker
server requires an HTTPS public URL; use host `npm start` for localhost HTTP.

The local development server uses port `3732` to avoid common default-port conflicts and binds to `0.0.0.0` so the pilot host VM can receive Slack OAuth redirects.

The health endpoint returns only fixed service/database status values, for example:

```json
{ "service": "ok", "database": "ok" }
```

If Postgres is unavailable, the same path returns HTTP 503 with:

```json
{ "service": "ok", "database": "unavailable" }
```

No Supabase, Auth, PostgREST, ORM, or migration framework is required for this substrate slice.

## Self-serve setup

- Install the Prism agent skill: open the Prism website and copy the prompt from the **Install Prism skill** action, or visit
  `/skills/install.md` on that same Prism origin.
- Local tool and API setup: [`docs/setup.md`](docs/setup.md)
- Website API reference: `/api-reference`
- Security review notes and token-risk guidance: [`docs/security.md`](docs/security.md)
- Slack app review artefacts: [`docs/slack/`](docs/slack/)
- Reference MCP adapter: [`examples/prism-mcp-adapter`](examples/prism-mcp-adapter/)

The repository Markdown remains the setup and security reference. The Prism website is the product surface for Slack linking, Token profile management, Metadata-only audit review, and the in-product API reference.

## Slack app setup

Slack app manifest and admin scope review artefacts live in [`docs/slack/`](docs/slack/).

The Prism website exposes Slack linking at `GET /v1/slack/oauth/start` and receives Slack OAuth callbacks at
`GET /v1/slack/oauth/callback`. The callback stores Slack access and refresh credentials only as encrypted server-side
envelopes in Postgres; Local tools and browser responses never receive Slack credentials.

For local mock QA without contacting Slack, prefer the mock-only Slack client, secret, and
`PRISM_SLACK_OAUTH_MOCK=1` overrides in ignored `.env.development.local`. Request the start route to create the
one-time state cookie, then request the callback with a synthetic `code` and the returned `state`. Keep real Slack
app values through Prism's web setup or the same ignored `.env.local` bootstrap file. If `npm start` loads the
complete reserved development-mock bundle from `.env.local`, Prism treats it as absent so active database configuration
or `/setup` can win; the bundle is never promoted into a real Slack request. A mock flag paired with a non-reserved real
client and partial real credential pairs remain invalid.

## Reference MCP adapter

A Prism-only Local tool example lives in [`examples/prism-mcp-adapter`](examples/prism-mcp-adapter/). It runs as an MCP stdio server configured with `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`, validates Prism status/capabilities, and maps representative MCP tools to Prism Slack-compatible endpoints without handling Slack credentials.
