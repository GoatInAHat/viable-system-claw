# Native OpenClaw package

Authored feature plugin using the public SDK, pinned to `2026.10.10-beta.5`. The Tool Factory bootstrap was explicitly ejected before implementation; `src/contract.ts` is the operation authority.

## Build and validate

From the repository root:

```sh
npm ci
npm --prefix hosts/openclaw ci
npm run check
npm test
npm run build:ui
npm run validate
```

The package owns two Control UI pages, **Organization** and **Compute**, plus a retained-state background service. It reuses native navigation, feature watches, session actions and conversation opening. It does not create another web server or credentials store.

## Installation

After building, use a disposable OpenClaw instance for host-backed qualification first:

```sh
openclaw plugins install --link ./hosts/openclaw --force --accept-capabilities
openclaw plugins inspect viable-system-claw --runtime --json
```

These commands change the target instance. Installation and Gateway activation have **not** been performed or verified on the development owner's live instance. The source package uses the SDK only as a development/peer dependency. A linked development checkout must retain its built assets.

Start in Organization with **Add system**. Add children or relations through the contextual inspector, and explicitly bind sessions that already exist. A binding does not give VSC ownership of that conversation or launch a worker. Compute stays empty until an authorized observer publishes real measurements.

## Operations

| Operation | Meaning |
| --- | --- |
| `graph.snapshot` | Configured containment, relations, active run identities and retained metadata activity |
| `unit.upsert` | Create/edit a purpose; reject cycles and missing parents |
| `relation.upsert` | Create/edit a relation between configured units |
| `unit.bind-session` | Verify an existing native session incarnation, bind or detach it |
| `compute.snapshot` | Last explicit pool/model/allocation observations |
| `compute.observe` | Validate and replace those observations; no dispatch or admission enforcement |
| `compute.plan` | Evaluate a scenario against current observations and server time; return a proposal or reasons |

Queries require native `operator.read`; actions require `operator.write`. The corresponding `vsc_*` agent tools are optional and must be enabled intentionally through normal tool policy. Restricted-agent operator access is all-or-none for this shared organization: if any bound unit belongs to a forbidden agent, reads and edits are refused. It is not a multi-tenant or per-unit ACL system.

`compute.plan` accepts `diagnosticOffset`; `diagnostics.nextOffset` identifies the next page, or null at the end. Every page recomputes the complete decision. Combine pages only when `snapshotRevision`, request, policy and evidence match, and retry on changing observations. Diagnostics pagination never excludes models from evaluation. Caller-supplied evidence/authorization is scenario data, not permission to dispatch or spend.

## Observation boundaries

Only explicitly bound sessions contribute activity. Adapters whitelist run/session/tool identifiers, timestamps, phases and accepted handoff receipts. They never retain tool arguments/results, message bodies or raw errors. An accepted handoff does not prove delivery. Native metadata payloads may contain primitive text, so payload mode alone is not treated as a privacy filter.

Coverage is **partial**: no historical replay, implicit session discovery or complete harness coverage is promised. Missing incarnation metadata is accepted only after a trusted current-process run association exists. Native tools that expose no reliable correlation are omitted. Session resets require explicit rebinding. Restarted running state becomes unknown; only newly established active run identities can animate. UI starts without fresh matching ends expire to unknown; these display freshness rules are not execution timeouts.

## State and boundaries

The native retained V2 store holds one atomic bounded document. CAS retries reevaluate tree, authorization and binding predicates; corrupt data is not silently replaced. Graph and compute projections are checked against the pinned SDK's full JSON limits **before** commit, including restart degradation. Rejected edits leave previous state readable; shorten existing detail to recover room. Counts and transport budgets are serialization bounds, not model/compute quotas.

This increment does not implement distributed dispatch, autonomous regulation, model/provider discovery, quota readers, automatic improvement adoption or an immutable execution kernel. Pure compute reservation helpers require a future durable owner and trusted accounting adapter before they can govern real work.
