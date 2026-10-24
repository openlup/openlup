/** Frozen host facts; no catalogue, registry or country-policy reread on retry.
 * Carrier: donor providerPorts snapshot and invoiceContracts LocalInvoiceSnapshot;
 * native invoicing_install_facts adds dates/refs/policyVersion and explicit totals.
 */
export interface InvoiceSeller {
  readonly name: string;
  readonly address: { readonly line1: string; readonly postalCode: string; readonly city: string };
  readonly taxIdentifier: { readonly scheme: string; readonly value: string };
  readonly registrationIds?: readonly { readonly scheme: string; readonly value: string }[];
  readonly bankAccount: string | null;
  /** Opaque host routing reference, interpreted only by the selected adapter. */
  readonly routingRef: string | null;
}
export interface InvoiceBuyer {
  readonly name: string;
  readonly email: string | null;
  readonly taxIdentifier: { readonly scheme: string; readonly value: string } | null;
  readonly companyName: string | null;
  readonly address: { readonly line1: string | null; readonly postalCode: string | null; readonly city: string | null; readonly country: string | null } | null;
}
/** Safe integer minor amounts; taxRateBps is a rate, never a fiscal-support claim.
 * Preserve array order and quantityUnit; no inferred shipping residual or FX.
 */
export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly quantityUnit?: string;
  readonly unitNetMinor: number;
  readonly unitGrossMinor: number;
  readonly totalNetMinor: number;
  readonly totalTaxMinor: number;
  readonly totalGrossMinor: number;
  readonly taxRateBps: number;
  readonly taxRateLabel?: string;
  readonly positionKind: "item" | "delivery" | null;
  readonly catalogTotalGrossMinor: number | null;
  readonly discountAllocatedMinor: number | null;
  readonly shippingGrossMinor: number | null;
  readonly shippingDiscountMinor: number | null;
}
export interface InvoiceFacts {
  readonly factRevision: string;
  readonly policyVersion: string;
  readonly refs: { readonly orderId: string; readonly orderRef: string; readonly invoiceRef: string };
  readonly dates: { readonly issueDate: string; readonly sellDate: string; readonly handedOverAt: string | null; readonly paymentCompletedAt: string | null };
  /** Host-defined kind selected through the identifier/tax seam, never guessed. */
  readonly documentKind: string;
  readonly clearanceRequired: boolean;
  readonly currency: string;
  readonly buyer: InvoiceBuyer;
  /** Claim projection only: the first durable claim freezes the seller; legacy obligations retain execution-time fallback. */
  readonly seller?: InvoiceSeller;
  readonly payment: { readonly intentRef: string; readonly providerRef: string | null; readonly providerPaymentRef: string | null; readonly amountMinor: number; readonly currency: string; readonly localSettlementState: "matched" | "unavailable" };
  readonly orderMoney: { readonly subtotalMinor: number; readonly discountMinor: number; readonly shippingMinor: number; readonly shippingDiscountMinor: number; readonly totalMinor: number } | null;
  readonly lines: readonly InvoiceLine[];
  readonly totalNetMinor: number;
  readonly totalTaxMinor: number;
  readonly totalGrossMinor: number;
  readonly chargedTotalGrossMinor: number;
}

/** Host-selected immutable revision; it contains no provider or country defaults. */
export interface InvoiceSellerRevision<Seller = InvoiceSeller> {
  readonly seller: Seller;
  readonly revisionRef: string;
}
/** Added only to returned claim facts, never to installed historical revisions. */
export interface InvoiceClaimedFacts extends InvoiceFacts {
  readonly sellerRevision?: string;
  readonly sellerMode?: "frozen" | "legacy_fallback";
}
