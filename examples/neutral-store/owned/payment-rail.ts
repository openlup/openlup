import {
  createPaymentProviderRegistry,
  createPostgresProviderPaymentRail,
  type PaymentProviderExecutor,
  type PostgresProviderPaymentRail,
} from '@openlup/platform/payments';
import type {
  PaymentAdapter,
  PaymentProviderRegistry,
  PostgresPaymentTruthOptions,
} from '@openlup/platform/payments/contracts';

type RailInput = Parameters<typeof createPostgresProviderPaymentRail>[0];

export interface OwnedPaymentRailComposition {
  readonly mode: 'sandbox' | 'provider';
  readonly registry: PaymentProviderRegistry | null;
  readonly rails: ReadonlyMap<string, PostgresProviderPaymentRail>;
}

export interface OwnedPaymentRailOptions {
  /** Optional provider adapters mounted by the adopter (e.g. a recipe adapter). Empty uses sandbox mode. */
  readonly adapters?: readonly PaymentAdapter[];
  /** Required when `adapters` is non-empty: PostgreSQL query executor backing the provider rails. */
  readonly executor?: PaymentProviderExecutor;
  /** Default provider rail mode when adapters are mounted. Defaults to `"test"`. */
  readonly railMode?: 'test' | 'live';
  /** Payment truth options required when `adapters` is non-empty. */
  readonly truth?: PostgresPaymentTruthOptions;
  /** Resolves the customer owner for webhook payment-method events when `adapters` is non-empty. */
  readonly resolveMethodOwner?: RailInput['resolveMethodOwner'];
  /** Resolves the customer owner for saved payment-method events when `adapters` is non-empty. */
  readonly resolveSavedMethodOwner?: RailInput['resolveSavedMethodOwner'];
}

/**
 * Application-owned payment rail composition seam.
 *
 * By default (no adapters supplied), the starter remains in zero-credential sandbox mode.
 * To mount an external payment provider recipe (for example `recipes/payments/adyen`),
 * register the adapter here with the host executor and method-owner resolvers.
 */
export function createOwnedPaymentRail(options: OwnedPaymentRailOptions = {}): OwnedPaymentRailComposition {
  const adapters = options.adapters ?? [];
  if (adapters.length === 0) {
    return { mode: 'sandbox', registry: null, rails: new Map() };
  }
  if (!options.executor || !options.truth || !options.resolveMethodOwner || !options.resolveSavedMethodOwner) {
    throw new TypeError('owned_payment_rail_host_ports_required');
  }
  const registry = createPaymentProviderRegistry(adapters);
  const rails = new Map<string, PostgresProviderPaymentRail>();
  for (const adapter of adapters) {
    rails.set(
      adapter.capabilities.providerKind,
      createPostgresProviderPaymentRail({
        executor: options.executor,
        adapter,
        mode: options.railMode ?? 'test',
        truth: options.truth,
        resolveMethodOwner: options.resolveMethodOwner,
        resolveSavedMethodOwner: options.resolveSavedMethodOwner,
      }),
    );
  }
  return { mode: 'provider', registry, rails };
}
