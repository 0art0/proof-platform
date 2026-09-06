# Autonomous development control plane

`agentctl` is a repository-local supervisor for isolated Codex implementers and reviewers. It is intentionally independent of the application toolchain: Python, SQLite, Git, tmux, and the Codex CLI are its only runtime requirements.

The supervisor is the continuously running component. Language-model processes are bounded turns. This distinction matters: if an account is rate-limited, durable state remains available, the worker releases its slot, and the supervisor sleeps until the recorded deadline before resuming that task's own Codex thread.

## Safety model

- One task owns one immutable contract, branch, worktree, tmux session, and Codex thread.
- Worker prompts contain the objective, frozen base, allowed paths, checks, and relevant repository rules—not another task's transcript.
- Worker commands run with Codex's `workspace-write` sandbox and `never` approval policy. Reviewer and user-facing orchestrator turns are read-only.
- Runtime SQLite, logs, prompts, model outputs, and the dedicated tmux socket live in `.agent-state/`, outside task worktrees.
- The `nodew` and `pnpmw` wrappers resolve the canonical checkout's verified toolchain and content-addressed store from a worktree's Git common directory; workers get reproducible dependencies without owning the control plane.
- Scope validation checks the complete diff without rename collapsing, all untracked files, symlink escapes, submodules, ancestry, protected paths, and `git diff --check`.
- The trusted runner, not the model, creates the candidate commit.
- Integration uses a fresh staging worktree at the current `main`, applies the exact candidate commit, verifies that prospective tree, and advances `main` only while holding an integration lock and only when the expected head is unchanged.
- No command pushes a branch.

Git worktrees and tmux are useful isolation mechanisms but are not security boundaries for hostile same-user code. Codex sandboxing and post-run validation are both required. Verification executes candidate code and must therefore remain sandboxed at the host/container level when contracts include untrusted code.

## Bootstrap

The checkout must be a writable Git repository with at least one commit. `agentctl init` is deliberately non-destructive: it creates control-plane state, but it will not replace invalid Git metadata or invent author identity for an initial commit. Managed environments that mount a read-only `.git` placeholder can use Git's supported separate metadata layout at ignored `.git-data/`; `agentctl` detects both layouts.

```bash
./scripts/agentctl doctor
./scripts/agentctl init
./scripts/agentctl start
```

`start` launches a dedicated tmux server and a restart loop. This survives terminal detachment, not host reboot. To start after reboot, adapt and install `orchestration/systemd/proof-platform-orchestrator.service` as a user service.

## User-facing workflow

Submit natural-language intent to the read-only orchestrator context:

```bash
./scripts/agentctl ask "Implement capture-avoiding substitution with property tests"
./scripts/agentctl messages
```

The structured orchestrator response is validated before proposed tasks enter SQLite. It also assigns every task a path in the durable project TODO tree. Inspect or extend that hierarchy independently of the execution queue:

```bash
./scripts/agentctl todo
./scripts/agentctl todo add --title "Stage 1" --description "MathJSON interaction spike"
./scripts/agentctl todo add --parent TODO_ID --title "Selection paths"
./scripts/agentctl todo set TODO_ID blocked
```

Task-linked TODO leaves follow the task state machine and cannot be manually marked done. Planning branches aggregate their children's state. For direct, explicit contracts:

```bash
./scripts/agentctl task add \
  --title "Implement operand-path replacement" \
  --prompt-file docs/tasks/operand-paths.md \
  --todo-parent TODO_ID \
  --write 'packages/selections/**' \
  --check './scripts/pnpmw --filter @proof/selections test'
```

Observe and control work:

```bash
./scripts/agentctl status
./scripts/agentctl task show TASK_ID
./scripts/agentctl logs TASK_ID
./scripts/agentctl retry TASK_ID
./scripts/agentctl cancel TASK_ID
./scripts/agentctl approve TASK_ID
./scripts/agentctl integrate TASK_ID
./scripts/agentctl attach
./scripts/agentctl stop
```

By default, a reviewed task stops at `awaiting_approval`. Approval never implies integration; `integrate` is a second explicit action. If the base has moved, the exact candidate is restaged and fully reverified. Conflicts leave the canonical branch untouched.

## Remote orchestrator

A dedicated Codex app-server thread can expose the same durable TODO, task status, and supervisor inbox through authenticated Remote Control:

```bash
./scripts/agentctl remote start
./scripts/agentctl remote pair
./scripts/agentctl remote status
```

The remote thread runs with a read-only filesystem sandbox. Its MCP surface has only three allow-listed operations: submit user intent to the supervisor inbox, read durable status/TODO state, and read orchestrator replies. Reads are pre-approved; submitting intent is marked as a write and uses Codex's normal user approval prompt. The thread cannot edit the repository, approve or integrate candidates, or control tmux. `remote stop` stops only this repository's thread and deliberately leaves the host-wide Codex Remote Control daemon alone.

In the ChatGPT mobile app, open the Remote tab and pair with the short-lived code. The host must remain awake, online, and running Codex. OpenAI currently documents Remote Control hosts as macOS and Windows; on other hosts, `remote start` keeps the restricted local thread ready but returns a nonzero status if the authenticated relay is unavailable. The SQLite queue is shown through this thread—it is not uploaded as a native Codex Cloud task list.

## State and recovery

SQLite uses WAL mode, foreign keys, a busy timeout, versioned migrations, atomic transitions, append-only events, and attempt fencing tokens. The same database stores the parent/child TODO tree and its task links. `agentctl doctor` runs `PRAGMA integrity_check`. Before scheduling, the daemon reconciles statuses with tmux sessions and Git worktrees. Interrupted attempts retain their worktree, diff, logs, and thread identifier.

Do not copy only `state.sqlite3` while the daemon is live; use SQLite's backup API or stop the supervisor so WAL data is included. Failed and cancelled evidence is retained by default.

## State model

```text
queued ──> preparing ──> running ──> verifying ──> reviewing
   ▲                         │             │            │
   │                         ├─> retry_wait┴────────────┤
   │                         ├─> needs_input            ├─> rework ──┐
   │                         └─> failed                 └─> awaiting_approval
   │                                                                  │
   └──────────────────────────────── retry <───────────────────────────┤
                                                                      v
                                                        ready_to_integrate
                                                                      │
                                                                      v
                                                             integrating
                                                               │      │
                                                needs_resolution      integrated
```

`cancelled` is terminal from every non-integrated state. Rate limits do not consume the automatic failure/rework budget and are tracked as deadlines rather than active workers.
