from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .codex import CodexOutcome, run_codex, validate_result_shape
from .config import Config
from .contracts import implementer_prompt, reviewer_prompt
from .gitops import commit_candidate, validate_candidate
from .scope import validate_scope
from .state import State
from .util import AgentCtlError, atomic_write, epoch_now, json_dumps
from .verify import run_checks


def _rate_limited(
    *, state: State, task: dict[str, Any], outcome: CodexOutcome, phase: str
) -> None:
    retry_at = outcome.retry_at or epoch_now() + 900
    state.set_rate_limit("codex-default", retry_at, outcome.output[-2000:])
    fields: dict[str, Any] = {
        "next_wake_at": retry_at,
        "last_error": f"{phase} rate limited; supervisor will retry at {retry_at}",
    }
    if phase == "implementer":
        fields["thread_id"] = outcome.thread_id
    else:
        fields["reviewer_thread_id"] = outcome.thread_id
    state.transition(
        task["id"],
        "retry_wait",
        actor="worker",
        payload={"phase": phase, "retryAt": retry_at, "pool": "codex-default"},
        fields=fields,
    )


def _review(
    *, config: Config, state: State, task: dict[str, Any], token: str, resume: bool
) -> None:
    if not config.review_enabled:
        target = "awaiting_approval" if config.require_human_approval else "ready_to_integrate"
        state.transition(
            task["id"],
            target,
            actor="reviewer",
            payload={"review": "disabled by repository configuration"},
        )
        return

    attempt = int(task["attempt"])
    review_log = config.state_dir / "logs" / f"{task['id']}-{attempt}-review.jsonl"
    review_result = config.state_dir / "results" / f"{task['id']}-{attempt}-review.json"
    outcome = run_codex(
        config=config,
        cwd=Path(task["worktree"]),
        prompt=reviewer_prompt(config, task),
        schema=config.root / "orchestration" / "schemas" / "review-result.schema.json",
        result_path=review_result,
        log_path=review_log,
        sandbox=str(config.raw["codex"]["reviewerSandbox"]),
        timeout=config.worker_timeout,
        resume_thread_id=str(task.get("reviewer_thread_id") or "") if resume else None,
    )
    state.update_task(
        task["id"],
        actor="reviewer",
        kind="review.output",
        fields={"reviewer_thread_id": outcome.thread_id},
    )
    if outcome.rate_limited:
        _rate_limited(state=state, task=state.get_task(task["id"]), outcome=outcome, phase="reviewer")
        return
    if outcome.returncode != 0:
        state.transition(
            task["id"],
            "failed",
            actor="reviewer",
            payload={"exitCode": outcome.returncode},
            fields={"last_error": outcome.output[-8000:]},
        )
        return
    result = validate_result_shape(outcome.result, ("verdict", "summary", "findings"))
    atomic_write(
        review_result,
        json.dumps(result, indent=2, ensure_ascii=False) + "\n",
        mode=0o600,
    )
    verdict = result["verdict"]
    if verdict == "approve":
        target = "awaiting_approval" if config.require_human_approval else "ready_to_integrate"
        state.transition(
            task["id"],
            target,
            actor="reviewer",
            payload={"verdict": verdict, "findings": result["findings"]},
            fields={"result_summary": str(result["summary"]), "last_error": None},
        )
    elif verdict == "request_changes":
        feedback = json_dumps({"summary": result["summary"], "findings": result["findings"]})
        state.note_failure(task["id"], actor="reviewer", reason="review requested changes")
        state.transition(
            task["id"],
            "rework",
            actor="reviewer",
            payload={"verdict": verdict, "findings": result["findings"]},
            fields={"last_error": feedback},
        )
    else:
        state.transition(
            task["id"],
            "needs_input",
            actor="reviewer",
            payload={"verdict": verdict},
            fields={"last_error": str(result["summary"])},
        )


def execute(root: Path, task_id: str, token: str, phase: str) -> int:
    config = Config.load(root)
    state = State(config.database_path)
    try:
        state.migrate()
        task = state.get_task(task_id)
        if task["fencing_token"] != token:
            raise AgentCtlError("worker fencing token is stale")
        state.transition(task_id, "running", actor="worker", expected="preparing")
        task = state.get_task(task_id)

        if phase == "review":
            state.transition(task_id, "verifying", actor="worker", expected="running")
            report = validate_candidate(config, task)
            run_checks(
                config=config,
                state=state,
                task_id=task_id,
                candidate_sha=str(task["candidate_sha"]),
                phase="candidate-review-retry",
                cwd=Path(task["worktree"]),
                commands=[*config.candidate_commands, *task["checks"]],
            )
            state.transition(
                task_id,
                "reviewing",
                actor="worker",
                expected="verifying",
                payload={"paths": list(report.changed_paths), "reverified": True},
            )
            _review(
                config=config,
                state=state,
                task=state.get_task(task_id),
                token=token,
                resume=True,
            )
            state.finish_attempt(
                task_id,
                token,
                exit_code=0,
                thread_id=task.get("reviewer_thread_id"),
                output_digest="review-retry",
            )
            return 0

        attempt = int(task["attempt"])
        log_path = config.state_dir / "logs" / f"{task_id}-{attempt}-implementer.jsonl"
        result_path = config.state_dir / "results" / f"{task_id}-{attempt}-implementer.json"
        outcome = run_codex(
            config=config,
            cwd=Path(task["worktree"]),
            prompt=implementer_prompt(config, task),
            schema=config.root / "orchestration" / "schemas" / "worker-result.schema.json",
            result_path=result_path,
            log_path=log_path,
            sandbox=str(config.raw["codex"]["implementerSandbox"]),
            timeout=config.worker_timeout,
            resume_thread_id=str(task.get("thread_id") or "") or None,
        )
        state.update_task(
            task_id,
            actor="worker",
            kind="implementer.output",
            fields={"thread_id": outcome.thread_id},
        )
        state.finish_attempt(
            task_id,
            token,
            exit_code=outcome.returncode,
            thread_id=outcome.thread_id,
            output_digest=outcome.digest,
        )
        task = state.get_task(task_id)
        if outcome.rate_limited:
            _rate_limited(state=state, task=task, outcome=outcome, phase="implementer")
            return 0
        if outcome.returncode != 0:
            state.transition(
                task_id,
                "failed",
                actor="worker",
                fields={"last_error": outcome.output[-8000:]},
                payload={"exitCode": outcome.returncode},
            )
            return 1
        result = validate_result_shape(
            outcome.result, ("status", "summary", "filesChanged", "checks", "risks", "needs")
        )
        atomic_write(result_path, json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        if result["status"] != "completed":
            target = "needs_input" if result["status"] == "needs_input" else "failed"
            state.transition(
                task_id,
                target,
                actor="worker",
                fields={"result_summary": str(result["summary"]), "last_error": json_dumps(result["needs"])},
                payload={"reportedStatus": result["status"]},
            )
            return 0 if target == "needs_input" else 1

        report = validate_scope(
            worktree=Path(task["worktree"]),
            base_sha=str(task["base_sha"]),
            allowed=task["scope"],
            protected=config.protected_paths,
            elevated=config.elevated_paths,
        )
        state.transition(
            task_id,
            "verifying",
            actor="worker",
            payload={"paths": list(report.changed_paths), "elevated": list(report.elevated_paths)},
        )
        run_checks(
            config=config,
            state=state,
            task_id=task_id,
            candidate_sha=None,
            phase="candidate",
            cwd=Path(task["worktree"]),
            commands=[*config.candidate_commands, *task["checks"]],
        )
        candidate = commit_candidate(config, task, report)
        state.transition(
            task_id,
            "reviewing",
            actor="worker",
            expected="verifying",
            fields={
                "candidate_sha": candidate,
                "result_summary": str(result["summary"]),
                "last_error": None,
            },
            payload={"candidateSha": candidate},
        )
        _review(
            config=config,
            state=state,
            task=state.get_task(task_id),
            token=token,
            resume=False,
        )
        return 0
    except AgentCtlError as exc:
        try:
            current = state.get_task(task_id)
            if current["status"] in {"preparing", "running", "verifying", "reviewing"}:
                state.transition(
                    task_id,
                    "failed",
                    actor="worker",
                    fields={"last_error": str(exc)},
                    payload={"error": str(exc)},
                )
        except AgentCtlError:
            pass
        print(f"agentctl worker: {exc}", file=sys.stderr)
        return 1
    finally:
        state.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--task", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--phase", choices=("implement", "review"), default="implement")
    arguments = parser.parse_args(argv)
    return execute(arguments.root.resolve(), arguments.task, arguments.token, arguments.phase)


if __name__ == "__main__":
    raise SystemExit(main())
