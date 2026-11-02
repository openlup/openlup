import { expect, it, vi } from 'vitest';
import { createNativeFulfillmentBinding } from '@openlup/platform/fulfillment/native';
import { createFulfillmentContribution } from '@openlup/platform/composition';
import { profile, request } from './fixtures.js';
import { createNativeFulfillmentBinding as builtBinding } from '../../dist/fulfillment/native/index.js';

it('default-off binding refuses every entry before invoking a worker, transaction or authoritative reader', async () => {
  const run = vi.fn(), readAuthoritative = vi.fn(), readiness = vi.fn(), listCandidates = vi.fn(), apply = vi.fn();
  const binding = createNativeFulfillmentBinding({ transactions: { run, close: async () => {} }, preparation: { readAuthoritative },
    services: { selection: request().selection, capability: profile(), provider: { prepare: vi.fn(), dispatch: vi.fn() }, readiness, listCandidates,
      config: { mode: 'live', batchLimit: 10 }, keys: { request: v => v.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) } },
    version: '0.21.0', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
  const refusal = { kind: 'refused', refusal: { reason: 'disabled', phase: 'selection', retryable: false } };
  expect(await binding.services.runDispatch()).toEqual(refusal);
  expect(await binding.prepare('shipment')).toEqual(refusal);
  expect(await binding.editAuthoritative({ fulfillmentRef: 'shipment', actorUserId: 'actor', idempotencyKey: 'edit' }, apply)).toEqual(refusal);
  const contribution = createFulfillmentContribution({ version: binding.version, requiredSchema: binding.requiredSchema,
    fulfillment: { dispatch: binding.dispatch }, handlers: [], schedules: [], routes: [] });
  expect(contribution.contributions[0].schedules).toEqual([]);
  expect(binding).not.toHaveProperty('contributions');
  for (const callback of [run, readAuthoritative, readiness, listCandidates, apply]) expect(callback).not.toHaveBeenCalled();
});

it('keeps the public package entry and built package constructor identical', () => {
  expect(createNativeFulfillmentBinding).toBe(builtBinding);
});
