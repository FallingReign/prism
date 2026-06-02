# Architecture Integration Brief: docker-compose-autostart

## Existing ownership

- Package/component/module/library:
  - Docker Compose owns local multi-service orchestration in `docker-compose.yml`; before this slice it owned only the `postgres` service and named volume, and current uncommitted changes add `web` (`docker-compose.yml:1-49`).
  - The Docker image boundary is owned by the new root `Dockerfile` plus `.dockerignore`; current runner uses `node:20-bullseye-slim`, copies build artifacts, and starts `scripts/docker-entrypoint.mjs` (`Dockerfile:1-27`, `.dockerignore:1-10`).
  - Database migration ownership remains the existing npm script `db:migrate`, which runs `scripts/ensure-local-encryption-key.mjs` then `scripts/run-migrations.mjs` (`package.json:16`, `scripts/run-migrations.mjs:1-71`).
  - Runtime DB configuration is owned by `src/server/config.ts`/`src/server/db.ts`, which derive `DATABASE_URL` from `DATABASE_URL` or canonical `POSTGRES_*` variables and create a `pg` pool (`src/server/config.ts:31-49`, `src/server/db.ts:19-28`).
  - Health/readiness is owned by `GET /v1/prism/health` and `src/server/health.ts`, returning only sanitized service/database status (`app/v1/prism/health/route.ts:1-13`, `src/server/health.ts:1-24`).
- Current owner rationale:
  - ADR 0001 establishes Next.js App Router plus plain Postgres in Docker as the local substrate, not Supabase/Auth/PostgREST/ORM (`docs/adr/0001-nextjs-postgres-substrate.md:1-3`).
  - README currently documents manual local startup (`npm run db:up`, `npm run db:migrate`, `npm run dev`) and health verification on port `3732` (`README.md:5-14`); this slice should make Compose own the equivalent end-to-end startup while preserving those scripts.
  - Security docs state migrations are part of operational controls and secrets must not be printed, pasted, or logged (`docs/security.md:9-11`, `docs/security.md:53-58`).
- Source evidence:
  - `package.json:10-17`, `docker-compose.yml:1-49`, `Dockerfile:1-27`, `scripts/docker-entrypoint.mjs:1-78`, `scripts/run-migrations.mjs:1-71`, `.env.example:1-43`, `.env.local:1-22` (contains real local secrets; do not echo values), `src/server/config.ts:31-138`, `src/server/db.ts:19-61`, `README.md:5-30`, `docs/security.md:5-11`.
  - Runtime evidence: `npm run build` passed; `npm test -- --reporter=dot` passed with 80 files / 260 tests; `docker compose build web` currently fails because `/app/public` does not exist; default Compose also warns required variables are unset when not using `.env.local`.

## Existing interaction model

- User/system behaviors that already exist:
  - Manual development flow is `npm install`, `cp .env.example .env.local`, `npm run db:up`, `npm run db:migrate`, `npm run dev`, then `curl -i http://localhost:3732/v1/prism/health` (`README.md:5-14`).
  - Postgres runs as a local Docker Compose service with a persistent `prism-postgres-data` volume (`docker-compose.yml:1-16`, `docker-compose.yml:48-49`).
  - Migrations are idempotent: `scripts/run-migrations.mjs` creates `schema_migrations`, applies sorted `db/migrations/*.sql`, and records versions in one transaction (`scripts/run-migrations.mjs:30-47`).
  - The new entrypoint waits for the database using `pg`, retries migrations, then starts `npm start` (`scripts/docker-entrypoint.mjs:20-75`). This is the right interaction shape, but the container build and env path currently prevent reliable Compose startup.
  - Health returns HTTP 200 with `{ service: "ok", database: "ok" }` or HTTP 503 with `{ service: "ok", database: "unavailable" }`, with tests asserting no secret leakage (`README.md:18-29`, `app/v1/prism/health/route.test.ts:17-40`).
- Behaviors that must remain unchanged:
  - Local tools must receive only Prism developer tokens, never Slack credentials (`CONTEXT.md:123-135`, `docs/setup.md:1-4`).
  - Slack credentials, encryption keys, peppers, DB passwords, connection strings, and authorization headers must not be committed, printed, exposed in health responses, or leaked in Docker logs (`docs/security.md:5-11`).
  - `npm run db:migrate` must remain the migration owner; Compose startup should invoke it rather than introduce a second migration mechanism.
  - Existing manual scripts (`npm run db:up`, `npm run db:down`, `npm run db:migrate`, `npm run dev`) should keep working for developer workflows and tests.
  - Mock Slack flags remain non-production only: config ignores `PRISM_SLACK_OAUTH_MOCK` and `PRISM_SLACK_WEB_API_MOCK` in production (`src/server/config.ts:94-101`).
- Runtime or UX evidence:
  - `docker compose build web` failed at `Dockerfile:22` (`COPY --from=builder /app/public ./public`) because `public/**` has no matches in the repo.
  - Default `docker compose build web` emitted warnings for unset `DATABASE_URL`, `PRISM_PUBLIC_BASE_URL`, `PRISM_CREDENTIAL_ENCRYPTION_KEY`, `PRISM_CREDENTIAL_ENCRYPTION_KEY_ID`, `PRISM_DEVELOPER_TOKEN_PEPPER`, and `PRISM_DEVELOPER_TOKEN_PEPPER_ID`; Compose automatically reads `.env`, not `.env.local`, for interpolation.
  - `node:20-bullseye-slim` has Node/npm but no `curl`/`wget` in a clean image, so the current web healthcheck command (`curl -f ...`) will fail even after the image builds.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use Docker Compose service wiring, `depends_on` health conditions where useful, named volumes, and `env_file` for ignored local runtime env. Avoid relying on manual `docker compose --env-file .env.local` because the goal is plain `docker compose up --build`.
  - Use the existing `scripts/docker-entrypoint.mjs` as the startup extension point: it already uses `pg` to wait for DB readiness, runs the canonical `npm run db:migrate`, and delegates serving to `npm start`.
  - Use existing config derivation from canonical `POSTGRES_*` variables (`src/server/config.ts:37-49`) and migration derivation in `scripts/run-migrations.mjs:57-71`; in the web container, override only container-specific values such as `POSTGRES_HOST=postgres`.
  - Use `GET /v1/prism/health` as the Compose health proof; implement the healthcheck with tools available in the runner image (for example Node's built-in `fetch`/HTTP) or explicitly install a healthcheck tool in the Dockerfile.
  - Use Next.js production server through the existing `npm start` script (`package.json:12`) unless a separate decision moves to `output: "standalone"`.
- Relevant docs or library capabilities:
  - Docker Compose substitutes `${VAR}` from the shell or project `.env`, not from service `env_file`; variables listed under `environment` override `env_file`, including with blank interpolated values. This is the current env-handling hazard.
  - Compose `env_file` can inject `.env.local` into containers at runtime, which fits the repo's ignored local-secret model.
  - Compose `depends_on` without `condition: service_healthy` only orders service creation; it does not guarantee Postgres is queryable. The entrypoint's DB wait loop remains necessary.
  - Next.js `next start -p 3732` serves the production build created by `next build`; current root `npm run build` succeeds with this app.
- Existing examples in this codebase:
  - `package.json:14-16` already wraps Compose for Postgres-only local development with `--env-file .env.local` and canonical migration script.
  - `README.md:5-14` provides the current startup/health verification sequence to preserve as a fallback or update with Compose-first instructions.
  - `app/v1/prism/health/route.test.ts:17-40` and `src/server/health.test.ts:5-23` show the required sanitized health contract.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add a second migration runner, ORM, Supabase stack, shell SQL bootstrap, or container-only schema path; invoke `npm run db:migrate` and `scripts/run-migrations.mjs`.
  - Do not bypass `src/server/config.ts`/`src/server/db.ts` with container-only connection logic in application routes.
  - Do not replace Next.js App Router route handlers with a custom Express/Fastify server or separate health endpoint.
  - Do not bake `.env.local`, Slack credentials, Prism developer tokens, peppers, encryption keys, or DB passwords into the Docker image; `.dockerignore` must continue excluding `.env.local` and `.env`.
- Shortcuts or parallel paths to avoid:
  - Avoid requiring users to `docker exec` into containers or manually rerun migrations after `docker compose up --build`.
  - Avoid documenting only `docker compose --env-file .env.local up --build` if the acceptance target is exactly `docker compose up --build`.
  - Avoid Compose `environment` entries like `SECRET: ${SECRET}` when unset values override `env_file` and produce blank required secrets.
  - Avoid fixing the missing `public` directory by adding an empty product asset directory unless the app actually needs it; prefer Dockerfile behavior that tolerates absent optional Next.js directories.
  - Avoid logging raw DB connection config or secret env values from the entrypoint, migration script, healthcheck, or Compose commands.
- Invariants:
  - `docker compose up --build` should build the image, start Postgres, wait for database readiness, apply idempotent migrations, start Next.js on port `3732`, and make `/v1/prism/health` return database `ok`.
  - Local `.env.local` remains ignored and host-owned; the image must not contain it.
  - Inside Compose, the app must connect to host `postgres`, not `localhost`, while same-machine manual development may keep `POSTGRES_HOST=localhost`.
  - Health and setup-required failures must remain sanitized and must not expose secrets or connection strings.
  - No Slack API/OAuth behavior should change as part of this startup slice.

## Integration plan

- Insert the change at:
  - `Dockerfile`: make optional artifact copies safe. Remove or conditionalize the `public` copy because the repo currently has no `public/`; ensure runtime includes files required by `npm start`, `scripts/docker-entrypoint.mjs`, `scripts/run-migrations.mjs`, `scripts/ensure-local-encryption-key.mjs`, `db/migrations`, `package.json`, `node_modules`, and `.next`. If using healthcheck tools from shell, install them here; otherwise keep the image lean and use Node for healthchecks.
  - `docker-compose.yml`: make Compose-first startup own both services. Add runtime env loading from `.env.local` for `web` and likely `postgres`, but avoid overriding env-file values with blank `${VAR}` entries. Explicitly set container-specific `POSTGRES_HOST=postgres` for `web`, `NODE_ENV=production`, and non-secret defaults as needed. Consider `depends_on: postgres: { condition: service_healthy }` while preserving entrypoint DB wait as defense in depth.
  - `docker-compose.yml` healthcheck: replace `curl -f` with a command available in `node:20-bullseye-slim` (for example `node -e "fetch(...).then(...)"`) or install `curl` in the runner image. Prefer Node healthcheck to avoid extra OS packages.
  - `scripts/docker-entrypoint.mjs`: keep as the single Compose startup hook. Tighten only if implementation finds signal handling, retries, or env treatment issues; do not move migrations into Compose YAML commands if the script can own sequencing.
  - `.env.example`/docs: align Compose instructions with the actual env model. If `.env.local` is required for real secrets, say so; if `docker compose up --build` should work after `cp .env.example .env.local`, document exactly that. Do not include real secret values.
- Why this is the correct integration point:
  - It keeps orchestration concerns in Docker/Compose, startup sequencing in one entrypoint, migrations in the existing migration script, and runtime DB access in the existing server config modules.
  - It resolves the observed failure causes without touching application domain behavior, Slack custody, token profile policy, audit, or route semantics.
  - It preserves security boundaries by using ignored runtime env files and avoiding image-baked secrets.
- Alternatives considered and rejected:
  - Running migrations manually after Compose startup: rejected because it violates the requested automatic startup and creates a human-dependent parallel path.
  - Adding database schema initialization SQL under Postgres `docker-entrypoint-initdb.d`: rejected because it bypasses `schema_migrations` and only runs on fresh volumes.
  - Baking `.env.local` into the image or changing `.dockerignore` to include it: rejected as a secret leak and contrary to repo security docs.
  - Requiring a checked-in `.env` with secrets for Compose interpolation: rejected because it encourages committing secret material.
  - Switching to Next.js standalone output now: possible later for smaller images, but unnecessary for this slice and would expand build/runtime assumptions beyond the current `next start` path.
  - Creating a `public/` directory solely to satisfy Docker COPY: rejected as a workaround for Dockerfile assumptions rather than a real product asset.

## Regression checklist

- Behavior: `docker compose up --build` from the repo root builds `web` without missing optional directory errors.
- Behavior: `docker compose up --build` does not require entering containers or manually running `npm run db:migrate`; logs show DB wait, migrations, and server start in order.
- Behavior: `curl -i http://localhost:3732/v1/prism/health` returns HTTP 200 and `{ "service": "ok", "database": "ok" }` after Compose startup.
- Behavior: Existing manual local flow (`npm run db:up`, `npm run db:migrate`, `npm run dev`) remains valid or docs clearly describe any intentional Compose-first replacement.
- Behavior: Migrations remain idempotent on repeated `docker compose up --build` with an existing `prism-postgres-data` volume.
- Behavior: `.env.local` and `.env` remain excluded from the Docker build context and from git; no real secrets appear in Dockerfile, Compose, docs, or logs.
- Behavior: Web container connects to Compose Postgres via `POSTGRES_HOST=postgres`; host development can still use `POSTGRES_HOST=localhost`.
- Behavior: Web healthcheck reaches healthy using tools present in the final image.
- Behavior: Existing tests for sanitized health/config, dependency guard, Slack OAuth custody, token profiles, forwarding, audit, and admin routes remain green.

## Test plan

- Existing tests to keep green:
  - `npm test -- --reporter=dot` (observed passing: 80 test files, 260 tests).
  - `npm run build` (observed passing with Next.js 16.2.6/Turbopack).
  - Pay special attention to `src/server/config.test.ts`, `src/server/health.test.ts`, `app/v1/prism/health/route.test.ts`, `src/server/dependency-guard.test.ts`, and route tests that assert secret redaction.
- New tests to add before/with implementation:
  - A lightweight test for `scripts/docker-entrypoint.mjs` would be valuable but may be hard because it currently executes on import. If refactoring is acceptable, extract pure helpers for DB config derivation/retry decisions and test that `DATABASE_URL` or `POSTGRES_*` env produce the expected `pg` config without logging values.
  - Add a config/guard test or script assertion that `docker-compose.yml` does not contain blank secret interpolation patterns for required runtime secrets (for example `PRISM_CREDENTIAL_ENCRYPTION_KEY: ${PRISM_CREDENTIAL_ENCRYPTION_KEY}`) and does not reference `.env.local` in the Docker build context.
  - Add/extend docs guard coverage if startup instructions change, ensuring README mentions Compose-first startup and does not include real-looking Slack/Prism tokens.
  - If no unit test is added for Compose YAML, live Compose verification is mandatory and should be treated as the primary regression proof.
- Live proof required:
  - From repo root, with `.env.local` present and secrets not printed: `docker compose up --build`.
  - Verify logs include database readiness, `Running migrations`, `Migrations applied.`, `Migrations completed successfully.`, and `Starting server...` without secret values.
  - In another shell: `curl -i http://localhost:3732/v1/prism/health` returns HTTP 200 with sanitized JSON.
  - Verify container health: `docker compose ps` shows `postgres` healthy and `web` healthy/running.
  - Re-run `docker compose up --build` against the same volume and confirm migrations are skipped/applied idempotently and the service still becomes healthy.
  - Negative proof if practical: stop Postgres or point a disposable run at an invalid DB and confirm `/v1/prism/health` returns sanitized unavailable state, not secrets.

## Risk assessment

- Risk: Compose env handling can silently split Postgres and web credentials. If `postgres` uses fallback defaults while `web` reads `.env.local`, the app will wait forever or migrations will fail. Mitigation: make one env source authoritative for both services and override only `POSTGRES_HOST=postgres` for web.
- Risk: Required app secrets may be blank under plain `docker compose up --build` because Compose does not read `.env.local` for interpolation. Mitigation: use `env_file` correctly and avoid blank `environment` overrides; document the prerequisite `cp .env.example .env.local` if needed.
- Risk: `.env.local` currently contains real Slack app credentials and local secret material. Mitigation: do not display values; keep `.dockerignore` exclusions; user should rotate tokens as planned.
- Risk: Current `ensure-local-encryption-key.mjs` writes `.env.local` only if the file exists inside the running filesystem; `.dockerignore` prevents that in containers. Mitigation: do not rely on this helper to create container secrets; use host `.env.local`/managed env for Compose runtime.
- Risk: Healthcheck command currently depends on `curl`, absent from `node:20-bullseye-slim`. Mitigation: use Node-based healthcheck or install curl intentionally.
- Risk: Docker build may mutate `next-env.d.ts` through `npm run build` if `scripts/restore-next-env-dev.mjs` behavior changes. Mitigation: keep `npm run build` validation and inspect git status after builds.
- Risk: `restart: unless-stopped` can hide repeated migration/startup failures by looping. Mitigation: during QA use `docker compose logs web` and health status; consider bounded restart only if needed for local clarity.
- Risk: Parallel path drift between manual npm flow and Compose flow. Mitigation: Compose should reuse `npm run db:migrate`; README should present Compose as the default while retaining scripts as lower-level tools.
- Risk: Docs vs code conflict exists now: README documents manual startup only, while code has attempted Compose `web` and entrypoint support; code/runtime currently fail before matching either desired Compose behavior or docs. Mitigation: update docs after implementation to match verified runtime.

## Decision confidence

- Confidence: high
- Reasons:
  - The failure modes are concrete and reproduced: missing `/app/public` copy, unset Compose variables under default invocation, and absent `curl` in the runner image.
  - Existing ownership is clear: Compose/Docker for orchestration, `scripts/docker-entrypoint.mjs` for startup sequencing, `npm run db:migrate` for schema changes, existing server config for DB connections, and `/v1/prism/health` for readiness.
  - The slice can be completed without changing product domain behavior or weakening Slack/token security boundaries.
- Open questions:
  - Should plain `docker compose up --build` be required to work only after `cp .env.example .env.local`, or should it also generate local-only encryption/pepper material automatically when `.env.local` is absent? Current security posture favors requiring an ignored env file rather than generating secrets inside an ephemeral container.
  - Should the final image stay `next start` with copied `node_modules`, or should a later optimization move to Next standalone output? This slice should not require standalone.
  - Should Compose keep `restart: unless-stopped` for local web, or remove it to make failed migrations more obvious during development?
