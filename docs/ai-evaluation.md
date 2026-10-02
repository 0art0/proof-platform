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
