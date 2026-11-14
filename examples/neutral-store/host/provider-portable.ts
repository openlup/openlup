import { createPostgresProviderPaymentRail, createPostgresPaymentMethodSetup } from '@openlup/platform/payments';
import type { PaymentAdapter } from '@openlup/platform/payments/contracts';
import { createNativeRenewalCodec, createPostgresProviderRenewalBinding, createPostgresRenewalSettlementPort } from '@openlup/platform/subscriptions';
import type { createNativeSubscriptionBinding } from '@openlup/platform/subscriptions';

type Native = Parameters<typeof createNativeSubscriptionBinding>[0];
type Payment = Parameters<typeof createPostgresProviderPaymentRail>[0];

/** Explicit server composition example. The starter does not select this factory.
 * The host owns SDK construction, credentials, live-mode policy and route auth.
 * Its client confirms off-session requests and leaves interactive confirmation
 * to the browser. Empty search results never authorize another charge.
 */
export function composeStripePortableRail(input: {
  enabled: boolean;
  executor: Native['executor']; withTransaction: Native['withTransaction'];
  adapter: PaymentAdapter; mode: "live" | "test";
  searchPaymentIntentsByMetadata(input: { key: string; value: string; limit: number }): Promise<{ ids: string[] }>;
  ensureCustomer(input: { clientId: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<string>;
  resolveMethodOwner: Payment['resolveMethodOwner']; resolveSavedMethodOwner: Payment['resolveSavedMethodOwner'];
  retry: Pick<Native['retry'], 'readFrozenMandate' | 'retryInput'>;
  failureTemplate: string; recoveredTemplate: string; recoveryPath: string;
  now(): string;
}) {
  const codec = createNativeRenewalCodec(), adapter = input.adapter;
  const truth = { dunningTemplateSlug: input.failureTemplate, recoveryTemplateSlug: input.recoveredTemplate, recoveryUrlPath: input.recoveryPath };
  const paymentRail: ReturnType<typeof createPostgresProviderPaymentRail> = createPostgresProviderPaymentRail({ executor: input.executor, adapter, mode: input.mode, truth,
    resolveMethodOwner: input.resolveMethodOwner, resolveSavedMethodOwner: input.resolveSavedMethodOwner,
    composeWebhook: (event, control) => renewal.composeWebhook(event, control) });
  const settlement = (db: Native['executor']) => createPostgresRenewalSettlementPort(db, codec, input.withTransaction);
  const renewal = createPostgresProviderRenewalBinding({ enabled: input.enabled, channelKey: adapter.capabilities.providerKind, executor: input.executor,
    withTransaction: input.withTransaction, paymentRail, codec, settlement, truth, now: input.now,
    search: async ({ localIntentId, limit }) => (await input.searchPaymentIntentsByMetadata({ key: 'paymentIntentId', value: localIntentId, limit })).ids });
  return {
    paymentRail,
    paymentMethodSetup: createPostgresPaymentMethodSetup(input.executor, { enabled: () => input.enabled,
      methodPort: adapter.methodPort!, ensureCustomer: input.ensureCustomer }),
    // Spread these into createNativeSubscriptionBinding with the host's single
    // population lease, inventory, execution-input policy and readiness probe.
    subscriptionPorts: { codec, settlement, paymentRails: renewal.paymentRails, providerLifecycle: renewal.lifecycle,
      retry: { ...input.retry, payments: renewal.retryPayments, recoveredTemplate: input.recoveredTemplate } },
  };
}
