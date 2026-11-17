/** An installed namespace identifies a finite reference target, never a relation or URL.
 * @experimental
 */
export interface CatalogAttributeReference { namespace: string; id: string }
/** @experimental */
export interface CatalogAttributeReferenceResolution extends CatalogAttributeReference {
  status: "resolved" | "dangling" | "private" | "unavailable";
}
/** Resolve the entire deduplicated allowlisted batch; omitted or duplicate results refuse.
 * @experimental
 */
export interface CatalogAttributeReferencePort {
  resolve(references: readonly Readonly<CatalogAttributeReference>[]): Promise<readonly CatalogAttributeReferenceResolution[]>;
}
