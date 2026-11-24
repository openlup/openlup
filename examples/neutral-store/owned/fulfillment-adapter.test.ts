import assert from 'node:assert/strict';
import test from 'node:test';
import type { FulfillmentProviderAdapter } from '@openlup/platform/fulfillment/contracts';
import { createOwnedFulfillmentRegistry } from './fulfillment-adapter.ts';

function buildStubFulfillmentAdapter(providerRef: string): FulfillmentProviderAdapter {
  const unsupported = { supported: false as const, reason: 'not_exposed' as const };
  return {
    capabilities: {
      providerRef,
      role: 'warehouse',
      operations: {
        dispatch: { supported: true },
        readback: unsupported,
        exactAbsence: unsupported,
        verifyObservation: unsupported,
        syncStock: unsupported,
        syncProducts: unsupported,
        labelCreate: unsupported,
        labelRead: unsupported,
        labelVoid: unsupported,
        cancel: unsupported,
        pickupPoint: unsupported,
        courierPickup: unsupported,
      },
      authentication: 'token',
      freshness: 'not_available',
      defaultOff: true,
      selected: true,
      readiness: { ready: true },
      ownsDeliveredNotification: false,
      stockAuthority: 'local_atp',
      labelReadOwner: 'none',
      actionPolicy: {
        providerSpecificAdminActions: false,
        genericAdminActions: true,
        mutationSurface: 'provider_adapter',
      },
    },
    dispatch: {
      async prepare() {
        return { kind: 'refused', refusal: { reason: 'not_ready', phase: 'prepare', retryable: false } };
      },
      async dispatch() {
        return {
          kind: 'not_dispatched',
          effectMayHaveSucceeded: false,
          refusal: { reason: 'not_ready', phase: 'dispatch', retryable: false },
        };
      },
    },
  };
}

test('createOwnedFulfillmentRegistry defaults to zero-credential sandbox mode', () => {
  const result = createOwnedFulfillmentRegistry();
  assert.equal(result.mode, 'sandbox');
  assert.equal(result.registry, null);
});

test('createOwnedFulfillmentRegistry mounts external fulfillment recipes into a provider registry', () => {
  const stub = buildStubFulfillmentAdapter('stub_3pl');
  const composed = createOwnedFulfillmentRegistry({ adapters: [stub] });
  assert.equal(composed.mode, 'provider');
  assert.ok(composed.registry);
  assert.equal(composed.registry.get('stub_3pl'), stub);
  assert.deepEqual(composed.registry.refs(), ['stub_3pl']);
});
