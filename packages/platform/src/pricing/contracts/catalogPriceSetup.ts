/** Immediate, positive, gross base replacement; later command versions are reserved.
 * @experimental
 */
export interface CatalogPriceSetupCommand {
  schemaVersion: 1;
  commandKey: string;
  variantId: string;
  priceListId: string;
  mode: "one_time";
  minQty: 1;
  amountKind: "gross";
  unitPriceMinor: number;
  expected: { entryId: null; unitPriceMinor: null } | { entryId: string; unitPriceMinor: number };
}
/** Basis-aware, exact-SKU, one-time base replacement.
 * @experimental
 */
export type CatalogPriceSetupCommandV2 = Omit<CatalogPriceSetupCommand, "schemaVersion" | "amountKind" | "expected"> & {
  schemaVersion: 2;
  amountKind: "gross" | "net";
  expectedListAmountBasis: "tax_inclusive" | "tax_exclusive";
  expected: { entryId: null; unitPriceMinor: null; amountKind: null }
    | { entryId: string; unitPriceMinor: number; amountKind: "gross" | "net" };
};
/** @experimental */
export interface CatalogPriceSetupEntry { entryId: string; unitPriceMinor: number; validFrom: string }
/** @experimental */
export interface CatalogPriceSetupReadiness { ready: boolean; reasons: string[] }
/** @experimental */
export interface CatalogPriceSetupPreviewQuery { variantId: string; priceListId: string; unitPriceMinor?: number }
/** @experimental */
export type CatalogPriceSetupSubscription =
  | { kind: "derived"; revisionId: string; discountBps: number; roundingQuantumMinor: number; derivedUnitPriceMinor: number | null }
  | { kind: "stored"; unitPriceMinor: number }
  | { kind: "unresolved"; reason: string };
/** @experimental */
export interface CatalogPriceSetupPreview {
  outcome: "preview";
  variantId: string;
  priceListId: string;
  inGate: boolean;
  current: CatalogPriceSetupEntry | null;
  currentCount: number;
  subscription: CatalogPriceSetupSubscription;
  readiness: CatalogPriceSetupReadiness;
  proposed?: { unitPriceMinor: number; readiness: CatalogPriceSetupReadiness };
}
/** @experimental */
export interface CatalogPriceSetupReceipt {
  commandKey: string;
  variantId: string;
  priceListId: string;
  actorId: string;
  previous: CatalogPriceSetupEntry | null;
  current: CatalogPriceSetupEntry;
}
/** @experimental */
export interface CatalogPriceSetupRefusal {
  outcome: "conflict" | "validation_issue" | "unauthorized" | "dependency_unavailable";
  reason: string;
  reasons?: string[];
}
/** @experimental */
export type CatalogPriceSetupApplyResult =
  | { outcome: "committed" | "replayed"; receipt: CatalogPriceSetupReceipt }
  | CatalogPriceSetupRefusal;
