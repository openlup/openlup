import { createPostgresCustomerPreferencePort, type SavedAddressQueryExecutor, type CustomerPreferencePolicy } from '@openlup/platform/shipping';
export const preferencePolicy: CustomerPreferencePolicy = { methods: { instant: 'instant',card: 'card',transfer: 'transfer' },providers: { warehouse: 'warehouse-a',carrier: 'carrier-a',manual: 'manual-a',simulator: 'simulator-a' } };
export const preferenceAt = '2026-11-11T00:00:00.000Z';
export const courierPreference = { scope: 'subscription' as const,deliveryKind: 'courier' as const,providerKind: 'warehouse-a',carrierKind: 'carrier-a',carrierCode: 'courier-a',serviceCode: 'standard',pickupPoint: null };
export const preferencePort = (db: SavedAddressQueryExecutor,principalId: string,clientId: string) => createPostgresCustomerPreferencePort(db,{ principalId,clientId },preferencePolicy,{ now: () => preferenceAt,readOrdererHints: async () => [] });
