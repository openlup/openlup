import type { AppConfigurationResponse } from '../shared/api.ts';
import { isRecord } from '../shared/offer.ts';
import { act } from '../shared/transport.ts';
import type { StarterCatalogueItem } from '../shared/catalogue-products.ts';

export { act, uncertainAction } from '../shared/transport.ts';

export async function storefrontCatalogue() {
  const result = await act('storefront.catalogue', {}, crypto.randomUUID());
  if (!result.ok) return result;
  const value = result.value;
  return isRecord(value) && Array.isArray(value.products)
    ? { ok: true as const, products: value.products as StarterCatalogueItem[] }
    : { ok: false as const, code: 'starter_response_invalid' };
}

export async function configuration(): Promise<AppConfigurationResponse> {
  const response = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('starter_configuration_unavailable');
  return response.json() as Promise<AppConfigurationResponse>;
}
