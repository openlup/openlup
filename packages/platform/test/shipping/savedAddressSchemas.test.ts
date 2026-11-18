import { describe, expect, it } from 'vitest';
import { createCustomerSavedAddressRequestSchemas, type CustomerSavedAddressValidationPolicy } from '@openlup/platform/shipping';
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

// D: frozen built-in behavior, also used by an existing host's explicit local-country binding.
const defaultFormats = [
  { postalCode: '12345', contactPhone: '500 100 100', postal: '12-345', phone: '+48500100100' },
  { postalCode: ' 12-345 ', contactPhone: '+48 (500) 100-100', postal: '12-345', phone: '+48500100100' },
  { postalCode: 'ab12345', contactPhone: '48 500 100 100', postal: '12-345', phone: '+48500100100' },
  { postalCode: '12345', contactPhone: '   ', postal: '12-345', phone: null },
  { postalCode: '12345', contactPhone: null, postal: '12-345', phone: null },
  { postalCode: '12345', postal: '12-345', phone: null },
  { postalCode: '123456', contactPhone: '500100100', invalid: 'postalCode' },
  { postalCode: '12345', contactPhone: '12345678', invalid: 'contactPhone' },
  { postalCode: '12345', contactPhone: '+99 500100100', invalid: 'contactPhone' },
  { foreign: true, postalCode: ' ab   123 ', contactPhone: 'local-call', postal: 'AB 123', phone: 'local-call' },
  { foreign: true, postalCode: '12345', contactPhone: '+48 500100100', postal: '12345', phone: '+48 500100100' },
  { foreign: true, postalCode: 'A12', contactPhone: '123456', postal: 'A12', phone: '123456' },
  { foreign: true, postalCode: 'A12', contactPhone: '1'.repeat(32), postal: 'A12', phone: '1'.repeat(32) },
  { foreign: true, postalCode: 'A12', contactPhone: '12345', invalid: 'contactPhone' },
  { foreign: true, postalCode: 'A12', contactPhone: '1'.repeat(33), invalid: 'contactPhone' },
  { foreign: true, postalCode: 'AB', invalid: 'postalCode' },
  { foreign: true, postalCode: 'A_B', invalid: 'postalCode' },
] as const;
describe.each([
  { name: 'default binding', country: 'ZZ', countryAliases: ['example'], phonePrefix: '48' },
  { name: 'compatible host binding', country: 'XY', countryAliases: ['sampleland', 'sample'], phonePrefix: '48' },
])('$name without local callbacks', ({ country, countryAliases, phonePrefix }) => {
  const schema = createCustomerSavedAddressRequestSchemas({ ...policy, country, countryAliases, phonePrefix }).customerAddressUpsertRequestSchema;
  it.each(defaultFormats)('preserves input/output %j', row => {
    const result = schema.safeParse({ ...input, postalCode: row.postalCode,
      contactPhone: 'contactPhone' in row ? row.contactPhone : undefined, country: 'foreign' in row ? 'us' : ` ${countryAliases[0]!.toUpperCase()} ` });
    if ('invalid' in row) {
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.flatten()).toMatchObject({ fieldErrors: { [row.invalid]: [row.invalid === 'postalCode' ? 'postal' : 'phone'] } });
    } else expect(result).toMatchObject({ success: true, data: { postalCode: row.postal, contactPhone: row.phone, country: 'foreign' in row ? 'US' : country } });
  });
});

const local = {
  normalizePostalCode: (value: string) => value.replace(/ /g, ''),
  isValidPostalCode: (value: string) => /^[A-Z]{2}\d{4}$/.test(value),
  normalizePhone: (value: string) => /^\d{8}$/.test(value) ? `+991${value}` : /^\+991\d{8}$/.test(value) ? value : null,
};
describe('optional local address formats', () => {
  const schema = createCustomerSavedAddressRequestSchemas({ ...policy, local }).customerAddressUpsertRequestSchema;
  it('normalizes before validating only for the selected local country and its aliases', () => {
    const seen: string[] = [];
    const selected = createCustomerSavedAddressRequestSchemas({ ...policy, local: {
      ...local, normalizePostalCode(value) { seen.push(value); return local.normalizePostalCode(value); },
      normalizePhone(value) { seen.push(value); return local.normalizePhone(value); },
    } }).customerAddressUpsertRequestSchema;
    for (const country of [undefined, 'zz', ' EXAMPLE ']) {
      expect(selected.safeParse({ ...input, country, postalCode: ' ab   1234 ', contactPhone: ' 12345678 ' }))
        .toMatchObject({ success: true, data: { country: 'ZZ', postalCode: 'AB1234', contactPhone: '+99112345678' } });
    }
    expect(new Set(seen)).toEqual(new Set(['AB 1234', '12345678']));
  });
  it.each([
    { postalCode: '12345', contactPhone: '12345678', field: 'postalCode', message: 'postal' },
    { postalCode: 'AB1234', contactPhone: '500100100', field: 'contactPhone', message: 'phone' },
  ])('refuses the field with its policy message %j', ({ field, message, ...values }) => {
    const result = schema.safeParse({ ...input, ...values });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten()).toMatchObject({ fieldErrors: { [field]: [message] } });
  });
  it('keeps optional phone and foreign formats outside the callbacks', () => {
    const throwing = () => { throw new Error('must_not_run'); };
    const selected = createCustomerSavedAddressRequestSchemas({ ...policy, local: {
      normalizePostalCode: throwing, isValidPostalCode: throwing, normalizePhone: throwing,
    } }).customerAddressUpsertRequestSchema;
    expect(selected.safeParse({ ...input, country: 'US', postalCode: ' ab 123 ', contactPhone: ' local-call ' }))
      .toMatchObject({ success: true, data: { postalCode: 'AB 123', contactPhone: 'local-call' } });
    expect(schema.safeParse({ ...input, postalCode: 'AB1234' })).toMatchObject({ success: true, data: { contactPhone: null } });
  });
  it.each(['normalizePostalCode', 'isValidPostalCode', 'normalizePhone'] as const)('refuses a throwing %s on its field', callback => {
    const selected = createCustomerSavedAddressRequestSchemas({ ...policy, local: {
      ...local, [callback]: () => { throw new Error('private_callback_failure'); },
    } }).customerAddressUpsertRequestSchema;
    const result = selected.safeParse({ ...input, postalCode: 'AB1234', contactPhone: '12345678' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten()).toEqual({ formErrors: [], fieldErrors: callback === 'normalizePhone'
      ? { contactPhone: ['phone'] } : { postalCode: ['postal'] } });
  });
  it.each(['normalizePostalCode', 'normalizePhone'] as const)('refuses a %s throw during output normalization', callback => {
    let calls = 0;
    const selected = createCustomerSavedAddressRequestSchemas({ ...policy, local: {
      ...local, [callback]: (value: string) => { if (++calls === 2) throw new Error('output_failure'); return local[callback](value); },
    } }).customerAddressUpsertRequestSchema;
    expect(selected.safeParse({ ...input, postalCode: 'AB1234', contactPhone: '12345678' }).success).toBe(false);
  });
  it.each([
    { ...local, normalizePostalCode: () => 'A'.repeat(25), isValidPostalCode: () => true },
    { ...local, normalizePostalCode: () => '', isValidPostalCode: () => true },
    { ...local, normalizePhone: () => '1'.repeat(65) },
    { ...local, normalizePhone: () => '' },
  ])('keeps platform bounds on callback output', override => {
    expect(createCustomerSavedAddressRequestSchemas({ ...policy, local: override }).customerAddressUpsertRequestSchema
      .safeParse({ ...input, postalCode: 'AB1234', contactPhone: '12345678' }).success).toBe(false);
  });
  it.each([{ postalCode: 'A'.repeat(25) }, { contactPhone: '1'.repeat(65) }])('keeps platform bounds on callback input %j', values => {
    expect(schema.safeParse({ ...input, postalCode: 'AB1234', contactPhone: '12345678', ...values }).success).toBe(false);
  });
  it.each([null, {}, ...['normalizePostalCode', 'isValidPostalCode', 'normalizePhone'].map(name => ({ ...local, [name]: 'invalid' }))])('refuses malformed callback configuration %j', override => {
    expect(() => createCustomerSavedAddressRequestSchemas({ ...policy, local: override as unknown as CustomerSavedAddressValidationPolicy['local'] }))
      .toThrow('saved_address_policy_invalid');
  });
});
