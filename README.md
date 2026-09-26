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

```bash
npm run dev -w @proof/web
```

Then open <http://127.0.0.1:3000>. See [AGENTS.md](./AGENTS.md) for development guidelines.
