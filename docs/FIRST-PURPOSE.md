# First operational purpose (canary)

Status: **design only, not active**. This is the first falsifiable continuous obligation for Viable System Claw. It does not replace the existing Substrate owner.

## Purpose

**Keep the OpenClaw gateway hosting VSC healthy enough to serve Bennett, without modifying services without explicit authority.**

This is a read-only canary because it is objective, reversible, continuously observable, and has an existing owner. It exercises the event → evidence → three brakes → action → outcome loop without risking Bennett's school, mail, calendar or projects.

## Authority boundary

- Read host health signals only.
- Never restart, stop, reconfigure or repair a service.
- A diagnostic subagent may read logs and propose a fix; it may not execute a fix without an explicit grant and human authorization where required.
- The existing Substrate owner remains the service owner until a verified handoff.
- The root charter and this purpose's grant can be paused by Bennett at any time.

## Essential variables and sources

| Variable | Source | Acceptable bound |
| --- | --- | --- |
| Gateway readiness | local `/readyz` and `/startupz` | HTTP 200 / ready |
| Available memory | `/proc/meminfo` | `MemAvailable` >= 1 GiB |
| Memory pressure | `/proc/pressure/memory` | full avg60 < 50% |
| Swap headroom | `/proc/meminfo` | `SwapFree` >= 1 GiB |
| Root disk | filesystem stat | free >= 10 GiB |
| VSC durable state | retained store read | valid and readable |
| VSC service | runtime lifecycle | started |

The thresholds are conservative canary limits, not the production floors. Production floors remain in the existing compute/substrate contracts until a verified handoff.

## Homeostat

- **Fast loop (code):** sample every 30 seconds. No model call on a healthy sample.
- **Accumulator:** threshold crossing must persist for 2 consecutive samples or exceed the hard bound immediately.
- **Gain:** ambient pressure and recent alarm history may raise or lower the threshold within bounded limits; record the applied gain.
- **Three brakes:**
  1. Evidence: the bound is crossed with required persistence.
  2. Environment answered: no diagnostic action is still awaiting an environmental return.
  3. Grant admits: the purpose's read-only grant is active and not paused.
- **Action:** record a root S5 alarm with the variable, observed value, bound, source and timestamp. Wake one bounded diagnostic subagent only when the alarm is not already explained by an open diagnostic. No repair.
- **Alarm path:** direct to root S5 and the native conversation/UI. It bypasses ordinary work queues. Acknowledgment is recorded; repeated alarm classes become S4 candidates.
- **Quiescence:** when healthy and no alarm is open, the loop does not call a model.

## Evaluation

- False-alarm rate against the existing Substrate/reconcile evidence.
- Detection latency for injected safe disturbances in a disposable Gateway.
- Recovery/return latency after a disturbance clears.
- Model calls and compute spent per hour while healthy.
- Diagnostic proposals independently checked; no repair action counted as successful without readback.

## Rollback

Pause the purpose grant, stop the canary service, retain evidence, and leave the existing Substrate owner untouched. No host service change is part of this canary.

## What this does not prove

It does not prove the full VSM, autonomous repair, all-system cutover, multi-day operation or superiority. It proves the first closed feedback loop can observe, accumulate evidence, apply the three brakes, alarm without a model call, wake a bounded diagnostic, and reconcile the result.
