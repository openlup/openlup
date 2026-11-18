import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import type { CatalogProductTypeRef } from "./productTypes.js";
/** Durable install evidence; installation does not publish catalogue data.
 * @experimental
 */
export interface CatalogDefinitionInstallReceipt {
  readonly packId: string;
  readonly packVersion: number;
  readonly manifestDigest: string;
  readonly installedAt: string;
  /** Immutable definitions included in this installation. @experimental */
  readonly subscriptionProfileDefinitions?: readonly CatalogSubscriptionProfileV1[];
  readonly types: readonly (CatalogProductTypeRef & { readonly definitionDigest: string })[];
}
