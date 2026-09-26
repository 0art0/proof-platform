# Proof Platform

This repository implements the [interactive mathematical discovery platform](./platform-design-plan.md). It is a TypeScript/pnpm monorepo: shared packages live in `packages/`, the proof worker in `apps/worker`, and the Next.js web app in `apps/web`.

## Setup and verification

The checked-in wrappers use the system Node.js when it satisfies `.node-version`, otherwise they use the verified repository-local toolchain in `.tools/`.

```bash
./scripts/pnpmw install --frozen-lockfile
./scripts/pnpmw verify
```

`verify` runs the Prettier check followed by lint, typecheck, test, and build across the workspace.

## Running locally

```bash
./scripts/pnpmw --filter @proof/web dev
```

Then open <http://127.0.0.1:3000>. See [AGENTS.md](./AGENTS.md) for development guidelines.
