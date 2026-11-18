type DisclosureLineIdentity = {
  variantId: string;
  sku: string;
  isAddon: boolean;
  subtotalDeltaMinor: number;
};
/** Per-line agreement disclosure. Missing sides are absent prices, including for zero-priced lines.
 * @experimental
 */
export type SubscriptionEditDisclosureLine = DisclosureLineIdentity & (
  | { kind: "retained"; agreedQuantity: number; newQuantity: number; agreedUnitMinor: number; newUnitMinor: number;
      deltaMinor: number; reason: "unchanged" | "price_changed" | "quantity_changed" }
  | { kind: "added"; agreedQuantity: null; newQuantity: number; agreedUnitMinor: null; newUnitMinor: number; deltaMinor: null; reason: "added" }
  | { kind: "removed"; agreedQuantity: number; newQuantity: null; agreedUnitMinor: number; newUnitMinor: null; deltaMinor: null; reason: "removed" }
);
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
  /** Present when the command keeps the agreement despite a fresh comparison. @experimental */
  noChange?: { livePriceDiffers: boolean };
}

/** Legacy desired-set inputs; money and identity are supplied on the server.
 * @experimental
 */
export interface LegacyEditConsentRequest {
  subscriptionId: string; coreLines: { variantId: string; qty: number }[]; addonLines?: { variantId: string; qty: number }[];
  compositionConstraint?: Record<string, unknown>; cadenceDays?: number; expectedTemplateVersion?: number; acceptedQuoteHash?: string;
}

/** Classic bundle composition with explicit update and resize actions.
 * Omitting add-on lines retains the current set.
 * @experimental
 */
export type ClassicBundleEditRequest = Omit<LegacyEditConsentRequest, "coreLines" | "addonLines"> & (
  | { action: "update_bundle"; coreLines: LegacyEditConsentRequest["coreLines"]; addonLines?: LegacyEditConsentRequest["addonLines"] }
  | { action: "resize_bundle"; resizeLever: { kind: string; value: unknown } }
);
