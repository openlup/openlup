import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBffResponder } from '@openlup/platform/bff';
import { createDeliverySelectionBoundary, createShippingBindings } from '@openlup/platform/shipping';
import type { DeliveryOption } from '@openlup/platform/shipping/contracts';

const option = (carrier: string): DeliveryOption => ({ id: carrier, kind: 'courier', deliveryKind: 'courier', providerKind: 'provider-a', carrierKind: carrier,
  carrierCode: carrier, service: 'service-a', serviceCode: 'service-a', label: 'Configured delivery', description: 'Synthetic', pickupPointRequired: false, addressRequired: true });
const canonical = { id: 'POINT-1', provider: 'carrier-a', name: 'Canonical point', address: { line1: 'Point street 1', postalCode: '00001', city: 'Example', country: 'ZZ' } };
function boundary(valid: boolean, carriers: string[] = []) {
  const getById = vi.fn(async () => canonical), search = vi.fn(async () => []), fallback = vi.fn(async () => null);
  const value = createDeliverySelectionBoundary({ dictionary: { valid, options: [option('carrier-a'), option('carrier-b')] }, acceptedCatalog: [option('carrier-a')],
    allowedCarriers: new Set(carriers), fallbackValidation: fallback, pointSources: { 'carrier-a': { getById, search } } });
  return { ...value, getById, search, fallback };
}
it('requires an allowlist for a valid dictionary, while malformed dictionary uses the whole accepted catalogue by default', async () => {
  expect(await boundary(true).port.listOptions()).toEqual([]);
  expect(await boundary(false).port.listOptions()).toEqual([option('carrier-a')]);
  const narrowed = boundary(false, ['carrier-a','not-declared']);
  expect(narrowed.source).toBe('static_accepted_catalog'); expect(narrowed.enabledCarriers).toEqual(['carrier-a']);
  expect(await narrowed.port.listOptions()).toEqual([option('carrier-a')]);
  expect(await boundary(false, ['not-declared']).port.listOptions()).toEqual([]);
  expect(await boundary(true, ['carrier-b']).port.listOptions()).toEqual([option('carrier-b')]);
  expect(boundary(true, ['not-declared']).enabledCarriers).toEqual(['not-declared']);
});
it('returns canonical injected point evidence, trims only lookup input and leaves excluded sources without I/O', async () => {
  const enabled = boundary(true, ['carrier-a']);
  expect(await enabled.port.validatePickupPoint({ pointId: ' POINT-1 ', carrierKind: 'carrier-a' })).toEqual(canonical);
  expect(enabled.getById).toHaveBeenCalledWith('POINT-1');
  expect(await enabled.port.validatePickupPoint({ pointId: ' ', carrierKind: 'carrier-a' })).toBeNull();
  expect(enabled.getById).toHaveBeenCalledTimes(1);
  const excluded = boundary(true, ['carrier-b']);
  expect(await excluded.searchPort.searchPickupPoints({ carrierKind: 'carrier-a', query: 'Example' })).toEqual([]);
  expect(await excluded.port.validatePickupPoint({ carrierKind: 'carrier-a', pointId: 'POINT-1' })).toBeNull();
  expect(excluded.getById).not.toHaveBeenCalled(); expect(excluded.search).not.toHaveBeenCalled(); expect(excluded.fallback).not.toHaveBeenCalled();
  expect(await excluded.searchPort.searchPickupPoints({ carrierKind: 'carrier-b' })).toEqual([]);
  await excluded.port.validatePickupPoint({ carrierKind: 'carrier-b', pointId: 'POINT-2' });
  expect(excluded.fallback).toHaveBeenCalledWith({ carrierKind: 'carrier-b', pointId: 'POINT-2' });
});
it('preserves missing selection and handler validation, refusing provider-selected checkout values without inventing transport', async () => {
  const responder = createBffResponder();
  expect(createShippingBindings({ dataKind: 'postgres', responder }).handlers.options).toBeNull();
  const selection = boundary(true);
  const schemas = { deliveryOptionsResponseSchema: z.object({ contractVersion: z.literal('shipping.delivery_selection.v1'), options: z.array(z.object({ carrierKind: z.string(), service: z.string() })).min(1) }),
    pickupPointSearchRequestSchema: z.any(), pickupPointSearchResponseSchema: z.any(), pickupPointValidationRequestSchema: z.any(), pickupPointValidationResponseSchema: z.any() };
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  const bindings = createShippingBindings({ dataKind: 'postgres', responder, selection: { ...selection, schemas } });
  await bindings.handlers.options!({ method: 'GET', query: {} }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) }));
  res.json.mockClear();
  const providerSelected = createShippingBindings({ dataKind: 'postgres', responder,
    selection: { ...selection, port: { ...selection.port, listOptions: async () => [{ ...option('carrier-a'), carrierKind: null, service: null } as unknown as DeliveryOption] }, schemas } });
  await providerSelected.handlers.options!({ method: 'GET', query: {} }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) }));
});
