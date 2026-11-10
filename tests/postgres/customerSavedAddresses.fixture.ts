import { createPostgresCustomerSavedAddressPort, type SavedAddressQueryExecutor, type CustomerSavedAddressValidationPolicy } from '@openlup/platform/shipping/postgres';
import type { CustomerAddressesResponse } from '@openlup/platform/shipping/contracts';
export const ADDRESS_AT = '2026-11-10T19:00:00.000Z';
export const addressValidation: CustomerSavedAddressValidationPolicy = {
  country: 'ZZ', countryAliases: ['example'], phonePrefix: '99',
  normalizeTaxId: value => { const digits = (value ?? '').replace(/\D/g, ''); return digits || null; },
  isValidTaxId: value => /^\d{10}$/.test(value) && [6,5,7,2,3,4,5,6,7].reduce((sum, weight, index) => sum + weight * Number(value[index]), 0) % 11 === Number(value[9]),
  messages: { name: 'Invalid name', country: 'Invalid country', phone: 'Invalid phone', postalCode: 'Invalid postal code', taxId: 'Invalid tax identifier' },
};
export function savedAddressPort(executor: SavedAddressQueryExecutor, principalId: string, clientId: string) {
  return createPostgresCustomerSavedAddressPort(executor, { principalId, clientId }, { validation: addressValidation,
    readOrdererProfiles: async () => [], now: () => ADDRESS_AT, inUseMessage: 'Address is used by an active subscription' });
}
export function addressId(book: CustomerAddressesResponse | null) { if (!book?.addresses[0]) throw new Error('address_fixture_missing'); return book.addresses[0].addressId; }
