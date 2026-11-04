import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { NativeEffectExecutor } from './execution/native.js';
import { addUnit, configureChannel, createState } from './vsm/kernel.js';
import { createNativeExecutor } from './vsm/native-adapter.js';
import { VsmService } from './vsm/service.js';
import { bootstrapDocument, readDocument, VSM_DOCUMENT_KEY, type DocumentStore } from './vsm/state.js';
import { CANARY_THRESHOLDS, canaryObservations, sampleCanary, type CanarySample } from './vsm/canary.js';
import type { NativeExecutor } from './vsm/executor.js';
import type { VsmAction, VsmState } from './vsm/types.js';



export interface VsmRuntimeConfig {
  principalId: string;
  charter: string;
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
  };
  if (runtime === undefined) return undefined;
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) throw new Error('VSC_RUNTIME_CONFIG');
  const record = runtime as Record<string, unknown>;
  if (record.enabled !== true) return undefined;
  const principalId = record.principalId;
  const charter = record.charter;
  if (typeof principalId !== 'string' || principalId.trim().length === 0) throw new Error('VSC_RUNTIME_CONFIG');
  if (typeof charter !== 'string' || charter.trim().length === 0) throw new Error('VSC_RUNTIME_CONFIG');
  return { principalId, charter };
}

export const CANARY_CHANNEL = 'canary/environment/return';
export const CANARY_INTERVAL_MS = 30_000;

export interface VsmRuntimeOptions {
  config: VsmRuntimeConfig;
  store: DocumentStore;
  executor: NativeExecutor;
  clock?: () => number;
  sampler?: (now: number) => Promise<CanarySample>;
  onAlarm?: (action: Extract<VsmAction, { type: 'alarm' }>, state: VsmState) => void;
  intervalMs?: number;
}

export interface VsmRuntime {
  service: VsmService;
  start(): Promise<void>;
  stop(): Promise<void>;
  sampleOnce(): Promise<void>;
}

export function buildRuntime(options: VsmRuntimeOptions): VsmRuntime {
  const clock = options.clock ?? Date.now;
  const sampler = options.sampler ?? ((now: number) => sampleCanary({
    now, readyzUrl: 'http://127.0.0.1:18789/readyz', filesystemPath: process.cwd(),
  }));
  const service = new VsmService({
    store: options.store,
    executor: options.executor,
    clock,
    alarmSink: options.onAlarm,
    log: { warn: () => undefined },
  });
  let timer: ReturnType<typeof setInterval> | null = null;

  async function sampleOnce(): Promise<void> {
    const now = clock();
    const sample = await sampler(now);
    for (const observation of canaryObservations(sample, CANARY_THRESHOLDS)) {
      await service.apply({
        id: `canary/${sample.at}/${observation.topic}/${observation.index}`,
        type: 'observation',
        channelId: CANARY_CHANNEL,
        index: observation.index,
        evidence: observation.evidence,
        topic: observation.topic,
        evidenceRef: observation.evidenceRef,
      });
    }
  }

  return {
    service,
    async start() {
      await service.start();
      if (timer === null && (options.intervalMs ?? CANARY_INTERVAL_MS) > 0) {
        timer = setInterval(() => { void sampleOnce().catch(() => undefined); }, options.intervalMs ?? CANARY_INTERVAL_MS);
      }
    },
    async stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      await service.stop();
    },
    sampleOnce,
  };
}

/** Root document creation is external/bootstrap-only, never an agent mutation. */
export async function ensureRootState(store: DocumentStore, config: VsmRuntimeConfig, now: number): Promise<void> {
  const observed = await store.observe(VSM_DOCUMENT_KEY);
  if (readDocument(observed.value)) return;
  let state = createState({ rootId: 'root', principalId: config.principalId, charter: config.charter, now });
  state = addUnit(state, { id: 'canary', parentId: 'root', purpose: 'Keep the host observable', exits: { observed: 1 } });
  state = configureChannel(state, CANARY_CHANNEL, { threshold: 2.5 });
  await bootstrapDocument(store, state);
}

export function nativeExecutorFor(api: OpenClawPluginApi, clock: () => number) {
  return createNativeExecutor({
    executor: new NativeEffectExecutor(api, { agentExists: () => false, now: clock }),
    // No non-kernel procedure is admitted yet; a dispatch without a host intent
    // is recorded as not-launched rather than guessed.
    resolveIntent: () => undefined,
    now: clock,
  });
}
