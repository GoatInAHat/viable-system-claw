import { Buffer } from 'node:buffer';

// Public feature transport envelope in the pinned OpenClaw 2026.10.10-beta.5 SDK.
// No public validator is exported. Keep this conservative preflight covered by real SDK tests.
const limits = { depth: 32, nodes: 4096, keys: 512, string: 65536, bytes: 262144 } as const;
export function assertTransportValue(value: unknown): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > limits.nodes || depth > limits.depth) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= limits.string;
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    if (typeof item !== 'object') return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(item);
    return entries.length <= limits.keys && entries.every(([key, child]) => key.length <= limits.string && visit(child, depth + 1));
  };
  if (!visit(value, 0) || Buffer.byteLength(JSON.stringify(value), 'utf8') > limits.bytes) {
    throw new Error('VSC projection exceeds the native feature transport budget; reduce graph detail or narrow compute candidates');
  }
}
