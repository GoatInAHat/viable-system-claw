# Pure VSM kernel

This directory is an **unintegrated foundation**, not a running organization. It imports no OpenClaw APIs and launches no work. Persisted state is plain JSON; functions return new state and explicit actions. No classes, callbacks, promises, credentials or tool arguments are persisted.

## Public entry points

| File | API | Responsibility |
| --- | --- | --- |
| `types.ts` | `VsmState`, `VsmEvent`, `VsmAction`, supporting types | Durable rooted organization, authority, homeostats, effects, evidence and provenance |
| `kernel.ts` | `createState`, `addUnit`, `connectHomeostat`, `configureChannel` | External/bootstrap construction, not agent mutation endpoints |
| `kernel.ts` | `organ`, `environment`, `endpointKey` | Typed endpoint construction/identity |
| `kernel.ts` | `validateState`, `assertValid` | Structural/authority validation; optional previous state enforces immutable references and grant history |
| `kernel.ts` | `isPrincipal`, `canGrant`, `canValue`, `grantAdmits` | Actor and instantaneous reservation/capability checks |
| `kernel.ts` | `assertJson`, `projectState`, `measureProjection`, `TRANSPORT_LIMITS` | JSON safety and independently bounded native projections |
| `runtime.ts` | `step(state, event, now)` | Pure event reduction; `{state, actions, decisions, errors}` |
| `runtime.ts` | `effectiveThreshold`, `dispatchAdmission` | Exact threshold and final grant-version/expiry preflight |
| `executor.ts` | `NativeExecutor`, request/result interfaces | Async adapter contract only |
| `executor.ts` | `dispatchRequest`, `reconcileRequest`, `executionEvents` | Build admitted requests and normalize authoritative adapter replies |
| `executor.ts` | `createFakeExecutor`, `fakeDispatch`, `fakeReconcile`, `fakeComplete`, `fakeRestart` | Pure synthetic adapter with persistent idempotency ledger and injected faults |

All times are finite, nonnegative processing-time milliseconds supplied by the host. `step` requires monotonic time; event valid times belong in provenance records, not in the processing clock. Duplicate source event IDs return the exact original state and no actions. Rejected events also leave original state unchanged and return precise error codes. A different ID with the same completed effect is still deduplicated by the effect lifecycle.

## Structural and authority semantics

- Exactly one designated root; recursive units have exactly one parent/owner. The principal owns root; a unit's parent owns its exit valuation. All nine explicit organs are required: operation, management, regulatory centre, S1, S2, S3, S3*, S4 and S5.
- Every constructor provisions operational, total and future environments; operation/environment and S4/future loops, a local operation/management loop, the S3/S4 adaptation loop, and a direct root S5 alarm loop. Children also get V1, V2, V5 and V6 pairs. Provision V3/lateral sibling and V4 shared-environment loops with `connectHomeostat`; the constructor does not assume every sibling pair is coupled.
- Every homeostat has two opposite directed channels of the same legal kind. V1/V2 connect parent S3 and child management; V5 connects parent S2 and child regulatory centre; V6 connects parent S3* and child operation; V3 connects sibling operations; V4 connects sibling operational environments. S5 is not an ordinary command endpoint. Environmental boundaries are crossed only by operation or S4.
- Seed procedures and deployment/kernel references cannot change when validated against previous state. Algedonic paths cannot be removed or rewired. The root charter is principal-ratified, root-only state; no reducer event edits it. Bootstrap/external ratification is an integration responsibility.
- A grant is explicit, expiring, revocable and versioned. Only parent S3 or the principal can issue/revoke it, never the receiving unit. Each version survives in `grantHistory`; each effect attempt retains its own grant-version reservation. Execution requires the procedure and its required tools/surfaces to be admitted. Bindings alone grant no authority.
- `Actor` is an authenticated host assertion, **not a security token**. The host must derive it from trusted identity/organ bindings. Never accept an actor supplied by a client as authenticated. Bootstrap helpers are not an agent-authorized graph editor.

## Channel transition semantics

1. **Persistent loops:** paired channel records survive procedure termination and serialization. Each direction parks with its own accumulator, sequence and last-effect reference.
2. **Summation:** on eligible observation, `E = max(0, E - decayPerMs * elapsed + channel.gain * evidence)`. Evidence is a caller-supplied signed log-likelihood score; default decay is zero (CUSUM retention). Decay is applied before every brake evaluation, including gain/grant/return events. Subthreshold and filtered observations retain evidence pointers without inference.
3. **Lateral first:** for an observation, discover outgoing sibling V3/lateral directions from the primary unit (or validate an explicit candidate list). Try them in stable ID order. A direction absorbs only if its filter, evidence, environment and grant permit a reservation. When one absorbs, record the choice and do not feed/wake the primary vertical direction. If none absorbs, feed the primary normally. Separate accumulated loops may later respond to gain/grant changes; this is event-local arbitration, not a global causal deduplicator for independently supplied observations.
4. **Filtering and bypass:** ordinary observations must pass index/topic filters. Alarms have a separate event path; they never pass through those filters or the resource-execution admission path.
5. **Ambient modulation:** effective threshold is `max(0, baseThreshold - ambient.gain + ambient.price * cost)`. Root S3/principal can change the medium; the change and each resulting brake decision are recorded. The linear price term is an explicit engineering policy, not a dual-optimal pricing theorem. No automatic consumption-driven price controller is implemented here.
6. **Three brakes:** sufficient retained evidence, a complete prior effect/environment round trip, and a current capacity/capability grant must all admit. First invocation has a free environment. Subsequently **both outcome and correlated environment return** are required (a conservative extra condition beyond receipt alone). A closed brake retains evidence and emits no dispatch. First successful admission records durable intent and reservation atomically, consumes the accumulated supporting evidence, and returns one dispatch action. New observations arriving in flight accumulate separately.
7. **Timescales:** S1/S2/S3/local loops have `fast-code` wakes; a channel touching S3*, S4 or S5 has `slow-deliberative`; algedonics have `alarm`. Wake classification is derived/validated from endpoints. Classification is not a CPU scheduler and does not itself invoke a model.

Channels without a procedure monitor evidence but never dispatch. Capacity, delay, transducer reference and cycle time are explicit metadata; this kernel does not simulate channel bandwidth, compile transducers, or impose a periodic cadence. There is no hidden timer or background poller.

## Purpose, audit and alarms

- Every child has exit values: declared, parent-imputed and residual error. `purpose.feedback` requires the parent S3/principal to supply **every exit**, adjusts each declaration toward its valuation by at most `maxUpdate`, and records revision/convergence steps and provenance. For fixed finite valuations this bounded update reaches them in finitely many steps. It is **not** a best-response policy solver or a proof of hierarchical optimality; changing/inaccurate parent valuations may not converge. Root purpose changes require external charter ratification.
- An outcome mismatch/failure creates one deterministic residual audit finding per effect/kind, with causal procedure attribution and evidence references. `audit.inspect` creates a missing-return finding when a supplied deadline event arrives. Attribution is numeric bookkeeping (residual blame; independent findings can carry credit/blame), **not inferred causal responsibility** or calibrated transducer learning. Audit signals identify parent S3* directly.
- Alarm threshold is `max(0, localThreshold - ln(delayCost / falseAlarmCost) - ambientGain)`. Nonnegative severity crosses that threshold directly to local S5, root S5 and the principal, independently of recursion depth. Subthreshold alarms remain recorded; raised alarms remain unacknowledged until an authorized S5/principal acknowledgment. Three raised occurrences of a class mark an S4 improvement candidate. The count of three and scalar severity are engineering approximations, not a fitted quickest-detection model.
- `alarm`, `audit` and `improve-alarm-class` actions are durable **notification/attention signals**, not granted model/tool dispatches. A host must route any resulting procedure execution back through a channel and the three brakes; an alarm delivery itself cannot be conditioned on those brakes.
- Episodes and semantic facts are append-only protected references with valid/knowledge times; facts can supersede prior facts. Raw traces remain at their canonical protected source. No automatic memory extraction, learning, temporal query engine or Honcho integration is included.

## Effect and restart protocol

`intent → reserved → accepted → succeeded|failed`, with `ambiguous` for uncertain transport and `lost` **only for definitive proof of no launch**. Intent and first reservation are one reducer transaction, not separate dispatch opportunities. Effect IDs are deterministic `channelId/effect/sequence`; retries retain the same effect ID. Receipts cannot change identity, late acceptance cannot regress a completed effect, duplicate outcomes are ignored, conflicting outcomes produce an audit, and outcomes are distinct from environment readback.

`restart` emits reconciliation actions for reserved/accepted/ambiguous/lost effects and completed effects still missing an environment return. It emits **no dispatch**. It also re-emits raised unacknowledged alarms and durable audit/improvement signals, using stable IDs for consumer deduplication. Acknowledged alarms are not re-emitted. Reservations remain occupied until outcome **and** environment return; definitive no-launch/cancellation do not occupy capacity. Revocation/version change/expiry blocks a queued dispatch preflight; an already accepted external run is not falsely called cancelled or released.

The adapter contract must distinguish authoritative `not-launched` from `unknown`. A timeout, unavailable provider, missing eventual-consistency row or lost reply is `unknown`, never permission to retry. Only definitive no-launch permits `effect.admit` to reserve the same effect again under a current grant, using its original procedure/cost/evidence. No general retry of an accepted or ambiguous effect is permitted. The fake demonstrates crash-before-launch, accepted/lost-reply, unavailable reconciliation, duplicate completions and restart without a second native launch.

### Parent integration order

1. Bind a trusted event source and authenticated actors. Validate loaded state and reject incompatible versions. Retain source events durably until committed; source delivery must not depend on UI projection success.
2. In one CAS/transaction, apply `step`, commit state/revision, the consumed event identity and an outbox/derived action reference. On CAS conflict, reread and recompute; do not execute actions from a failed commit. This directory supplies no persistence, locking or multi-record transaction implementation.
3. **After commit**, claim dispatch ownership with one live executor; call `dispatchRequest` against the latest authoritative state immediately before launch. Serialize grant withdrawal and final admission/launch ownership. The preflight alone cannot eliminate a host-side revocation/launch race.
4. Pass the stable effect ID as the adapter's native idempotency key. Enforce request capabilities in the native tool/execution policy. Persist accepted receipts and independent outcome/readback evidence by ingesting `executionEvents`. Never treat dispatch return as completion.
5. After a restart, process `restart` before launching anything. Reconcile every uncertain effect; persist definitive absence before enqueueing `effect.admit`. If a current grant is closed, retain the effect/evidence and readmit on a subsequent authority/resource event. Schedule `audit.inspect` at outstanding return deadlines using the host's durable event system.
6. Deliver alarm notifications with stable alarm IDs until acknowledged. Deduplicate audit/improvement signals; they are not authorization to spend inference. Support principal revocation externally. Native cancellation/draining and release accounting remain adapter responsibilities.
7. Store full authoritative records/references separately from small native feature pages. `projectState` explicitly selects IDs (default root only), returns counts, and rejects an oversized **selection** without truncating domain history. Add host-side cursor/paged queries and archive policy; never replace authoritative state with the projection. Effect/event IDs must not be forgotten while their replay window remains open.

Exactly-once **external** execution is not claimed. It requires a native durable idempotency ledger and authoritative reconciliation, as provided only by the synthetic fake here. If the real actuator cannot resolve uncertain acceptance, preserve ambiguity and escalate rather than replaying a side effect.

## Validation and transport fixture

Run from repository root using existing dependencies:

```sh
./node_modules/.bin/tsc -p hosts/openclaw/tsconfig.check.json --noEmit --incremental false
./node_modules/.bin/vitest run --config hosts/openclaw/vitest.config.ts --maxWorkers=1 src/vsm/
```

Tests use synthetic data only. The transport fixture contains 12 recursively owned units and 100 retained observations/decisions. A selected root + child + one channel page measures **4423 UTF-8 bytes / 307 JSON values**, passing 262144-byte / 4096-value, depth-32, 512-object-key and 65536-character string limits. Selecting all units/channels intentionally rejects with `TRANSPORT_NODES`; authoritative observations remain intact. JSON rejects nonfinite numbers, undefined values, classes, sparse arrays and cycles. Projection clones selected records so a view cannot mutate authoritative state.

No backend/UI integration, live executor, kernel adoption pipeline, statistical calibration, measured viability guarantee, or operational qualification is implied by these tests.

## Durable runtime slice (milestone 1)

| File | API | Responsibility |
| --- | --- | --- |
| `state.ts` | `encodeDocument`, `readDocument`, `bootstrapDocument`, `changeDocument` | One retained JSON document, CAS retry on explicit conflict only, byte budget, refusal to reinterpret invalid bytes |
| `service.ts` | `VsmService` | Serialized event application; commits state before performing any action; dispatch, reconcile, alarm and audit sinks; restart recovery from durable state |
| `native-adapter.ts` | `createNativeExecutor` | Bridges the kernel dispatch contract to `execution/native.ts` without inventing agent, message, purpose or authority |
| `canary.ts` | `sampleCanary`, `canaryObservations` | Read-only host-health purpose; absent counters are evidence, never a healthy reading |

The service is durable but **not wired into the running Gateway** in this slice. It is exercised by synthetic tests, including restart, conflict, duplicate-event, ambiguous-launch and alarm-bypass cases.

