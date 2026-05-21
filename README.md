# Prism

Prism is a Next.js Prism hosted service with a Prism website and server-side `/v1/*` API routes for local tools.

## Local development

```bash
npm install
cp .env.example .env.local
npm run db:up
npm run dev
curl -i http://localhost:3000/v1/prism/health
```

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

