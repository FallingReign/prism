# Architecture Integration Brief: skill-install-distribution

## Scope and status

- Slice: end-to-end MVP for fluid Prism Agent Skill installation.
  1. Homepage hero gains an always-visible CTA that copies a minimal prompt of the form
     `Go to <current web origin>/skills/install.md and follow the setup instructions.`
  2. Prism hosts canonical, human- and agent-readable install instructions at `/skills/install.md`, which
     direct the receiving agent to `/skills/manifest.json` and `/skills/latest.zip`.
  3. `next build` generates a deterministic ZIP from the canonical source tree
     `.agents/skills/prism-slack/`, with a top-level archive folder `prism-slack/`, an independent
     `VERSION` file inside the skill tree, an external `manifest.json` (bundled skills, version, archive
     URL, archive hash, per-file list), an immutable versioned archive, and a `latest.zip` alias.
  4. The receiving agent installs project-local or global (asking, never guessing), stages atomically,
     fails closed, warns and asks before replacing an existing skill, preserves the skill-local
     `config.json`, then explicitly confirms any origin change.
  5. The existing `prism-slack` skill and its helper are updated in the same slice to use a
     **skill-local** `config.json` (`origin`, `configured`, `verifiedAt`) instead of the current
     user-level `%USERPROFILE%\.copilot\skills\prism-slack\config.json` marker.
  6. Related docs are updated.
- Status: **architecture aligned; implementation in progress**. The user-approved
  decisions are browser-derived prompt origin, route-backed generated artifacts,
  no legacy-marker migration, independent skill version `1.0.0`, and standard-library
  helper tests.
- Non-goals for this slice: skill registries/marketplaces, signing/PKI, multi-skill catalogues,
  non-Windows credential backends, Slack behaviour changes, Token profile behaviour changes,
  auth on the bundle endpoints (the bundle is intentionally public and secret-free).
- Repository state at time of review: working tree has uncommitted modifications to
  `.agents/skills/prism-slack/SKILL.md` and `.agents/skills/prism-slack/scripts/setup_credentials.py`,
  plus an untracked `.agents/skills/prism-slack/scripts/__pycache__/`. Per the source-of-truth order,
  the **working tree** is authoritative for this brief, not `HEAD` (`git status --short`).

---

## Existing ownership

### Web surface (Prism website)

- `app/page.tsx:22-26` — homepage is `export const dynamic = "force-dynamic"` and is an async **server
  component**; `app/page.tsx:28-34` awaits `cookies()` (Next 15/16 async dynamic APIs).
- `app/page.tsx:85-99` — the hero `<section aria-labelledby="prism-title">` owns the "Prism hosted
  service" eyebrow, the `h1`, the descriptive paragraph, and the compact `SlackStatusPanel`. This is
  the correct and only insertion point for the hero CTA.
- `app/ui.tsx:49-66` — `Button` / `LinkButton` shadcn-backed primitives; `app/ui.tsx:68-105` `Panel`;
  `app/ui.tsx:107-124` `StatusBadge` / `Notice`. All new UI must use these.
- `app/client-clipboard.ts:1-16` — the single owner of clipboard writes
  (`copyTextToClipboard`, 1500 ms timeout, `"use client"`).
- `app/token-profiles-panel.tsx:1-2,156-165` and `app/token-profile-detail-panel.tsx:14,181-190` —
  the two existing consumers of `copyTextToClipboard`, and the established copy-failure UX
  ("Could not copy automatically. Select the token and copy it…"). Both are `"use client"` islands
  embedded in server pages.
- `app/design-system.test.ts:7-16` — guards that `page.tsx` and the listed panels contain no inline
  `style={{`; `app/design-system.test.ts:18-33` guards Tailwind + real shadcn substrate.

### HTTP surface conventions

- Every HTTP endpoint in this repo is an App Router **route handler** with a colocated test:
  `app/v1/prism/capabilities/route.ts:10` (`export const dynamic = "force-dynamic"`),
  `app/v1/prism/capabilities/route.ts:32-38` (`noStoreJson` sets explicit `Cache-Control` and
  `X-Prism-Request-ID`), `app/v1/prism/health/route.ts:6-13`.
- There is **no `public/` directory in this repository at all**. Static-asset serving is currently an
  unused capability.
- `app/api-reference/endpoint-catalog.ts:35-84` owns the documented endpoint catalogue rendered by
  `app/api-reference/page.tsx`.

### Configuration and origin

- `src/server/config.ts:50-68` — `getSlackOAuthConfig` is the only consumer of `PRISM_PUBLIC_BASE_URL`;
  it is required (`src/server/config.ts:54`) and is used to derive the Slack OAuth redirect URI.
- `app/v1/slack/oauth/start/route.ts:35-44` and `app/v1/slack/oauth/callback/route.ts:52-54` read
  `process.env.PRISM_PUBLIC_BASE_URL` with a `http://localhost:3732` fallback.
- `scripts/docker-entrypoint.mjs:8-18,33-38` — `PRISM_PUBLIC_BASE_URL` is a hard startup requirement.
- `.env.example:13-17` — the pilot host is documented as `http://10.62.240.10:3732` (**plain HTTP, LAN
  IP**). This is load-bearing for the clipboard risk below.
- **Ownership conclusion:** `PRISM_PUBLIC_BASE_URL` belongs to Slack OAuth redirect correctness. The
  slice explicitly must **not** reuse it for the hero prompt origin.

### Skill and helper

- `.agents/skills/prism-slack/SKILL.md` (231 lines) — canonical skill procedure. Frontmatter
  `name: prism-slack` at lines 1-5; steps at lines 15, 37, 59, 76, 107, 137, 180, 217.
- `.agents/skills/prism-slack/SKILL.md:16-19` and `:43-46` — currently point the agent at
  `%USERPROFILE%\.copilot\skills\prism-slack\config.json` (**user-level**, to be replaced by
  skill-local).
- `.agents/skills/prism-slack/SKILL.md:84`, `:99`, `:118` — hard-code the repo-relative path
  `.agents\skills\prism-slack\scripts\setup_credentials.py`. After hosted install into an arbitrary
  skill folder these paths are wrong and must become skill-root-relative.
- `.agents/skills/prism-slack/scripts/setup_credentials.py` — the credential/custody owner:
  - `:74-111` `normalize_origin` (scheme/port/IDNA normalisation, rejects userinfo/query/fragment/path,
    default port 3732 for http and 443 for https, requires `allow_insecure_http` for bare hosts).
  - `:113-120` `credential_target` → `Prism/<hostname>/developer-token`.
  - `:164-220` Windows Credential Manager backend; `:221-381` ACL-guarded file fallback;
    `:382-396` ephemeral validation backend; `:527-536` `_select_backend` (Windows-only, fallback only
    with explicit opt-in).
  - `:398-403` `_fallback_path` → `%APPDATA%\Prism\credentials.json`.
  - `:405-410` `_user_skill_config_path` → **`%USERPROFILE%\.copilot\skills\prism-slack\config.json`**
    (the exact function this slice must repoint to the skill folder).
  - `:412-433` `_write_configuration_marker` — already writes `{origin, configured, verifiedAt}` and
    already does an atomic temp-file + `os.fsync` + `os.replace`.
  - `:435-458` `record_verified_origin` — live-verifies token/Slack/execution-identity/`chat.postMessage`
    before writing the marker.
  - `:542-605` `request` — allowlisted paths only, in-memory `Authorization` header, never returns a token.
  - `:607-638` `setup_credentials`, `:947-987` `main` / `--host`, `--allow-file-fallback`,
    `--allow-insecure-http`.
- `docs/research/prism-slack-skill-packaging.md` — records the `.agents/skills/<name>/SKILL.md` layout
  decision and the agentskills.io specification reference.
- `docs/setup.md:15-16` links to the skill by repo-relative path.

### Guards and tests

- `src/server/docs-guard.test.ts:5` — `publishedDocs` list; `:9-56` required topic coverage;
  `:58-96` secret-shaped-content rejection over the joined published docs.
- `src/server/dependency-guard.test.ts:5-16` — forbidden dependency patterns and `package.json` check.
- `vitest.config.ts:8-13` — `@` alias to repo root and a `server-only` stub; `test.environment: "node"`.

---

## Existing interaction model

### What already exists

1. A user opens the Prism website, connects Slack, creates a Token profile, and copies a
   **copy-once** developer token via `copyTextToClipboard`.
2. The user hands a host address to a local agent; the agent runs the `prism-slack` skill, which
   normalises the origin, health-checks, and — only if not already configured — launches
   `setup_credentials.py` to capture the token in a masked local window and store it in Windows
   Credential Manager (`SKILL.md:76-105`).
3. The helper live-verifies and then writes the non-secret marker (`record_verified_origin`).
4. All later Slack calls go through the helper's `request` allowlist with confirmation gates
   (`SKILL.md:137-216`).
5. **Today the skill itself is only obtainable by having this repository checked out.** That is the gap
   this slice closes.

### Behaviours that must remain unchanged

- Slack credential custody: Slack app credentials and Slack tokens never leave the server; the local
  agent only ever holds a Prism developer token.
- The Prism developer token stays in Windows Credential Manager. The file fallback stays opt-in and
  ACL-guarded. **No token may ever be written into `config.json`, the ZIP, the manifest, or `install.md`.**
- The token is never printed, returned, echoed to chat, or passed on a command line
  (`setup_credentials.py:542-605`, `:640-676`).
- Masked local prompt; agent launches the helper itself rather than asking the user to run Python
  (`SKILL.md:76-90`).
- Explicit-confirmation gates: bare-host HTTP approval, recipient confirmation before any Slack send,
  file-fallback approval.
- Live status is authoritative over any persisted marker (`SKILL.md:37-58`).
- Homepage server-rendered flow, `force-dynamic`, Slack status panel, Token profile panel, and audit
  panel behaviour.
- `PRISM_PUBLIC_BASE_URL` continues to drive Slack OAuth redirects only.

### Runtime observations

- No Prism server was running during this review (`http://localhost:3732/v1/prism/health` refused).
  Live QA for this slice must start the server explicitly.
- Installed Next version: **16.2.6** (`node_modules/next/package.json`).
- `send` MIME resolution used by Next static serving maps `.md` → `text/markdown` and `.zip` →
  `application/zip` (verified via `next/dist/compiled/send`).
- Next's static/public serving does **not** attach a `Cache-Control` header; only `/_next/static` gets
  `public, max-age=31536000, immutable` (`node_modules/next/dist/server/lib/router-utils/router-server.js:398`).
  Differentiated caching therefore requires either route handlers or `next.config.ts` `headers()`.
- Next metadata-route detection for `manifest.json` is **root-anchored**
  (`node_modules/next/dist/lib/metadata/is-metadata-route.js`: `MANIFEST_JSON_REGEX = /^[\\/]manifest\.json$/`,
  and the compiled `^[\\/]manifest…` regex). A nested `app/skills/manifest.json/route.ts` is therefore
  **not** hijacked by the Next metadata pipeline. Note the sitemap regex is *not* root-anchored — avoid
  ever naming an artifact `sitemap.xml`.

### Conflicts surfaced (do not silently resolve)

- **C1 — Clipboard vs. plain-HTTP pilot.** `navigator.clipboard` is only defined in a secure context
  (HTTPS or `localhost`). The documented pilot origin is `http://10.62.240.10:3732`
  (`.env.example:13-17`). On that host `navigator.clipboard` is `undefined`, so
  `app/client-clipboard.ts:9` throws synchronously and the promise rejects. **The always-visible CTA
  will not silently work on the pilot.** The prompt text must therefore always be rendered visibly and
  manually selectable, with a `document.execCommand("copy")` fallback over a selected node. This is a
  product-visible requirement, not an optional polish item.
- **C2 — `Dockerfile` does not ship any artifact directory.** `Dockerfile:15-24` copies only
  `package.json`, `node_modules`, `.next`, `scripts`, and `db` into the runner. Any on-disk build
  artifact (ZIP/manifest/instructions) will 404 in Docker unless a new `COPY` line is added. This is
  the single highest-probability way for this slice to pass locally and fail in the pilot.
- **C3 — Marker location conflict.** `SKILL.md:16-19,43-46` and `setup_credentials.py:405-410` specify a
  user-level marker; the approved slice requires a skill-local marker. Both must change together in
  this slice. The approved behavior is to ignore the legacy marker and require setup again.
- **C4 — `docs/setup.md:15-16` links to the skill by repo path.** Once the skill is distributed, docs
  must present the hosted `/skills/install.md` route as the primary path and the repo path as the
  contributor path.

---

## Existing extension points

### Web

- **App Router route handlers** (`app/**/route.ts` + colocated `route.test.ts`) — the repo's only HTTP
  convention. Gives exact control of `Content-Type`, `Cache-Control`, and status codes, and is directly
  unit-testable under `vitest` (`environment: "node"`).
- Route segments may contain dots (`app/skills/install.md/route.ts`). Static segments win over dynamic
  siblings, so `install.md`, `manifest.json`, and `latest.zip` can coexist with a dynamic
  `archive/[file]` segment.
- `NextResponse` / `Response` with a `Uint8Array` body for the ZIP (`Buffer` is a `Uint8Array`).
- `next.config.ts` (`next.config.ts:5-10`) currently sets only `devIndicators` and `turbopack.root`; an
  async `headers()` block is available if the static-file variant is chosen.
- `npm` lifecycle: adding a `prebuild` script makes generation automatic for `npm run build` (and thus
  for `Dockerfile:11`). `next dev` does **not** run `prebuild`; a `predev` script is required for parity.

### Origin derivation — the decisive analysis

**Server side (`next/headers`).** In Next 16 a server component can do:

```ts
import { headers } from "next/headers";
const h = await headers();
const host = h.get("x-forwarded-host") ?? h.get("host");
const proto = h.get("x-forwarded-proto") ?? "http";
```

There is **no** canonical request-URL API for server components (`next/headers` exposes only
`cookies`, `headers`, `draftMode`). In a route handler, `NextRequest.url` is itself reconstructed from
the `Host` header. Both `Host` and `X-Forwarded-*` are attacker-controlled unless a reverse proxy
overwrites them. This deployment (`docker-compose.yml`: `ports: "3732:3732"`, no proxy) exposes the
Node server directly, so **nothing rewrites `Host`**. Deriving the copied prompt origin server-side
would therefore let any request forge the origin embedded in a prompt shown to a user.

**Decision (mandatory):**

1. **The hero prompt origin is derived in the browser only**, from `window.location.origin`, inside the
   `"use client"` CTA island. This is by definition the *current browser-facing web origin*, comes from
   the URL bar, and is immune to header spoofing. No `PRISM_PUBLIC_BASE_URL`, no env, no headers.
2. **Hydration safety:** compute the prompt string **at click time**, not at render time, so the SSR and
   client trees are identical. For the always-visible preview text, render a stable server placeholder
   and fill in the real origin after mount (`useState(null)` + `useEffect(() => setOrigin(...), [])`),
   or wrap only the origin span in `suppressHydrationWarning`. Never call `window.location` during the
   first render pass.
3. **Degenerate origins:** `window.location.origin` yields the string `"null"` for opaque origins.
   Fall back to `` `${location.protocol}//${location.host}` `` and, if that is unusable, render the
   manual-entry/instruction fallback rather than emitting a broken prompt.
4. **`install.md` must use root-relative URLs** (`/skills/manifest.json`, `/skills/latest.zip`) and must
   explicitly tell the agent: *"resolve these relative to the origin you fetched this document from."*
   This removes header trust from the server side entirely — the document never has to know its own
   origin, and the agent always has it because it just performed the fetch.
5. **Agent-side origin fallback chain (documented in `install.md` and `SKILL.md`):**
   (a) the origin used to fetch `install.md`; (b) the origin in the user's pasted prompt;
   (c) the `origin` field of an existing skill-local `config.json`; (d) **ask the user** — the rare
   fallback. Never guess, never read `PRISM_PUBLIC_BASE_URL` from the server, never assume localhost.

### Skill / helper

- `normalize_origin` (`setup_credentials.py:74-111`) is already the correct and only origin normaliser —
  reuse it for any origin comparison, never re-implement string comparison.
- `_write_configuration_marker` (`:412-433`) is already atomic and non-secret — repoint its **path**
  only; keep the write mechanics and the `{origin, configured, verifiedAt}` shape.
- `record_verified_origin` (`:435-458`) is already the "verify then persist" gate — keep it as the only
  writer of `configured: true`.
- Skill-root resolution must be derived from the helper's own location:
  `Path(__file__).resolve().parents[1] / "config.json"` — this works identically for
  `.agents/skills/prism-slack/`, `%USERPROFILE%\.copilot\skills\prism-slack\`, and any other install root.

### Packaging capabilities

- Node has **no built-in ZIP writer**. `node:zlib.deflateRawSync` + a CRC-32 table is sufficient for a
  ~150-line dependency-free deterministic writer, and is the recommended route: the repo is
  deliberately dependency-lean and `src/server/dependency-guard.test.ts` polices additions.
- Do **not** use PowerShell `Compress-Archive`: it is Windows-only (Docker builds on
  `node:20-bullseye-slim`, `Dockerfile:1`) and is not byte-deterministic.
- Determinism requirements for a stable archive hash: sorted entry order, fixed DOS timestamp, fixed
  external attributes, UTF-8 name flag (GP bit 11 / `0x800`), forward-slash entry names, no extra fields,
  explicit directory entries for `prism-slack/` and `prism-slack/scripts/`.
- `node:crypto.createHash("sha256")` for the archive hash and per-file hashes.
- Verification tooling already available on the target box: PowerShell `Expand-Archive` and Python
  `zipfile` — use both in live QA.

---

## Do-not-bypass list

1. **Do not use `PRISM_PUBLIC_BASE_URL`, `SLACK_OAUTH_REDIRECT_URI`, or any env var for the hero prompt
   origin.** They belong to Slack OAuth (`src/server/config.ts:50-58`).
2. **Do not trust `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto`** to build the copied prompt or to
   build absolute URLs inside `install.md`. No proxy normalises them in this deployment.
3. **Do not add a second clipboard implementation.** Extend/route through `app/client-clipboard.ts`.
4. **Do not add a second UI primitive set.** Use `app/ui.tsx` (`Button`, `Panel`, `Notice`,
   `StatusBadge`) and `components/ui/*`; no inline `style={{` (`app/design-system.test.ts:7-16`).
5. **Do not bypass the App Router route-handler convention** for new HTTP surfaces without deliberately
   choosing the static alternative below — and never do both for the same path.
6. **Do not touch** Slack OAuth, forwarding, method registry, policy evaluation, Token profile
   lifecycle, developer-token issuance/verification, or audit for this slice.
7. **Do not put any secret in the bundle.** The ZIP must exclude `config.json`, `__pycache__/`, `*.pyc`,
   `credentials.json`, `.env*`, and anything not part of the skill source tree. The manifest's file list
   is the contract — enforce it with an allowlist, not a denylist alone.
8. **Do not move the Prism developer token out of Windows Credential Manager.** `config.json` is
   non-secret metadata only: `origin`, `configured`, `verifiedAt`.
9. **Do not re-implement origin normalisation** in the skill, the install instructions, or the website.
   `normalize_origin` (`setup_credentials.py:74-111`) is the single normaliser on the agent side.
10. **Do not silently no-op or silently overwrite** an existing installed skill. Warn, show the version
    delta, ask, and only then replace.
11. **Do not guess the install location.** Ask project-local vs global; use `.agents/skills/` when the
    receiving agent supports it, otherwise the agent's own documented skill folder; if neither is known,
    ask.
12. **Do not silently change a configured origin.** Compare with `normalize_origin`, show old vs new,
    and require explicit confirmation. Same rule for a differing `PRISM_BASE_URL` in the environment —
    compare and ask; never rewrite the user's environment.
13. **Do not remove the live-verification gate** before writing `configured: true`
    (`setup_credentials.py:435-458`).
14. **Do not extract archives in place.** Stage, validate, then swap.
15. **Do not add a dependency** for zipping without re-checking `src/server/dependency-guard.test.ts`
    and the repo's dependency-lean posture.
16. **Do not name a generated artifact `sitemap.xml`** — Next's metadata regex for sitemap is not
    root-anchored.

---

## Integration plan

### A. Artifact generation (build time)

- Add `scripts/build-skill-bundle.mjs` (+ a small `scripts/lib/zip-writer.mjs` if the writer is
  extracted) that:
  1. Reads `.agents/skills/prism-slack/VERSION` (new file, e.g. `1.0.0`) — independent of
     `package.json` version. Validate strictly (`^\d+\.\d+\.\d+$`); fail the build if missing/invalid.
  2. Walks the canonical source tree with an **allowlist** (`SKILL.md`, `scripts/**/*.py`, `VERSION`,
     plus any `references/**`), rejecting `config.json`, `__pycache__`, `*.pyc`, dotfiles, and symlinks.
  3. Emits `prism-slack-<version>.zip` with all entries under a top-level `prism-slack/` folder,
     deterministically (sorted, fixed timestamps, UTF-8 flag, forward slashes).
  4. Computes `sha256` of the archive and of each file.
  5. Writes `manifest.json`:
     `{ schemaVersion, generatedFor: "prism-slack", bundledSkills: [{ name, version, archivePath }],
     version, archive: { file, path, sizeBytes, sha256 }, latestPath, files: [{ path, sizeBytes, sha256 }] }`
     with **relative** paths only.
  6. Writes `latest.zip` as a **byte copy** of the versioned archive (not a symlink — Windows symlink
     creation requires elevation/developer mode).
  7. Renders `install.md` from a template, using **root-relative** URLs only.
- Output directory: `.artifacts/skills/` (gitignored). Chosen so it can never shadow a route path.
- Wire-up: add `"prebuild": "node scripts/build-skill-bundle.mjs"` and
  `"predev": "node scripts/build-skill-bundle.mjs"` to `package.json`. `npm run build` already runs
  inside `Dockerfile:11`.

### B. HTTP surface — **recommended: route handlers**

| Path | File | Content-Type | Cache-Control |
|---|---|---|---|
| `/skills/install.md` | `app/skills/install.md/route.ts` | `text/plain; charset=utf-8` | `public, max-age=0, must-revalidate` |
| `/skills/manifest.json` | `app/skills/manifest.json/route.ts` | `application/json; charset=utf-8` | `public, max-age=0, must-revalidate` |
| `/skills/latest.zip` | `app/skills/latest.zip/route.ts` | `application/zip` | `public, max-age=0, must-revalidate` |
| `/skills/archive/<file>.zip` | `app/skills/archive/[file]/route.ts` | `application/zip` | `public, max-age=31536000, immutable` |

- All four read from `.artifacts/skills/` via `path.join(process.cwd(), ".artifacts", "skills", …)`.
- All four use `export const dynamic = "force-dynamic"` (repo convention,
  `app/v1/prism/capabilities/route.ts:10`) so nothing is prerendered at build time.
- Set `ETag` (the manifest's `sha256`) on the archive/manifest responses and honour `If-None-Match` to
  make "latest revalidates" cheap.
- `app/skills/archive/[file]/route.ts` must validate `file` against the manifest's known archive name
  (exact match), never against the filesystem — no path traversal, no directory listing.
- Serve `install.md` as `text/plain; charset=utf-8` so browsers render it inline. `text/markdown`
  triggers a download in Chromium, which breaks the "human-readable in a browser" requirement.
- **`Dockerfile` must gain `COPY --from=builder /app/.artifacts ./.artifacts`** (see C2). Verify
  `.dockerignore` does not exclude it (currently it does not).

**Rejected alternative (documented for the implementer):** generate into `public/skills/` and let Next
serve the files statically, with `next.config.ts` `headers()` supplying the cache policy. Rejected
because (i) the repo has no `public/` directory and no static-asset precedent — every HTTP surface is a
route handler with a colocated test; (ii) `.md` would be served as `text/markdown` and download rather
than render; (iii) header policy would live in `next.config.ts`, far from the endpoint; (iv) it still
requires the same `Dockerfile` `COPY`, so it buys nothing operationally. If the implementer chooses it
anyway, pick **one** mechanism — never both for the same path.

### C. Homepage hero CTA

- New client island `app/skill-install-cta.tsx` (`"use client"`), rendered from `app/page.tsx` inside
  the hero at `app/page.tsx:85-99`, **unconditionally** (before Slack is connected, while
  `reauth_required`, and when linked).
- Behaviour:
  - Always-visible `Button` labelled e.g. "Copy agent setup prompt".
  - Always-visible, selectable prompt text (`<code>` / readonly input) so the plain-HTTP pilot still
    works — see C1.
  - On click: build `Go to ${origin}/skills/install.md and follow the setup instructions.` from
    `window.location.origin`, call `copyTextToClipboard`, show a polite `aria-live` confirmation.
  - On failure: reuse the existing copy-failure pattern ("Could not copy automatically. Select the
    prompt and copy it."), then attempt the `execCommand("copy")` selection fallback.
  - Origin is filled post-mount for the preview; the copied string is computed at click time.
- Keep the prompt **exactly minimal** — one sentence, one URL, no token, no host hints, no branding
  noise. It is an instruction to an agent, not marketing copy.

### D. Skill + helper changes (same slice)

- `.agents/skills/prism-slack/VERSION` — new file, single semver line.
- `setup_credentials.py`:
  - Replace `_user_skill_config_path` (`:405-410`) with a skill-local resolver
    (`Path(__file__).resolve().parents[1] / "config.json"`). Keep the atomic write in
    `_write_configuration_marker` (`:412-433`) unchanged.
  - Ignore any legacy user-level marker. If the skill-local config is absent, require the normal
    origin and live onboarding flow again.
  - Add an origin-change gate: if an existing skill-local `config.json` has an `origin` that
    `normalize_origin`-differs from the requested one, refuse to overwrite without an explicit
    `--confirm-origin-change` (or equivalent) flag, and emit a redacted old→new diff.
  - Add a non-mutating `PRISM_BASE_URL` comparison: if `os.environ.get("PRISM_BASE_URL")` normalises to
    something different from the config origin, report the mismatch and ask; never write the env var.
  - Fail with an actionable, redacted error if the skill folder is read-only.
- `SKILL.md`:
  - Update `:16-19` and `:43-46` to the skill-local `config.json`.
  - Replace hard-coded `.agents\skills\prism-slack\...` paths at `:84`, `:99`, `:118` with
    skill-root-relative instructions ("from the folder containing this SKILL.md").
  - Add the origin fallback chain (fetch origin → pasted prompt → `config.json` → ask).
  - Keep line count and token budget within the packaging guidance in
    `docs/research/prism-slack-skill-packaging.md`.
- `.gitignore`: add `.artifacts/`, `.agents/skills/prism-slack/config.json`, and
  `__pycache__/` / `*.pyc`.

### E. `install.md` content contract

Must state, in agent-executable order:

1. Resolve the Prism origin = the origin this document was fetched from.
2. `GET /skills/manifest.json`; read `version`, `archive.sha256`, `files[]`.
3. Ask the user: **project-local** (`<project>/.agents/skills/prism-slack`) or **global** (the agent's
   own documented skill folder, e.g. `%USERPROFILE%\.copilot\skills\prism-slack`). If the agent's skill
   folder convention is unknown, ask. Never guess.
4. `GET /skills/latest.zip` (or the immutable `archive.path`); verify SHA-256 against the manifest;
   abort on mismatch.
5. Extract into a **staging** directory on the same volume as the target. Reject any entry that is
   absolute, contains `..`, contains a drive letter or backslash, is a symlink/hardlink, or is not under
   `prism-slack/`. Verify each extracted file's SHA-256 against `files[]`. Abort and delete staging on
   any failure (fail-closed).
6. If the target exists: report installed vs new version, warn that it will be replaced, and **ask**.
   No silent no-op, no silent overwrite.
7. On approval: preserve the existing `config.json` (copy it into staging), rename the old directory to
   a timestamped backup, move staging into place, verify, then delete the backup. Roll back on failure.
8. Read the preserved `config.json`; if its `origin` differs from the origin this document came from,
   show both and **ask** before changing.
9. Hand off to the skill's normal onboarding (`SKILL.md` step 1 onward). HTTP is acceptable for an
   internally configured pilot with explicit confirmation; HTTPS is recommended for public exposure.
10. State plainly: the bundle is public, contains no secrets, and the Prism developer token is never
    part of it.

### F. Docs

- `README.md` — add a "Install the Prism agent skill" section pointing at `/skills/install.md`.
- `docs/setup.md:15-16` — hosted install first, repo path as the contributor path.
- `docs/security.md` — new subsection: the skill bundle is public and secret-free; `config.json` is
  non-secret metadata; token custody is unchanged; SHA-256 verification is the integrity control and
  signing is an explicit deferral.
- `docs/research/prism-slack-skill-packaging.md` — record the distribution decision and `VERSION` file.
- Consider adding the three `/skills/*` endpoints to `app/api-reference/endpoint-catalog.ts` marked as
  unauthenticated/public.
- **Guard check:** `src/server/docs-guard.test.ts:5` joins the `publishedDocs` list and asserts topic
  coverage plus secret-shape rejection. Adding docs does not break coverage, but any newly listed doc
  must pass `findPublishedDocSafetyViolations`. If `install.md` is added to `publishedDocs`, it must
  contain no `prism_dev_`-shaped or bearer-shaped strings.

---

## Regression checklist

**Website**

- [ ] Homepage renders for not-linked, `reauth_required`, and linked states; the CTA is present in all three.
- [ ] `app/page.test.tsx` API-reference and Admin-console visibility assertions still pass.
- [ ] No hydration warnings in the browser console on first load of `/`.
- [ ] `app/design-system.test.ts` passes — no inline styles introduced in `page.tsx` or new panels.
- [ ] Slack status panel, Token profiles panel, and audit panel are visually and behaviourally unchanged.
- [ ] Copy CTA works on `localhost` (secure context) **and** degrades gracefully with visible,
      selectable text on `http://<lan-ip>:3732`.
- [ ] The copied prompt contains exactly the current browser origin — verified from two different
      hostnames pointing at the same server.
- [ ] Forging `Host: evil.example` on a request to `/` does **not** change the copied prompt.

**Artifacts**

- [ ] `npm run build` regenerates all four artifacts; two consecutive builds produce byte-identical
      ZIPs and identical `sha256`.
- [ ] Archive top-level folder is exactly `prism-slack/`.
- [ ] Archive contains `SKILL.md`, `VERSION`, `scripts/setup_credentials.py`, and nothing else.
- [ ] Archive contains **no** `config.json`, `__pycache__`, `*.pyc`, `.env*`, or credential file.
- [ ] `manifest.json` version matches `VERSION`; archive hash matches the served bytes; every `files[]`
      hash matches an extracted file.
- [ ] `latest.zip` and the versioned archive are byte-identical.
- [ ] `/skills/install.md` renders inline in a browser and is fetchable as plain text by an agent.
- [ ] Versioned archive returns `immutable`; `latest.zip`, `manifest.json`, and `install.md` revalidate.
- [ ] `docker compose up --build` then `curl -I http://localhost:3732/skills/latest.zip` → **200**
      (this is the C2 regression).

**Skill / helper**

- [ ] Fresh install with no prior config: onboarding completes and writes skill-local `config.json`
      with `{origin, configured: true, verifiedAt}`.
- [ ] Re-run with a valid config: skips onboarding (steps 3–5) and proceeds.
- [ ] Upgrade over an existing install preserves `config.json` byte-for-byte.
- [ ] Upgrade prompts for approval and never silently no-ops or silently overwrites.
- [ ] Origin change is detected and requires explicit confirmation.
- [ ] A `PRISM_BASE_URL` differing from the config origin triggers a question and no env mutation.
- [ ] Windows Credential Manager remains the token store; no token appears in `config.json`, the ZIP,
      the manifest, the console, or any log.
- [ ] Corrupted ZIP / wrong hash / traversal entry → aborts, leaves the existing install untouched, and
      leaves no staging residue.
- [ ] Interrupted install leaves either the old install or the new install, never a half-written tree.
- [ ] Repo-local `.agents/skills/prism-slack` still works for contributors developing in this repo.

**Guards**

- [ ] `src/server/docs-guard.test.ts` and `src/server/dependency-guard.test.ts` pass.
- [ ] No new runtime dependency added to `package.json` (or, if added, justified and guard-checked).

---

## Test plan

TDD order — write each test red, then implement.

**1. ZIP writer / bundle generator (`scripts/…` + `scripts/build-skill-bundle.test.ts` or
`src/server/skill-bundle.test.ts`, vitest node env)**

- Determinism: generating twice yields identical bytes and identical `sha256`.
- Entry names: all under `prism-slack/`, forward slashes only, includes `SKILL.md`, `VERSION`,
  `scripts/setup_credentials.py`.
- Exclusion: a fixture tree containing `config.json`, `__pycache__/x.pyc`, and `.env.local` produces an
  archive containing none of them.
- Secret canary: a fixture file containing a `prism_dev_`-shaped or `xox`-shaped canary in an excluded
  path is absent from the archive; the generator fails loudly if a canary appears in an *included* path.
- Manifest: version equals `VERSION`; `files[]` hashes match; archive hash matches the emitted bytes;
  all paths are relative.
- Round-trip: the produced archive is readable by Node's own reader in-test, and (live QA) by PowerShell
  `Expand-Archive` and Python `zipfile`.
- `VERSION` missing/invalid → generator exits non-zero.

**2. Route handlers (`app/skills/**/route.test.ts`, mirroring `app/v1/**/route.test.ts`)**

- `install.md` → 200, `text/plain; charset=utf-8`, revalidating `Cache-Control`, body contains
  `/skills/manifest.json` and `/skills/latest.zip` and contains **no** absolute `http://`/`https://`
  Prism origin.
- `manifest.json` → 200, `application/json`, parses, matches the generated manifest.
- `latest.zip` → 200, `application/zip`, byte length matches the manifest, revalidating cache header.
- `archive/<known>.zip` → 200 with `public, max-age=31536000, immutable`.
- `archive/../../etc/passwd`, `archive/unknown.zip`, `archive/latest.zip` → 404, no filesystem probing.
- Missing artifact directory → 503/404 with a clear non-leaking body (never a raw stack).
- Conditional request with the matching `If-None-Match` → 304.

**3. Hero CTA (`app/skill-install-cta.test.tsx`, `renderToStaticMarkup` like `app/ui.test.tsx`)**

- Server render contains the button and a stable placeholder, and does **not** contain a hard-coded
  origin, `PRISM_PUBLIC_BASE_URL`, or `localhost`.
- Prompt builder is a **pure exported function** `buildInstallPrompt(origin: string): string` so it can
  be unit-tested without a DOM: exact string, no trailing slash, `origin` with a trailing slash is
  normalised, `"null"` origin is rejected.
- `app/page.test.tsx` extended: the CTA is present in not-linked and linked renders.
- `app/design-system.test.ts`: add the new file to the inline-style guard list.

**4. Helper (`setup_credentials.py`)**

- The helper uses standard-library `unittest` coverage without adding a third-party dependency. Minimum
  coverage:
  - Config path resolves relative to the script's skill root, for two different install roots.
  - Marker write is atomic and produces exactly `{origin, configured, verifiedAt}`.
  - Origin-change without confirmation raises and leaves the existing file untouched.
  - Legacy user-level marker is read as a candidate only and never deleted.
  - `PRISM_BASE_URL` mismatch is reported and no env is mutated.
  - No code path can write a token into `config.json`.

**5. Full suite / build**

- `npm test`
- `npm run build`

**Live proof required (server was not running during this review)**

- `npm run db:up && npm run db:migrate && npm run build && npm run start`.
- Playwright against `http://localhost:3732/`: screenshot the hero CTA, click it, read the clipboard,
  assert the copied string equals `Go to http://localhost:3732/skills/install.md and follow the setup instructions.`
- Repeat against `http://127.0.0.1:3732/` (or the LAN IP) and confirm the copied origin follows the URL
  bar and that the plain-HTTP fallback path is exercised.
- `curl -i` each of the four endpoints; capture status, `Content-Type`, `Cache-Control`, `ETag`.
- `curl -H "Host: evil.example" http://localhost:3732/skills/install.md` — confirm the body still
  contains no absolute origin.
- End-to-end agent run: from a clean directory, paste the copied prompt into a fresh agent session and
  confirm it installs the skill, asks project-local vs global, verifies the hash, and reaches Prism
  onboarding.
- Upgrade run: bump `VERSION`, rebuild, re-run install, confirm the warn→approve→replace path and that
  `config.json` survived.
- `docker compose up --build` and re-`curl` `/skills/latest.zip`.
- Confirm no token, no Slack credential, and no `prism_dev_`-shaped string appears in any artifact,
  response, console line, or log.

---

## Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | `navigator.clipboard` is undefined on the plain-HTTP pilot origin (`.env.example:13-17`), so the CTA silently fails. | **High** | Always render selectable prompt text; add `execCommand` fallback; test on a non-localhost HTTP origin; keep the existing "could not copy automatically" message pattern. |
| R2 | `Dockerfile:15-24` does not copy the artifact directory → all `/skills/*` 404 in the pilot while passing locally. | **High** | Add the `COPY` line in the same commit; regression-check with `docker compose up --build`. |
| R3 | Origin spoofing if any absolute URL is derived from `Host`/`X-Forwarded-*`. | **High** | Browser-only origin for the prompt; root-relative URLs in `install.md`; explicit `Host: evil.example` test. |
| R4 | Public unauthenticated bundle leaks a secret (e.g. a developer's local `config.json` or a stray `.env`). | **High** | Allowlist-based file selection, secret-canary test, manifest file-list as the contract, `.gitignore` entries. |
| R5 | Non-atomic extraction destroys a working install or leaves a half-written skill. | **High** | Stage on the same volume, verify hashes, rename-old → move-new → verify → delete-backup, roll back on failure. |
| R6 | Zip-slip / traversal / symlink entries in a tampered archive. | **High** | Reject absolute paths, `..`, drive letters, backslashes, links, and any entry outside `prism-slack/`; verify archive SHA-256 before extraction. |
| R7 | Hand-rolled ZIP writer produces archives some extractors reject. | Medium | Keep to ZIP 2.0 + deflate + UTF-8 flag; verify with Node, PowerShell `Expand-Archive`, and Python `zipfile` in live QA. |
| R8 | Non-deterministic archive hash (timestamps, directory order) breaks the immutable/hash contract. | Medium | Fixed DOS timestamps, sorted entries, fixed attributes; assert byte-equality across two builds. |
| R9 | Hydration mismatch from reading `window.location` during render. | Medium | Compute at click time; fill preview post-mount; assert SSR markup has no origin. |
| R10 | Moving the marker to a skill-local path silently breaks users with the existing user-level marker. | Medium | Legacy markers are intentionally ignored; document the setup-again behavior in `SKILL.md`. |
| R11 | `next dev` serves stale or missing artifacts because `prebuild` does not run. | Medium | Add `predev`; make the route handlers return an explicit, actionable "run the bundle script" error rather than a stack trace. |
| R12 | A dot-containing route segment (`install.md`, `latest.zip`) behaves unexpectedly in Next 16. | Medium | Verified `manifest.json` is not captured by Next's root-anchored metadata regex; still confirm all four paths resolve in `npm run build` output before proceeding. Fallback: a single `app/skills/[artifact]/route.ts`. |
| R13 | Python helper coverage expands the repository beyond the current Vitest-only setup. | Medium | Use standard-library `unittest` only; do not add a third-party test dependency. |
| R14 | HTTP-only distribution means the bundle can be tampered with in transit; SHA-256 from the same channel does not prevent an active MITM. | Medium | Recommend HTTPS for any public exposure; state the limitation explicitly in `install.md` and `docs/security.md`; treat signing as a named deferral. |
| R15 | The prompt grows beyond one minimal sentence and becomes agent-ambiguous. | Low | Pin the exact string in a unit test on `buildInstallPrompt`. |
| R16 | `docs/setup.md` and `README.md` drift, leaving the repo-path install as the apparent primary route. | Low | Doc updates are in-scope for this slice and are on the regression checklist. |
| R17 | `SKILL.md` grows past the ~500-line / ~5,000-token packaging guidance. | Low | Keep install mechanics in `install.md`; `SKILL.md` covers only post-install operation. |

---

## Decision confidence

**Overall: high** for the web/origin/CTA design and the ownership map; **medium-high** for packaging
mechanics; **medium** for the agent-side install contract.

Confident because:

- Ownership is unambiguous: one hero section (`app/page.tsx:85-99`), one clipboard helper
  (`app/client-clipboard.ts`), one UI primitive set (`app/ui.tsx`), one skill source tree, one
  credential helper.
- The origin question has a clean, evidence-backed answer: server-side origin derivation is
  header-dependent and this deployment has no trusted proxy, while `window.location.origin` plus
  root-relative URLs in `install.md` removes the trust problem entirely rather than mitigating it.
- The route-handler convention is uniform across the repository and gives exact control of the
  content types and cache policy the slice requires.
- The helper already has the right primitives: a strict origin normaliser, an atomic non-secret marker
  writer with the exact `{origin, configured, verifiedAt}` shape, and a live-verification gate. The
  change is a **path** change plus confirmation gates, not a redesign.
- Two concrete failure modes were found by inspection rather than assumption (C1 clipboard on
  plain-HTTP pilot, C2 missing Docker `COPY`), and both have deterministic checks.

Less confident / decide during implementation:

- **Artifact directory name and location** (`.artifacts/skills/` vs `public/skills/`). Recommendation is
  `.artifacts/` + route handlers; the static alternative is documented and acceptable if the implementer
  prefers it, but not both.
- **Hand-rolled ZIP writer vs a build-time dependency.** Recommendation is dependency-free; revisit if
  extractor compatibility testing fails.
- **Python test coverage for the helper** — needs a decision on toolchain (see R13). Raise via
  `Question` before adding `pytest`.
- **Whether `install.md` joins `publishedDocs`** in `src/server/docs-guard.test.ts:5`. Recommended yes,
  for secret-shape coverage, but it changes what that guard asserts over.

Decisions confirmed before implementation:

1. Copy the exact browser-origin prompt pinned by the CTA test.
2. Use `.artifacts/skills/` with route handlers rather than `public/` static serving.
3. Ignore legacy `%USERPROFILE%\.copilot\skills\prism-slack\config.json` files and require
   the skill-local setup flow.
4. Start the independent skill version at `1.0.0` and bump it explicitly per skill change.
5. Use standard-library Python `unittest` without adding a third-party test dependency.
