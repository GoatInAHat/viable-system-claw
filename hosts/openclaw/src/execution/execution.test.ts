import { describe, expect, it, vi } from 'vitest';
import { NativeEffectExecutor, effectSessionKey, type NativeExecutorOptions } from './native.js';
import { EffectReconciler, classifyWait } from './reconcile.js';
import { planRecovery, type RecoveryRecord } from './recovery.js';
import { EXECUTION_LIMITS, projectEffectIntent, type EffectIntent, type EffectOutcome,
  type EffectReceipt, type NativeSubagentRuntime, type PrivateResultSink } from './types.js';

const now = 10_000;
const intent = (patch: Partial<EffectIntent> = {}): EffectIntent => ({ id: 'effect-1', unitId: 'unit-1',
  procedureId: 'procedure-1', agentId: 'worker', message: 'private-input', purpose: 'private-purpose',
  grantRef: 'grant:1', createdAt: now - 1, ...patch });
const accepted = (patch: Partial<Extract<EffectReceipt, { status: 'accepted' }>> = {}): Extract<EffectReceipt, { status: 'accepted' }> => ({
  effectId: 'effect-1', status: 'accepted', runId: 'run-1', sessionKey: effectSessionKey('effect-1', 'worker'), at: now, ...patch,
});
function fake() {
  const run = vi.fn<NativeSubagentRuntime['run']>().mockResolvedValue({ runId: 'run-1' });
  const waitForRun = vi.fn<NativeSubagentRuntime['waitForRun']>().mockResolvedValue({ status: 'pending' });
  const getSessionMessages = vi.fn<NativeSubagentRuntime['getSessionMessages']>().mockResolvedValue({ messages: [] });
  const runtime: NativeSubagentRuntime = { run, waitForRun, getSessionMessages };
  const executor = (options: Partial<NativeExecutorOptions> = {}) => new NativeEffectExecutor({ runtime: { subagent: runtime } },
    { agentExists: id => id === 'worker', now: () => now, ...options });
  return { runtime, run, waitForRun, getSessionMessages, executor };
}
const terminal = (patch: Partial<EffectOutcome> = {}): EffectOutcome => ({ effectId: 'effect-1', runId: 'run-1',
  status: 'ok', terminal: true, endedAt: now + 5, stopReason: 'completed', livenessState: 'completed', ...patch });
const record = (patch: Partial<RecoveryRecord> = {}): RecoveryRecord => ({ effectId: 'effect-1', launchState: 'unattempted', ...patch });

// Every runtime below is a synthetic fake. No SDK runtime functions are executed.
describe('native dispatch', () => {
  it('returns admission, not success; routes the configured agent through a stable plugin-owned key', async () => {
    const f = fake();
    const receipt = await f.executor().dispatch(intent());
    expect(receipt).toEqual(accepted());
    expect(receipt).not.toHaveProperty('outcome');
    expect(f.run).toHaveBeenCalledExactlyOnceWith({ sessionKey: accepted().sessionKey,
      message: 'private-input', deliver: false, promptMode: 'minimal' });
    expect(f.run.mock.calls[0][0]).not.toHaveProperty('model');
    expect(f.run.mock.calls[0][0]).not.toHaveProperty('provider');
    expect(f.run.mock.calls[0][0]).not.toHaveProperty('completionDelivery');
    expect(f.waitForRun).not.toHaveBeenCalled();
  });
  it('makes session keys deterministic, agent-scoped and insensitive to prompt text', () => {
    const key = effectSessionKey('effect-1', 'worker');
    expect(key).toMatch(/^agent:worker:subagent:viable-system-claw-effect-[a-f0-9]{64}$/);
    expect(effectSessionKey(intent({ message: 'different' }).id, 'worker')).toBe(key);
    expect(effectSessionKey('effect-2', 'worker')).not.toBe(key);
    expect(effectSessionKey('effect-1', 'other')).not.toBe(key);
    expect(() => effectSessionKey('bad\nid', 'worker')).toThrow('Invalid execution identity');
    expect(() => effectSessionKey('effect-1', 'worker:other')).toThrow('Invalid execution identity');
  });
  it('coalesces concurrent dispatch and remembers the same receipt afterwards', async () => {
    const f = fake();
    const executor = f.executor();
    const [a, b] = await Promise.all([executor.dispatch(intent()), executor.dispatch(intent())]);
    expect(a).toBe(b);
    expect(await executor.dispatch(intent({ message: 'must not launch' }))).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('retains the canonical host session key and samples acceptance time after admission', async () => {
    const f = fake();
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now + 3);
    f.run.mockResolvedValue({ runId: 'canonical-run', sessionKey: 'agent:worker:subagent:canonical' });
    expect(await f.executor({ now: clock }).dispatch(intent())).toEqual(accepted({ runId: 'canonical-run',
      sessionKey: 'agent:worker:subagent:canonical', at: now + 3 }));
  });
  it.each([
    [{ agentId: '' }, 'invalid-agent'],
    [{ agentId: 'worker:other' }, 'invalid-agent'],
    [{ agentId: 'Worker' }, 'invalid-agent'],
    [{ agentId: 'a'.repeat(EXECUTION_LIMITS.agentId + 1) }, 'invalid-agent'],
    [{ agentId: 'missing' }, 'missing-agent'],
    [{ message: '' }, 'invalid-message'],
    [{ message: '  \n' }, 'invalid-message'],
    [{ message: 'nul\0input' }, 'invalid-message'],
    [{ message: 'x'.repeat(EXECUTION_LIMITS.message + 1) }, 'message-too-long'],
    [{ unitId: '' }, 'invalid-intent'],
    [{ procedureId: 'p'.repeat(EXECUTION_LIMITS.id + 1) }, 'invalid-intent'],
    [{ grantRef: '' }, 'invalid-intent'],
    [{ purpose: '' }, 'invalid-intent'],
    [{ purpose: 'p'.repeat(EXECUTION_LIMITS.purpose + 1) }, 'invalid-intent'],
    [{ createdAt: Number.NaN }, 'invalid-intent'],
    [{ createdAt: -1 }, 'invalid-intent'],
    [{ deadline: Number.POSITIVE_INFINITY }, 'invalid-intent'],
    [{ deadline: now - 2 }, 'invalid-intent'],
    [{ deadline: now }, 'deadline-expired'],
  ] as const)('rejects invalid or unavailable dispatch before any launch: %j', async (patch, reason) => {
    const f = fake();
    const receipt = await f.executor().dispatch(intent(patch));
    expect(receipt).toMatchObject({ status: 'rejected', admission: 'not-accepted', runId: null, reason });
    expect(f.run).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain('private-input');
    expect(JSON.stringify(receipt)).not.toContain('private-purpose');
  });
  it('accepts the exact message bound without truncation', async () => {
    const f = fake();
    const message = 'x'.repeat(EXECUTION_LIMITS.message);
    expect((await f.executor().dispatch(intent({ message }))).status).toBe('accepted');
    expect(f.run.mock.calls[0][0].message).toBe(message);
  });
  it('rejects invalid effect identities without persisting private/unbounded input', async () => {
    const f = fake();
    await expect(f.executor().dispatch(intent({ id: 'secret\n'.repeat(100) }))).rejects.toThrow('Invalid effect identity');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('does not disclose validation or authority exception bodies', async () => {
    for (const options of [
      { agentExists: () => { throw new Error('private-validation'); } },
      { assertCurrent: () => { throw new Error('private-authority'); } },
    ]) {
      const f = fake();
      const receipt = await f.executor(options).dispatch(intent());
      expect(receipt).toMatchObject({ status: 'rejected', admission: 'not-accepted' });
      expect(JSON.stringify(receipt)).not.toMatch(/private-validation|private-authority/);
      expect(f.run).not.toHaveBeenCalled();
    }
  });
  it('asserts current authority both before launch and at the host admission boundary with immutable intent', async () => {
    const f = fake();
    const assertCurrent = vi.fn();
    const original = intent();
    await f.executor({ assertCurrent }).dispatch(original);
    original.message = 'changed';
    f.run.mock.calls[0][0].assertCurrent?.();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(assertCurrent.mock.calls[1][0].message).toBe('private-input');
    expect(Object.isFrozen(assertCurrent.mock.calls[1][0])).toBe(true);
  });
  it('treats accepted launch with lost admission reply as ambiguous, not retryable', async () => {
    const f = fake();
    let hostLaunches = 0;
    f.run.mockImplementation(async () => { hostLaunches++; throw new Error('private-transport-detail'); });
    const executor = f.executor();
    const receipt = await executor.dispatch(intent());
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'admission-unknown', admission: 'unknown' });
    expect(JSON.stringify(receipt)).not.toContain('private-transport-detail');
    expect(await executor.dispatch(intent())).toBe(receipt);
    const restarted = f.executor();
    expect(await restarted.dispatch(intent(), JSON.parse(JSON.stringify(receipt)) as EffectReceipt)).toEqual(receipt);
    expect(await restarted.reconcile(receipt)).toMatchObject({ status: 'unknown', terminal: false, reason: 'admission-unknown' });
    expect(planRecovery(record({ launchState: 'ambiguous', receipt }))).toMatchObject({ action: 'require-policy', reason: 'admission-unknown' });
    expect(hostLaunches).toBe(1);
    expect(f.waitForRun).not.toHaveBeenCalled();
  });
  it.each([
    { runId: '' }, { runId: 'r'.repeat(EXECUTION_LIMITS.nativeId + 1) },
    { runId: 'run-1', sessionKey: 'bad\nkey' },
  ])('treats malformed admission as ambiguous with no blind retry: %j', async nativeResult => {
    const f = fake();
    f.run.mockResolvedValue(nativeResult);
    const executor = f.executor();
    const receipt = await executor.dispatch(intent());
    expect(receipt).toMatchObject({ status: 'rejected', admission: 'unknown', reason: 'invalid-admission' });
    await executor.dispatch(intent());
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('never re-launches a persisted accepted receipt, including after observing it', async () => {
    const f = fake();
    const a = accepted();
    expect(await f.executor().dispatch(intent(), a)).toEqual(a);
    const reconstructed = f.executor();
    await reconstructed.reconcile(a);
    expect(await reconstructed.dispatch(intent())).toEqual(a);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('never retries a definitive rejection under the same effect id', async () => {
    const f = fake();
    const rejected = await f.executor().dispatch(intent({ agentId: 'missing' }));
    const executor = f.executor();
    expect(await executor.dispatch(intent(), rejected)).toEqual(rejected);
    expect(await executor.reconcile(rejected)).toMatchObject({ status: 'error', terminal: true, reason: 'dispatch-rejected', endedAt: null });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.waitForRun).not.toHaveBeenCalled();
  });
  it('requires matching receipt identity', async () => {
    await expect(fake().executor().dispatch(intent(), accepted({ effectId: 'different' }))).rejects.toThrow('Receipt identity mismatch');
  });
  it('publishes a body-free intent projection', () => {
    const projection = projectEffectIntent(intent({ deadline: now + 100 }));
    expect(projection).toEqual({ id: 'effect-1', unitId: 'unit-1', procedureId: 'procedure-1', agentId: 'worker', createdAt: now - 1, deadline: now + 100 });
    expect(JSON.stringify(projection)).not.toMatch(/private-input|private-purpose|grant:1/);
    expect(projectEffectIntent(intent())).not.toHaveProperty('deadline');
    expect(() => projectEffectIntent(intent({ id: 'x'.repeat(EXECUTION_LIMITS.id + 1) }))).toThrow('Invalid effect projection');
    expect(() => projectEffectIntent(intent({ agentId: 'worker:other' }))).toThrow('Invalid effect projection');
  });
});

describe('native wait state transitions', () => {
  it.each([
    [{ status: 'ok' }, { status: 'ok', terminal: true, endedAt: null }],
    [{ status: 'error', endedAt: now + 1, error: 'private-error' }, { status: 'error', terminal: true, endedAt: now + 1 }],
    [{ status: 'timeout' }, { status: 'unknown', terminal: false, reason: 'observation-timeout', endedAt: null }],
    [{ status: 'timeout', timeoutPhase: 'gateway_draining' }, { status: 'unknown', terminal: false, reason: 'observation-timeout' }],
    [{ status: 'timeout', endedAt: now + 1, stopReason: 'hard_timeout' }, { status: 'timeout', terminal: true, endedAt: now + 1 }],
    [{ status: 'timeout', endedAt: now, stopReason: 'aborted' }, { status: 'timeout', terminal: true, stopReason: 'aborted' }],
    [{ status: 'timeout', stopReason: 'timed_out' }, { status: 'timeout', terminal: true, endedAt: null }],
    [{ status: 'pending', timeoutPhase: 'queue', providerStarted: false }, { status: 'unknown', terminal: false, reason: 'wait-pending' }],
    [{ status: 'ok', yielded: true }, { status: 'unknown', terminal: false, reason: 'incomplete-terminal' }],
    [{ status: 'error', pendingError: true }, { status: 'unknown', terminal: false, reason: 'incomplete-terminal' }],
    [{ status: 'error', retryableTransportError: true }, { status: 'unknown', terminal: false, reason: 'wait-unavailable' }],
    [{ status: 'error', stopReason: 'aborted' }, { status: 'unknown', terminal: false, reason: 'incomplete-terminal' }],
    [{ status: 'error', stopReason: 'cancelled', endedAt: now }, { status: 'killed', terminal: true, stopReason: 'cancelled' }],
    [{ status: 'error', stopReason: 'restart', endedAt: now }, { status: 'killed', terminal: true, stopReason: 'restart' }],
    [{ status: 'error', stopReason: 'superseded', endedAt: now }, { status: 'killed', terminal: true, stopReason: 'superseded' }],
    [{ status: 'error', stopReason: 'aborted', endedAt: now }, { status: 'killed', terminal: true, stopReason: 'aborted' }],
    [{ status: 'error', livenessState: 'killed', endedAt: now }, { status: 'killed', terminal: true, livenessState: 'killed' }],
    [{ status: 'ok', stopReason: 'killed', endedAt: now }, { status: 'unknown', terminal: false, reason: 'incomplete-terminal' }],
    [{ status: 'error', stopReason: 'private\nstop', livenessState: 'private-state' }, { status: 'error', terminal: true, stopReason: 'other', livenessState: 'other' }],
    [{ status: 'timeout', endedAt: Number.NaN }, { status: 'unknown', terminal: false, endedAt: null }],
  ] as const)('classifies native observation %j as %j', (result, expected) => {
    const outcome = classifyWait(accepted(), result);
    expect(outcome).toMatchObject(expected);
    expect(JSON.stringify(outcome)).not.toMatch(/private-error|private-state|private\\nstop/);
  });
  it('wait observation timeout leaves work pending and later reconciles the SAME run', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValueOnce({ status: 'timeout' }).mockResolvedValueOnce({ status: 'ok', endedAt: now + 5 });
    const executor = f.executor({ timeoutMs: 20 });
    const pending = await executor.reconcile(accepted());
    expect(pending).toMatchObject({ status: 'unknown', terminal: false, endedAt: null, reason: 'observation-timeout' });
    expect(f.getSessionMessages).not.toHaveBeenCalled();
    expect(await executor.reconcile(accepted(), pending)).toMatchObject({ status: 'ok', terminal: true, endedAt: now + 5 });
    expect(f.waitForRun.mock.calls).toEqual([[{ runId: 'run-1', timeoutMs: 20 }], [{ runId: 'run-1', timeoutMs: 20 }]]);
    expect(f.run).not.toHaveBeenCalled(); // No relaunch or cancellation capability exists on this fake.
  });
  it('returns unknown on wait transport failure and permits another observation, not launch', async () => {
    const f = fake();
    f.waitForRun.mockRejectedValueOnce(new Error('private-wait-error')).mockResolvedValueOnce({ status: 'pending' });
    const executor = f.executor();
    const outcome = await executor.reconcile(accepted());
    expect(outcome).toMatchObject({ status: 'unknown', terminal: false, reason: 'wait-unavailable' });
    expect(JSON.stringify(outcome)).not.toContain('private-wait-error');
    expect(await executor.reconcile(accepted(), outcome)).toMatchObject({ reason: 'wait-pending' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('reconciles a restart while running without dispatching accepted work', async () => {
    const f = fake();
    const receipt = await f.executor().dispatch(intent());
    expect(planRecovery(record({ launchState: 'launching', receipt }))).toMatchObject({ action: 'reconcile', runId: 'run-1' });
    const restarted = f.executor();
    expect(await restarted.reconcile(receipt)).toMatchObject({ status: 'unknown', terminal: false });
    expect(await restarted.dispatch(intent(), receipt)).toEqual(receipt);
    f.waitForRun.mockResolvedValue({ status: 'ok', endedAt: now + 1 });
    expect(await restarted.reconcile(receipt)).toMatchObject({ status: 'ok', terminal: true });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('coalesces duplicate completion, caches terminals and restores persisted terminal idempotently', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok', endedAt: now + 10, terminalReply: { disposition: 'visible', text: 'private-result' } });
    const executor = f.executor();
    const [a, b] = await Promise.all([executor.reconcile(accepted()), executor.reconcile(accepted())]);
    expect(a).toBe(b);
    expect(await executor.reconcile(accepted())).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.resultRef)).toBe(true);
    expect(f.waitForRun).toHaveBeenCalledTimes(1);
    expect(f.getSessionMessages).toHaveBeenCalledExactlyOnceWith({ sessionKey: accepted().sessionKey, limit: EXECUTION_LIMITS.messageCount });
    const rehydrated: EffectOutcome = JSON.parse(JSON.stringify(a)) as EffectOutcome;
    const restarted = f.executor();
    const restored = await restarted.reconcile(accepted(), rehydrated);
    expect(restored).toEqual(a);
    expect(await restarted.reconcile(accepted())).toBe(restored);
    expect(f.waitForRun).toHaveBeenCalledTimes(1);
  });
  it('never overwrites a restored terminal with a late in-flight observation', async () => {
    const f = fake();
    let finish!: (value: Awaited<ReturnType<NativeSubagentRuntime['waitForRun']>>) => void;
    f.waitForRun.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const executor = f.executor();
    const inFlight = executor.reconcile(accepted());
    const restored = await executor.reconcile(accepted(), terminal());
    finish({ status: 'error', endedAt: now + 20 });
    expect(await inFlight).toBe(restored);
    expect(await executor.reconcile(accepted())).toBe(restored);
    expect(f.getSessionMessages).not.toHaveBeenCalled();
  });
  it('refuses a terminal assertion on an admission-unknown receipt', async () => {
    const f = fake();
    const receipt: EffectReceipt = { effectId: 'effect-1', status: 'rejected', runId: null, sessionKey: null,
      at: now, admission: 'unknown', reason: 'admission-unknown' };
    await expect(f.executor().reconcile(receipt, terminal({ runId: null }))).rejects.toThrow('Ambiguous admission');
    expect(f.waitForRun).not.toHaveBeenCalled();
  });
  it('does not confuse lost history with failed execution or invent a missing reply', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok', endedAt: now });
    f.getSessionMessages.mockRejectedValue(new Error('private-history-error'));
    const outcome = await f.executor().reconcile(accepted());
    expect(outcome).toMatchObject({ status: 'ok', terminal: true, resultRef: { history: 'unavailable', messagesObserved: 0 } });
    expect(outcome).not.toHaveProperty('terminalReply');
    expect(JSON.stringify(outcome)).not.toContain('private-history-error');
    const recovery = planRecovery(record({ receipt: accepted(), outcome, replyState: 'lost' }));
    expect(recovery).toMatchObject({ action: 'settle', requiresResultPolicy: true });
  });
  it('requires matching outcome identity and rejects invalid observation budgets', async () => {
    const f = fake();
    await expect(f.executor().reconcile(accepted(), terminal({ runId: 'different' }))).rejects.toThrow('Outcome identity mismatch');
    await expect(f.executor().reconcile(accepted(), terminal({ effectId: 'different' }))).rejects.toThrow('Outcome identity mismatch');
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 30_001]) {
      expect(() => new EffectReconciler(f.runtime, { timeoutMs })).toThrow('Observation timeout');
    }
  });
});

describe('private result boundary', () => {
  it('emits metadata only by default, including visible/silent/empty terminal dispositions', async () => {
    for (const terminalReply of [{ disposition: 'visible', text: 'private-result', modelRouteChange: 'private-route' },
      { disposition: 'silent' }, { disposition: 'empty', code: 'message-tool-not-called' }] as const) {
      const f = fake();
      f.waitForRun.mockResolvedValue({ status: 'ok', terminalReply });
      f.getSessionMessages.mockResolvedValue({ messages: [{ role: 'tool', body: 'private-tool-body', credentials: 'private-secret' }] });
      const outcome = await f.executor().reconcile(accepted());
      expect(outcome.terminalReply?.disposition).toBe(terminalReply.disposition);
      expect(outcome.resultRef).toMatchObject({ history: 'available', messagesObserved: 1, privateResult: 'not-requested' });
      expect(JSON.stringify(outcome)).not.toMatch(/private-result|private-route|private-tool-body|private-secret/);
      expect(outcome).toEqual(JSON.parse(JSON.stringify(outcome)));
    }
  });
  it('sends bounded private bodies only to an explicit idempotent sink, once per terminal', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok', terminalReply: { disposition: 'visible', text: 'private-result' } });
    f.getSessionMessages.mockResolvedValue({ messages: [{ role: 'assistant', content: 'private-message' }] });
    const write = vi.fn<PrivateResultSink['write']>().mockResolvedValue(undefined);
    const executor = f.executor({ privateResultSink: { write } });
    const outcome = await executor.reconcile(accepted());
    await executor.reconcile(accepted());
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ messages: [{ role: 'assistant', content: 'private-message' }], terminalReply: { text: 'private-result' } });
    expect(outcome.resultRef?.privateRef).toMatch(/^vsc-private-result:[a-f0-9]{64}$/);
    expect(outcome.resultRef?.privateRef).toBe(write.mock.calls[0][0].ref);
    expect(outcome.resultRef?.privateResult).toBe('stored');
    expect(JSON.stringify(outcome)).not.toMatch(/private-message|"text"/);
  });
  it('bounds oversized/malformed history and reply payloads without storing partial JSON', async () => {
    const f = fake();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    f.waitForRun.mockResolvedValue({ status: 'ok', terminalReply: { disposition: 'visible', text: 'x'.repeat(EXECUTION_LIMITS.privateReplyCharacters + 1) } });
    f.getSessionMessages.mockResolvedValue({ messages: [cycle, undefined, { text: 'x'.repeat(EXECUTION_LIMITS.privateMessagesBytes + 1) },
      ...Array.from({ length: 20 }, () => ({ text: 'small-private' }))] });
    const write = vi.fn<PrivateResultSink['write']>().mockResolvedValue(undefined);
    const outcome = await f.executor({ privateResultSink: { write } }).reconcile(accepted());
    const stored = write.mock.calls[0][0];
    expect(stored.truncated).toBe(true);
    expect(stored.messages.length).toBeLessThanOrEqual(EXECUTION_LIMITS.messageCount);
    expect(Buffer.byteLength(JSON.stringify(stored.messages))).toBeLessThanOrEqual(EXECUTION_LIMITS.privateMessagesBytes);
    expect(stored.terminalReply?.disposition === 'visible' && stored.terminalReply.text.length).toBe(EXECUTION_LIMITS.privateReplyCharacters);
    expect(outcome.resultRef).toMatchObject({ historyMayBeTruncated: true, messagesObserved: 10, privatePayloadTruncated: true });
    expect(JSON.stringify(outcome)).not.toContain('small-private');
  });
  it('accounts for UTF-8 and JSON array overhead in private message export', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok' });
    f.getSessionMessages.mockResolvedValue({ messages: ['x'.repeat(EXECUTION_LIMITS.privateMessagesBytes - 3),
      'é'.repeat(EXECUTION_LIMITS.privateMessagesBytes / 2), 'small'] });
    const write = vi.fn<PrivateResultSink['write']>().mockResolvedValue(undefined);
    await f.executor({ privateResultSink: { write } }).reconcile(accepted());
    const stored = write.mock.calls[0][0];
    expect(stored.messages).toEqual(['small']);
    expect(stored.truncated).toBe(true);
    expect(stored).not.toHaveProperty('terminalReply');
  });
  it('can privately retain a known empty terminal disposition when history is lost', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok', terminalReply: { disposition: 'empty', code: 'message-tool-not-called' } });
    f.getSessionMessages.mockRejectedValue(new Error('unavailable'));
    const write = vi.fn<PrivateResultSink['write']>().mockResolvedValue(undefined);
    const outcome = await f.executor({ privateResultSink: { write } }).reconcile(accepted());
    expect(write.mock.calls[0][0]).toMatchObject({ terminalReply: { disposition: 'empty', code: 'message-tool-not-called' }, messages: [] });
    expect(outcome.resultRef).toMatchObject({ history: 'unavailable', privateResult: 'stored' });
  });
  it('records private sink failure without losing execution finality or retrying the write implicitly', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok', terminalReply: { disposition: 'silent' } });
    const write = vi.fn<PrivateResultSink['write']>().mockRejectedValue(new Error('private-sink-error'));
    const executor = f.executor({ privateResultSink: { write } });
    const outcome = await executor.reconcile(accepted());
    expect(outcome).toMatchObject({ status: 'ok', terminal: true, resultRef: { privateResult: 'unavailable' } });
    expect(JSON.stringify(outcome)).not.toContain('private-sink-error');
    expect(await executor.reconcile(accepted())).toBe(outcome);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('does not call a private sink when history and terminal reply are both unavailable', async () => {
    const f = fake();
    f.waitForRun.mockResolvedValue({ status: 'ok' });
    f.getSessionMessages.mockRejectedValue(new Error('unavailable'));
    const write = vi.fn<PrivateResultSink['write']>().mockResolvedValue(undefined);
    const outcome = await f.executor({ privateResultSink: { write } }).reconcile(accepted());
    expect(write).not.toHaveBeenCalled();
    expect(outcome.resultRef?.privateResult).toBe('unavailable');
  });
});

describe('pure restart planning', () => {
  it('plans a crash before the launch marker as a single dispatch, not an automatic launch', async () => {
    const f = fake();
    const snapshot = record();
    expect(planRecovery(snapshot)).toEqual({ effectId: 'effect-1', action: 'dispatch-once', reason: 'never-attempted' });
    expect(f.run).not.toHaveBeenCalled();
    // The durable owner atomically writes launching BEFORE calling dispatch.
    const launching = { ...snapshot, launchState: 'launching' as const };
    const receipt = await f.executor().dispatch(intent());
    expect(planRecovery({ ...launching, receipt })).toMatchObject({ action: 'reconcile', runId: 'run-1' });
    expect(planRecovery(launching)).toMatchObject({ action: 'require-policy', reason: 'launch-ambiguous' });
    expect(snapshot).toEqual(record());
  });
  it.each(['launching', 'ambiguous'] as const)('never retries a crash in the %s window without a receipt', launchState => {
    expect(planRecovery(record({ launchState }))).toMatchObject({ action: 'require-policy', reason: 'launch-ambiguous' });
  });
  it('accepted receipts always reconcile even with a stale unattempted marker or lost reply', () => {
    expect(planRecovery(record({ receipt: accepted() }))).toMatchObject({ action: 'reconcile', runId: 'run-1', requiresResultPolicy: false });
    expect(planRecovery(record({ receipt: accepted(), replyState: 'lost' }))).toMatchObject({ action: 'reconcile', requiresResultPolicy: true });
    expect(planRecovery(record({ receipt: accepted(), outcome: terminal({ status: 'unknown', terminal: false }) }))).toMatchObject({ action: 'reconcile' });
  });
  it.each(['ok', 'error', 'timeout', 'killed'] as const)('settles confirmed terminal %s without another observation or launch', status => {
    const input = record({ receipt: accepted(), outcome: terminal({ status }) });
    expect(planRecovery(input)).toEqual({ effectId: 'effect-1', action: 'settle', reason: 'terminal-outcome', requiresResultPolicy: false });
    expect(planRecovery({ ...input, replyState: 'ambiguous' })).toMatchObject({ action: 'settle', requiresResultPolicy: true });
  });
  it('settles definitive admission rejection, never relaunching the same effect', () => {
    const receipt: EffectReceipt = { effectId: 'effect-1', status: 'rejected', runId: null, sessionKey: null,
      at: now, reason: 'missing-agent', admission: 'not-accepted' };
    expect(planRecovery(record({ receipt }))).toMatchObject({ action: 'settle', reason: 'dispatch-rejected' });
  });
  it('requires policy for ambiguous/lost replies and orphan outcomes, rather than dispatching', () => {
    for (const replyState of ['ambiguous', 'lost'] as const) {
      expect(planRecovery(record({ replyState }))).toMatchObject({ action: 'require-policy', reason: 'reply-ambiguous' });
    }
    expect(planRecovery(record({ outcome: terminal() }))).toMatchObject({ action: 'require-policy', reason: 'orphan-outcome' });
    expect(planRecovery(record({ outcome: terminal({ status: 'unknown', terminal: false }) }))).toMatchObject({ action: 'require-policy', reason: 'orphan-outcome' });
  });
  it('refuses mismatched journal identities', () => {
    expect(() => planRecovery(record({ receipt: accepted({ effectId: 'other' }) }))).toThrow('Receipt identity mismatch');
    expect(() => planRecovery(record({ receipt: accepted(), outcome: terminal({ effectId: 'other' }) }))).toThrow('Outcome identity mismatch');
    expect(() => planRecovery(record({ receipt: accepted(), outcome: terminal({ runId: 'other' }) }))).toThrow('Outcome identity mismatch');
  });
});
