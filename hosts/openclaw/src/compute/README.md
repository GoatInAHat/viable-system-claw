# Compute proposals and accounting

Pure TypeScript; no dispatch, service, clock reads, model/provider hierarchy, prices or account quotas embedded in code. Existing `../model.ts` is authoritative for the backend snapshot. All thresholds, constraints, per-window costs, prices and weights are supplied data. IDs are opaque. Parent code owns durable storage, observation trust, authorization and atomic compare-and-swap admission.

## API

- `planAllocation(snapshot: ComputeSnapshot, request: TaskConstraints, context: PlanningContext): AllocationPlan`
- `reserveAllocation(snapshot: ComputeSnapshot, proposal: AllocationPlan, context: PlanningContext): ReservationResult`
- `transitionCommitment(state: ComputeState, id: string, status: 'running' | 'finished' | 'cancelled', at?: number): ComputeState`
- `updateEvidence(state: ComputeState, event: EvidenceUpdate): EvidenceResult`
- `emptyComputeState(): ComputeState`

`PlanningContext` supplies server `now`, `policy`, `state` and optional snapshot-revision-specific `coverage`. `ComputePlanInputSchema` accepts only request/policy/state/coverage; the backend supplies its snapshot and current time. `AllocationPlanSchema` validates both choice and explicit blocked evidence. Transport collection bounds in `schema.ts` are JSON safety limits, not resource quotas. Exceeding them requires explicit archival/compaction by the owner, never silent evidence removal.

## Feasibility and approximation

For each model: check pinned task capabilities/allowlist/latency, profile freshness, independently verified task-class-specific quality, pool availability/freshness, concurrent slots, **every** quota window, plus current metered price and explicit per-request authorization. A subscription without observed windows is unknown, not free. A throughput pool can have no quota windows but must expose capacity. Metered alternatives never bypass authorization, even when subscriptions are exhausted. Unknown costs, usage, prices, slots or stale quality block; no timer automatically declares a reset empty.

Each `quotaCost[windowId]` is a caller-supplied conservative **fraction of that window per request**, including any model multiplier. Raw profile `quality`/`samples` have no independent-verifier provenance and cannot establish eligibility. Verified evidence lives separately, keyed by model/pool/capabilities and task class. Only individually fresh observations count; one new result cannot refresh an old batch. Quality lower bound is `max(0, min(latest, mean - sqrt(log(1/alpha)/(2*samples))))`; mean, latest, lower bound, samples, age and verifier remain visible. This Hoeffding-style penalty assumes bounded comparable samples; it is a conservative scoring heuristic, not calibrated confidence under changing workloads. A bad latest score immediately blocks a model; subsequent good evidence can restore eligibility. Changed underlying versions must use a new opaque model ID because the shared contract has no version field.

Among feasible candidates, maximize `task.expectedContribution * qualityLowerBound - quotaWeight * sum(windowCosts) - latencyWeight * latencyMs - moneyWeight * meteredPrice - capacityWeight * projectedSlotFraction`. This is a deterministic one-task greedy approximation, not globally optimal scheduling, an actual measured contribution prediction, or a promise of realized work. `expectedContribution` is task value **if independently verified**, and must be comparable across candidates. Summing overlapping normalized windows is a configurable ranking penalty; feasibility still checks each window separately. Prices/costs/weights can change without code changes. Model labels never influence choice; opaque IDs break equal-score ties.

## Commitment lifecycle

Planning pins a deep copy of the task; it changes no state. Reserve revalidates the original selected model and all constraints against **current** telemetry/evidence/policy, records one commitment, and reports an admitted Allocation, but does not dispatch. A changed profile or removed model is blocked. Fallback means calling `planAllocation(latestSnapshot, oldProposal.request, latestContext)` and reserving the new proposal; never remove original capabilities/quality/allowlist/authorization to make a fallback fit. Do not dispatch an idempotent `existing` result: it could already be running or finished.

A running task cannot cancel away quota. Finish releases its slot but retains its estimated quota until fresh telemetry shows a reset after the recorded `finishedAt`, or coverage explicitly declares that its **complete** charge/remaining reservation is included in a window total. Coverage is valid only for the same snapshot revision and pool, and must come from the trusted accounting adapter; partial in-flight usage is not complete coverage. Active IDs remove duplicate slot reservation when pool.active already includes them. Running/reserved work, work finished after the reset, and work without a proven completion time carry their quota commitments across resets. Without coverage, add local commitments conservatively (possible false blocks, never imaginary headroom). Stable allocation/evidence IDs deduplicate restarts; persist state atomically before dispatch and serialize competing reservations through backend CAS. These functions alone are not a distributed lock.

## Conservative learning

Verified outcome ingest requires an independent verifier ID, stable evidence ID, bounded score, task class, timestamp and model profile. Reject self-scoring, duplicates and out-of-order observations. The caller is responsible for trustworthy verifier identity and timestamp, not a client-supplied boolean in a privileged execution path.

Quota ingest records before/after account observations separately from estimates. Shared deltas are confounded: outside usage may explain **all** the increase, so attribution confidence is `unidentified`, never a per-request point observation. Only adapters explicitly asserting `counterSemantics: 'monotone-within-window'` (no expiry/replenishment/negative adjustments during the interval) can produce the usage-in-interval bound `[0, accountDelta]`. Unknown semantics, resets and changing windows retain diagnostics but produce no bound. A running task's bound covers only the observation interval, not its full eventual cost. Such evidence can raise an estimate envelope, never reduce a configured estimate or create a free model. Samples count observations, not independent requests. Rolling counters without this assertion cannot be learned from net deltas. The caller must supply a conservative full-request cost forecast; learned envelopes are cautionary evidence, not certified future usage bounds.

No automatic evidence expiry/compaction or durable integration is performed here. Parent supplies the schema-validated, trusted state; a public `compute.plan` query is scenario analysis only, and its caller-supplied quality/authorization must never be treated as authority to spend or dispatch.

## Native diagnostic pages

The native `compute.plan` wrapper returns `diagnostics` metadata and a transport-bounded slice of candidates (and blocked reasons). Supply `diagnosticOffset` to continue from `diagnostics.nextOffset`; null means complete. All models are evaluated on every call, so pagination changes explanations, not selection. Join pages only for matching snapshot revisions and identical scenario inputs. The pure `planAllocation` result remains complete for in-process admission revalidation.
