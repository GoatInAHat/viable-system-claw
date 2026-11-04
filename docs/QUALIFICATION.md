# Disposable Gateway qualification

Date: 2026-11-04 (America/Chicago). Host: vado. OpenClaw 2026.10.10-beta.5.

## What ran

A second Gateway used an isolated state directory and port 18890:

- plugin installed from the repository path into the disposable state;
- plugin dependencies linked only inside that disposable install;
- runtime enabled with `VSC_RUNTIME_ENABLED=1`, principal `human`, charter "Keep the host observable";
- gateway bound to loopback with `--auth none --allow-unconfigured`;
- two starts against the same state directory, with a clean stop in between.

The production Gateway was not modified, and the VSC plugin was not enabled there.

## Observed

| Observation | First start | After restart |
| --- | --- | --- |
| retained namespace/key | `@retained.vsm` / `vsm-v1` | same document |
| document revision | 12 | 37 |
| units | `root`, `canary` | `root`, `canary` (no duplicate) |
| charter text | "Keep the host observable" | unchanged |
| canary observations | 9 | 33 |
| decisions | 10 | 35 |
| recovery decisions | - | 2 ("Recovery emits reconcile and durable notifications only, never dispatch") |
| effects | 0 | 0 |
| alarms | 0 | 0 |

The restart advanced the same durable document instead of bootstrapping a second root, and the read-only canary accumulated evidence across both runs without dispatching work.

## What this proves

- The feature plugin loads in a real Gateway and registers the opt-in runtime service.
- The retained VSM document survives a process restart and is read back rather than replaced.
- Root bootstrap is idempotent; a second start does not duplicate the root or canary unit.
- The canary purpose observes without native dispatch, and recovery records its intent durably.

## What this does not prove

- Any native dispatch path: no non-kernel procedure was admitted, so effects stayed empty by design.
- Production cutover, UI rendering, alarm delivery to the principal, or multi-day operation.
- Model-assisted decisions: the canary is deterministic host-health sampling.

Cleanup: the disposable Gateway was stopped after the run. The isolated state directory remains as local evidence and is not part of the production state.
