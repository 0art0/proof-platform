# Proof Platform

This repository implements the [interactive mathematical discovery platform](./platform-design-plan.md). It is a TypeScript monorepo using npm workspaces: shared packages live in `packages/`, the proof worker in `apps/worker`, and the Next.js web app in `apps/web`.

## Setup and verification

Requires Node.js 24 and npm 11. `.npmrc` disables npm's update check, audit upload, and funding banner, and the web scripts set `NEXT_TELEMETRY_DISABLED=1`.

```bash
npm ci
npm run verify
```

`verify` runs the Prettier check followed by lint, typecheck, test, and build across the workspace.

## Running locally

Start the proof worker with the non-persistent in-memory store (no PostgreSQL needed). It listens on
`http://127.0.0.1:8787` by default; set `PROOF_HTTP_PORT` to change it.

```bash
PROOF_STORE=memory npx tsx apps/worker/src/main.ts
```

Without `PROOF_STORE=memory`, the worker uses PostgreSQL and requires `PROOF_DATABASE_URL` (or
`DATABASE_URL`) to point at a database migrated with `apps/worker/migrations/`.

The worker accepts only requests whose `Host` header names it (`localhost`, `127.0.0.1`, `[::1]`
or the bind host; this blocks DNS rebinding from a browser). Two optional settings tighten or
widen that, and neither is needed locally:

- `PROOF_HTTP_TOKEN` is a shared secret. When set, the worker answers `401` unless a request
  carries `Authorization: Bearer <token>`, and the web app sends the token if the same variable is
  set in its environment (server-side only; it is never sent to the browser). Setting
  `PROOF_HTTP_HOST` to anything but a loopback address (127.0.0.0/8, `::1`, `localhost`) makes the
  token mandatory, at least 32 characters, e.g. `openssl rand -hex 32`; the worker refuses to start
  without it.
- `PROOF_HTTP_ALLOWED_HOSTS` is a comma-separated list of extra host names to accept in `Host`
  (any port), for example `proof-worker` when the web app reaches a containerized worker at
  `http://proof-worker:8787`. Other hosts get `403`.

In another terminal, start the web app. It reaches the worker at `PROOF_HTTP_ORIGIN`
(default `http://127.0.0.1:8787`).

```bash
npm run dev -w @proof/web
```

Then open <http://127.0.0.1:3000>.

The proof-workspace browser tests start both servers themselves, using the in-memory store:

```bash
npm run test:e2e:workspace
```

See [AGENTS.md](./AGENTS.md) for development guidelines and
[docs/non-ai-roadmap.md](./docs/non-ai-roadmap.md) for the current TODO list.
