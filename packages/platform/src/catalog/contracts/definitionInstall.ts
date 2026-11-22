import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import type { CatalogProductTypeRef } from "./productTypes.js";
/** Durable install evidence; installation does not publish catalogue data.
 * @experimental
 */
export interface CatalogDefinitionInstallReceipt {
  readonly packId: string;
  readonly packVersion: number;
  /** Profile-bearing receipts carry the profiles-v1: tag on the manifest SHA-256. */
  readonly manifestDigest: string;
  readonly installedAt: string;
  /** Original canonical pack manifest, retained for installs with full profile declarations. */
  readonly canonicalManifest?: string;
  readonly subscriptionProfileDefinitions?: readonly (CatalogSubscriptionProfileV1 & { readonly profileDigest: string })[];
  readonly types: readonly (CatalogProductTypeRef & { readonly definitionDigest: string })[];
}
