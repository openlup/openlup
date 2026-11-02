import { afterEach, expect, it, vi } from 'vitest';
import { createM08FulfillmentReferenceBinding as referenceBinding } from '../../server/runtime/public-reference/m08FulfillmentBinding.js';
import * as nativeBinding from '@openlup/platform/fulfillment/native';
import { createFulfillmentContribution } from '@openlup/platform/composition';
import { profile, request } from '../helpers/fulfillmentComposition.js';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('delegates host methods and adds exactly the contribution, bound=%s', bound => {
  const factory = vi.spyOn(nativeBinding, 'createNativeFulfillmentBinding');
  const input = { transactions: bound ? { run: async () => { throw new Error('must_not_run'); }, close: async () => {} } : null,
    preparation: { readAuthoritative: vi.fn() },
    services: { selection: request().selection, capability: profile(), provider: { prepare: vi.fn(), dispatch: vi.fn() }, readiness: vi.fn(), listCandidates: vi.fn(),
      config: { mode: 'live' as const, batchLimit: 10 }, keys: { request: (v: { requestKey: string }) => v.requestKey, mappedAttempt: (key: string) => key, acceptance: (ref: string) => ({ providerAttemptKey: ref, labelKey: ref }) } },
    version: '0.21.0', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } };
  const facade = referenceBinding(input);
  expect(factory).toHaveBeenCalledExactlyOnceWith(input);
  const packaged = factory.mock.results[0]!.value as ReturnType<typeof nativeBinding.createNativeFulfillmentBinding>;
  expect(facade.services).toBe(packaged.services);
  expect(facade.prepare).toBe(packaged.prepare);
  expect(facade.editAuthoritative).toBe(packaged.editAuthoritative);
  const contribution = createFulfillmentContribution({ version: packaged.version, requiredSchema: packaged.requiredSchema,
    fulfillment: { dispatch: packaged.dispatch }, handlers: [], schedules: [], routes: [] });
  expect(facade).toEqual({ services: packaged.services, ...contribution, prepare: packaged.prepare, editAuthoritative: packaged.editAuthoritative });
  expect(Object.keys(facade).sort()).toEqual(['services', 'ports', 'contributions', 'routes', 'triggers', 'prepare', 'editAuthoritative'].sort());
  expect(packaged.dispatch).toBe(bound ? packaged.services.runDispatch : null);
  expect(packaged).not.toHaveProperty('contributions');
});
