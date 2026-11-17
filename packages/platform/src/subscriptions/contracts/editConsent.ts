/** Per-line agreement disclosure. Missing sides are absent prices, including for zero-priced lines.
 * @experimental
 */
export interface SubscriptionEditDisclosureLine {
  kind: "retained" | "added" | "removed";
  variantId: string;
  sku: string;
  isAddon: boolean;
  agreedQuantity: number | null;
  newQuantity: number | null;
  agreedUnitMinor: number | null;
  newUnitMinor: number | null;
  deltaMinor: number | null;
  subtotalDeltaMinor: number;
  reason: "unchanged" | "price_changed" | "quantity_changed" | "added" | "removed";
}
/** Versioned disclosure bound to the original lane quote and complete current agreement.
 * @experimental
 */
export interface SubscriptionEditConsent {
  version: 1;
  currency: string;
  baselineFingerprint: string;
  innerQuoteHash: string;
  lines: readonly SubscriptionEditDisclosureLine[];
  agreedTotalMinor: number;
  newTotalMinor: number;
  subtotalDeltaMinor: number;
}

/** Legacy desired-set inputs; money and identity are supplied on the server.
 * @experimental
 */
export interface LegacyEditConsentRequest {
  subscriptionId: string; coreLines: { variantId: string; qty: number }[]; addonLines?: { variantId: string; qty: number }[];
  compositionConstraint?: Record<string, unknown>; cadenceDays?: number; expectedTemplateVersion?: number; acceptedQuoteHash?: string;
}
