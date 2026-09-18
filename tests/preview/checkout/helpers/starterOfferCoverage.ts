import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Fail-closed accounting for the starter-offer skip in the checkout browser matrix.
 *
 * WHY THIS EXISTS
 *
 * Fourteen journeys across `checkout-preview.spec.ts`, `checkout-stripe.spec.ts`
 * and `checkout-tpay.spec.ts` guard themselves with
 * `test.skip(await starterOfferShown(page), STARTER_OFFER_SKIP)`. The guard is
 * correct: when step 5 paints the acquisition offer instead of the purchase-mode
 * controls, there is no purchase shape to drive and `fillStep4` would only time
 * out waiting for controls that are gone by design.
 *
 * What was wrong is the SIGNAL. A fired guard exits 0 with no assertions
 * executed, so a deployment that serves the acquisition offer to every mailbox
 * turns the most business-critical suite in the product green while it proves
 * nothing whatsoever about checkout.
 *
 * That state is reachable today, not hypothetically. `COMMERCE_STARTER_PACK_ENABLED`
 * is true on staging and declared true for production, and the staging
 * `configurator_offer_layout` row is `starter_first`. Two test-side facts hold the
 * offer off the guarded journeys: the default `?offer=subscription` pin, and a
 * paid-history mailbox. The second is NOT under test control -- it falls back to
 * `MAILBOXES.returning`, whose history accumulates run over run, so a freshly
 * reset database makes that mailbox first-order eligible and fires all fourteen
 * guards at once.
 *
 * This reporter counts the guards that fired and fails the run when any journey
 * was suppressed, so the silent green becomes an attributable red.
 *
 * ⛔ It deliberately does NOT count the suite's other environment skips (no preview
 * base URL, non-desktop project, Stripe panel absent, promo inactive, Tpay tile
 * absent). Those are preconditions with no coverage claim attached; only the
 * starter-offer guard silently deletes an assertion that was expected to run.
 * Attribution is by marker, never by counting skips in general.
 */

/**
 * Sentinel embedded in every starter-offer skip reason.
 *
 * Attribution is by this marker alone. Matching on prose would silently stop
 * working the first time someone rewords a skip message, which is precisely the
 * failure mode this module exists to prevent.
 */
export const STARTER_OFFER_SKIP_MARKER = "[starter-offer-coverage]";

/** Env knob that downgrades the failure to a warning. */
export const STARTER_OFFER_ALLOW_ENV = "CHECKOUT_ALLOW_STARTER_OFFER_SKIPS";

/** What the run did with the starter-offer-guarded journeys. */
export interface StarterOfferCoverageCounts {
  /** Guarded journeys the starter offer suppressed. */
  suppressed: number;
  /** Tests that actually reached a verdict (passed or failed), suite-wide. */
  executed: number;
}

export interface StarterOfferCoverageVerdict {
  /**
   * `ok` - nothing was suppressed.
   * `overridden` - suppressed, but the operator opted out; warn and stay green.
   * `failed` - suppressed with no opt-out; the run must go red.
   */
  status: "ok" | "overridden" | "failed";
  /** Human-readable line to print, or null when there is nothing to say. */
  message: string | null;
}

/**
 * Pure decision function behind the reporter, kept separate so the fail-closed
 * behaviour is provable in the vitest node lane without booting a browser.
 */
export function starterOfferCoverageVerdict(
  counts: StarterOfferCoverageCounts,
  allowOverride: boolean,
): StarterOfferCoverageVerdict {
  if (counts.suppressed <= 0) return { status: "ok", message: null };

  const journeys = `${String(counts.suppressed)} checkout ${
    counts.suppressed === 1 ? "journey" : "journeys"
  }`;
  const detail =
    `${journeys} proved nothing: step 5 served the starter-pack acquisition offer, ` +
    `so the purchase-mode assertions never ran (${String(counts.executed)} test(s) ` +
    `did reach a verdict). Point STARTER_PACK_KNOWN_EMAIL at a mailbox with paid ` +
    `history on this deployment, or set ${STARTER_OFFER_ALLOW_ENV}=1 to accept the ` +
    `reduced coverage deliberately.`;

  if (allowOverride) {
    return {
      status: "overridden",
      message: `starter-offer coverage WARNING (${STARTER_OFFER_ALLOW_ENV} set): ${detail}`,
    };
  }
  return { status: "failed", message: `starter-offer coverage FAILURE: ${detail}` };
}

/** True when any annotation description carries the marker. */
export function hasStarterOfferMarker(
  annotations: readonly { readonly description?: string }[] | undefined,
): boolean {
  return (annotations ?? []).some((annotation) =>
    (annotation.description ?? "").includes(STARTER_OFFER_SKIP_MARKER),
  );
}

/** Reads the opt-out from an env bag. Only "1" and "true" opt out. */
export function starterOfferOverrideEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[STARTER_OFFER_ALLOW_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Playwright reporter that turns suppressed checkout journeys into a red run.
 *
 * Runtime `test.skip(condition, description)` appends to `testInfo.annotations`,
 * which reaches the reporter on `TestResult.annotations`. `TestCase.annotations`
 * is also consulted so the attribution survives either shape.
 */
class StarterOfferCoverageReporter implements Reporter {
  private suppressed = 0;
  private executed = 0;

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "skipped") {
      if (
        hasStarterOfferMarker(result.annotations) ||
        hasStarterOfferMarker(test.annotations)
      ) {
        this.suppressed += 1;
      }
      return;
    }
    if (result.status === "passed" || result.status === "failed") this.executed += 1;
  }

  // Async because `Reporter.onEnd` types its status override as
  // `void | Promise<...>`; a synchronous object return does not satisfy it.
  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | undefined> {
    const verdict = starterOfferCoverageVerdict(
      { suppressed: this.suppressed, executed: this.executed },
      starterOfferOverrideEnabled(process.env),
    );
    if (verdict.message) console.error(`\n${verdict.message}\n`);
    // Never downgrade a run that already failed for its own reasons.
    if (verdict.status === "failed" && result.status === "passed") return { status: "failed" };
    return undefined;
  }
}

export default StarterOfferCoverageReporter;
