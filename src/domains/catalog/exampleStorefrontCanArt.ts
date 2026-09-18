/**
 * Public/default owner of `#storefront-can-art`: the Example Store's pack art.
 *
 * The example catalogue sells two items, and no deployment-specific photography
 * ships with the platform, so this owner answers every request with one of the
 * platform's own neutral packshots and reports `personalised: false` for all of
 * them. That is the honest answer, not a stub: a fresh installation genuinely
 * has no personalised artwork until it produces some, and the surfaces that read
 * this seam are written to fall back exactly this way.
 *
 * Both exports are annotated from {@link StorefrontCanArtOwner}. This checkout
 * resolves the `deployment-overlay` branch of the seam, so nothing here is
 * compiled against its real consumers; the annotation is what makes a drifted
 * signature fail on this file rather than in the published tree.
 */
import { packshotCanPrimary, packshotCanSecondary } from "#deployment-media";

import type { StorefrontCanArtOwner } from "./storefrontCanArt.js";

export const STOREFRONT_VARIANT_SLUGS: StorefrontCanArtOwner["variantSlugs"] = [
  "example-original",
  "example-reserve",
];

const GENERIC_PACK: Record<string, string> = {
  "example-original": packshotCanPrimary,
  "example-reserve": packshotCanSecondary,
};

export const packArt: StorefrontCanArtOwner["packArt"] = (variant) => ({
  src: GENERIC_PACK[variant] ?? packshotCanPrimary,
  personalised: false,
});
