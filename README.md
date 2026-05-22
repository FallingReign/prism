# Prism

Prism is a Next.js Prism hosted service with a Prism website and server-side `/v1/*` API routes for local tools.

## Local development

```bash
npm install
cp .env.example .env.local
npm run db:up
npm run db:migrate
npm run dev
curl -i http://localhost:3732/v1/prism/health
```

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

## Slack app setup

Slack app manifest and admin scope review artefacts live in [`docs/slack/`](docs/slack/).

The Prism website exposes Slack linking at `GET /v1/slack/oauth/start` and receives Slack OAuth callbacks at
`GET /v1/slack/oauth/callback`. The callback stores Slack access and refresh credentials only as encrypted server-side
envelopes in Postgres; Local tools and browser responses never receive Slack credentials.

For local mock QA without contacting Slack, set `PRISM_SLACK_OAUTH_MOCK=1` in ignored `.env.local`, request the start
route to create the one-time state cookie, then request the callback with a synthetic `code` and the returned `state`.
