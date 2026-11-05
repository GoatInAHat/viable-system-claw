import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { NativeEffectExecutor } from './execution/native.js';
import { addProcedure, addUnit, configureChannel, createState } from './vsm/kernel.js';
import { createNativeExecutor } from './vsm/native-adapter.js';
import { VsmService } from './vsm/service.js';
import { step } from './vsm/runtime.js';
import { bootstrapDocument, changeDocument, readDocument, VSM_DOCUMENT_KEY, type DocumentStore } from './vsm/state.js';
import { readIntent, writeIntent } from './vsm/intent-store.js';
import { effectSessionKey } from './execution/native.js';
import { CANARY_THRESHOLDS, canaryObservations, sampleCanary, type CanarySample } from './vsm/canary.js';
import type { NativeExecutor } from './vsm/executor.js';
import type { AuthorityFence, PrivateResultSink } from './execution/types.js';
import type { VsmAction, VsmState } from './vsm/types.js';

export interface VsmRuntimeConfig {
  principalId: string;
  charter: string;
  /** When set, the canary gains one natively dispatched probe procedure. */
  agentId?: string;
}

/**
 * Disabled by default: absent or non-true `runtime.enabled` adds no behavior.
 * The feature SDK does not forward a plugin config schema yet, so the same
 * runtime block can also arrive through operator environment variables.
 */
export function readRuntimeConfig(
  pluginConfig: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): VsmRuntimeConfig | undefined {
  const runtime = pluginConfig?.runtime ?? {
    enabled: env.VSC_RUNTIME_ENABLED === '1',
    principalId: env.VSC_RUNTIME_PRINCIPAL_ID,
    charter: env.VSC_RUNTIME_CHARTER,
    agentId: env.VSC_RUNTIME_AGENT_ID,
  };
  if (runtime === undefined) return undefined;
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) throw new Error('VSC_RUNTIME_CONFIG');
  const record = runtime as Record<string, unknown>;
  if (record.enabled !== true) return undefined;
  const principalId = record.principalId;
  const charter = record.charter;
  if (typeof principalId !== 'string' || principalId.trim().length === 0) throw new Error('VSC_RUNTIME_CONFIG');
  if (typeof charter !== 'string' || charter.trim().length === 0) throw new Error('VSC_RUNTIME_CONFIG');
  const agentId = record.agentId;
  if (agentId !== undefined && (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(agentId))) {
    throw new Error('VSC_RUNTIME_CONFIG');
  }
  return { principalId, charter, ...(agentId === undefined ? {} : { agentId }) };
}

export const CANARY_CHANNEL = 'canary/environment/return';
export const DISPATCH_CHANNEL = 'canary/local/forward';
export const PROBE_PROCEDURE = 'canary/probe';
export const CANARY_INTERVAL_MS = 30_000;
/** Three consecutive faulted samples raise one algedonic alarm for the unit. */
export const CANARY_FAULT_STREAK = 3;

export interface VsmRuntimeOptions {
  config: VsmRuntimeConfig;
  store: DocumentStore;
  executor: NativeExecutor;
  /** Optional shared fence; buildRuntime binds the synchronous authority check. */
  fence?: AuthorityFence;
  /** Host-boundary assertion supplied by nativeExecutorFor; re-reads the committed state. */
  assertCurrent?: () => void;
  privateStore?: DocumentStore;
  clock?: () => number;
  sampler?: (now: number) => Promise<CanarySample>;
  onAlarm?: (action: Extract<VsmAction, { type: 'alarm' }>, state: VsmState) => void;
  /** Durable audit notification; bounded metadata only, never private bodies. */
  onAudit?: (action: Extract<VsmAction, { type: 'audit' }>, state: VsmState) => void;
  /** Retries private result payloads that a terminal execution failed to store. */
  retainPending?: () => Promise<void>;
  /** Improvement candidate signal; carries the class, never an authorization. */
  onImprovement?: (action: Extract<VsmAction, { type: 'improve-alarm-class' }>, state: VsmState) => void;
  /** Operator-surface notification; carries revision only, never private data. */
  onChange?: (revision: number, updatedAt: number) => void;
  log?: (detail: string) => void;
  intervalMs?: number;
  channelId?: string;
  readyzUrl?: string;
}

export interface VsmRuntime {
  service: VsmService;
  channelId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sampleOnce(): Promise<void>;
  reconcileOnce(): Promise<void>;
}

export function buildRuntime(options: VsmRuntimeOptions): VsmRuntime {
  const clock = options.clock ?? Date.now;
  const sampler = options.sampler ?? ((now: number) => sampleCanary({
    now, readyzUrl: options.readyzUrl ?? process.env.VSC_RUNTIME_READYZ_URL ?? 'http://127.0.0.1:18789/readyz',
    filesystemPath: process.cwd(),
  }));
  const channelId = options.channelId ?? (options.config.agentId ? DISPATCH_CHANNEL : CANARY_CHANNEL);
  const service = new VsmService({
    store: options.store,
    executor: options.executor,
    clock,
    alarmSink: options.onAlarm,
    auditSink: options.onAudit,
    improvementSink: options.onImprovement,
    log: { warn: () => undefined },
    ...(options.privateStore && options.config.agentId ? {
      markIntent: async (request, state) => {
        const procedure = state.procedures[request.procedureId];
        const intent = {
          id: request.effectId,
          unitId: request.unitId,
          procedureId: request.procedureId,
          agentId: options.config.agentId!,
          message: `Observe host health for ${request.effectId}. Reply with one short status line and no file changes.`,
          purpose: procedure?.executionRef ?? 'canary probe',
          grantRef: `${request.grant.id}:${request.grant.version}`,
          capabilities: { tools: [...request.capabilities.tools], surfaces: [...request.capabilities.surfaces] },
          createdAt: clock(),
          sessionKey: effectSessionKey(request.effectId, options.config.agentId!),
        };
        await writeIntent(options.privateStore!, intent);
        return intent;
      },
    } : {}),
  });
  // Synchronous last-instant authority fence: reads the latest committed document at the
  // host's admission boundary, so a revocation committed after the adapter's preflight
  // still refuses the launch. A revocation does not cancel an already accepted run.
  if (options.fence) options.fence.check = intent => {
    const state = service.state;
    const effect = state.effects[intent.id];
    if (!effect || effect.status !== 'reserved') throw new Error('VSC_AUTHORITY_CLOSED');
    const separator = intent.grantRef.lastIndexOf(':');
    const grantId = intent.grantRef.slice(0, separator);
    const version = Number(intent.grantRef.slice(separator + 1));
    const grant = state.grants[grantId];
    const at = clock();
    if (!grant || grant.version !== version || grant.revokedAt !== null
      || at < grant.validFrom || at >= grant.validUntil) throw new Error('VSC_AUTHORITY_CLOSED');
    if (effect.grantId !== grantId || effect.grantVersion !== version) throw new Error('VSC_AUTHORITY_CLOSED');
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let consecutiveFaults = 0;
  const inspected = new Set<string>();

  async function reconcileOnce(): Promise<void> {
    try {
      await service.apply({ id: `reconcile/${clock()}`, type: 'restart' });
    } catch (error) {
      options.log?.(`reconcile-failed ${(error instanceof Error ? error.name : 'unknown').slice(0, 40)}`);
      return;
    }
    // A succeeded effect still needs a correlated post-action readback before the
    // channel re-opens. The same sampler supplies that environment observation.
    for (const effect of Object.values(service.state.effects)) {
      if (effect.status === 'ambiguous' && !effect.receipt) {
        const alarmId = `alarm/unresolved/${effect.id}`;
        if (!service.state.alarms[alarmId]) {
          await service.apply({
            id: `unresolved/${effect.id}/${clock()}`,
            type: 'alarm.raised',
            alarmId,
            unitId: effect.unitId,
            alarmClass: 'runtime.unresolved-launch',
            severity: 1,
            localThreshold: 1,
            falseAlarmCost: 1,
            delayCost: 10,
            evidenceRef: `effect:${effect.id}`,
          });
        }
      }
      // Failure is terminal too; the environment brake still needs a readback.
      if (!['succeeded', 'failed'].includes(effect.status) || effect.environmentReturn) continue;
      try {
        const sample = await sampler(clock());
        await service.apply({
          id: `environment/${effect.id}/${sample.at}`,
          type: 'environment.returned',
          effectId: effect.id,
          evidenceRef: `canary:${sample.at}:readback:${effect.id}`,
        });
      } catch (error) {
        // A failed readback must not abort the pass; the missing return stays visible to
        // the deadline audit below.
        options.log?.(`environment-readback-failed ${(error instanceof Error ? error.name : 'unknown').slice(0, 40)}`);
      }
    }
    // Return deadlines become durable audit findings even when the effect never
    // reports. One inspect per effect and deadline; the event id is stable, so a
    // restart cannot duplicate the finding. Findings are notification signals, never
    // permission to spend inference.
    for (const effect of Object.values(service.state.effects)) {
      if (['intent', 'lost', 'cancelled'].includes(effect.status)) continue;
      if (effect.environmentReturn || clock() < effect.returnDueAt) continue;
      const key = `audit/${effect.id}/${effect.returnDueAt}`;
      if (inspected.has(key)) continue;
      try {
        // Mark only after the finding is durable: a transient storage fault must be
        // retried on the next pass, not suppressed until a restart.
        await service.apply({ id: key, type: 'audit.inspect', effectId: effect.id });
        inspected.add(key);
      } catch (error) {
        options.log?.(`audit-inspect-failed ${(error instanceof Error ? error.name : 'unknown').slice(0, 40)}`);
      }
    }
    if (options.retainPending) {
      try { await options.retainPending(); }
      catch (error) { options.log?.(`retention-pass-failed ${(error instanceof Error ? error.name : 'unknown').slice(0, 40)}`); }
    }
    options.onChange?.(service.state.revision, service.state.updatedAt);
  }

  async function sampleOnce(): Promise<void> {
    const now = clock();
    const sample = await sampler(now);
    const observations = canaryObservations(sample, CANARY_THRESHOLDS);
    let severity = 0;
    for (const observation of observations) {
      if (observation.evidence > 0) severity += observation.evidence;
      await service.apply({
        id: `canary/${sample.at}/${observation.topic}/${observation.index}`,
        type: 'observation',
        channelId,
        index: observation.index,
        evidence: observation.evidence,
        topic: observation.topic,
        evidenceRef: observation.evidenceRef,
      });
    }
    options.onChange?.(service.state.revision, service.state.updatedAt);
    consecutiveFaults = severity > 0 ? consecutiveFaults + 1 : 0;
    if (consecutiveFaults >= CANARY_FAULT_STREAK && !openAlarm(service.state, 'canary.host-health')) {
      await service.apply({
        id: `alarm/${sample.at}`,
        type: 'alarm.raised',
        alarmId: `alarm/canary/${sample.at}`,
        unitId: 'canary',
        alarmClass: 'canary.host-health',
        severity,
        localThreshold: 1,
        falseAlarmCost: 1,
        delayCost: 10,
        evidenceRef: observations[0]?.evidenceRef ?? `canary:${sample.at}`,
      });
    }
  }

  return {
    service,
    channelId,
    async start() {
      await service.start();
      if (timer === null && (options.intervalMs ?? CANARY_INTERVAL_MS) > 0) {
        timer = setInterval(() => {
          void (async () => {
            await sampleOnce().catch(() => undefined);
            await reconcileOnce().catch(() => undefined);
          })();
        }, options.intervalMs ?? CANARY_INTERVAL_MS);
      }
    },
    async stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      await service.stop();
    },
    sampleOnce,
    reconcileOnce,
  };
}

/** Root document creation is external/bootstrap-only, never an agent mutation. */
export async function ensureRootState(
  store: DocumentStore, config: VsmRuntimeConfig, now: number,
): Promise<void> {
  const observed = await store.observe(VSM_DOCUMENT_KEY);
  const existing = readDocument(observed.value);
  if (!existing) {
    let state = createState({ rootId: 'root', principalId: config.principalId, charter: config.charter, now });
    state = addUnit(state, { id: 'canary', parentId: 'root', purpose: 'Keep the host observable', exits: { observed: 1 } });
    state = withProbe(state, config, now);
    await bootstrapDocument(store, seedChannels(state, config));
    return;
  }
  const state = existing.state;
  if (config.agentId && !state.procedures[PROBE_PROCEDURE]) {
    const decided = withProbeGrant(configureChannel(addProcedure(structuredClone(state), probeProcedure(config)),
      DISPATCH_CHANNEL, { procedureId: PROBE_PROCEDURE, threshold: 2.5 }), now);
    const written = await changeDocument(store, next => {
      if (next.revision !== state.revision) return false;
      for (const key of Object.keys(next)) delete (next as unknown as Record<string, unknown>)[key];
      Object.assign(next, structuredClone(decided));
      return true;
    });
    if (!written.changed) throw new Error('VSC_RUNTIME_BOOTSTRAP_CONFLICT');
    return;
  }
  if (config.agentId && state.procedures[PROBE_PROCEDURE]?.executionRef !== `agent:${config.agentId}`) {
    throw new Error('VSC_RUNTIME_AGENT_CHANGED');
  }
}

function openAlarm(state: VsmState, alarmClass: string): boolean {
  return Object.values(state.alarms).some(alarm => alarm.class === alarmClass && alarm.state !== 'acknowledged');
}

function probeProcedure(config: VsmRuntimeConfig) {
  return {
    id: PROBE_PROCEDURE, unitId: 'canary', organ: 'operation' as const, kind: 'model' as const,
    executionRef: `agent:${config.agentId}`, expectedOutcome: 1, returnTimeoutMs: 120_000,
    requiredTools: [] as string[], requiredSurfaces: [] as string[],
  };
}

export const PROBE_GRANT = 'canary/probe-grant';

/** The probe procedure needs an explicit, expiring, revocable grant from root S3. */
function withProbeGrant(state: VsmState, now: number): VsmState {
  if (state.grants[PROBE_GRANT]) return state;
  const result = step(state, {
    id: `grant/${PROBE_GRANT}/${now}`,
    type: 'grant.changed',
    actor: { kind: 'organ', unitId: 'root', role: 'S3' },
    grant: {
      id: PROBE_GRANT, version: 1, unitId: 'canary', issuer: { kind: 'organ', unitId: 'root', role: 'S3' },
      procedureIds: [PROBE_PROCEDURE], tools: [], surfaces: [], capacity: 2,
      validFrom: now, validUntil: now + 10 * 365 * 24 * 60 * 60 * 1000, revokedAt: null,
    },
  }, now);
  if (result.errors.length) throw new Error(`VSC_RUNTIME_GRANT:${result.errors[0].code}`);
  return result.state;
}

function withProbe(state: VsmState, config: VsmRuntimeConfig, now: number): VsmState {
  return config.agentId ? withProbeGrant(addProcedure(state, probeProcedure(config)), now) : state;
}

function seedChannels(state: VsmState, config: VsmRuntimeConfig): VsmState {
  return config.agentId
    ? configureChannel(state, DISPATCH_CHANNEL, { procedureId: PROBE_PROCEDURE, threshold: 2.5 })
    : configureChannel(state, CANARY_CHANNEL, { threshold: 2.5 });
}

/**
 * Outcome rule for a textual purpose: native success plus a non-blank visible reply.
 * This is a completion rule, not proof that the diagnosis is correct; correctness needs
 * an independent comparison against the sampled condition.
 */
export function evaluateDeliverable(outcome: { status: string; terminalReply?: { disposition: string; textCharacters?: number; textNonWhitespace?: number } }): { value: number; success: boolean } {
  const reply = outcome.terminalReply;
  const delivered = reply?.disposition === 'visible' && (reply.textCharacters ?? 0) > 0 && (reply.textNonWhitespace ?? 0) > 0;
  const ok = outcome.status === 'ok' && delivered;
  return { value: ok ? 1 : 0, success: ok };
}

export function nativeExecutorFor(
  api: OpenClawPluginApi, clock: () => number, options: {
    store?: DocumentStore;
    privateStore?: DocumentStore;
    agentId?: string;
    log?: (detail: string) => void;
    privateResultSink?: PrivateResultSink;
    fence?: AuthorityFence;
  } = {},
): NativeExecutor {
  return createNativeExecutor({
    executor: new NativeEffectExecutor(api, {
      // The operator names the agent explicitly; the native runtime still rejects a
      // missing agent when the launch is attempted.
      agentExists: id => options.agentId !== undefined && id === options.agentId,
      now: clock,
      ...(options.privateResultSink ? { privateResultSink: options.privateResultSink } : {}),
      ...(options.fence ? { fence: options.fence } : {}),
      // The host calls this at its own admission boundary; it reads the fence bound by
      // buildRuntime, so a launch that the runtime already refused cannot proceed.
      assertCurrent: intent => options.fence?.check?.(intent),
    }),
    resolveIntent: async request => {
      if (!options.privateStore) return undefined;
      const intent = await readIntent(options.privateStore, request.effectId);
      if (!intent) return undefined;
      return { agentId: intent.agentId, message: intent.message, purpose: intent.purpose, createdAt: intent.createdAt,
        capabilities: { tools: [...intent.capabilities.tools], surfaces: [...intent.capabilities.surfaces] },
        ...(intent.deadline === undefined ? {} : { deadline: intent.deadline }) };
    },
    assertAdmission: async request => {
      if (!options.store) return false;
      const observed = await options.store.observe(VSM_DOCUMENT_KEY);
      const state = readDocument(observed.value)?.state;
      const effect = state?.effects[request.effectId];
      const grant = state?.grants[request.grant.id];
      if (!state || !effect || !grant) return false;
      if (effect.status !== 'reserved' || effect.grantId !== request.grant.id
        || effect.grantVersion !== request.grant.version) return false;
      if (grant.revokedAt !== null || grant.version !== request.grant.version) return false;
      const now = clock();
      return now >= grant.validFrom && now < grant.validUntil;
    },
    // A visible reply with actual content is the minimum evidence that the authorized
    // deliverable exists; process success alone is not an outcome.
    evaluate: evaluateDeliverable,
    probeLaunch: async request => {
      // Durable knowledge beats a fresh guess: a reservation already proven absent stays
      // absent instead of being degraded back to ambiguity by the periodic pass.
      if (options.store) {
        const observed = await options.store.observe(VSM_DOCUMENT_KEY);
        const known = readDocument(observed.value)?.state.effects[request.effectId];
        if (known?.status === 'lost') return 'absent';
      }
      if (!options.privateStore) return 'unknown';
      const marker = await readIntent(options.privateStore, request.effectId);
      if (!marker) return 'unknown';
      try {
        const history = await api.runtime.subagent.getSessionMessages({ sessionKey: marker.sessionKey, limit: 1 });
        if (!Array.isArray(history.messages)) return 'unknown';
        // A committed marker means a launch was attempted, so an empty transcript is not
        // proof that nothing was sent: transcripts persist late and can be reset. Absence
        // must come from durable knowledge or an authoritative rejection, never from this.
        return 'unknown';
      } catch {
        return 'unknown';
      }
    },
    resolveReceipt: async request => {
      if (!options.store) return undefined;
      const observed = await options.store.observe(VSM_DOCUMENT_KEY);
      const effect = readDocument(observed.value)?.state.effects[request.effectId];
      if (!effect?.receipt?.sessionKey) return undefined;
      return {
        effectId: request.effectId, status: 'accepted', runId: effect.receipt.nativeId,
        sessionKey: effect.receipt.sessionKey, at: effect.receipt.acceptedAt,
      };
    },
    now: clock,
    log: options.log,
  });
}
