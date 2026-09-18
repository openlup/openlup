// The media a deployment supplies to the platform's pages, named by role.
//
// WHY THIS EXISTS. A page that imports a hero photograph straight out of this
// deployment's `src/assets` library binds the platform to that library: the
// published tree keeps the page and drops the file, so the import resolves to
// nothing. That class of edge is what `oss:split-rehearsal`'s asset stage
// counts, and it cannot be paid by moving files - only by giving the page a
// *logical* name and letting the deployment answer it.
//
// Sibling of `presentation.ts` (email) and `appShellAssets.ts` (entry document),
// and the same shape for the same reason: the platform names a role, one owner
// per deployment supplies the bytes. The owners are selected by the
// `deployment-overlay` package-import condition on `#deployment-media`; see
// `docs/SELF_HOSTING.md` and `docs/plan/oss-neutral-email-templates.md` section 1.4.
//
// Keys are roles, never file names, and never one deployment's vocabulary: this
// module is published, so a role that spelled out a brand, a market or a product
// category would move the platform's own shared-vocabulary ratchet. Name the
// slot the page fills, not the picture the deployment happens to put in it.
//
// EACH ROLE IS ITS OWN NAMED EXPORT, deliberately. A single frozen record would
// put all 56 resolved URLs into whatever chunk first touched media - measured at
// +1.4/+3.2/+5.8 KiB on the three `guard-perf-budgets` entries - because a page
// that wants one logo would pull the whole map. Named exports let the bundler
// keep only the roles a chunk actually renders.

/**
 * Every media role the publishable pages name, and the single source of the key
 * union. `deploymentMedia.test.ts` holds both owners to this list, so a role
 * added here without an owner fails before it can resolve to `undefined` and
 * render as a broken image.
 */
export const DEPLOYMENT_MEDIA_ROLES = [
  // Marks. D24 bounds this group: a deployment's real marks never enter the published set.
  "brandMark",
  "brandMarkInverse",
  "footerPartnerPrimary",
  "footerPartnerSecondary",
  "storyPartnerPrimary",
  "storyPartnerSecondary",
  "storyPartnerTertiary",
  // Packshots carried by the storefront's own sliders.
  "packshotCanPrimary",
  "packshotCanSecondary",
  "packshotJarPrimary",
  "packshotJarSecondary",
  // Lifestyle photography and the one motion loop.
  "lifestyleOwnerPortrait",
  "lifestyleMealMoment",
  "lifestyleFieldCompanion",
  "lifestyleMotionLoop",
  // Home hero, in the three encodings the `<picture>` element selects between.
  "heroHomePrimary",
  "heroHomePrimaryWide",
  "heroHomePrimaryNarrow",
  "heroPrivateLabel",
  // Story route.
  "storyHero",
  "storyHeroCompressed",
  "storyLandscape",
  "founderPortraitPrimary",
  "founderPortraitSecondary",
  "foundersWithCompanion",
  "foundersAtWork",
  // Science route.
  "scienceHeroProcess",
  "scienceHeroNutrition",
  // Portion-guide silhouettes, by species group and size band.
  "portionSilhouetteCanineSmall",
  "portionSilhouetteCanineMedium",
  "portionSilhouetteCanineLarge",
  "portionSilhouetteCanineExtraLarge",
  "portionSilhouetteFelineSmall",
  "portionSilhouetteFelineMedium",
  "portionSilhouetteFelineLarge",
  // Front packshots, per flavour. `SecondaryLocale` is the same product shot with
  // the alternate-locale artwork on the label; the base role carries the primary
  // one. Named by locale ROLE, not by market, because this list is published.
  "packshotFrontLamb",
  "packshotFrontLambSecondaryLocale",
  "packshotFrontVenison",
  "packshotFrontVenisonSecondaryLocale",
  "packshotFrontBeef",
  "packshotFrontBeefSecondaryLocale",
  "packshotFrontTurkey",
  "packshotFrontTurkeySecondaryLocale",
  "packshotFrontSalmon",
  "packshotFrontSalmonSecondaryLocale",
  "packshotFrontPork",
  "packshotFrontPorkSecondaryLocale",
  // Science route: the ingredient photograph, the process diagram in both locale
  // variants, and the ancestry portrait.
  "scienceIngredientPhoto",
  "scienceProcessDiagram",
  "scienceProcessDiagramSecondaryLocale",
  "scienceAncestorPortrait",
  // Order-lifecycle banners reused by the marketing pages.
  "lifecycleBannerWelcome",
  "lifecycleBannerApproved",
  "lifecycleBannerDelivered",
  "lifecycleBannerShipped",
  // The compressed variant of `lifestyleOwnerPortrait`, for above-the-fold use.
  "lifestyleOwnerPortraitCompressed",
  // Ingredient glyphs, keyed by the ingredient they illustrate.
  "ingredientIconSheep",
  "ingredientIconDeer",
  "ingredientIconCow",
  "ingredientIconTurkey",
  "ingredientIconFish",
  "ingredientIconPig",
  "ingredientIconMushroom",
  "ingredientIconBroth",
  "ingredientIconBanana",
  "ingredientIconPumpkin",
  "ingredientIconCarrot",
  "ingredientIconBeet",
  "ingredientIconApple",
  "ingredientIconParsnip",
  "ingredientIconZucchini",
  "ingredientIconSweetPotato",
  "ingredientIconHeart",
  "ingredientIconYeast",
  "ingredientIconOilDrop",
  "ingredientIconPrebiotic",
  "ingredientIconShield",
] as const;

/** A role the platform's pages may ask a deployment for. */
export type DeploymentMediaKey = (typeof DEPLOYMENT_MEDIA_ROLES)[number];

/** The complete set an owner module must export, one resolved asset URL per role. */
export type DeploymentMedia = Readonly<Record<DeploymentMediaKey, string>>;
