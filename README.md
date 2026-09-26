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
