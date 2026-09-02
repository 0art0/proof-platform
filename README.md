# Proof Platform

This repository implements the [interactive mathematical discovery platform](./platform-design-plan.md). It is a TypeScript/pnpm monorepo with a dependency-light autonomous development control plane in `orchestration/`.

## Bootstrap

The checked-in wrapper uses the system Node.js when it satisfies `.node-version`, otherwise it uses the verified repository-local toolchain in `.tools/`.

```bash
./scripts/pnpmw install --frozen-lockfile
./scripts/pnpmw verify
./scripts/agentctl doctor
./scripts/agentctl init
./scripts/agentctl start
```

See [orchestration/README.md](./orchestration/README.md) before submitting autonomous work. The supervisor never pushes changes and requires a human approval before integration by default.
