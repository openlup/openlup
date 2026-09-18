import { packArt } from "#storefront-can-art";
import type { StorefrontVariantSlug } from "@/domains/catalog/storefrontCanArt";
import {
  productAccentColor,
  productShortLabel,
  resolveLaunchProductSlug,
  type ProductDisplayLang,
} from "@/lib/catalogProductDisplay";

/**
 * Flavour identity for the account UI — resolves a subscription line to its
 * flavour slug, can image and accent colour, reusing the deployment's own pack
 * art through `#storefront-can-art` and the brand colour SoT from
 * `src/data/products.ts`.
 *
 * Display-only: the editor still drives the mix through the catalog and
 * `subscriptionEditModel`. Resolution is by recipe name (PL or EN) so it works
 * offline (no catalog fetch) for both real data and the dev harness.
 */

export const FLAVOUR_HEX = Object.fromEntries(
  (["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const).map((slug) => [
    slug,
    productAccentColor(slug),
  ]),
) as Record<StorefrontVariantSlug, string>;

/** Resolve a recipe name / title to a flavour slug, or null when unknown. */
export function resolveFlavourSlug(
  name: string | null | undefined,
): StorefrontVariantSlug | null {
  return resolveLaunchProductSlug(name);
}

export interface FlavourView {
  slug: StorefrontVariantSlug | null;
  label: string;
  /** Can image URL, or null when the flavour can't be resolved. */
  image: string | null;
  /** Accent hex; falls back to brand teal for unresolved flavours. */
  color: string;
}

const FALLBACK_COLOR = "#45BABC";

/** Build the display view for a recipe line (image + colour + label). */
export function flavourView(
  name: string | null | undefined,
  breed: string | null | undefined,
  lang: ProductDisplayLang = "pl",
): FlavourView {
  const slug = resolveFlavourSlug(name);
  return {
    slug,
    label: productShortLabel(slug, lang) ?? name?.trim() ?? "",
    image: slug ? packArt(slug, breed).src : null,
    color: slug ? FLAVOUR_HEX[slug] : FALLBACK_COLOR,
  };
}
