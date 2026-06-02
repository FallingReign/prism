# Prism

Prism is an internal Slack-compatible bridge for developer-owned **Local tools**. The **Prism hosted service** owns Slack credential custody, Token profile policy, Slack-compatible endpoint forwarding, rate limits, and Metadata-only audit. Local tools receive only opaque **Prism developer tokens**, never **Slack credentials**.

## Local development

```bash
npm install
cp .env.example .env.local
npm run db:up
npm run db:migrate
npm run dev
curl -i http://localhost:3732/v1/prism/health
```

## Docker Compose startup (automatic migrations)

```bash
cp .env.example .env.local
# Fill .env.local with local values (do not commit it).
docker compose up --build
```

Compose startup now waits for Postgres, runs `npm run db:migrate` automatically, and then starts the Next.js server on port `3732`.
If `.env.local` is missing required values or still contains `replace-with-*` placeholders for required Prism server secrets, startup fails fast with a clear error.

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

For local mock QA without contacting Slack, set `PRISM_SLACK_OAUTH_MOCK=1` in ignored `.env.local`, request the start
route to create the one-time state cookie, then request the callback with a synthetic `code` and the returned `state`.

## Reference MCP adapter

A Prism-only Local tool example lives in [`examples/prism-mcp-adapter`](examples/prism-mcp-adapter/). It runs as an MCP stdio server configured with `PRISM_BASE_URL` and `PRISM_DEVELOPER_TOKEN`, validates Prism status/capabilities, and maps representative MCP tools to Prism Slack-compatible endpoints without handling Slack credentials.
