# Disposable Gateway qualification

Date: 2026-11-04 (America/Chicago). Host: vado. OpenClaw 2026.10.10-beta.5.

## Part 1: durable runtime across restart

A second Gateway used an isolated state directory and port 18890:

- plugin installed from the repository path into the disposable state;
- plugin dependencies linked only inside that disposable install;
- runtime enabled with `VSC_RUNTIME_ENABLED=1`, principal `human`, charter "Keep the host observable";
- gateway bound to loopback with `--auth none --allow-unconfigured`;
- two starts against the same state directory, with a clean stop in between.

| Observation | First start | After restart |
| --- | --- | --- |
| retained namespace/key | `@retained.vsm` / `vsm-v1` | same document |
| document revision | 12 | 37 |
| units | `root`, `canary` | `root`, `canary` (no duplicate) |
| charter text | "Keep the host observable" | unchanged |
| canary observations | 9 | 33 |
| effects | 0 | 0 |
| alarms | 0 | 0 |

The restart advanced the same durable document instead of bootstrapping a second root.

## Part 2: live native dispatch and regulation

A fresh isolated state (`/tmp/vsc-qual-4`) added:

- agent `main` pinned to the Spark endpoint (DeepSeek V4.1 Flash);
- `VSC_RUNTIME_AGENT_ID=main`, which provisions the `canary/probe` procedure, an expiring revocable grant from root S3, and the `canary/local/forward` dispatch channel;
- `VSC_RUNTIME_READYZ_URL` pointed at a closed port, so each sample produced a real readiness fault above threshold.

Each regulation cycle then did this on its own:

1. sampled host health and fed evidence into the channel;
2. admitted one effect when the three brakes opened;
3. wrote a private launch intent under `@retained.vsm-private` before any native call;
4. dispatched a native subagent run for agent `main`;
5. recorded the accepted receipt, including the native session key;
6. reconciled the run to a terminal outcome;
7. took a post-action host readback as the correlated environment return;
8. re-armed the channel for the next effect.

Observed after six cycles:

| Effect | Status | Outcome | Environment return |
| --- | --- | --- | --- |
| `canary/local/forward/effect/1` | succeeded | 1 | `canary:...:readback:effect/1` |
| `.../effect/2` | succeeded | 1 | `canary:...:readback:effect/2` |
| `.../effect/3` | succeeded | 1 | `canary:...:readback:effect/3` |
| `.../effect/4` | succeeded | 1 | `canary:...:readback:effect/4` |
| `.../effect/5` | succeeded | 1 | `canary:...:readback:effect/5` |
| `.../effect/6` | succeeded | 1 | `canary:...:readback:effect/6` |

Channel state after the run: `phase: evidence`, `sequence: 6`; no alarms.

Real probe replies from the native runs included:

> Host vado (canary/local/forward/effect/1): UP 4d19h — but degraded: load 11.03 on 16 cores, memory 12.2/15.4 GB used, swap 11.9/16 GB consumed, disk 93% (34 GB free). No file changes made.

Each reply was produced by a real subagent run, not a synthetic stub. Receipt identity survived restart because the kernel now persists the native session key.

## What this proves

- A durable, authorized, independently measured execution loop exists: evidence, brakes, reservation, private intent, native launch, receipt, outcome, environment readback and re-regulation.
- The launch marker is committed before dispatch, so a crash between admission and launch leaves recoverable intent instead of a guess.
- A definitively absent launch (`lost`) re-opens the channel; an ambiguous launch does not.
- Restart reconciliation works because receipt identity is durable.
- The read-only canary never repairs the host; it only observes and reports.

## What this does not prove

- Production cutover, alarm delivery to the principal, or the runtime view.
- Multi-day sustained operation or behavior under real faults beyond a readiness failure.
- Any purpose other than the read-only canary.

Cleanup: every disposable Gateway was stopped after its run. The isolated state directories remain as local evidence and are not part of production state.

## Part 3: result retention, alarm dedupe and evaluated outcomes

Commits `d8965a8` and `0d8d35e` (both pushed to `main`) closed three review findings from `.agents/local/astra-review-2.md`:

1. **Native result payloads are retained.** `EffectReconciler` now writes each terminal effect's bounded message history and visible terminal reply to an explicit idempotent private sink (`@retained.vsm-private/vsc-private-result:<sha256(effectId, runId)>`), and `nativeExecutorFor` forwards the sink into the native executor. A first wiring attempt constructed the sink in `index.ts` but never passed it through `nativeExecutorFor`; a fresh disposable run showed zero stored payloads, which caught the dead wiring before any claim.
2. **Alarm re-delivery is deduped.** The `onAlarm` sink delivers each `alarm.id` + `raisedAt` pair once per process, so restart passes re-emitting unacknowledged alarms no longer re-deliver every finding.
3. **Outcomes are evaluated, not assumed.** The runtime's `evaluate` maps native `ok` to success only when the terminal reply is visible and non-empty, so a silent or empty completion no longer scores as a verified diagnostic.

Verification (fresh disposable Gateway `/tmp/vsc-qual-8`, port 18890, isolated state, `VSC_RUNTIME_AGENT_ID=main`, closed-port readiness fault):

- 251 tests and `tsc --noEmit` pass on the changed source.
- Effects 1-3 completed `succeeded` with outcome 1; effect 4 accepted, pending reconciliation; alarm `canary.host-health` raised once in the log (single delivery, no re-emission).
- Retained private state holds one intent marker (432 bytes) and one stored result payload per completed effect. The stored payload for effect 1 contains 4 messages, `truncated: false`, and a visible terminal reply with the real host diagnosis: "Host is up 4d 21h; load ~4.8-5.1, memory 10.9/15.4 GB used (4.5 GB available), but root filesystem is the concern at **95% used (26 GB free)** - worth pruning soon."
- Every stored payload is effect-correlated (`effectId`, `runId`, `sessionKey`, `storedAt`), so audit can join action, diagnosis and delivery without re-reading the native transcript.
- Gateway stopped after the run; isolated state kept as local evidence only.

Still open from the review: grant enforcement at the actual actuator (revocation race, `capabilities` not carried into native tool execution), crash-window recovery for reservations without receipts, failed-run environment readback, `audit.inspect` scheduling at `returnDueAt`, alarm acknowledgment and principal delivery, monolithic history bounds, compute-stewardship connection, and recursive adaptation.
