import { createFulfillmentProviderRegistry } from '@openlup/platform/fulfillment';
import type {
  FulfillmentProviderAdapter,
  FulfillmentProviderRegistry,
} from '@openlup/platform/fulfillment/contracts';

export interface OwnedFulfillmentComposition {
  readonly mode: 'sandbox' | 'provider';
  readonly registry: FulfillmentProviderRegistry | null;
}

export interface OwnedFulfillmentOptions {
  /** Optional fulfillment provider adapters mounted by the adopter (e.g. `owned/adapters/fulfillment/amazon-mcf`). */
  readonly adapters?: readonly FulfillmentProviderAdapter[];
}

/**
 * Application-owned fulfillment adapter composition seam.
 *
 * By default (no adapters supplied), the starter remains in zero-credential sandbox mode.
 * To mount external 3PL or carrier fulfillment recipes, register their adapters here.
 */
export function createOwnedFulfillmentRegistry(
  options: OwnedFulfillmentOptions = {},
): OwnedFulfillmentComposition {
  const adapters = options.adapters ?? [];
  if (adapters.length === 0) {
    return { mode: 'sandbox', registry: null };
  }
  return {
    mode: 'provider',
    registry: createFulfillmentProviderRegistry(adapters),
  };
}
