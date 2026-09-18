/**
 * The contract of `#storefront-can-art`: which pack image a storefront shows for
 * a given item, personalised for a given subject.
 *
 * A storefront that sells a physical pack shows a picture of it, and a storefront
 * that personalises the pack — a name, a segment, a portrait printed on the label
 * — shows a *different* picture per (item, subject) pair. Which pairs actually
 * have artwork is a fact about one deployment's photography, not about the
 * platform: it is a finite, closed set that some team physically produced, and it
 * changes whenever they produce more.
 *
 * So the platform declares the question and the shape of the answer here, and the
 * answer itself is owned through the `#storefront-can-art` package import: this
 * deployment's private owner resolves against its own registry, and the neutral
 * default resolves against the platform's own media set, so a fresh installation
 * renders complete packs instead of broken images.
 *
 * ⛔ The value space is deliberately OPEN. `StorefrontVariantSlug` is `string`,
 * exactly as `CatalogProductSlug` is: a closed union here would be one
 * deployment's catalogue published as platform vocabulary. The deployment
 * declares its own closed set on its own side.
 */

/** A sellable item's catalog slug. Open by design — see the note above. */
export type StorefrontVariantSlug = string;

/** One resolved image, and whether it is the personalised or the generic one. */
export interface StorefrontPackArt {
  /** URL or bundled asset reference for the `<img src=...>`. */
  src: string;
  /** True when this is the subject-specific artwork rather than the generic pack. */
  personalised: boolean;
}

/**
 * What an owner of `#storefront-can-art` must provide.
 *
 * ⛔ Both owners annotate their exports with these members rather than inferring
 * them. A seam is resolved by *condition*, so this checkout only ever typechecks
 * one branch of it; annotating both against one declaration is what stops a
 * signature drifting on the branch nobody here compiles.
 */
export interface StorefrontCanArtOwner {
  /** Every item slug the storefront may ask for art for. */
  readonly variantSlugs: readonly StorefrontVariantSlug[];
  /**
   * The best available pack image for an (item, subject) pair, falling back to
   * the generic pack whenever no personalised artwork exists.
   */
  packArt(
    variant: StorefrontVariantSlug,
    subject: string | null | undefined,
  ): StorefrontPackArt;
}
