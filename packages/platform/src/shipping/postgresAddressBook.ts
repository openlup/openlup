import { z } from 'zod';
import type { CustomerAddressReadStore } from './addressPorts.js';
import type { CustomerAddressesResponse, CustomerAddressUpsertRequest, CustomerAddressDeleteRequest } from './contracts/address.js';
export interface CustomerSavedAddressPort {
  getAddressBook(userId: string): Promise<CustomerAddressesResponse | null>;
  upsertAddress(userId: string, input: CustomerAddressUpsertRequest): Promise<CustomerAddressesResponse | null>;
  deleteAddress(userId: string, input: CustomerAddressDeleteRequest): Promise<CustomerAddressesResponse | null>;
}
import { createCustomerSavedAddressRequestSchemas, type CustomerSavedAddressValidationPolicy } from "./customerSavedAddressSchemas.js";
import { canonicalAddressKey } from './addressCanonical.js';
import { addressRow, readAddresses, readOrdererProfiles } from './customerSelfServiceAddressModels.js';
export interface SavedAddressQueryExecutor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface CustomerSavedAddressScope { principalId: string; clientId: string }
export interface CustomerSavedAddressOptions {
  validation: CustomerSavedAddressValidationPolicy;
  now(): string;
  /** Explicit billing-profile reader; this port does not install a billing store. */
  readOrdererProfiles(clientId: string): Promise<Record<string, unknown>[]>;
  inUseMessage: string;
}
export type CustomerSavedAddressRefusalCode = 'address_scope_mismatch' | 'address_invalid_input' | 'address_invalid_response' | 'address_in_use' | 'address_not_found' | 'address_event_append_failed';
export class CustomerSavedAddressRefused extends Error {
  constructor(readonly code: CustomerSavedAddressRefusalCode, message = code as string) { super(message); }
}
/** Each query call commits separately, matching default-clear/write/event failure and replay behavior. */
export function createPostgresCustomerSavedAddressPort(executor: SavedAddressQueryExecutor, scope: CustomerSavedAddressScope,
  options: CustomerSavedAddressOptions): CustomerSavedAddressPort {
  const principal = z.guid().parse(scope.principalId), client = z.guid().parse(scope.clientId);
  const country = z.string().regex(/^[A-Z]{2}$/).parse(options.validation.country);
  const requests = createCustomerSavedAddressRequestSchemas(options.validation);
  if (!options.inUseMessage.trim() || typeof options.readOrdererProfiles !== 'function') throw new Error('saved_address_configuration_invalid');
  const identity = [principal, client];
  function refuse(code: CustomerSavedAddressRefusalCode): never { throw new CustomerSavedAddressRefused(code); }
  const verify = (userId: string) => { if (typeof userId !== 'string' || userId.toLowerCase() !== principal.toLowerCase()) refuse('address_scope_mismatch'); };
  async function call(name: string, args: unknown[] = []) {
    const placeholders = [...identity, ...args].map((_, i) => `$${i + 1}`).join(',');
    return (await executor.query(`SELECT public.${name}(${placeholders}) AS result`, [...identity, ...args])).rows[0]?.result ?? null;
  }
  async function ownedRows() {
    const value = await call('customer_saved_addresses_read');
    if (value === null) return null;
    if (!Array.isArray(value) || value.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) refuse('address_invalid_response');
    return value as Record<string, unknown>[];
  }
  const store: CustomerAddressReadStore = {
    async readAddresses(id) { if (id !== client) refuse('address_scope_mismatch'); return await ownedRows() ?? []; },
    async readOrdererProfiles(id) { if (id !== client) refuse('address_scope_mismatch'); return options.readOrdererProfiles(id); },
    async addressUsedByActiveSubscription(id, addressId) { if (id !== client) refuse('address_scope_mismatch'); return await call('customer_saved_address_in_use', [addressId]) === true; },
    async findCanonicalAddressId(id, canonical) { if (id !== client) refuse('address_scope_mismatch'); const found = await call('customer_saved_address_canonical', [canonical]); return found === null ? null : z.guid().parse(found); },
    async clearDefaultAddress(id, kind, at) { if (id !== client) refuse('address_scope_mismatch'); if (await call('customer_saved_address_clear_defaults', [kind, at]) !== true) refuse('address_scope_mismatch'); },
  };
  const book = async () => {
    const rows = await ownedRows();
    if (rows === null) return null;
    // The existing handler validates this shared DTO against the host response schema.
    const response = { contractVersion: 'customer.addresses.v1' as const,
      ordererProfiles: await readOrdererProfiles(store, client), addresses: await readAddresses({ ...store, readAddresses: async () => rows }, client) };
    return response;
  };
  async function append(type: string, entityId: string, input: unknown) {
    const result = (await executor.query('SELECT public.customer_account_event_append($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) AS result',
      [...identity, type, 'address', entityId, JSON.stringify(input), options.now()])).rows[0]?.result;
    if (typeof result !== 'string') refuse('address_event_append_failed');
  }
  return {
    async getAddressBook(userId) { verify(userId); return book(); },
    async upsertAddress(userId, input) {
      verify(userId);
      const parsed = requests.customerAddressUpsertRequestSchema.safeParse(input);
      if (!parsed.success) refuse('address_invalid_input');
      if (await ownedRows() === null) return null;
      const data = { ...parsed.data, country: parsed.data.country ?? country };
      const eventType = 'customer.address_upserted';
      if (await call('customer_saved_address_replayed', [eventType, data.idempotencyKey]) === true) return book();
      const canonical = (value: Parameters<typeof canonicalAddressKey>[0]) => canonicalAddressKey(value, country);
      const row = { ...addressRow(client, data, canonical), updated_at: options.now() };
      if (data.isDefault) await store.clearDefaultAddress(client, data.kind, options.now());
      const addressId = data.addressId ?? await store.findCanonicalAddressId(client, row.canonical_key);
      let saved: unknown;
      try { saved = await call('customer_saved_address_write', [addressId, JSON.stringify(row), row.updated_at]); }
      catch (error) { if (error instanceof Error && error.message === 'customer_saved_address_not_found') refuse('address_not_found'); throw error; }
      if (typeof saved !== 'string') refuse('address_scope_mismatch');
      await append(eventType, saved, data);
      return book();
    },
    async deleteAddress(userId, input) {
      verify(userId);
      const parsed = requests.customerAddressDeleteRequestSchema.safeParse(input);
      if (!parsed.success) refuse('address_invalid_input');
      if (await ownedRows() === null) return null;
      const data = parsed.data, eventType = 'customer.address_deleted';
      if (await call('customer_saved_address_replayed', [eventType, data.idempotencyKey]) === true) return book();
      try { if (await call('customer_saved_address_delete', [data.addressId]) !== true) refuse('address_scope_mismatch'); }
      catch (error) { if (error instanceof Error && error.message === 'customer_saved_address_in_use') throw new CustomerSavedAddressRefused('address_in_use', options.inUseMessage); throw error; }
      await append(eventType, data.addressId, data);
      return book();
    },
  };
}
