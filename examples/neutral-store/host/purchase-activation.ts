import type { Pool } from 'pg';
import { activateNativePurchaseWithRenewal, type NativeRenewalPurchaseFacts } from '@openlup/platform/subscriptions';
import type { CreateQuoteResponse } from '@openlup/platform/pricing';
import type { ShippingTerms } from '@openlup/platform/shipping';
import { createAcquisitionRenewalBinding, type AcquisitionRenewalBinding } from './acquisition-predecessors.ts';

const acquisitionTerms = (snapshot: CreateQuoteResponse) =>
  (snapshot.quote.context as { acquisitionTerms?: unknown })?.acquisitionTerms;

/** Shared by sandbox capture actions. Validation precedes observation; activation follows ingress. */
export function createInitialPurchaseActivation(db: Pool, renewal: AcquisitionRenewalBinding = createAcquisitionRenewalBinding(db)) {
  return {
    assertCaptureAvailable(snapshot: CreateQuoteResponse) {
      if (acquisitionTerms(snapshot)) renewal.assertAvailable(snapshot);
    },
    async activate(input: Parameters<AcquisitionRenewalBinding['activate']>[0] & { currency: string }): Promise<string | undefined> {
      const declaration = (await db.query('SELECT cadence_days FROM public.subscription_activations WHERE order_id=$1', [input.orderId])).rows[0];
      if (!declaration) return undefined;
      if (acquisitionTerms(input.acceptedQuote)) {
        const { currency: _currency, ...acquisitionInput } = input;
        return renewal.activate(acquisitionInput);
      }
      const quote = input.acceptedQuote.quote;
      const shippingTerms = (quote.context as { shippingTerms?: ShippingTerms } | undefined)?.shippingTerms;
      const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: 'sandbox', ...input.methodFacts,
        stockSourceKey: input.stockSourceKey, templateId: input.templateId, cadenceDays: declaration.cadence_days,
        currency: input.currency, shippingAmountMinor: (quote.shippingGross?.amountMinor ?? 0) - (quote.shippingDiscountGross?.amountMinor ?? 0), acquisitionRef: null,
        renewalTerms: { version: 'native.renewal-terms.v1', ...(shippingTerms === undefined ? {} : { shippingTerms }) },
        lines: quote.lines.map((line, index) => ({ lineOrdinal: index + 1, sku: line.sku, quantity: line.quantity, unitAmountMinor: line.unitPriceGross.amountMinor })) };
      return (await activateNativePurchaseWithRenewal(db, { orderId: input.orderId,
        idempotencyKey: `activate:${input.orderId}`, capturedReference: input.capturedReference, facts })).renewalAttachment;
    },
  };
}
