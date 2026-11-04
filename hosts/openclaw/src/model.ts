/** Serializable, credential-free projection shared by native views and backend. */
export type UnitStatus = 'idle' | 'running' | 'waiting' | 'blocked' | 'unknown';
export interface Unit { id: string; parentId?: string; name: string; purpose: string; status: UnitStatus; session?: { sessionKey: string; agentId: string }; updatedAt: number; }
export interface Relation { id: string; source: string; target: string; kind: 'communication' | 'coordination' | 'resource' | 'audit'; label?: string; }
export interface Activity { id: string; unitId: string; targetUnitId?: string; kind: 'run-start' | 'run-end' | 'tool-start' | 'tool-end' | 'message' | 'error'; at: number; runId?: string; toolCallId?: string; label?: string; }
export interface GraphSnapshot { revision: number; observedAt: number; units: Unit[]; relations: Relation[]; activities: Activity[]; coverage: 'live' | 'partial' | 'disconnected'; }
export interface QuotaWindow { id: string; label: string; usedFraction: number; resetsAt?: number; windowMs?: number; }
export interface ComputePool { id: string; label: string; kind: 'throughput' | 'subscription' | 'metered'; observedAt: number; status: 'available' | 'unavailable' | 'unknown'; concurrency?: number; active?: number; windows: QuotaWindow[]; }
export interface ModelProfile { id: string; poolId: string; label: string; capabilities: string[]; observedAt: number; quality?: number; samples: number; quotaCost?: Record<string, number>; latencyMs?: number; }
export interface Allocation { id: string; unitId: string; modelId?: string; status: 'proposed' | 'admitted' | 'running' | 'blocked' | 'finished'; reason: string; at: number; }
export interface ComputeSnapshot { revision: number; observedAt: number; pools: ComputePool[]; models: ModelProfile[]; allocations: Allocation[]; }
