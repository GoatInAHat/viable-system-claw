# Milestone: durable VSC runtime (canary slice)

Status: **build target, not active.** No production cutover. No new tool authority.

## Why

The pure kernel and native executor exist, but nothing durable connects them. A plan cannot become a reservation, launch, accepted receipt, outcome and regulated-variable update, and a restart loses the relationship between them. This milestone closes that loop for one canary purpose so the mechanism can be judged by evidence instead of design text.

## Scope

Implement inside `hosts/openclaw/src/vsm/` only:

1. `state.ts` — retained store adapter.
   - Wrap `openKeyedStoreV2({ namespace: 'vsm', retention: 'retained' })`.
   - One document key `vsm-v1`; JSON only; typebox schema for `VsmState` plus envelope `{ version: 1, revision, state }`.
   - CAS through `observe` then `compareAndApply`; retry only on explicit conflict; surface storage errors unchanged; refuse to replace invalid state.
   - Enforce a byte budget below the native transport limit; refuse oversized mutations before CAS.

2. `service.ts` — durable runtime service.
   - `start()` loads state, validates it, reconstructs pending effects, and registers a monotonic clock. It never claims retained state is live.
   - `apply(event)` runs `step()`, persists the resulting state before acting on any returned action, then performs actions in order.
   - Dispatch: persist intent (already in state) before calling the native executor; persist the receipt or the reconciled ambiguity; never blind retry. A rejected dispatch is recorded as `not-launched` only when the adapter proves it; otherwise `unknown`.
   - Reconcile: resolve `reconcile` actions through the adapter and record `not-launched`/`unknown`/`accepted` as distinct states.
   - Alarms: pass `alarm` actions to a sink callback; the alarm record stays in state and is never erased by acknowledgement.
   - `stop()` stops timers and leaves durable state readable. Restart reconstructs deadlines from state, not from timers.

3. `canary.ts` — first purpose: read-only host health.
   - Samples gateway `/readyz` and disk/inode thresholds on a 30s cadence.
   - Emits typed observations with evidence references; never repairs, restarts or writes outside its own state.
   - A failed sample is evidence, not an alarm by itself; the homeostat decides.

4. Tests in `state.test.ts` and `service.test.ts` using the fake executor and a fake store that implements the same CAS contract.
   - Restart after accepted/ambiguous/outcome states.
   - CAS conflict and storage error behavior.
   - Duplicate dispatch idempotence.
   - Alarm bypass never blocked by channel filters.
   - Canary observation shape and evidence refs.

## Contracts

- Persisted records contain data only: no functions, promises, credentials, tool arguments or transcript bodies.
- Actor identity is supplied by the host from trusted bindings; never accepted from a client.
- A projection is a read model; closing the UI never stops the service.
- The service owns no second task ledger: work identity stays in the kernel's effects, and native run identity stays in receipts.

## Acceptance

- `npx tsc -p hosts/openclaw/tsconfig.check.json --noEmit` passes.
- `node_modules/.bin/vitest run --config hosts/openclaw/vitest.config.ts src/vsm --maxWorkers 1` passes, including all pre-existing tests.
- `git diff --stat` shows changes only under `hosts/openclaw/src/vsm/` plus this milestone document.
- No live install, reload or cutover; no change to the existing Substrate owner.

## Out of scope

- UI panel for the runtime view.
- Disposable-gateway qualification.
- Any repair action by the canary.

## Addendum (2026-11-04, part 3)

Result retention, alarm dedupe and outcome evaluation are now implemented on top of this milestone's slice:

- `EffectReconciler` accepts an optional `privateResultSink`; the production runtime supplies an idempotent sink backed by the retained `vsm-private` namespace. Terminal message history and visible terminal replies are retained per effect, bounded, and effect-correlated.
- `nativeExecutorFor` forwards the sink into the native executor. The production `evaluate` callback scores success only when the terminal reply is visible and non-empty.
- The `onAlarm` sink dedupes delivery by alarm identity and `raisedAt`, so restart passes re-emit without re-delivering.

Evidence: `docs/QUALIFICATION.md` part 3. Not yet open: principal alarm delivery with acknowledgment, `audit.inspect` scheduling at `returnDueAt`, actuator-level grant enforcement.
