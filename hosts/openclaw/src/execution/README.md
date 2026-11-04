# Native execution adapter

This directory is an **unwired** execution boundary. It does not register services,
open stores, schedule work, perform authorization, deliver replies, or run anything
on import. The VSM/durable owner must integrate it; all tests use synthetic fakes.
Runtime types come only from the public `openclaw/plugin-sdk/core` export.

## API

- `types.ts`: `EffectIntent`, `EffectReceipt`, `EffectOutcome`, `EffectExecutor`,
  `NativeSubagentRuntime`, `NativeWaitResult`, `NativeReply`, `PrivateResultSink`,
  `ReconcileOptions`, `ResultReference`, `ReplyMetadata`, `Json`,
  `EXECUTION_LIMITS`, and `projectEffectIntent(intent)`.
- `native.ts`: `NativeEffectExecutor(api, options)`,
  `NativeExecutorOptions`, `effectSessionKey(effectId, agentId)`, and
  `validReference(value, limit?)`.
- `reconcile.ts`: `EffectReconciler(subagentRuntime, options?)` with
  `reconcile(receipt, previousOutcome?)`, and pure
  `classifyWait(acceptedReceipt, nativeWaitResult)`.
- `recovery.ts`: pure `planRecovery(record)`, `RecoveryRecord`, and `RecoveryPlan`.

`NativeEffectExecutor` implements:

```ts
interface EffectExecutor {
  dispatch(intent: EffectIntent, previous?: EffectReceipt): Promise<EffectReceipt>;
  reconcile(receipt: EffectReceipt, previous?: EffectOutcome): Promise<EffectOutcome>;
}
```

Construct with `{ runtime: { subagent: api.runtime.subagent } }` (the full public
plugin API is structurally compatible) and options:

```ts
const executor = new NativeEffectExecutor(api, {
  agentExists: id => currentConfiguredAgentIds.has(id),
  assertCurrent: intent => assertGrantStillCurrent(intent.grantRef), // recommended
  timeoutMs: 30_000, // optional: observation wait only
  // privateResultSink: { write: async payload => privateStore.upsert(payload.ref, payload) },
});
```

The two callbacks above are provided by the owner, not implemented here. A required
`agentExists` check distinguishes malformed, unconfigured, and available agents.
The optional `assertCurrent` is checked before launch and forwarded as the public
SDK's `assertCurrent` callback for revalidation at host admission. The intent copy
seen by that callback is immutable. Neither `agentExists` nor `grantRef` grants
permission; host operator/agent/tool policies still apply.

Dispatch calls **only**:

```ts
api.runtime.subagent.run({
  sessionKey,
  message: intent.message,
  deliver: false,
  promptMode: 'minimal',
  // assertCurrent, when supplied by the parent
});
```

There is no provider/model override, tool expansion, session deletion, cancellation,
or explicit delivery. The configured agent's existing runtime/model routing owns
execution. `minimal` is a prompt selection, **not** a tool or authority sandbox.
There is no `agentId` parameter on public `run`; the destination agent is encoded
in `agent:<agentId>:subagent:viable-system-claw-effect-<sha256(effectId)>`.
This key is deterministic and plugin-namespaced, not an exactly-once native launch
guarantee. Receipt keys prefer the canonical key returned by the host. An explicit
custom runtime that omits that field uses the requested key.

## Records and privacy

All records are JSON data; no functions, errors, credentials, raw tool arguments,
or runtime handles are persisted by this adapter. It opens no store.

- `EffectIntent`: stable `id`, `unitId`, `procedureId`, configured `agentId`,
  `message`, `purpose`, opaque `grantRef`, millisecond `createdAt`, optional
  millisecond `deadline`. This is a **private retained** record: never project it
  wholesale. The caller must not put credentials in it. `projectEffectIntent`
  returns only validated identity/time fields, dropping message, purpose and
  authority reference. Identities themselves must be nonsecret opaque labels.
- Accepted receipt: `effectId`, `status: 'accepted'`, `runId`, canonical
  `sessionKey`, and `at` (admission response time). It means admission, **not**
  execution success, delivery, task correctness or an environment return.
- Rejected receipt: `effectId`, `status: 'rejected'`, `runId: null`, nullable
  requested `sessionKey`, `at` (attempt observation time), fixed `reason`, and
  **required** `admission: 'not-accepted' | 'unknown'`.
  `not-accepted` means local validation/pre-admission authority failed.
  `unknown` means native admission was invoked and may have succeeded before its
  reply was lost. **Never treat `status: 'rejected'` alone as retry permission.**
  Invalid effect IDs throw a fixed programmer error instead of echoing invalid,
  unbounded/private identities into a receipt.
- Outcome: `effectId`, nullable `runId`, `status`, `terminal`, host `endedAt` or
  `null`, `stopReason` and `livenessState` tokens or `null`, optional `nativeStatus`,
  fixed observation `reason`, `terminalReply` **metadata**, and `resultRef`.
  `endedAt` is never synthesized from wall time. Known host tokens are retained;
  unknown free-form stop/liveness strings become `other` to avoid leaking text.
  Raw wait errors and exception bodies are never retained.
- `terminalReply` intentionally differs from the native snapshot: only
  disposition (`visible`/`silent`/`empty`), visible text character count, and the
  known empty-reply code are projected. There is no text or model-route detail.
- `resultRef` points to the accepted native session/run; it contains bounded
  message count, history availability/page uncertainty, and private-write status.
  It is a reference to an observation, not an archival guarantee or proof that a
  particular message is the terminal answer. No message bodies are returned.

An explicitly supplied `PrivateResultSink.write(payload)` alone receives a bounded
JSON copy of history and native terminal reply text. The adapter chooses a stable
`vsc-private-result:<sha256(effectId + NUL + runId)>` key; the sink must upsert
idempotently into private storage, enforce access/retention and never publish the
payload. Sink exceptions become metadata `privateResult: 'unavailable'`, never raw
errors; the execution outcome remains terminal. No automatic sink retry occurs.
If both history and native terminal reply are unavailable, no write is attempted.
Visible reply text is truncated for this optional private export only, not in the
agent's native session. Cyclic/non-JSON/oversized messages are omitted, not stored
as partial JSON; omission/truncation is reported.

## Observation transitions

| Native observation | Adapter outcome | Next step |
| --- | --- | --- |
| Valid local intent; native admission responds | accepted receipt only | Persist receipt, reconcile |
| Missing agent, invalid/overlong message, expired deadline, rejected local authority | rejected / not-accepted | Settle rejection; changed work needs a new effect ID |
| Admission throws, or returns an invalid identity | rejected / unknown | Explicit ambiguity policy; never blind retry |
| `pending` | unknown, nonterminal | Re-observe the same run |
| Bare wait `timeout`, including `gateway_draining` phase | unknown, nonterminal | Re-observe; **not cancellation** |
| Wait transport exception / `retryableTransportError` | unknown, nonterminal | Re-observe; **not failure** |
| `yielded` / `pendingError` | unknown, nonterminal | Await native settlement |
| `ok` | ok, terminal | Read bounded history, persist outcome |
| `error` | error, terminal | Same; error bodies stay private to the host |
| `timeout` with valid host `endedAt`, or explicit `hard_timeout`/`timed_out` stop reason | timeout, terminal | Settle actual execution timeout |
| Terminal `error` with host `endedAt` and killed/aborted/cancelled/restart/superseded metadata | killed, terminal | Settle; never relaunch |
| Bare abort without host end time, or contradictory `ok` + killed signal | unknown, nonterminal | Explicitly incomplete terminal evidence |

A terminal timeout stays timeout even if cleanup reports provider abort. The
public wait union has **no** `killed` status: killed is derived only from explicit
terminal error/cancellation metadata and `nativeStatus: 'error'` remains visible.
History lookup failure does not undo a native terminal execution; result availability
is a separate concern. A run's `ok` is not independent validation of useful work.

## Durable-owner integration and restart

1. Persist a private, immutable intent with a globally unique stable effect ID and
   `launchState: 'unattempted'`. Validate grants, parent lifetimes, workload policy,
   budgets and environment preconditions in the owning runtime.
2. In a serialized durable transaction/CAS, change the state to `launching` **before**
   entering `dispatch`. Only the winner may call dispatch. Do not insert an await
   or another dispatcher between the claim and the call without preserving custody.
3. Persist the returned receipt immediately, including unknown admission. If the
   process dies between the launch marker and receipt persistence, retain ambiguity.
   A crash just after the marker but before launch cannot be distinguished from a
   launch whose reply was lost. A never-attempted intent, before its marker, can
   still be dispatched once.
4. Reconcile only an accepted receipt, or obtain the fixed outcome for a rejected
   receipt. Persist every observation and the first terminal outcome. Serialize
   terminal persistence and semantic/environment-return application in the parent.
5. On restart, pass stored receipts/outcomes into a fresh executor (or reconciler).
   Reconstruct `RecoveryRecord` and call `planRecovery`:

| Journal evidence | Pure plan |
| --- | --- |
| unattempted + no receipt/outcome/reply ambiguity | `dispatch-once` |
| launching/ambiguous + no receipt | `require-policy: launch-ambiguous` |
| rejected receipt with unknown admission | `require-policy: admission-unknown` |
| accepted receipt + no confirmed terminal outcome | `reconcile` (same run ID) |
| confirmed terminal outcome with its receipt | `settle` |
| definitive rejected receipt | `settle: dispatch-rejected` |
| lost/ambiguous reply without a known run | `require-policy: reply-ambiguous` |
| outcome without its receipt | `require-policy: orphan-outcome` |

Known execution can reconcile/settle despite lost result delivery, but the plan sets
`requiresResultPolicy: true` when the parent supplies `replyState: 'lost'` or
`'ambiguous'`. Execution settlement never silently resolves result/delivery loss.
The parent must infer/set that flag from its actual result/return requirements,
including missing history, unavailable private sink or partial result pages.
This planner does not decide whether a reply is required or manufacture one.
It never grants a retry; replacement/recovery actions need explicit owning policy
and a new identity when they are new work.

Repeated dispatch calls in one executor coalesce by effect ID, including rejection
and ambiguous results. Passing a persisted receipt prevents launch on a fresh
executor; observing a receipt also remembers it for later dispatch calls.
Repeated reconciliation coalesces in-flight observations and returns the same
immutable terminal outcome without re-waiting, rereading history or rewriting
private results. Supplying the stored terminal outcome restores that behavior after
restart. Nonterminal observations deliberately remain observable again. Caches
are in-memory and live for the executor's lifetime; the parent owns lifecycle,
retention, cross-process serialization and durable deduplication.

## Bounds and SDK constraints

`EXECUTION_LIMITS` documents per-record/observation bounds, not host context,
concurrency, model or work-budget restrictions:

- Opaque references: 128 characters. Normalized agent IDs: 64, lower-case
  alphanumeric/underscore/hyphen, beginning alphanumeric.
- Message: 32,768 UTF-16 code units; purpose: 512; messages are validated, never
  truncated before launch. IDs use safe reference tokens, not arbitrary text.
- Native run ID: 256; native session key: 512; timestamps: nonnegative safe integers.
- One history page: 10 messages. Page fullness is conservatively marked potentially
  truncated; there is no SDK cursor/whole-transcript guarantee.
- Optional private export: at most 65,536 UTF-8 bytes of JSON message array and
  16,384 UTF-16 code units of native reply text (plus bounded identity metadata).
- Wait observation budget: integer 1–30,000 milliseconds, default 30,000. This is
  only `waitForRun({ runId, timeoutMs })`, never an execution timeout/cancel timer.

The public run API returns `{ runId, sessionKey? }` and throws on failure. It has no
published typed definitive-rejection discriminator, so **all** run exceptions are
conservatively ambiguous. No private error-shape parsing is used. A deterministic
session key is not native deduplication; this adapter does not rely on undocumented
`idempotencyKey` replay semantics. The public SDK also has no bounded-history
pagination/result correlation or get-messages timeout argument. Only native
terminal facts prove execution settlement; a history row cannot prove admission,
completion or lack of a run. No cancellation or private Gateway RPC is used to
resolve ambiguity. Recovery grants cannot be resurrected from persisted history.

`deadline` rejects already-expired dispatch; it does not cancel a run, override the
agent budget, or schedule anything. The parent owns future deadlines and wakes.
Accepted work always retains its observation/cleanup responsibilities even when a
grant is revoked. Any environment return, valuation, authorization or delivery
commitment must be implemented by the parent, not inferred from these receipts.

## Validation

From the repository root, using existing dependencies only:

```sh
node_modules/.bin/vitest run --config hosts/openclaw/vitest.config.ts src/execution/execution.test.ts --maxWorkers 1
node_modules/.bin/tsc -p hosts/openclaw/tsconfig.check.json --pretty false
```

Tests cover local rejection boundaries, deterministic routing, admission ambiguity,
crashes before/in the launch window, restart while running, every wait classification,
wait-only timeout, duplicate completion/terminal rehydration, privacy/private-sink
bounds and failure, immutable receipts/outcomes, and all restart-planner branches.
No live agent work, install, build output, reload or service change is required.
