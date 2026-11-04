import type { FeatureInvocationContext } from 'openclaw/plugin-sdk/feature-plugin';
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { contract } from './contract.js';
import { planPage } from './backend/plan-page.js';
import { Backend } from './backend/backend.js';
import { planAllocation } from './compute/index.js';
import { fromNativeEvent, fromSessionSend, metadataId, type Observation } from './backend/events.js';
import { buildRuntime, ensureRootState, nativeExecutorFor, readRuntimeConfig } from './runtime.js';

const agentAccess = (context: FeatureInvocationContext) => context.source === 'session-action' && context.action.client?.allowsAgent
  ? (agentId: string) => context.action.client!.allowsAgent!(agentId) : undefined;

export { contract } from './contract.js';
const plugin = defineFeaturePlugin({
  contract,
  name: 'Viable System Claw',
  description: 'Explicit organizational graph, metadata activity projection and compute observations.',
  setup(api, events) {
    const backend = new Backend({
      store: api.runtime.state.openKeyedStoreV2({ namespace: 'organization', retention: 'retained' }),
      verifySession: async session => {
        const entry = await api.runtime.agent.session.getSessionEntryAsync({
          ...session, hydrateSkillPromptRefs: false, readConsistency: 'latest',
        });
        return entry ? { sessionId: entry.sessionId } : undefined;
      },
      changed: event => events.emit('changed', event),
    });
    // Projection failures are isolated from the observed workload. No exception or raw error string is logged.
    let reportedFailure = false;
    const safelyObserve = async (event: Observation | undefined): Promise<void> => {
      if (!event) return;
      try { await backend.observe(event); }
      catch {
        if (!reportedFailure) {
          reportedFailure = true;
          api.logger.warn('VSC metadata projection failed; coverage remains partial. Inspect retained storage health.');
        }
      }
    };
    // The durable runtime is opt-in per plugin config; absent config adds no timers or stores.
    const runtimeConfig = readRuntimeConfig(api.pluginConfig);
    if (runtimeConfig) {
      const clock = () => Date.now();
      const vsmStore = api.runtime.state.openKeyedStoreV2({ namespace: 'vsm', retention: 'retained' });
      const privateStore = runtimeConfig.agentId
        ? api.runtime.state.openKeyedStoreV2({ namespace: 'vsm-private', retention: 'retained' })
        : undefined;
      const runtime = buildRuntime({
        config: runtimeConfig, store: vsmStore, privateStore, clock,
        executor: nativeExecutorFor(api, clock, { privateStore, agentId: runtimeConfig.agentId }),
        onAlarm: action => api.logger.warn(`VSC alarm ${action.alarmId} raised for ${action.principalId}`),
      });
      api.registerService({
        id: 'viable-system-claw:runtime',
        async start() { await ensureRootState(vsmStore, runtimeConfig, clock()); await runtime.start(); },
        async stop() { await runtime.stop(); },
      });
    }
    api.registerService({
      id: 'viable-system-claw:backend',
      async start() { reportedFailure = false; await backend.start(); },
      async stop() { await backend.stop(); },
    });
    api.agent.events.registerAgentEventSubscription({
      id: 'organization-activity', streams: ['lifecycle', 'tool', 'error'], payload: 'metadata',
      async handle(event) {
        // Include synchronous normalization failures in the same isolation boundary.
        try { await safelyObserve(fromNativeEvent(event)); }
        catch { /* Malformed producer metadata must not affect a run. */ }
      },
    });
    // Hook fallbacks share semantic event identities with the native stream, so they cannot double count.
    api.on('before_tool_call', async (event, context) => {
      try {
        const runId = metadataId(event.runId ?? context.runId);
        const toolCallId = metadataId(event.toolCallId ?? context.toolCallId);
        if (!context.sessionKey || !runId || !toolCallId) return;
        await safelyObserve({ sessionKey: context.sessionKey, agentId: context.agentId, sessionId: context.sessionId,
          runId, toolCallId, kind: 'tool-start', at: Date.now(), toolName: metadataId(event.toolName) });
      } catch { /* Metadata observation never changes the call's authority or arguments. */ }
    });
    api.on('after_tool_call', async (event, context) => {
      try {
        await safelyObserve(fromSessionSend(event, context, Date.now()));
        const runId = metadataId(event.runId ?? context.runId);
        const toolCallId = metadataId(event.toolCallId ?? context.toolCallId);
        if (!context.sessionKey || !runId || !toolCallId) return;
        await safelyObserve({ sessionKey: context.sessionKey, agentId: context.agentId, sessionId: context.sessionId,
          runId, toolCallId, kind: 'tool-end', at: Date.now(), toolName: metadataId(event.toolName), failed: Boolean(event.error) });
      } catch { /* Observation only; never fail a tool. */ }
    });
    api.on('agent_end', async (event, context) => {
      try {
        const runId = metadataId(event.runId ?? context.runId);
        if (!context.sessionKey || !runId) return;
        await safelyObserve({ sessionKey: context.sessionKey, agentId: context.agentId, sessionId: context.sessionId,
          runId, kind: 'run-end', at: Date.now(), failed: !event.success });
      } catch { /* Observation only; never fail another workload. */ }
    });
    return {
      'graph.snapshot': (_input, context) => backend.graphSnapshot(agentAccess(context)),
      'compute.snapshot': (_input, context) => backend.computeSnapshot(agentAccess(context)),
      'compute.plan': async (input, context) => {
        const access = agentAccess(context);
        const graph = await backend.graphSnapshot(access);
        if (!graph.units.some(unit => unit.id === input.request.unitId)) throw new Error('Allocation unit does not exist');
        const plan = planAllocation(await backend.computeSnapshot(access), input.request, {
          now: Date.now(), policy: input.policy, state: input.state, coverage: input.coverage,
        });
        return planPage(plan, input.diagnosticOffset);
      },
      'unit.upsert': (input, context) => backend.upsertUnit(input, agentAccess(context)),
      'relation.upsert': (input, context) => backend.upsertRelation(input, agentAccess(context)),
      'unit.bind-session': (input, context) => {
        // Feature actions have operator.write; additionally honor an authenticated restricted-agent view.
        if (input.session && context.source === 'session-action' && context.action.client?.allowsAgent
          && !context.action.client.allowsAgent(input.session.agentId)) throw new Error('Operator cannot access the selected agent');
        return backend.bindSession(input, agentAccess(context));
      },
      'compute.observe': (input, context) => backend.observeCompute(input, agentAccess(context)),
    };
  },
});
export default plugin;
