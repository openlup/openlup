import type { CatalogProductTypeRef } from "./productTypes.js";
/** Durable install evidence; installation does not publish catalogue data.
 * @experimental
 */
export interface CatalogDefinitionInstallReceipt {
  readonly packId: string;
  readonly packVersion: number;
  readonly manifestDigest: string;
  readonly installedAt: string;
  readonly types: readonly (CatalogProductTypeRef & { readonly definitionDigest: string })[];
}
