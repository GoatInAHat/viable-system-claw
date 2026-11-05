# Host capabilities the plugin cannot supply alone

Status: recorded 2026-11-04 from the actuator, crash-recovery and delivery work. These are boundaries of the installed host, verified against OpenClaw 2026.10.10-beta.5 dist. They are not preferences and not reasons to weaken a guarantee silently.

## 1. Durable launch identity for plugin subagents

`SubagentRunParams.idempotencyKey` is accepted, but the gateway resolves it through an in-memory dedupe map (`agent:<idempotencyKey>`, `setGatewayDedupeEntry`, pruned by `pruneAgentRunCache`). It does not survive a gateway restart. Consequence: after a crash between `subagent.run` returning and the receipt being committed, the plugin has a durable intent marker and a deterministic session key but no durable run identity. Replaying the launch cannot be proven safe, so the effect stays `ambiguous` and escalates through a durable alarm. A durable plugin-subagent launch ledger (or a run lookup by idempotency key/session key) is required to resolve that window inside the plugin.

## 2. Exact tool-surface restriction

The plugin subagent runtime exposes two exact surfaces: none (`disableTools: true`) and the worker normal surface plus named plugin tools (`toolsAlsoAllow`). The two cannot be combined (`Tool-free plugin subagent runs cannot request additive tools`). There is no exact subset of the normal surface. Consequence: VSC refuses any grant that claims tools or surfaces (`capability-unsupported`) rather than advertising an authority it cannot enforce. A purpose that needs host tools requires an exact allowlist surface in the host.

## 3. Cancellation and draining of accepted runs

The kernel keeps an accepted external run alive after revocation and refuses new admissions; that is deliberate. If a principal wants revocation to stop work already in flight, the host must expose cancellation/drain and the adapter must report it as a distinct outcome rather than as absence.

## 4. Principal alarm delivery and acknowledgment

The plugin can raise a durable alarm and emit a native feature event once. It cannot reach the principal outside the Gateway process, and no acknowledgment operation exists yet on the public contract. Delivery with durable acknowledgment needs either a host notification route owned by the principal or a new authenticated `vsm.alarm.ack` operation backed by the kernel principal role.

## 5. Asynchronous authority assertion at host admission

OpenClaw forwards a plugin-supplied `assertCurrent` callback into the subagent admission path, but the callback signature is synchronous (`() => void`). A synchronous callback can only validate the last committed state the plugin holds. If a revocation commits to durable storage after the adapter final read and before the host calls the callback, the callback approves stale authority. Review 3 reproduced exactly that ordering.

Closing it needs one of: an awaitable assertion at the host admission boundary, a host-side revocation fence that reads durable authority itself, or serialization of revocation and launch through one durable lock. The plugin cannot close the window from inside a synchronous callback. The durable-state re-check after the intent read does close the earlier timing (revocation during the intent read).
