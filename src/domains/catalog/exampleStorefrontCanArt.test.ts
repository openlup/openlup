import { describe, expect, it } from "vitest";

import { STOREFRONT_VARIANT_SLUGS, packArt } from "./exampleStorefrontCanArt.js";

// The platform half of `#storefront-can-art`, imported by RELATIVE PATH on purpose.
// Every non-hosted command in this repository resolves the seam to this deployment's own
// overlay, so the neutral owner has no other way of being exercised - and an owner nobody
// runs is an owner that rots. This is the same shape as the dispatch-policy and media
// seams' own owner tests.
describe("platform can-art owner", () => {
  it("answers for every slug it advertises, not just the ones it happens to list", () => {
    // Canon section 1.1: a published module must WORK completely. A fresh installation that
    // never edits this file still has to render a real image for each catalogue item.
    expect(STOREFRONT_VARIANT_SLUGS.length).toBeGreaterThan(0);
    for (const slug of STOREFRONT_VARIANT_SLUGS) {
      const art = packArt(slug, null);
      expect(art.src, `${slug} must resolve to an asset reference`).toBeTruthy();
      expect(typeof art.src).toBe("string");
    }
  });

  it("distinguishes its items rather than returning one image for the whole catalogue", () => {
    // A single shared packshot would let a consumer that keys off `src` look correct here
    // and collapse on any deployment whose items really do differ.
    const [first, second] = STOREFRONT_VARIANT_SLUGS;
    expect(packArt(first, null).src).not.toBe(packArt(second, null).src);
  });

  it("falls back instead of throwing on a slug it has never heard of", () => {
    // The seam is called with whatever the deployment's catalogue returns, so an unknown
    // slug is an ordinary runtime case, not a programming error.
    const art = packArt("an-item-this-owner-does-not-ship", null);
    expect(art.src).toBeTruthy();
    expect(art.personalised).toBe(false);
  });

  it("never claims personalisation, which is the honest default", () => {
    // The platform ships no subject-specific artwork. Reporting `true` here would make a
    // fresh installation advertise a gallery it does not have; the subject argument is
    // accepted and deliberately ignored.
    for (const subject of [null, undefined, "", "Any Subject Name"]) {
      expect(packArt(STOREFRONT_VARIANT_SLUGS[0], subject).personalised).toBe(false);
    }
  });
});
