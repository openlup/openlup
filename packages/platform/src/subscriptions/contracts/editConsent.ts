/** An immutable, versioned fact resolved by the owning service.
 * @experimental
 */
export interface SubscriptionEditOwnerEvidence {
  readonly owner: string;
  readonly version: string;
  readonly digest: string;
}

/** Minor units and their pricing basis. Currency uses a three-letter code.
 * @experimental
 */
export interface SubscriptionEditAmount {
  readonly amountMinor: number;
  readonly currency: string;
  readonly basis: "tax_inclusive" | "tax_exclusive";
}

/** One recurring amount supplied by its owner. Render the label with the amount.
 * @experimental
 */
export interface SubscriptionEditRecurringTerms {
  readonly payment: {
    readonly kind: "payable" | "estimate";
    readonly label: string;
    readonly amount: SubscriptionEditAmount;
    readonly evidence: SubscriptionEditOwnerEvidence;
  };
  readonly cadence: { readonly days: number; readonly evidence: SubscriptionEditOwnerEvidence };
}

interface DisclosureLineSide {
  readonly quantity: number;
  readonly label: string;
  readonly unitAmount: SubscriptionEditAmount;
}

/** Compare by variant, SKU and role. An absent side represents an addition or removal.
 * @experimental
 */
export type SubscriptionEditDisclosureLine = {
  readonly variantId: string;
  readonly sku: string;
  readonly isAddon: boolean;
} & (
  | { readonly kind: "added"; readonly agreed: null; readonly proposed: DisclosureLineSide; readonly unitDelta: null }
  | { readonly kind: "removed"; readonly agreed: DisclosureLineSide; readonly proposed: null; readonly unitDelta: null }
  | { readonly kind: "retained"; readonly agreed: DisclosureLineSide; readonly proposed: DisclosureLineSide;
    readonly unitDelta: SubscriptionEditAmount | null }
);

/** The immutable display payload. Render its amounts, labels, cycle and cadence in
 * the declared locale and presentation version.
 * @experimental
 */
export interface SubscriptionEditDisclosure {
  readonly version: 1;
  readonly currency: string;
  readonly disposition: "changes_agreement" | "keeps_agreement";
  readonly agreed: SubscriptionEditRecurringTerms;
  readonly proposed: SubscriptionEditRecurringTerms;
  readonly effectiveCycle: {
    readonly number: number;
    readonly scheduledAt: string;
    readonly editCutoffAt: string;
    readonly evidence: SubscriptionEditOwnerEvidence;
  };
  readonly presentation: {
    readonly version: string;
    readonly locale: string;
    readonly labels: {
      readonly title: string;
      readonly agreed: string;
      readonly proposed: string;
      readonly effectiveCycle: string;
      readonly cadence: string;
      readonly confirmation: string;
    };
  };
  readonly lines: readonly SubscriptionEditDisclosureLine[];
}

/** The persistence owner supplies both reference types when acceptance is composed.
 * @experimental
 */
export type SubscriptionEditAcceptanceLink<EventId, PreviewReference> =
  | { readonly outcome: "applied"; readonly eventId: EventId; readonly acceptedPreview: PreviewReference }
  | { readonly outcome: "noop"; readonly eventId: null; readonly acceptedPreview: PreviewReference };
