import { expect, it, vi } from 'vitest';
import { createM08FulfillmentReferenceBinding } from './m08FulfillmentBinding.js';
import { profile, request } from '../../../tests/helpers/fulfillmentComposition.js';

it('default-off binding refuses every entry before invoking a worker, transaction or authoritative reader', async () => {
  const run = vi.fn(), readAuthoritative = vi.fn(), readiness = vi.fn(), listCandidates = vi.fn(), apply = vi.fn();
  const binding = createM08FulfillmentReferenceBinding({ transactions: { run, close: async () => {} }, preparation: { readAuthoritative },
    services: { selection: request().selection, capability: profile(), provider: { prepare: vi.fn(), dispatch: vi.fn() }, readiness, listCandidates,
      config: { mode: 'live', batchLimit: 10 }, keys: { request: v => v.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) } },
    version: '0.21.0', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
  const refusal = { kind: 'refused', refusal: { reason: 'disabled', phase: 'selection', retryable: false } };
  expect(await binding.services.runDispatch()).toEqual(refusal);
  expect(await binding.prepare('shipment')).toEqual(refusal);
  expect(await binding.editAuthoritative({ fulfillmentRef: 'shipment', actorUserId: 'actor', idempotencyKey: 'edit' }, apply)).toEqual(refusal);
  expect(binding.contributions[0].schedules).toEqual([]);
  for (const callback of [run, readAuthoritative, readiness, listCandidates, apply]) expect(callback).not.toHaveBeenCalled();
});
