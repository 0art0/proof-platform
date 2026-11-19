# Proof Platform

This repository implements the [interactive mathematical discovery platform](./platform-design-plan.md). It is a TypeScript monorepo using npm workspaces: shared packages live in `packages/`, the proof worker in `apps/worker`, and the Next.js web app in `apps/web`.

## Generalized rewriting

In the formal proof workspace, hover over an expression to inspect rewrites or click to see their
previews. **Work with** focuses suggestions on a relation. You can also drag a hypothesis or a
library result onto an occurrence in the goal or in another hypothesis. The preview shows the
replacement, transition class, and new obligations. **Apply this step** commits the change.

For example, given `x ≤ y` and the goal `x · c ≤ z`, select `x` and choose **Order (≤)**.
Replacing `x` with `y` strengthens the goal to `y · c ≤ z`. The multiplication lemma requires
`0 ≤ c`, which becomes an obligation unless the context supplies it. For implication, rewriting
a goal using `P ⇒ Q` works back from `Q` to `P`. In a hypothesis it can move from `P` to `Q`.
Negation and implication antecedents reverse this direction. A result `A, B ⊢ C` can replace
`C` by `A` inside a positive goal position, leaving `B` to prove. The same step inside a
universal or existential body closes any variable-dependent side goal over its enclosing
binders. A universally quantified hypothesis specializes when the selected occurrence
determines its variables.

The modular arithmetic pack uses `["Congruent", a, b, m]` for integer congruence modulo `m`.
An approved library result can declare `congruenceSymbols`, for example `["Multiply"]` on
`a ≤ b, 0 ≤ c ⊢ a · c ≤ b · c`. The tag indexes the result by the enclosing operator. The kernel
checks the instantiated theorem, including its other premises, and records which lemmas licensed
the step. See the [starter library](./packages/library/src/packs.ts),
[Rocq's morphism signatures](https://docs.rocq-prover.org/master/refman/addendum/generalized-rewriting.html),
and [Mathlib's generalized congruence rules](https://leanprover-community.github.io/mathlib4_docs/Mathlib/Tactic/GCongr/Core.html).

## Setup and verification

Requires Node.js 24 and npm 11. `.npmrc` disables npm's update check, audit upload, and funding banner, and the web scripts set `NEXT_TELEMETRY_DISABLED=1`.

```bash
npm ci
npm run verify
```

`verify` runs the Prettier check followed by lint, typecheck, test, and build across the workspace.

## Running locally

Start the worker and the web app together with one command, then open <http://localhost:3000>:

```bash
scripts/start.sh   # or: npm run dev
```

It uses the in-memory store unless `PROOF_DATABASE_URL` (or `DATABASE_URL`) is set, gives the
worker the AI settings in `.env.local`, and stops both servers on Ctrl-C. The rest of this section
describes starting each server by hand.

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
