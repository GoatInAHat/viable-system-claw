import { dispatchRequest, executionEvents, reconcileRequest,
  type ExecutionResult, type NativeExecutor } from './executor.js';
import { step } from './runtime.js';
import { changeDocument, readDocument, VSM_DOCUMENT_KEY, VSM_MAX_ATTEMPTS,
  type DocumentStore, type VsmDocument } from './state.js';
import type { EffectIntent } from '../execution/types.js';
import type { ValidationError, VsmAction, VsmEvent, VsmState } from './types.js';

export interface VsmServiceOptions {
  store: DocumentStore;
  executor: NativeExecutor;
  /** Monotonic host processing time in milliseconds. */
  clock?: () => number;
  /**
   * Commits the private launch intent before dispatch. Undefined means no launch can be
   * formed; a thrown storage fault means admission is unknown, never absent.
   */
  markIntent?: (request: ReturnType<typeof dispatchRequest>, state: VsmState) => Promise<EffectIntent | undefined>;
  /** Direct root S5 alarm path; never routed through channel filters. */
  alarmSink?: (action: Extract<VsmAction, { type: 'alarm' }>, state: VsmState) => void;
  auditSink?: (action: Extract<VsmAction, { type: 'audit' }>, state: VsmState) => void;
  improvementSink?: (action: Extract<VsmAction, { type: 'improve-alarm-class' }>, state: VsmState) => void;
  log?: { warn(message: string): void };
}

export class VsmEventError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super(errors.map(error => error.code).join(','));
    this.name = 'VsmEventError';
  }
}

/**
 * Durable VSM runtime. State is committed before any action is performed, so a crash
 * between commit and dispatch leaves an admitted effect that restart reconciliation
 * resolves instead of silently forgetting.
 */
export class VsmService {
  private document: VsmDocument | null = null;
  private started = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingActions = 0;

  constructor(private readonly options: VsmServiceOptions) {}

  get state(): VsmState {
    if (!this.document) throw new Error('VSC_VSM_NOT_STARTED');
    return this.document.state;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const observed = await this.options.store.observe(VSM_DOCUMENT_KEY);
    const document = readDocument(observed.value);
    if (!document) throw new Error('VSC_VSM_NOT_BOOTSTRAPPED');
    this.document = document;
    this.started = true;
    // Recovery is a durable event: it records reconciliation intent and alarms, never dispatch.
    await this.serialize(() => this.applyInternal({ id: `restart/${this.now()}`, type: 'restart' }));
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.tail;
  }

  /** Serialized event application. Rejects on validation failure without changing state. */
  apply(event: VsmEvent): Promise<void> {
    if (!this.started) return Promise.reject(new Error('VSC_VSM_NOT_STARTED'));
    return this.serialize(() => this.applyInternal(event));
  }

  /** Read-only snapshot of the durable document, safe for projections. */
  async snapshot(): Promise<VsmState> {
    const observed = await this.options.store.observe(VSM_DOCUMENT_KEY);
    const document = readDocument(observed.value);
    if (!document) throw new Error('VSC_VSM_NOT_BOOTSTRAPPED');
    return document.state;
  }

  private now(): number {
    const raw = this.options.clock?.() ?? Date.now();
    const floor = this.document?.state.updatedAt ?? 0;
    return Math.max(raw, floor);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyInternal(event: VsmEvent): Promise<void> {
    if (!this.document) throw new Error('VSC_VSM_NOT_STARTED');
    const now = this.now();
    for (let attempt = 0; attempt < VSM_MAX_ATTEMPTS; attempt++) {
      const base = this.document;
      const result = step(base.state, event, now);
      if (result.errors.length) throw new VsmEventError(result.errors);
      if (result.state === base.state) {
        // Duplicate source event: the durable state already reflects it.
        await this.perform(result.actions);
        return;
      }
      const written = await changeDocument(this.options.store, next => {
        if (next.revision !== base.revision) return false;
        replaceState(next, result.state);
        return true;
      });
      if (!written.changed) {
        // An explicit conflict means another writer committed. Reload and re-evaluate
        // the same stable event against the new durable state.
        this.document = written.document;
        continue;
      }
      this.document = written.document;
      await this.perform(result.actions);
      return;
    }
    throw new Error('VSC_VSM_CONCURRENT_EVENT');
  }

  private async perform(actions: VsmAction[]): Promise<void> {
    for (const action of actions) {
      if (action.type === 'dispatch') await this.dispatch(action.effectId);
      else if (action.type === 'reconcile') await this.reconcile(action.effectId);
      else if (action.type === 'alarm') this.options.alarmSink?.(action, this.state);
      else if (action.type === 'audit') this.options.auditSink?.(action, this.state);
      else if (action.type === 'improve-alarm-class') this.options.improvementSink?.(action, this.state);
    }
  }

  private async dispatch(effectId: string): Promise<void> {
    if (!this.document) throw new Error('VSC_VSM_NOT_STARTED');
    // Intent and reservation are already durable before this call.
    const request = dispatchRequest(this.document.state, effectId, this.now());
    if (this.options.markIntent) {
      let intent: EffectIntent | undefined;
      try {
        intent = await this.options.markIntent(request, this.document.state);
      } catch {
        await this.applyExecution(effectId, { status: 'unknown' }, `intent/${request.effectId}`);
        return;
      }
      if (!intent) {
        await this.applyExecution(effectId, { status: 'not-launched' }, `intent/${request.effectId}`);
        return;
      }
    }
    let result: ExecutionResult;
    try {
      result = await this.options.executor.dispatch(request);
    } catch {
      // An exception is an ambiguous launch, never proof of no launch.
      result = { status: 'unknown' };
    }
    await this.applyExecution(effectId, result, `dispatch/${request.effectId}`);
  }

  private async reconcile(effectId: string): Promise<void> {
    if (!this.document) throw new Error('VSC_VSM_NOT_STARTED');
    const request = reconcileRequest(this.document.state, effectId);
    let result: ExecutionResult;
    try {
      result = await this.options.executor.reconcile(request);
    } catch {
      result = { status: 'unknown' };
    }
    await this.applyExecution(effectId, result, `reconcile/${request.effectId}`);
  }

  private async applyExecution(effectId: string, result: ExecutionResult, sourcePrefix: string): Promise<void> {
    if (!this.document) throw new Error('VSC_VSM_NOT_STARTED');
    const attempt = this.document.state.effects[effectId]?.dispatchAttempts ?? 0;
    const sourceId = `${sourcePrefix}/${attempt}/${this.now()}`;
    for (const event of executionEvents(effectId, result, sourceId)) {
      await this.applyInternal(event);
    }
  }
}

/** Whole-document replacement keeps the caller's computed revision intact. */
function replaceState(target: VsmState, source: VsmState): void {
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, structuredClone(source));
}
