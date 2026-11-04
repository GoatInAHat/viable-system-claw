# Runtime integration boundary

Status: **kernel, durable state, service and native adapter implemented; not wired or cut over.** Synthetic tests cover restart, CAS conflict, duplicate events, ambiguous launches and the alarm bypass. The canary purpose is read-only. Gateway registration, the disposable-Gateway qualification and any live purpose remain open.

## Durable state

- Keep the existing `organization-v1` document for graph/compute observation. Keep `vsm-v1` as a separate retained document for the VSM kernel.
- Each document has its own schema, CAS and revision. Do not pretend the two stores are one transaction; record cross-store intent and reconcile.
- `vsm-v1` holds the root charter, units/organs/environments, homeostat channels, grants, purposes, effects, alarms, audit findings, episodic references, semantic facts and decisions.
- Store canonical episode/effect **references**, not private transcript bodies, in any public projection.
- Preflight every public projection against the native JSON envelope before CAS. A rejected mutation leaves the previous state readable.
- For large state, expose paged/subtree projections; never let the UI projection size cause domain observations to be dropped.

## Operations

| Operation | Authority | Purpose |
| --- | --- | --- |
| `vsm.snapshot` | `operator.read` | Bounded summary plus explicitly paged sections (units, channels, effects, alarms) |
| `vsm.bootstrap` | principal only | Create the single root, charter and kernel refs |
| `vsm.unit.add` | parent S3 or principal | Add a viable unit under the root with standard organs |
| `vsm.channel.configure` | owning function or principal | Set threshold/gain/cost/filter/procedure on a legal homeostat channel |
| `vsm.grant` | parent S3 or principal | Issue a versioned, revocable grant; never self-issued |
| `vsm.grant.revoke` | issuer or principal | Revoke by version; accepted effects may finish but no new effect admits |
| `vsm.observe` | authenticated source adapter | Feed a typed observation with source/evidence reference |
| `vsm.purpose.feedback` | parent valuation owner or principal | Supply imputed exit values and evidence |
| `vsm.alarm.ack` | principal or root S5 | Acknowledge an alarm; never erase it |
| `vsm.effect.reconcile` | runtime owner | Reconcile a pending/accepted effect after restart or ambiguity |
| `vsm.pause` | principal | Pause a purpose/channel admission without deleting state |

All mutating operations validate the actor/function capability at the storage boundary. No bound native session gets write authority over its own grant or charter.

## Runtime service

1. Start: load both stores; validate schemas; recover effect intents/receipts; rebuild fast-loop registrations; never claim retained active state is live.
2. Fast code loop: sample the first purpose's host-health variables every 30 seconds; update the homeostat accumulator; no model call when healthy.
3. Three brakes: evidence persistence, no outstanding environment return, active grant. Only then create an effect intent and reserve capacity.
4. Dispatch: call the native executor with a stable effect ID; persist accepted receipt. A rejected/ambiguous dispatch is recorded, never blindly retried.
5. Reconcile: wait/read by run identity; accepted but unknown stays ambiguous; terminal ok/error is an outcome, not proof of world success where external readback is needed.
6. Alarm: root S5 alarm record plus native UI event; direct bypass path. Repeated classes become improvement candidates.
7. Audit: missing/conflicting returns produce findings with evidence; no automatic blame without attribution evidence.
8. Shutdown: stop loops, drain accepted work, preserve pending intents/receipts. Restart reconstructs deadlines from durable state, not from service timers.

## First purpose

See `docs/FIRST-PURPOSE.md`: read-only host health canary. It is deliberately not a repairer. It proves the loop before any operational cutover.

## UI

- Keep Organization and Compute as evidence views.
- Add a compact Runtime view or graph panel showing: root charter, active purposes, open alarms, pending effects, last decisions, and grant/effect/outcome lineage.
- Principal actions (pause, acknowledge, grant/revoke, charter ratification) go through the same backend operations. No decorative dashboard.
- The UI is a projection. Closing it never stops the service.

## Tests before live activation

- Unit: kernel invariants, three brakes, lateral-before-vertical, purpose convergence, audit residual, alarm bypass, effect idempotence, grant revocation.
- Integration: fake executor crash/lost reply/duplicate completion/restart; VSM store CAS corruption/recovery; transport paging.
- Disposable Gateway: native plugin load, custom UI lab, permission filtering, real event delivery, real retained store restart.
- Canary: injected safe host-health disturbance, detection, alarm, diagnostic wake, independent readback, recovery and rollback.
