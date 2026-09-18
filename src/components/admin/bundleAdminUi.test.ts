import { describe, expect, it } from "vitest";

import { bundlePreviewKey, storedBundleCurrency } from "./bundleAdminUi";

/**
 * `storedBundleCurrency` answers one question — "does this bundle already carry a
 * currency?" — and the price card names a currency in its preview request only
 * when the answer is no. A wrong "no" re-anchors a bundle priced outside the
 * settlement currency to the settlement currency, so the undefined branch is the
 * one that has to be exactly right.
 *
 * No currency literal is a settlement currency here: these are opaque codes
 * standing in for "some currency", which is all this function knows about them.
 */

const priced = (currency: string) => ({ currency, active: true });

describe("storedBundleCurrency", () => {
  it("is the resolved currency the server answered with", () => {
    expect(
      storedBundleCurrency({ resolvedCurrency: "XTS", prices: [priced("XTS")] }),
    ).toBe("XTS");
  });

  it("is undefined for a bundle that has never been priced", () => {
    expect(storedBundleCurrency({ resolvedCurrency: null, prices: [] })).toBeUndefined();
  });

  it("is undefined when there is no bundle loaded yet", () => {
    expect(storedBundleCurrency(undefined)).toBeUndefined();
  });

  it("falls back to a stored row when the server could not resolve one", () => {
    // A price row whose price list no longer joins arrives with a null resolved
    // currency. The bundle IS priced, so reading this as "never priced" would let
    // the card propose the settlement currency for it.
    expect(
      storedBundleCurrency({ resolvedCurrency: null, prices: [priced("XTS")] }),
    ).toBe("XTS");
  });

  it("ignores a stored row that carries no currency at all", () => {
    expect(
      storedBundleCurrency({ resolvedCurrency: null, prices: [priced(""), priced("XXA")] }),
    ).toBe("XXA");
  });
});

describe("bundlePreviewKey", () => {
  it("separates a request that names a currency from one that does not", () => {
    // Same bundle, same target, two different questions: anchor this to a named
    // currency, versus resolve it from the bundle's own price row. One key for
    // both would serve the first answer for the second after a first save.
    expect(bundlePreviewKey("b", 2000, "XTS")).not.toEqual(bundlePreviewKey("b", 2000));
  });

  it("keeps every candidate target cached separately", () => {
    expect(bundlePreviewKey("b", 2000)).not.toEqual(bundlePreviewKey("b", 3000));
  });
});
