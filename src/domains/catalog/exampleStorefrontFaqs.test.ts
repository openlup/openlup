import { describe, expect, it } from "vitest";

import { storefrontFaqsByLocale } from "./exampleStorefrontFaqs.js";

// The platform half of `#storefront-faqs`, imported by RELATIVE PATH: every non-hosted
// command here resolves the seam to this deployment's overlay, so this is the neutral
// owner's only exercise.
describe("platform storefront FAQ owner", () => {
  const locales = Object.keys(storefrontFaqsByLocale);

  it("ships more than one locale, because the map's whole point is that it can", () => {
    // A single-locale default would let a locale-keyed contract pass while behaving like
    // the two market-named exports it replaced.
    expect(locales.length).toBeGreaterThanOrEqual(2);
  });

  it("answers for the same items in every locale", () => {
    // A slug present in one locale and missing in another renders an empty FAQ for exactly
    // the visitors who switched language - the failure a per-locale table invites.
    const slugsByLocale = locales.map((locale) => Object.keys(storefrontFaqsByLocale[locale]).sort());
    for (const slugs of slugsByLocale) expect(slugs).toEqual(slugsByLocale[0]);
    expect(slugsByLocale[0].length).toBeGreaterThan(0);
  });

  it("gives every entry both halves of a question", () => {
    for (const locale of locales) {
      for (const [slug, entries] of Object.entries(storefrontFaqsByLocale[locale])) {
        expect(entries.length, `${locale}/${slug} must not be empty`).toBeGreaterThan(0);
        for (const entry of entries) {
          expect(entry.q.trim(), `${locale}/${slug} question`).not.toBe("");
          expect(entry.a.trim(), `${locale}/${slug} answer`).not.toBe("");
        }
      }
    }
  });

  // NOT asserted here: that the copy names no brand. `analyzeSurfaceFamilies()` already
  // scans this file set against the `public-platform-runtime` baseline, and a regex
  // duplicating it would have to SPELL the brand, which that same scanner then counts
  // against this file. The ratchet is the check.
});
