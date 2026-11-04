import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { assertJson, assertValid, validateState } from './kernel.js';
import type { VsmState } from './types.js';

/** One retained document holds the whole rooted organization. */
export const VSM_DOCUMENT_KEY = 'vsm-v1';
/** Below every native JSON transport limit, with headroom for UI projections. */
export const VSM_MAX_BYTES = 900 * 1024;
export const VSM_MAX_ATTEMPTS = 8;

const EnvelopeSchema = Type.Object({
  version: Type.Literal(1),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  state: Type.Unknown(),
}, { additionalProperties: false });

export interface VsmDocument {
  version: 1;
  revision: number;
  state: VsmState;
}

export type DocumentStore = {
  observe(key: string): Promise<{ value: unknown; comparison: unknown }>;
  compareAndApply(key: string, comparison: unknown,
    mutation: { operation: 'update'; action: 'set'; value: unknown }): Promise<{ status: 'applied' | 'conflict' | 'unchanged' }>;
};

export function encodeDocument(state: VsmState): VsmDocument {
  assertJson(state);
  assertValid(state);
  const document: VsmDocument = { version: 1, revision: state.revision, state };
  const bytes = new TextEncoder().encode(JSON.stringify(document)).length;
  if (bytes > VSM_MAX_BYTES) throw new Error('VC_VSM_BYTES');
  return document;
}

/**
 * Refuses to reinterpret retained bytes. Invalid state stays readable on disk and
 * blocks mutation until an operator repairs or explicitly discards it.
 */
export function readDocument(value: unknown): VsmDocument | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Value.Check(EnvelopeSchema, value)) throw new Error('VSC_VSM_ENVELOPE_INVALID');
  const document = value as VsmDocument;
  assertJson(document);
  if (!document.state || document.state.version !== 1) throw new Error('VSC_VSM_STATE_INVALID');
  if (document.revision !== document.state.revision) throw new Error('VSC_VSM_REVISION_MISMATCH');
  const errors = validateState(document.state);
  if (errors.length) throw new Error('VSC_VSM_STATE_INVALID');
  return { version: 1, revision: document.revision, state: structuredClone(document.state) };
}

export async function bootstrapDocument(store: DocumentStore, state: VsmState): Promise<VsmDocument> {
  const observed = await store.observe(VSM_DOCUMENT_KEY);
  if (observed.value !== undefined && observed.value !== null) {
    const existing = readDocument(observed.value);
    if (!existing) throw new Error('VSC_VSM_BOOTSTRAP_CONFLICT');
    return existing;
  }
  const document = encodeDocument(state);
  const result = await store.compareAndApply(VSM_DOCUMENT_KEY, observed.comparison,
    { operation: 'update', action: 'set', value: document });
  if (result.status !== 'applied') throw new Error('VSC_VSM_BOOTSTRAP_CONFLICT');
  return document;
}

/**
 * CAS with recomputation on explicit conflict only. Storage faults propagate and are
 * never retried, because an unknown write outcome cannot be safely replayed.
 */
export async function changeDocument(
  store: DocumentStore,
  decide: (state: VsmState) => boolean,
): Promise<{ document: VsmDocument; changed: boolean }> {
  for (let attempt = 0; attempt < VSM_MAX_ATTEMPTS; attempt++) {
    const observed = await store.observe(VSM_DOCUMENT_KEY);
    const current = readDocument(observed.value);
    if (!current) throw new Error('VSC_VSM_NOT_BOOTSTRAPPED');
    const next = structuredClone(current.state);
    if (!decide(next)) return { document: current, changed: false };
    const document = encodeDocument(next);
    const result = await store.compareAndApply(VSM_DOCUMENT_KEY, observed.comparison,
      { operation: 'update', action: 'set', value: document });
    if (result.status === 'applied') return { document, changed: true };
    if (result.status === 'unchanged') throw new Error('VSC_VSM_UNEXPECTEDLY_UNCHANGED');
  }
  throw new Error('VSC_VSM_CONCURRENT');
}
