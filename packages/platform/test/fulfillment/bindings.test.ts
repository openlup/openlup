import { expect, it, vi } from 'vitest';
import { checkReadiness } from '@openlup/core/readiness';
import { createBundleComposer, createFulfillmentContribution } from '../../src/composition/index.js';
import { createFulfillmentServices } from '../../src/fulfillment/index.js';
import type { FulfillmentServicesOptions } from '../../src/fulfillment/contracts/index.js';
import { request as candidate, memoryStore, profile } from './fixtures.js';

function options(): FulfillmentServicesOptions {
  const request = candidate();
  return {
    selection: request.selection, capability: profile(), store: memoryStore(),
    provider: { async prepare() { throw new Error('no candidates'); }, async dispatch() { throw new Error('no candidates'); } },
    readiness: async () => ({ ready: true }), listCandidates: async () => [],
    keys: { request: value => value.requestKey, mappedAttempt: (key, index) => `${key}:${index}`,
      acceptance: ref => ({ providerAttemptKey: `${ref}:attempt`, labelKey: `${ref}:label` }) },
    config: { mode: 'live', batchLimit: 10 },
  };
}
it.each(['off', 'not_ready'] as const)('services refuse %s before any worker read or write', async scenario => {
  const input = options(), sweep = vi.spyOn(input.store!, 'markStaleSubmissionsUncertain'), list = vi.fn(input.listCandidates);
  const observe = vi.fn(async () => ({ ready: false as const, refusal: { reason: 'not_ready' as const, phase: 'selection' as const, retryable: false } }));
  const services = createFulfillmentServices({ ...input, enabled: scenario === 'not_ready', readiness: observe, listCandidates: list });
  expect(await services.runDispatch()).toMatchObject({ kind: 'refused', refusal: { reason: scenario === 'off' ? 'disabled' : 'not_ready' } });
  expect(sweep).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(scenario === 'off' ? 0 : 1);
});
it('explicit ready services bind one executor and run only on invocation', async () => {
  const input = options(), sweep = vi.spyOn(input.store!, 'markStaleSubmissionsUncertain'), observe = vi.fn(input.readiness);
  const services = createFulfillmentServices({ ...input, enabled: true, readiness: observe });
  expect(createBundleComposer({ blob: () => null })({}).ports).not.toHaveProperty('fulfillment');
  expect(createBundleComposer({ blob: () => null, fulfillment: () => services })({}).ports.fulfillment).toBe(services);
  expect(sweep).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
  expect(await services.runDispatch()).toMatchObject({ ok: true, checked: 0 });
  expect(sweep).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledOnce();
});
it('contribution readiness refuses duplicate event, schedule and route ownership without invoking them', async () => {
  const run = vi.fn(), schema = { version: 'fixture', migration: 'fixture', objects: [] };
  const binding = createFulfillmentContribution({ version: '0.21.0', requiredSchema: schema, fulfillment: { dispatch: run },
    handlers: [{ eventType: 'OrderPaid', timeoutMs: 1000 }], schedules: [{ id: 'dispatch', cadenceSeconds: 60, run }], routes: [{ id: 'orders', handle: run }] });
  const input = { candidate: { artifact: 'fixture', configuration: 'fixture', environment: 'fixture', database: 'fixture', schema: 'fixture' }, inventoryComplete: true as const,
    loadedPackages: [{ name: '@openlup/core', version: '0.21.0', kind: 'kernel' as const }, { name: '@openlup/platform', version: '0.21.0', kind: 'rail' as const, modules: ['fulfillment'] }],
    contributions: binding.contributions, vocabulary: [{ eventType: 'OrderPaid', owner: '@openlup/platform/fulfillment' }], exemptions: [],
    bindings: { ports: binding.ports, routes: binding.routes, triggers: binding.triggers, env: {} },
    schemaProbe: { async observe() { return { database: 'fixture', version: 'fixture', objects: [] }; } } };
  expect((await checkReadiness(input)).state).toBe('ready');
  const duplicate = await checkReadiness({ ...input, contributions: [...binding.contributions, ...binding.contributions] });
  expect(duplicate.state).toBe('unsatisfied');
  expect(duplicate.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'OPENLUP_E_EVENT_DUPLICATE' }),
    expect.objectContaining({ subject: 'schedule:dispatch' }), expect.objectContaining({ subject: 'route:orders' }),
  ]));
  expect(run).not.toHaveBeenCalled();
});
