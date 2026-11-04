import type { AllocationPlan } from '../compute/index.js';
import { assertTransportValue } from './transport.js';

/** Decisions consider every candidate. Only explanatory diagnostics are paged. */
export function planPage(plan: AllocationPlan, offset = 0) {
  if (offset > plan.candidates.length) throw new Error('Compute diagnostic offset is beyond the candidate list');
  const page = {
    ...plan, candidates: [] as AllocationPlan['candidates'],
    ...(plan.kind === 'blocked' ? { reasons: plan.candidates.length ? [] as string[] : plan.reasons } : {}),
    diagnostics: { candidateCount: plan.candidates.length, offset, nextOffset: offset < plan.candidates.length ? offset : null,
      reasonCount: plan.kind === 'blocked' ? plan.reasons.length : 0 },
  };
  assertTransportValue(page);
  for (let index = offset; index < plan.candidates.length; index++) {
    const candidate = plan.candidates[index]!;
    const candidates = [...page.candidates, candidate];
    const next = { ...page, candidates,
      ...(plan.kind === 'blocked' ? { reasons: candidates.flatMap(item => item.reasons.map(reason => `${item.modelId}:${reason}`)) } : {}),
      diagnostics: { ...page.diagnostics, nextOffset: index + 1 < plan.candidates.length ? index + 1 : null },
    };
    try { assertTransportValue(next); }
    catch { if (!page.candidates.length) throw new Error('One compute candidate exceeds the transport budget'); break; }
    Object.assign(page, next);
  }
  return page;
}
