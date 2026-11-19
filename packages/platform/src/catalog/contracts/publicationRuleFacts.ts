import type { CatalogProductTypeRef, CatalogQuantity, CatalogOptionValue } from "./productTypes.js";
import type { CatalogAttributeValue } from "./draftV2.js";
import type { CatalogPublicationFacts } from "./draftV3.js";

/** @internal */
export interface RulesIdentifier {
  scheme: string; issuer: string; value: string; packagingLevel: "unit" | "case"; quantity: number;
  isPrimary: boolean; label: string | null; sourceRef: string | null;
}
/** @internal */
export interface RulesProduct {
  id: string; slug: string; name: string; status: "draft" | "active" | "archived";
  type: CatalogProductTypeRef; axes: string[]; attributes: Record<string, CatalogAttributeValue>;
  primarySkuId: string | null; presentation: CatalogPublicationFacts | null;
}
/** @internal */
export interface RulesSku {
  id: string; productId: string; code: string; title: string; status: "draft" | "active" | "archived";
  minQuantity: number; isAddon: boolean; sellableStandalone: boolean; sellableInSubscription: boolean;
  netContent: CatalogQuantity; grossMass: CatalogQuantity | null; options: Record<string, CatalogOptionValue>;
  attributes: Record<string, CatalogAttributeValue>; facts: CatalogPublicationFacts;
  identifiers: RulesIdentifier[]; assetRefs: string[]; logisticsRef: string | null;
  memberships: { offerVersion: string; admitted: boolean }[];
}
