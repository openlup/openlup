/**
 * What a subscription editor needs to know about a sellable catalog item.
 *
 * A *port* in the strict sense: it states the fields the editing surface reads
 * and nothing else, so the surface depends on this declaration rather than on
 * whichever richer contract a deployment happens to answer with. Any item
 * carrying at least these fields satisfies it structurally — no adapter, no
 * mapping layer, no runtime cost.
 *
 * It exists because the account's subscription editor previously imported this
 * shape from the storefront package composer, which had itself aliased it from a
 * commerce contract the account is walled off from. That indirection made a
 * publishable surface depend on an unpublishable one for a type it fully
 * describes on its own.
 *
 * The overlay supplying the real items proves it still satisfies this contract at
 * compile time; see `subscriptionCatalogTypes.ts` on the composer surface.
 */
export interface SubscriptionCatalogProduct {
  /** Stable identifier of the sellable variant, as used on subscription lines. */
  variantId: string;
  /** Operator-facing stock keeping unit. */
  sku: string;
  /** Catalog slug the editor keys labels and imagery off. */
  slug: string;
  /** Whether the item may be added to a subscription right now. */
  selectable: boolean;
  /**
   * Slugs of the buyer-declared exclusions this item conflicts with. Read-only:
   * the editor filters on it and never rewrites it.
   */
  conflictAllergenSlugs: readonly string[];
}
