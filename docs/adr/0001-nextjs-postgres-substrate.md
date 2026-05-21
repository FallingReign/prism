# Use Next.js with plain Postgres for the initial hosted service

Prism will start as a TypeScript full-stack hosted service using Next.js route handlers for the website and `/v1/*` API, backed by plain Postgres in Docker for local development. We considered self-hosted Supabase, but Prism v1 needs custom Slack OAuth, encrypted Slack credential custody, opaque Prism token verification, metadata-only audit, and rate-limit state; Supabase Auth, Realtime, storage, and PostgREST add operational surface without carrying the core v1 requirements. The persistence layer should remain Postgres-oriented and not block a later move to managed or self-hosted Supabase if those platform features become useful.

