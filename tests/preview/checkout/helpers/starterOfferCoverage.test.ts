import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasStarterOfferMarker,
  STARTER_OFFER_ALLOW_ENV,
  STARTER_OFFER_SKIP_MARKER,
  starterOfferCoverageVerdict,
  starterOfferOverrideEnabled,
} from "./starterOfferCoverage.ts";

/**
 * Falsifier for wave W4b. The reporter's job is to turn a silently-skipping
 * checkout suite red; these assertions are what stop it from silently becoming a
 * no-op itself.
 */
describe("starterOfferCoverageVerdict", () => {
  it("passes when nothing was suppressed", () => {
    const verdict = starterOfferCoverageVerdict({ suppressed: 0, executed: 12 }, false);
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toBeNull();
  });

  it("fails closed on a single suppressed journey", () => {
    const verdict = starterOfferCoverageVerdict({ suppressed: 1, executed: 12 }, false);
    expect(verdict.status).toBe("failed");
    expect(verdict.message).toContain("1 checkout journey");
    expect(verdict.message).toContain("STARTER_PACK_KNOWN_EMAIL");
  });

  it("fails closed when every guarded journey was suppressed", () => {
    // The live silent-failure mode: a reset database makes the fallback mailbox
    // first-order eligible and all fourteen guards fire together.
    const verdict = starterOfferCoverageVerdict({ suppressed: 14, executed: 0 }, false);
    expect(verdict.status).toBe("failed");
    expect(verdict.message).toContain("14 checkout journeys");
  });

  it("downgrades to a warning under the documented override, still reporting the count", () => {
    const verdict = starterOfferCoverageVerdict({ suppressed: 14, executed: 0 }, true);
    expect(verdict.status).toBe("overridden");
    expect(verdict.message).toContain("WARNING");
    expect(verdict.message).toContain("14 checkout journeys");
  });

  it("stays green under the override when nothing was suppressed", () => {
    expect(starterOfferCoverageVerdict({ suppressed: 0, executed: 3 }, true).status).toBe("ok");
  });
});

describe("starterOfferOverrideEnabled", () => {
  it("opts out only on an explicit affirmative", () => {
    expect(starterOfferOverrideEnabled({ [STARTER_OFFER_ALLOW_ENV]: "1" })).toBe(true);
    expect(starterOfferOverrideEnabled({ [STARTER_OFFER_ALLOW_ENV]: "true" })).toBe(true);
    expect(starterOfferOverrideEnabled({ [STARTER_OFFER_ALLOW_ENV]: "TRUE" })).toBe(true);
  });

  it("does not opt out on absent, empty, or falsy values", () => {
    expect(starterOfferOverrideEnabled({})).toBe(false);
    expect(starterOfferOverrideEnabled({ [STARTER_OFFER_ALLOW_ENV]: "" })).toBe(false);
    expect(starterOfferOverrideEnabled({ [STARTER_OFFER_ALLOW_ENV]: "0" })).toBe(false);
    // ⛔ A stray value must not silently disable the gate.
    expect(starterOfferOverrideEnabled({ [STARTER_OFFER_ALLOW_ENV]: "no" })).toBe(false);
  });
});

describe("hasStarterOfferMarker", () => {
  it("attributes only annotations carrying the marker", () => {
    expect(hasStarterOfferMarker([{ description: `x ${STARTER_OFFER_SKIP_MARKER} y` }])).toBe(true);
    expect(hasStarterOfferMarker(undefined)).toBe(false);
    expect(hasStarterOfferMarker([])).toBe(false);
    expect(hasStarterOfferMarker([{}])).toBe(false);
    // The suite's other environment skips must never be counted.
    expect(
      hasStarterOfferMarker([
        { description: "stripe-pay-panel did not mount (stripeCheckoutUiEnabled off)" },
        { description: "journey checkout runs on desktop-chromium only" },
      ]),
    ).toBe(false);
  });
});

describe("spec wiring", () => {
  const specs = [
    "checkout-preview.spec.ts",
    "checkout-stripe.spec.ts",
    "checkout-tpay.spec.ts",
  ] as const;

  // Attribution is by marker, so a skip reason that loses the marker becomes
  // invisible to the reporter. That is the one regression that would restore the
  // silent green without failing anything, so it is pinned here.
  it.each(specs)("%s embeds the marker in its starter-offer skip reason", (spec) => {
    const source = readFileSync(join(import.meta.dirname, "..", spec), "utf8");
    // The reason is built from the shared constant, so the source carries the
    // identifier rather than the literal. Pin both the import and the
    // interpolation: either one going missing makes every skip in that file
    // invisible to the reporter, restoring the silent green.
    expect(source).toContain(
      'import { STARTER_OFFER_SKIP_MARKER } from "./helpers/starterOfferCoverage.ts";',
    );
    expect(source).toMatch(
      /const STARTER_OFFER_SKIP =\s*\n\s*`\$\{STARTER_OFFER_SKIP_MARKER\}/,
    );
  });

  it("registers the reporter in the checkout Playwright config", () => {
    const config = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "..", "playwright.checkout.config.ts"),
      "utf8",
    );
    expect(config).toContain("starterOfferCoverage.ts");
  });
});
