# Offline AI evaluation

`apps/worker/src/ai-evaluation.ts` defines model-independent runners and scoring for the handwritten
benchmark problems. The formalizer runner supplies the problem text, background, selected packs, and
their approved library contents. Its task omits the handwritten hypotheses, goals, and proof steps.
The shortlister runner builds a context from the current session and selected occurrences, calls an
injected adapter with only that role context, then teacher-forces the recorded step to advance. Both
runners take injected adapters and make no provider calls by default.

The shortlister score checks whether rank 1 matches the recorded corpus suggestion by source,
artifact ID, and pattern ID when the corpus records one. It also reports hit@K counts for requested
K values. Missing predictions count against both coverage and top 1 accuracy; the scorer also reports
accuracy over returned candidate lists as `scoredAccuracy`.

The formalizer score sends a proposed `ProblemDraft` through `validateProblemDraft`, the same pure
N26 admission function used by the HTTP validation endpoint. For valid drafts it compares the
resulting initial state with the corpus state: declaration symbol and sort, hypotheses, goal, and
empty obligations. Expressions compare up to alpha-equivalence with the problem's operator set.
Draft metadata is validated during admission, while mathematical comparison ignores metadata,
generated IDs, and rendered wording; the admitted MathJSON proof state is authoritative.
`corpusReferenceDraft` converts a handwritten case to a valid reference-shaped draft for replay and
adapter tests.

The stateful-agent adapter creates an HTTP session, drives it through the same client methods used
by a human, and fetches the stored history for scoring. The scorer checks that the history root
matches the corpus problem, then runs the discovery-tree analyzer. It passes only when the proof is
solved without background inferences or sorry assumptions. This repository change defines the
injected adapter contract; it does not implement an agent loop, HTTP agent endpoint, or provider
adapter.

The existing corpus coverage golden remains the benchmark's deterministic protocol baseline. It
records every corpus problem and scripted step, including deterministic suggestion ranks and applied
kernel operations. AI adapter results should be recorded separately so changes in model quality do
not rewrite that baseline.

# Live smoke test

`apps/worker/src/ai-live-smoke.ts` runs the AI roles against the Vercel AI Gateway. It makes paid
calls, so it is run by hand and never by `npm test`:

```sh
node --env-file=.env.local --import tsx apps/worker/src/ai-live-smoke.ts \
  [--problems corpus:contraposition,corpus:weak-shift] [--out <directory>]
```

It starts the worker in process on the memory store with the real AI runtime and drives each
benchmark problem through the HTTP routes the web application uses: propose a background, revise it
once and accept it; build a library and keep every admitted result; formalize the problem and
approve the setup; request suggestions for the first scripted step's selections and shortlist
them; describe a step in words, preview it and apply it; and save it as a reusable move, submitting
the draft when its template validates. When the drafted setup is not admitted, the session is
opened from the corpus reference draft so that the later roles still run. Problems run
concurrently.

Each gateway attempt is timed and its token usage kept by wrapping `fetch`, and attributed to its
call by the envelope ID in the request. The stored call evidence says whether the output passed
validation (`validated`, `rejected`, `transport-failed`). The provider timeout is raised to
600000 ms unless `PROOF_AI_TIMEOUT_MS` is set, so slow generations are measured rather than cut off,
and the summary counts attempts slower than the worker's 120000 ms default. Cost is usage times the
gateway's list prices; the change in the account balance is printed as a cross-check (it can lag).
The output directory receives one JSON record per problem (steps, diagnostics, the raw response of
rejected outputs, provider error text) and `summary.md`/`summary.json`. It is a developer artifact,
not product storage, and holds no credentials.

## Results, 2026-10-21

Two runs over five problems (`contraposition`, `proof-by-cases`, `divisibility-sum`,
`subset-chain-membership`, `weak-shift`), default models and efforts. Counts are over both runs.

| Role                | Calls | Output validated | Downstream outcome                             | Median s | Max s | Cost $ |
| ------------------- | ----- | ---------------- | ---------------------------------------------- | -------- | ----- | ------ |
| background-proposer | 20    | 20               | 20 proposals, 10 revisions accepted            | 3.9      | 6.3   | 0.0035 |
| librarian           | 10    | 10               | 4 to 20 admitted results each                  | 77       | 111.6 | 0.0264 |
| formalizer          | 10    | 10               | 3 admitted, 2 needs-review, 5 insufficient-ctx | 5.2      | 6.7   | 0.0063 |
| move-shortlister    | 8     | 8                | 7 shortlisted, 1 low-confidence fallback       | 0.4      | 0.6   | 0.0012 |
| move-executor       | 10    | 10               | 8 previewed and applied, 2 plan-failed         | 5.4      | 10.7  | 0.0053 |
| move-author         | 8     | 0                | 8 rejected                                     | 44       | 78.9  | 0.0284 |

The whole run costs about $0.035 (roughly $0.007 per problem); the move author and the librarian
are three quarters of it.

What did not break:

- The gateway accepted every strict output schema, including the recursive MathJSON ones of the
  librarian, executor and move author. There were no transport failures and no HTTP errors.
- No attempt exceeded 120 s. The librarian is the closest (median 77 s, maximum 111.6 s at high
  effort with a 32,000 token limit), and it shares `PROOF_AI_TIMEOUT_MS` rather than the formalizer's
  budget, so it is the first role that will time out.
- Jev handles the reserved none-relevant option: it never chose it, and gave it at most 0.03. A
  positive none-relevant case (genuinely unrelated candidates) was not exercised.

What needs prompt or context fixes, in order of impact:

1. **Move author, 0 of 8 validated.** Five outputs supplied a `state` for the source example, which
   the platform supplies and the validator refuses; the strict wire form makes `state` nullable, so
   the schema cannot forbid it. The other three were a `null` where a string is required, a formula
   that is not plain MathJSON, and `premiseHypothesisIds` given as a source hypothesis where
   `apply-result-forward` does not take one. No draft reached submission, so submitting and
   reviewing a generated move is still untested live.
2. **Formalizer, 3 of 10 setups admitted.** Its system message allows "the built-in symbols" but
   never lists them, so with an empty `approvedLibrary.operators` (packs without operators of their
   own) it answers `insufficient-context` in 5 of 10 calls; every recorded rationale asks for addition
   (`operator-definition`). In 2
   it wrote implication as `p \to q`, which parses as an unknown operator `To`. The diagnostic then
   says "The approved operators are: none.", which is accurate for constants but misleading.
3. **Move executor, 2 of 10 plans failed in the kernel.** Both failed at the last step on a stale
   reference (`target-not-found`, `assumption-not-found`) to something an earlier step had replaced.
4. **Shortlister confidence.** Confidences ranged from 0.43 to 0.99; two of nine (including the
   trial run) fell below the 0.55 threshold and fell back to the deterministic order, both on the
   contraposition goal where Jev's choice was reasonable. Where the scripted selections resolved, its
   top choice was the corpus suggestion in 2 of 4 scored calls.
