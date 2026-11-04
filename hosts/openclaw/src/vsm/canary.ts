import { statfs } from 'node:fs/promises';

/** Read-only host-health purpose. It observes; it never repairs, restarts or writes outside VSM state. */
export interface CanaryThresholds {
  latencyMs: number;
  diskUsedRatio: number;
  inodeUsedRatio: number;
}

export const CANARY_THRESHOLDS: CanaryThresholds = {
  latencyMs: 3000,
  diskUsedRatio: 0.92,
  inodeUsedRatio: 0.92,
};

export interface CanarySample {
  at: number;
  readyz: { status: number | null; latencyMs: number | null; error: boolean };
  disk: { usedRatio: number | null };
  inodes: { usedRatio: number | null };
}

export interface CanaryObservation {
  index: number;
  topic: 'health.ready' | 'health.disk' | 'health.inodes';
  evidence: number;
  evidenceRef: string;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

export async function sampleCanary(options: {
  now: number;
  readyzUrl: string;
  filesystemPath: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<CanarySample> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const started = Date.now();
  let readyz: CanarySample['readyz'] = { status: null, latencyMs: null, error: true };
  if (fetchImpl) {
    try {
      const response = await fetchImpl(options.readyzUrl, { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
      readyz = { status: response.status, latencyMs: Date.now() - started, error: false };
    } catch {
      readyz = { status: null, latencyMs: Date.now() - started, error: true };
    }
  }
  let disk: CanarySample['disk'] = { usedRatio: null };
  let inodes: CanarySample['inodes'] = { usedRatio: null };
  try {
    const stats = await statfs(options.filesystemPath);
    const blocks = Number(stats.blocks);
    const free = Number(stats.bfree);
    const files = Number(stats.files);
    const filesFree = Number(stats.ffree);
    disk = { usedRatio: blocks > 0 ? 1 - free / blocks : null };
    inodes = { usedRatio: files > 0 ? 1 - filesFree / files : null };
  } catch {
    // Unreadable counters stay null: absent evidence is not a healthy reading.
  }
  return { at: options.now, readyz, disk, inodes };
}

/**
 * Deterministic log-likelihood scores. Healthy samples carry a small negative score so a
 * persistent fault must accumulate rather than latch on one noisy observation.
 */
export function canaryObservations(sample: CanarySample, thresholds = CANARY_THRESHOLDS): CanaryObservation[] {
  const observations: CanaryObservation[] = [];
  const push = (topic: CanaryObservation['topic'], evidence: number): void => {
    const index = observations.length + 1;
    observations.push({ index, topic, evidence, evidenceRef: `canary:${sample.at}:${topic}:${index}` });
  };
  if (sample.readyz.error) push('health.ready', 3.0);
  else if (sample.readyz.status !== 200) push('health.ready', 2.0);
  else if ((sample.readyz.latencyMs ?? 0) > thresholds.latencyMs) push('health.ready', 1.0);
  else push('health.ready', -0.5);

  if (sample.disk.usedRatio === null) push('health.disk', 1.0);
  else if (sample.disk.usedRatio >= thresholds.diskUsedRatio) push('health.disk', 2.5);
  else push('health.disk', -0.5);

  if (sample.inodes.usedRatio === null) push('health.inodes', 1.0);
  else if (sample.inodes.usedRatio >= thresholds.inodeUsedRatio) push('health.inodes', 2.5);
  else push('health.inodes', -0.5);
  return observations;
}
