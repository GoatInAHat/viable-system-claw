import { describe, expect, it } from 'vitest';
import { createState } from './kernel.js';
import { bootstrapDocument, changeDocument, encodeDocument, readDocument, VSM_DOCUMENT_KEY, VSM_MAX_BYTES } from './state.js';
import type { DocumentStore } from './state.js';
import type { VsmState } from './types.js';

const base = () => createState({ rootId: 'root', principalId: 'human', charter: 'Synthetic obligation', now: 0 });

class MemoryStore implements DocumentStore {
  value: unknown = undefined;
  version = 0;
  conflicts = 0;
  failNextObserve = false;
  async observe(_key: string) {
    if (this.failNextObserve) { this.failNextObserve = false; throw new Error('STORAGE_DOWN'); }
    return { value: structuredClone(this.value), comparison: { version: this.version } };
  }
  async compareAndApply(_key: string, comparison: unknown,
    mutation: { operation: 'update'; action: 'set'; value: unknown }) {
    if ((comparison as { version: number }).version !== this.version) return { status: 'conflict' as const };
    if (this.conflicts > 0) { this.conflicts--; return { status: 'conflict' as const }; }
    this.value = structuredClone(mutation.value);
    this.version++;
    return { status: 'applied' as const };
  }
}

describe('durable VSM document', () => {
  it('round-trips a valid state and keeps the revision in step', () => {
    const state = base();
    const document = encodeDocument(state);
    expect(document.version).toBe(1);
    expect(document.revision).toBe(state.revision);
    const read = readDocument(structuredClone(document));
    expect(read).toEqual(document);
  });

  it('refuses an invalid envelope rather than reinterpreting retained bytes', () => {
    expect(() => readDocument({ version: 2, revision: 0, state: base() })).toThrow('VSC_VSM_ENVELOPE_INVALID');
    expect(() => readDocument({ version: 1, revision: 9, state: base() })).toThrow('VSC_VSM_REVISION_MISMATCH');
    const broken = encodeDocument(base());
    broken.state.units = {} as VsmState['units'];
    expect(() => readDocument(broken)).toThrow('VSC_VSM_STATE_INVALID');
  });

  it('refuses a mutation that exceeds the durable byte budget', () => {
    const state = base();
    state.charter.text = 'x'.repeat(VSM_MAX_BYTES + 1024);
    expect(() => encodeDocument(state)).toThrow('VC_VSM_BYTES');
  });

  it('bootstraps once and returns the existing document afterwards', async () => {
    const store = new MemoryStore();
    const first = await bootstrapDocument(store, base());
    expect(first.revision).toBe(0);
    const again = await bootstrapDocument(store, addRevision(base()));
    expect(again.revision).toBe(0);
  });

  it('retries only on explicit conflict', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, base());
    store.conflicts = 2;
    const result = await changeDocument(store, state => { state.revision++; return true; });
    expect(result.changed).toBe(true);
    expect(result.document.revision).toBe(1);
  });

  it('propagates storage faults without replaying the write', async () => {
    const store = new MemoryStore();
    await bootstrapDocument(store, base());
    store.failNextObserve = true;
    await expect(changeDocument(store, state => { state.revision++; return true; })).rejects.toThrow('STORAGE_DOWN');
    expect((readDocument(store.value) as { revision: number }).revision).toBe(0);
    expect(VSM_DOCUMENT_KEY).toBe('vsm-v1');
  });
});

function addRevision(state: VsmState): VsmState {
  const next = structuredClone(state);
  next.revision++;
  return next;
}
