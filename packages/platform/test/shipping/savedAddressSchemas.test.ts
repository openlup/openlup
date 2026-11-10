import { describe, expect, it } from 'vitest';
import { createCustomerSavedAddressRequestSchemas } from '@openlup/platform/shipping';
const policy = { country: 'ZZ', countryAliases: ['example'], phonePrefix: '99', normalizeTaxId: (value: string | null) => value?.replace(/\D/g, '') || null,
  isValidTaxId: (value: string) => value === '1234563218', messages: { name: 'name', country: 'country', phone: 'phone', postalCode: 'postal', taxId: 'tax' } };
const input = { idempotencyKey: 'address-key', kind: 'shipping', line1: ' Example 1 ', city: ' Example ', postalCode: '12345' };
const schemas = createCustomerSavedAddressRequestSchemas(policy);
describe('saved address request policy', () => {
  it('normalizes local selection and strips company/tax from shipping', () => {
    expect(schemas.customerAddressUpsertRequestSchema.safeParse({ ...input, country: 'example', recipientName: '  Example   Recipient ', contactPhone: '500 100 100', companyName: 'Ignored', taxId: 'invalid' }))
      .toMatchObject({ success: true, data: { line1: 'Example 1', city: 'Example', country: 'ZZ', postalCode: '12-345', contactPhone: '+99500100100', recipientName: 'Example Recipient', companyName: null, taxId: null } });
  });
  it('uses an alternate local binding without changing normalization rules', () => {
    const selected = createCustomerSavedAddressRequestSchemas({ ...policy, country: 'XY', countryAliases: ['sampleland','sample'], phonePrefix: '97' });
    expect(selected.customerAddressUpsertRequestSchema.safeParse({ ...input, country: 'Sampleland', contactPhone: '(97) 500-100-100', kind: 'both', taxId: '123-456-32-18' }))
      .toMatchObject({ success: true, data: { country: 'XY', contactPhone: '+97500100100', postalCode: '12-345', taxId: '1234563218' } });
    expect(selected.customerAddressUpsertRequestSchema.safeParse({ ...input, country: 'XY', contactPhone: '12345678' }).success).toBe(false);
  });
  it.each([{ recipientName: 'A' }, { recipientName: 'www.example.test' }, { country: 'Unknown country' }, { contactPhone: '123' }, { postalCode: 'invalid' },
    { kind: 'billing', taxId: 'bad-1' }, { line1: '' }, { line1: 'x'.repeat(241) }, { city: 'x'.repeat(161) }, { label: 'x'.repeat(121) },
    { deliveryNotes: 'x'.repeat(501) }, { courierInstructions: 'x'.repeat(501) }, { idempotencyKey: 'short' }, { addressId: 'invalid' }, { extra: true }])('refuses invalid or wider input %j', changes => {
    expect(schemas.customerAddressUpsertRequestSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  });
  it('preserves foreign phone length and postal rules and optional empty name semantics', () => {
    expect(schemas.customerAddressUpsertRequestSchema.safeParse({ ...input, country: 'US', postalCode: 'ABC 123', contactPhone: 'local-call', recipientName: '   ' }))
      .toMatchObject({ success: true, data: { contactPhone: 'local-call', recipientName: null, postalCode: 'ABC 123' } });
  });
  it('refuses malformed policy configuration', () => {
    expect(() => createCustomerSavedAddressRequestSchemas({ ...policy, country: 'TOO' })).toThrow();
    expect(() => createCustomerSavedAddressRequestSchemas({ ...policy, phonePrefix: 'x' })).toThrow();
  });
});
