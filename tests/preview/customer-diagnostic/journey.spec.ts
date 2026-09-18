import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Response as PlaywrightResponse, type Route } from "@playwright/test";

import { mintCustomerSessionWithRetry } from "../../../scripts/mint-customer-session-with-retry.ts";
// ⛔ RETAINED, and it must stay that way: `verify-closure` fails a retained source that
// names a withheld one, and both `tests/preview/checkout/helpers/configuratorFlow.ts` and
// `helpers/stripe.ts` are withheld through their own imports. `journeyDrive.ts` beside this
// file is the adapted copy of exactly the subset these legs use - see its header for why.
// `helpers/fixtures.ts` IS retained and is still imported directly.
import {
  CARD_DECLINED,
  choosePayment,
  expectStep,
  fillAddressStep,
  fillPackageStep,
  fillStripeCard,
  isCheckoutSubmitResponse,
  isCheckoutSubmitUrl,
  next,
  payButton,
  starterOfferShown,
  STRIPE_PANEL_TESTID,
  walkToPackageStep,
} from "./journeyDrive.ts";
import {
  ADDRESSES, CONSENTS, DOGS, INVOICES, MAILBOXES, ownerFor,
  type AllergenSlug, type FlavorSlug,
} from "../checkout/helpers/fixtures.ts";

/**
 * The customer-diagnostic staging journey (Wave 5 item 6).
 *
 * This suite drives the SHIPPED browser producers on one immutable candidate. It never
 * POSTs to `/api/bff/platform/customer-diagnostic-events` itself: a script that did would
 * prove the ingest route and nothing about the bundle baked with
 * `VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED=true`, and it would additionally need
 * `CUSTOMER_DIAGNOSTIC_INGRESS_KEY` in the runner's hands. The deployment holds that key,
 * inside itself, which is the whole reason this leg is Playwright.
 *
 * Every leg either passes on an observation it actually saw or records `unknown` with the
 * reason it could not be driven. Nothing here guesses a pass: `scripts/customer-diagnostic-
 * staging-proof.ts` is fail-closed on unknowns, so a guessed leg buys a ready verdict.
 * Legs therefore wait for the observation they need (`awaitObservation`) instead of for a
 * fixed sleep, and the magic-link leg additionally judges WHERE the browser landed.
 *
 * The collected legs are written to `$CUSTOMER_DIAGNOSTIC_JOURNEY_LEGS`; the runner turns
 * them into a receipt whose identifiers are fingerprinted, never raw.
 *
 * Two legs drive the shipped configurator rather than only watching it, and their ORDER is
 * load-bearing. `checkout-submit-rejected` runs first and INTERCEPTS a single
 * `POST /api/bff/commerce/checkout`, answering it with the shipped error envelope carrying
 * an `x-request-id` - the only condition under which the bundle reports a BROWSER-side
 * request reference at all. It mints no order and it unroutes itself before returning.
 * `seeded-recurring-payment-failure` then submits the SAME configured pack for real and
 * declines Stripe's published test card twice on the order that creates. A lane that ran
 * them the other way round would either decline against an intercepted submit or refuse a
 * submit the previous leg had already spent.
 *
 * This file is RETAINED for publication, so it imports no withheld module. Two decisions it
 * cannot make on its own - whether the recipient is an approved test address, and whether
 * the Supabase project is the staging one - live on the withheld side, so
 * `scripts/staging-customer-diagnostic-journey.ts` makes them and hands the answer down as
 * `CUSTOMER_DIAGNOSTIC_JOURNEY_APPROVED=1`. Without that flag the authenticated legs record
 * `unknown` and never reach for a credential.
 */

const INGEST_PATH = "/api/bff/platform/customer-diagnostic-events";
const CREDENTIAL_KEY = "customer-diagnostic-segment:v1";
const MAIN = "#main-content";
/**
 * The account routes do NOT all carry `#main-content`.
 *
 * On 2026-09-15 `magic-link-sign-in` reported `unknown: waiting for #main-content` on a
 * candidate the database proved had authenticated: the dashboard shell renders
 * `<main className="min-w-0">` with no id at all (`src/pages/account/v2/AccountShell.tsx`),
 * while `#main-content` exists only on the public pages and on the account LOGIN and
 * payment pages (`LoginPage.tsx`, `RecoverPaymentPage.tsx`, `CompletePaymentPage.tsx`).
 * Waiting for the element itself covers both, and it costs nothing that mattered: a
 * rendered sign-in form was never what proved a session here - the landing-origin check
 * and an accepted auth observation are, and both stay.
 */
const ACCOUNT_MAIN = "main";
const ACCOUNT_PATH = "/konto";
const SIGN_IN_PATH = "/zaloguj-sie";
const SUBMIT_TESTID = "configurator-submit";
/**
 * The account dashboard's card-replacement CTA. There is no testid on it, so it is matched
 * by its shipped Polish label (`account:dashboard.sectionsV2.payments.card.replaceCta` in
 * `src/i18n/locales/pl/account.json`); the journey drives the `pl` surface throughout.
 */
const CARD_SETUP_CTA = "Zmień kartę";
/** How many flavors the pack takes - the checkout helper's own default, kept explicit here
 *  because the in-stock list the runner hands in has to be trimmed to the same shape. */
const PACK_FLAVORS = 2;
const READY_MS = 15_000;
/** How long a leg waits for the observation it needs, and how often it looks. */
const OBSERVATION_MS = 10_000;
/**
 * The gate is the one leg whose producer is lazy: `src/pages/skomponuj-pakiet/index.tsx`
 * emits `configurator_enter` on mount through the lazily loaded reporter, and on two of
 * three runs on 2026-09-15 that chunk had not landed inside 10 s. Only the WAIT widens;
 * the accepted-observation bar does not, so a candidate that never emits stays `unknown`
 * rather than passing on a rendered route.
 */
const GATE_OBSERVATION_MS = 20_000;
const AUTH_OBSERVATION_MS = 15_000;
const LANDING_MS = 30_000;
/** The configurator walk may not eat the authenticated tail; the project timeout is the sum
 *  of these ceilings, not a slack allowance (`playwright.account.config.ts`). */
const DRIVE_MS = 60_000;
/** The double-decline leg, end to end: two confirms, a recovery and a segment rotation. */
const DECLINE_LEG_MS = 150_000;
/** How long the Payment Element gets to mount, and to unmount into the shipped recovery. */
const PANEL_MS = 20_000;
/** The ingest's own admission cap, its window, and how long a leg will wait for headroom. */
const ADMISSION_CAP = 20;
const CAP_WINDOW_MS = 60_000;
const HEADROOM_MS = 65_000;
/** What a critical moment is about to spend: a submit or a confirm emits a handful. */
const HEADROOM_NEEDED = 8;
/** A confirm's own settlement, and the shorter window before the ONE retry click. */
const CONFIRM_MS = 20_000;
const CONFIRM_FIRST_MS = 8_000;
const POLL_MS = 250;
const FAILURE_CODES = new Set(["failed", "rejected", "timeout", "transport_uncertain", "retryable"]);
const PAYMENT_ACTIONS = new Set(["checkout_submit", "payment_confirm", "payment_status"]);
const AUTH_ACTIONS = new Set(["auth_callback", "auth_bootstrap"]);
/**
 * The BFF's own request-reference header (`src/lib/bff/contracts.ts`
 * `BFF_REQUEST_REFERENCE_HEADER`). `requestBff` reads it - or the identical
 * `meta.requestId` - off a rejected response into `BffClientError.requestId`, and
 * `src/lib/diagnostics/customerJourneyCheckoutProducer.ts` is the ONLY producer in the
 * bundle that puts such a value on an observation, as `relatedRequestId`.
 */
const REQUEST_REFERENCE_HEADER = "x-request-id";
/**
 * Run-unique, so the leg can prove THIS submit produced the reference it observes rather
 * than inheriting one. Shape is the intersection of the two filters it must pass: the
 * client's `bffRequestReferenceSchema` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`) and the
 * reporter's own `validRequestId` before it queues the observation.
 */
const REQUEST_REFERENCE = `cdj-${randomUUID()}`;

type Observation = {
  status: number; at: number; action?: string; phase?: string; code?: string;
  clientActionKey?: string; relatedRequestId?: string;
};
type Leg = { id: string; status: "pass" | "fail" | "unknown"; detail: string };

const legs: Leg[] = [];
const identifiers: Record<string, string> = {};
const counts: Record<string, number> = {};
const observations: Observation[] = [];
/** Which flavors the pack was built from, for the refusal detail. Empty = the enabled tiles. */
let packFlavors: string[] = [];
/** Which step-5 shape the candidate served: the sampler carries SKUs the tiles never picked. */
let packPath = "unreached";
/** Flavors kept out of the MIX through the dog's allergens, because the pack blends them all. */
let packExcluded: string[] = [];
/** How the second confirm was reached - the retry does not always mint a new checkout POST. */
let retryPath = "not reached";
const startedAt = new Date().toISOString();

const record = (id: string, status: Leg["status"], detail: string): void => { legs.push({ id, status, detail }); };
const since = (mark: number): Observation[] => observations.slice(mark);
const accepted = (rows: Observation[]): Observation[] => rows.filter((row) => row.status >= 200 && row.status < 300);
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wait for an observation the browser actually produced, rather than for a clock.
 *
 * A leg decided by a fixed sleep reports whatever the reporter happened to have drained by
 * the time the sleep ended - on 2026-09-15 that both passed a leg with no session behind it
 * and reported `unknown` for a callback the database proved had settled.
 *
 * Only ACCEPTED observations count. That TIGHTENS the gate and card-setup legs, which used
 * to take any status: a rejected ingest is not evidence the producer's payload was taken, so
 * a leg that passed on one was claiming more than it saw. The one count this wave leaves
 * alone is the double-decline leg's `declines`, because that is a rail invariant rather
 * than a wait.
 */
async function awaitObservation(
  mark: number,
  predicate: (row: Observation) => boolean,
  timeoutMs: number,
): Promise<Observation | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = accepted(since(mark)).find(predicate);
    if (match) return match;
    if (Date.now() >= deadline) return null;
    await delay(POLL_MS);
  }
}

/** The origin of a navigable URL, or "" for `about:blank` and anything unparsable. */
function originOf(raw: string): string {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch { return ""; }
}

function safeUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

const isSettledDecline = (row: Observation): boolean =>
  PAYMENT_ACTIONS.has(row.action ?? "") && row.phase === "settled" && FAILURE_CODES.has(row.code ?? "");

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  const out = process.env.CUSTOMER_DIAGNOSTIC_JOURNEY_LEGS;
  if (!out) return;
  counts.acceptedObservations = accepted(observations).length;
  counts.rejectedObservations = observations.length - accepted(observations).length;
  writeFileSync(out, `${JSON.stringify({
    schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), legs, identifiers, counts,
  }, null, 2)}\n`, "utf8");
});

test("the shipped producers emit across an anonymous -> authenticated -> account journey", async ({ page }) => {
  watch(page);

  await leg("anonymous-browse", async () => {
    const mark = observations.length;
    if (!await visit(page, "/", MAIN)) return unknown("the candidate did not render its public entry");
    if (!await awaitObservation(mark, () => true, OBSERVATION_MS)) {
      return unknown("the entry rendered but no observation was accepted");
    }
    const emitted = accepted(since(mark));
    identifiers.anonymousSegmentCredential = (await credential(page)) ?? "";
    return pass(`${emitted.length} accepted observation(s) on the anonymous entry`);
  });

  await leg("configurator-quote-gate", async () => {
    const mark = observations.length;
    if (!await visit(page, "/skomponuj-pakiet", MAIN)) return unknown("the configurator did not render on this candidate");
    const gate = await awaitObservation(
      mark,
      (row) => row.action === "configurator_enter" || row.action === "configurator_gate",
      GATE_OBSERVATION_MS,
    );
    return gate
      ? pass(`the configurator emitted '${gate.action}'`)
      : unknown("the configurator rendered but emitted no gate observation" + rejectionsSince(mark));
  });

  await leg("checkout-entry", async () => {
    const mark = observations.length;
    // The gate redirects when no quote exists, which is a legitimate outcome here rather
    // than a failure: the two legs below drive the configurator themselves, so nothing
    // here has to leave a quote behind for them.
    if (!await visit(page, "/skomponuj-pakiet/platnosc", MAIN)) return unknown("checkout entry did not render");
    if (!await awaitObservation(mark, () => true, OBSERVATION_MS)) {
      return unknown("checkout entry rendered without a quote, so no submit observation was produced");
    }
    return pass(`${accepted(since(mark)).length} accepted observation(s) on checkout entry`);
  });

  await leg("checkout-submit-rejected", async () => {
    // The ONE leg that proves a BROWSER-reported request reference reaches the ingest,
    // distinct from the reference the ingest mints for its own request - which is exactly
    // what the readback's `request_correlation` probe reads, and what stayed `unknown` on
    // 2026-09-15 because nothing in the journey had ever made the BFF reject a submit.
    let intercepted = false;
    const submitRoute = (url: URL): boolean => isCheckoutSubmitUrl(url.href);
    const refuse = async (route: Route): Promise<void> => {
      if (route.request().method() !== "POST") { await route.fallback(); return; }
      // ⛔ The FIRST post is answered here; a later one is ABORTED, never passed through.
      // `route.fallback()` would reach the real BFF and mint a real order on the
      // candidate, which this leg has no business doing - it exercises the refusal path.
      if (intercepted) { await route.abort(); return; }
      intercepted = true;
      await route.fulfill({
        status: 409,
        headers: { "content-type": "application/json", [REQUEST_REFERENCE_HEADER]: REQUEST_REFERENCE },
        // The shipped error envelope (`bffErrorResponseSchema`). `details.reason` is what
        // makes the SPA read this as a deterministic REJECTION rather than an ambiguous
        // submit: `isStockUnavailableCheckoutError` settles the diagnostic `rejected` with
        // the `BffClientError` as its source, and issues no readback of its own, so the
        // leg costs exactly one intercepted request. `meta.requestId` repeats the header
        // because `readResponseRequestId` withholds the value when the two disagree.
        body: JSON.stringify({
          ok: false,
          error: {
            code: "CONFLICT",
            message: "customer-diagnostic journey: refused on purpose",
            details: { reason: "stock_unavailable" },
          },
          meta: { requestId: REQUEST_REFERENCE },
        }),
      });
    };
    await page.route(submitRoute, refuse);
    try {
      const undrivable = await driveToPaymentStep(page);
      if (undrivable) return unknown(undrivable);
      // ⛔ The walk itself spends the segment's whole 20-per-minute admission budget, so the
      // ONE observation this leg exists to read would be refused - measured on 2026-09-15.
      // Wait for headroom rather than touching the page: the 19:58Z run proved a reload
      // costs the released payment step.
      const spare = await awaitHeadroom(HEADROOM_NEEDED);
      const mark = observations.length;
      await page.getByTestId(SUBMIT_TESTID).click({ timeout: READY_MS });
      const settled = await awaitObservation(
        mark,
        (row) => row.action === "checkout_submit" && row.phase === "settled"
          && row.relatedRequestId === REQUEST_REFERENCE,
        OBSERVATION_MS,
      );
      if (!settled) {
        return unknown((intercepted
          ? "the checkout submit was refused but no accepted observation carried the browser's request reference"
          : "the payment step was reached but the shipped configurator posted no checkout submit")
          + (spare ? "" : " (the ingest's admission window never cleared within this leg's wait)")
          + rejectionsSince(mark));
      }
      // Fingerprinted by the runner like every other identifier; never raw in a detail.
      identifiers.browserReportedRequestReference = REQUEST_REFERENCE;
      return pass(`a refused checkout submit reported the BFF's request reference ('${settled.code ?? ""}')`);
    } finally {
      // The later legs must reach the real BFF again.
      await page.unroute(submitRoute, refuse).catch(() => undefined);
    }
  });

  await leg("seeded-recurring-payment-failure", async () => {
    // The leg id is HISTORICAL and deliberately kept: renaming it moves the runbook, the
    // receipt, the packet and the readiness history for no gain. NOTHING is seeded here
    // any more. The previous shape seeded a Tpay-simulator decline server-side and opened
    // its payment-status URL, which cannot work: `/skomponuj-pakiet/platnosc`
    // (`src/checkout/adapters/PlatnoscPage.tsx`) mounts no customer-diagnostic producer at
    // all, so a decline the browser did not perform is not observable from that route.
    //
    // What it does instead is the thing the invariant is actually about: drive the SHIPPED
    // configurator and Payment Element and decline Stripe's published test card TWICE on
    // one order, through the shipped recovery - a card decline unmounts the panel and hands
    // the buyer back the payment step with the reason and the tiles, so the retry is one
    // tap on the same CTA. Wave 2R's per-submit action key must record those two declines
    // as TWO actions rather than one conflicting terminal, and
    // `useConfiguratorCheckoutTerminalRouting.ts:205` mints a fresh key per settlement.
    const budget = Date.now() + DECLINE_LEG_MS;
    const mark = observations.length;
    /** How long each confirm took to settle - the receipt's evidence that BOTH happened. */
    const settledMs: number[] = [];
    const reachable = await reachStripePanel(page);
    if (reachable) return unknown(reachable);
    for (const attempt of [1, 2]) {
      if (attempt === 2) {
        if (Date.now() > budget) return unknown(`the first decline settled past this leg's budget, so the retry was not driven${describeDeclines(settledMs)}`);
        const reopened = await reopenAfterDecline(page);
        if (reopened) return unknown(`${reopened}${describeDeclines(settledMs)}`);
        // The retry's own settlement is a second observation the cap can refuse.
        await awaitHeadroom(HEADROOM_NEEDED);
      }
      // Wait for THIS attempt's settlement rather than a flat sleep: on a slow candidate
      // the second decline would otherwise go uncounted and the invariant would report a
      // collapse the rail never produced.
      const startedAt = Date.now();
      const failed = await declineOnce(page, observations.length);
      if (failed) return unknown(`${failed} (attempt ${attempt})${describeDeclines(settledMs)}`);
      settledMs.push(Date.now() - startedAt);
    }
    // Counted exactly as before - every settled failure, not only the accepted ones - so
    // this wave changes where the declines come from, never what the invariant counts.
    const declines = since(mark).filter(isSettledDecline);
    const actionKeys = new Set(declines.map((row) => row.clientActionKey ?? ""));
    counts.paymentFailureActions = actionKeys.size;
    if (declines.length === 0) {
      return unknown("the declined card was confirmed twice but no settled payment failure was observed"
        + describeDeclines(settledMs) + rejectionsSince(mark));
    }
    return actionKeys.size === 2
      ? pass(`two declines of the same card recorded two distinct actions${describeDeclines(settledMs)}`)
      : fail(`two declines collapsed into ${actionKeys.size} action(s)${describeDeclines(settledMs)}`);
  });

  const session = await signIn(page);
  await leg("magic-link-sign-in", async () => session);

  await leg("account-section", async () => {
    if (session.status !== "pass") return unknown("no customer session, so the account section was never reached");
    const mark = observations.length;
    if (!await visit(page, ACCOUNT_PATH, ACCOUNT_MAIN)) return unknown("the account dashboard did not render");
    // A rendered sign-in form is not an account dashboard. The magic-link leg can land a
    // session on a DIFFERENT origin (the Supabase redirect allow-list decides), and this
    // candidate would then bounce `/konto` here and emit anonymous beacons that read like a
    // pass. Report the bounce instead of counting them.
    if ((safeUrl(page.url())?.pathname ?? "").startsWith(SIGN_IN_PATH)) {
      return unknown("the candidate redirected /konto to sign-in: no session on this origin");
    }
    identifiers.authenticatedSegmentCredential = (await credential(page)) ?? "";
    if (identifiers.authenticatedSegmentCredential
      && identifiers.authenticatedSegmentCredential === identifiers.anonymousSegmentCredential) {
      return fail("the segment credential did not rotate across the authentication boundary");
    }
    if (!await awaitObservation(mark, () => true, OBSERVATION_MS)) {
      return unknown("the account dashboard rendered but emitted nothing" + rejectionsSince(mark));
    }
    return pass(`${accepted(since(mark)).length} accepted observation(s) on the account dashboard`);
  });

  await leg("payment-card-setup-retry", async () => {
    if (session.status !== "pass") return unknown("no customer session, so the card-setup retry was never reached");
    // ⛔ The route was WRONG until 2026-09-15 19:58Z, and no wait would have fixed it.
    // `/konto/platnosc/napraw` (`src/pages/account/RecoverPaymentPage.tsx`) reported NOTHING
    // then; since 2026-09-16 it reports `account_card_setup` too
    // (`src/pages/account/cardSetupSupport.ts`), but this leg drives
    // `src/pages/account/v2/sections/PaymentCardSetup.tsx`, which the
    // dashboard's PAYMENTS tab mounts - URL-addressable as `?sekcja=payments`
    // (`src/pages/account/v2/lib/useAccountNavigation.ts`).
    //
    // And it is not a render-time producer: `reportCardSetup("attempted", "observed", ...)`
    // fires from `begin()`, the "change card" CTA's own handler, BEFORE its network call.
    // So the leg presses the button a customer would press. `begin()` mints a Stripe SETUP
    // intent on the test account - no charge, and no card is ever confirmed; the observation
    // this leg needs is already emitted by then.
    if (!await visit(page, `${ACCOUNT_PATH}?sekcja=payments`, ACCOUNT_MAIN)) {
      return unknown("the account payments section did not render");
    }
    // Present only for an account that HAS a card-capable subscription (`cardSubscriptionId`
    // in `PaymentsSection.tsx`); its absence is a fixture fact, not a producer defect.
    const replaceCard = page.getByRole("button", { name: CARD_SETUP_CTA, exact: true });
    if (!await replaceCard.isVisible({ timeout: READY_MS }).catch(() => false)) {
      return unknown("the payments section offered no card-replacement control, so this account has no card-capable subscription to retry");
    }
    await awaitHeadroom(HEADROOM_NEEDED);
    const mark = observations.length;
    await replaceCard.click({ timeout: READY_MS });
    const setup = await awaitObservation(
      mark,
      (row) => row.action === "account_card_setup" || row.action === "account_payment_mutation",
      OBSERVATION_MS,
    );
    return setup
      ? pass(`the account surface emitted '${setup.action}'`)
      : unknown("the card-replacement control was pressed but emitted no card-setup observation" + rejectionsSince(mark));
  });
});

/**
 * Walk the SHIPPED configurator to its payment step with the RETAINED checkout helpers.
 * Returns `null` when it arrived, and otherwise the reason it could not be driven - the
 * leg is then `unknown`, never a guess, because a configurator this run could not walk
 * says nothing about whether the refusal path reports a request reference.
 *
 * The walk skips the caloric reveal, which is not an optimisation: the reveal dwells 16-21 s
 * between the contact and package steps and this journey has eight legs to fit.
 *
 * The RETURNING mailbox, aliased per call by `ownerFor`, so each walk is its own bucket in
 * the fail-closed public-checkout limiter (five attempts per address per hour) while
 * first-order eligibility still plus-normalizes back to a paid-history identity - which is
 * what keeps the starter-pack sampler off the package step. The Stripe suite resolves the
 * same pair, so one `STARTER_PACK_KNOWN_EMAIL` serves both.
 */
async function driveToPaymentStep(page: Page): Promise<string | null> {
  const deadline = Date.now() + DRIVE_MS;
  try {
    // ⛔ WHICH flavors, when the runner could read the candidate's stock. On 2026-09-15
    // 20:06Z the real submit came back `409 (CONFLICT/stock_unavailable)`: five of six can
    // SKUs had `reserved == on_hand` against two live reservation rows - the materialized
    // counters had drifted - and the configurator renders a tile for them anyway, so
    // "whatever is enabled" built a pack the BFF had to refuse. An empty list falls back to
    // that same enabled-tile pick, which is exactly the old behaviour.
    const preferred = (process.env.CUSTOMER_DIAGNOSTIC_JOURNEY_FLAVORS ?? "")
      .split(",").map((slug) => slug.trim()).filter(Boolean).slice(0, PACK_FLAVORS);
    packFlavors = preferred;
    // ⛔ The dog's ALLERGENS, which is the only lever the shipped configurator gives over the
    // MIX. The 20:41Z run submitted `beef:3 + lamb:1 + pork:1 + salmon:3 + turkey:3 +
    // venison:3` from two picked tiles: the one-time pack algorithm blends every flavor the
    // recommendation engine has. `buildRecommendationRequest` sends
    // `petProfile.allergenSlugs` and `buildCheckoutIntent` builds `selectedVariants` from the
    // lines that come back, so an allergen is what actually removes a flavor from the pack.
    // The runner never names an OFFERED flavor here - `configuratorValidation` refuses a
    // selected flavor that conflicts with an allergen, so such a pack would not submit at all.
    packExcluded = (process.env.CUSTOMER_DIAGNOSTIC_JOURNEY_EXCLUDE_FLAVORS ?? "")
      .split(",").map((slug) => slug.trim()).filter((slug) => slug && !preferred.includes(slug));
    await walkToPackageStep(page, {
      ...(preferred.length > 0 ? { flavors: preferred as FlavorSlug[] } : {}),
      // The suite's low-stock-pressure profile: a 5 kg adult resolves to the smallest real
      // can count.
      dog: DOGS.smallPuppy,
      ...(packExcluded.length > 0
        ? { allergies: { hasAllergies: true, allergens: packExcluded as AllergenSlug[] } }
        : {}),
      // ⛔ A RETURNING mailbox, and this is what the 20:34Z run turned on. A fresh address is
      // first-order-eligible, so `COMMERCE_STARTER_PACK_ENABLED` replaces the purchase-mode
      // step with the SAMPLER - and the sampler's intent carries all six flavor SKUs
      // whatever the tiles picked, which is why the detail read
      // `refused pack: BEEF + LAMB + PORK + SALMON + TURKEY + VENISON` while the runner had
      // offered three. Staging has no provider stock for lamb or pork, so that pack can
      // never reserve. The same knob the Stripe suite uses takes precedence, so an operator
      // can point both suites at one paid-history address.
      owner: ownerFor(process.env.STARTER_PACK_KNOWN_EMAIL ?? MAILBOXES.returning),
    });
    // The offer REPLACES the purchase-mode controls outright, so there is no regular path to
    // take when it still appears: `fillStep4` would only time out on controls the deployment
    // removed by design. Report it instead - naming the path taken either way.
    if (await starterOfferShown(page)) {
      return "the candidate served the starter-pack sampler in place of the purchase-mode step"
        + " (set STARTER_PACK_KNOWN_EMAIL to a paid-history mailbox); its intent carries every"
        + " flavor SKU, which cannot reserve against this candidate's provider stock";
    }
    packPath = "purchase-mode";
    // ONE-TIME, like `tests/preview/checkout/checkout-stripe.spec.ts`, which is the proof
    // that this exact shape reaches a mounted Payment Element on this candidate. A
    // subscription_initial adds a reusable-method mandate that neither of these two legs
    // observes, and the seeding this replaced was a one-time BLIK checkout too.
    await fillPackageStep(page, { lengthDays: 14, subscription: false });
    await next(page);
    await fillAddressStep(page, {
      address: ADDRESSES.warszawaCourier,
      invoice: INVOICES.none,
      consents: CONSENTS.required,
    });
    await next(page);
    await expectStep(page, 7);
    // Card is the rail a subscription needs (a reusable method) and the only tile that
    // asks for nothing further on this step: BLIK wants a code and pay-by-link a channel.
    await choosePayment(page, "card");
    // ⛔ Assert the CTA released before the leg clicks it. Playwright's actionability treats
    // `aria-disabled=true` as disabled, so a click on a still-blocked submit does not fail
    // with a reason - it hangs to the action timeout and spends the journey's budget.
    await expect(page.getByTestId(SUBMIT_TESTID), "the payment step released its submit")
      .not.toHaveAttribute("aria-disabled", "true", { timeout: READY_MS });
    return Date.now() > deadline
      ? "the configurator reached the payment step past this leg's budget, so the submit was not driven"
      : null;
  } catch (error) {
    return `the shipped configurator could not be driven to its payment step: ${message(error)}`;
  }
}

/**
 * Get the browser onto a MOUNTED Stripe Payment Element with a real order behind it.
 * Returns `null` when it arrived, and otherwise the reason it could not.
 *
 * The pack the refusal leg already configured is REUSED when the browser is still on a
 * released payment step: a second full walk costs ~30 s of the suite's budget and mints a
 * second quote for no extra evidence. The refusal leg lifted its route interception before
 * returning, so this submit reaches the real BFF and creates the order this leg declines.
 */
async function reachStripePanel(page: Page): Promise<string | null> {
  if (!await onReleasedPaymentStep(page)) {
    const undrivable = await driveToPaymentStep(page);
    if (undrivable) return undrivable;
  }
  // The walk - this leg's or the refusal leg's - spent the segment's admission budget, and
  // the two confirms below are the whole evidence. Wait for the window to clear rather than
  // reloading: the 19:58Z run proved a reload does not return a released payment step.
  //
  // The refusal leg left its forged submit error on screen; that is a MESSAGE, not a lock.
  // Its `stock_unavailable` branch had already run `clearCheckoutAttemptKey()` and
  // `clearCheckoutContinuation()`, so the machine is clean and the next submit mints a fresh
  // journey key - which is why three of the checkout route's four `409` reasons are
  // impossible here.
  await awaitHeadroom(HEADROOM_NEEDED);
  return submitForPanel(page);
}

/** Is the browser on step 7 with the submit CTA released? A cheap, bounded read. */
async function onReleasedPaymentStep(page: Page): Promise<boolean> {
  try {
    const step = await page.getByTestId("configurator-step-current").getAttribute("data-step", { timeout: 2_000 });
    if (step !== "7") return false;
    return await page.getByTestId(SUBMIT_TESTID).getAttribute("aria-disabled", { timeout: 2_000 }) !== "true";
  } catch { return false; }
}

/**
 * Submit the configured pack for real and wait for the Payment Element.
 *
 * Also the RETRY path: after a deterministic decline the shipped code unmounts the panel
 * and the same CTA re-enters checkout on the SAME order and the SAME payment intent
 * (`commerce_payment_intents` is `UNIQUE (order_id)`), so this is one function, not two.
 */
async function submitForPanel(page: Page): Promise<string | null> {
  try {
    const submitted = page.waitForResponse(isCheckoutSubmitResponse, { timeout: READY_MS }).catch(() => null);
    await page.getByTestId(SUBMIT_TESTID).click({ timeout: READY_MS });
    const response = await submitted;
    if (!response) return "the payment step was reached but the checkout submit produced no response";
    // 429/503 are the shared preview's capacity answers (per-IP checkout quota, bounded
    // inventory reservations), not a defect - and an `unknown` never counts as a pass.
    if (response.status() >= 400) {
      // The status alone said nothing on 2026-09-15, and the refusal reason alone was not
      // enough either: `stock_unavailable` on a candidate the runner had just read as
      // in-stock leaves the PACK as the only unknown. So the refused composition is named
      // too - SKUs and quantities are catalog vocabulary, never a customer value.
      return `the candidate answered the checkout submit with HTTP ${response.status()} `
        + `${await describeCheckoutRefusal(response)}, so no order was created to decline`
        + `${describeRefusedPack(response)}${describeHandedFlavors()}`;
    }
    // The order this leg is about to leave behind, so the withheld runner can release its
    // reservation afterwards. Raw here and fingerprinted in the receipt like every other
    // identifier; an unreleased `pending_payment` order IS the stock drift that broke the
    // 20:06Z run, one run at a time.
    await rememberDeclineOrder(response);
    const mounted = await page.getByTestId(STRIPE_PANEL_TESTID)
      .waitFor({ state: "visible", timeout: PANEL_MS }).then(() => true).catch(() => false);
    return mounted
      ? null
      : "the Stripe Payment Element did not mount (the candidate's card rail is unavailable, or PAYMENTS_STRIPE_SANDBOX_ENABLED is off)";
  } catch (error) {
    return `the checkout submit could not be driven: ${message(error)}`;
  }
}

/**
 * What the browser actually asked the BFF to buy: each `intent.selectedVariants[]` as
 * `sku:qty` (or its variant id when the line carries no SKU), plus the purchase shape. Read
 * off the REQUEST, so it is what was refused rather than what the harness meant to send.
 */
function describeRefusedPack(response: PlaywrightResponse): string {
  try {
    const body = JSON.parse(response.request().postData() ?? "{}") as {
      intent?: { selectedVariants?: unknown; mode?: unknown; cadenceDays?: unknown; sizeConstraint?: unknown };
    };
    const intent = body.intent ?? {};
    const lines = (Array.isArray(intent.selectedVariants) ? intent.selectedVariants : [])
      // ⛔ `qty`, not `quantity`: `commerce.configurator_intent.v1` spells it `qty`
      // (`src/domains/commerce/configuratorIntentContracts.ts:135`), which is why the 20:34Z
      // detail printed `sku:?` and hid the sampler's own quantities.
      .map((entry) => entry as { sku?: unknown; flavorSlug?: unknown; variantId?: unknown; qty?: unknown })
      .map((line) => {
        const name = [line.flavorSlug, line.sku, line.variantId].find((value) => typeof value === "string" && value);
        return `${String(name ?? "?")}:${typeof line.qty === "number" ? line.qty : "?"}`;
      });
    const shape = [
      typeof intent.mode === "string" ? `mode ${intent.mode}` : null,
      intent.cadenceDays !== undefined ? `cadenceDays ${String(intent.cadenceDays)}` : null,
      intent.sizeConstraint !== undefined ? `sizeConstraint ${String(intent.sizeConstraint)}` : null,
    ].filter(Boolean).join(", ");
    if (lines.length === 0 && !shape) return "";
    return ` [refused pack: ${lines.join(" + ") || "no lines"}${shape ? `; ${shape}` : ""}]`;
  } catch {
    return " [the refused pack could not be read]";
  }
}

/** What the withheld runner handed down, so a refusal can be read against it. */
function describeHandedFlavors(): string {
  const handed = (process.env.CUSTOMER_DIAGNOSTIC_JOURNEY_FLAVORS ?? "").trim();
  const took = handed
    ? `runner offered: ${handed}; pack took: ${packFlavors.join(",") || "none"}`
    : "the runner handed down no in-stock flavor list, so the pack took whatever was enabled";
  return ` [${took}; excluded: ${packExcluded.join(",") || "none"}; step-5 path: ${packPath}]`;
}

/** The first order id a checkout response carried, kept for the runner's cleanup. */
async function rememberDeclineOrder(response: PlaywrightResponse): Promise<void> {
  if (identifiers.declineOrderId) return;
  try {
    const body = await response.json() as { data?: { orderId?: unknown } };
    if (typeof body.data?.orderId === "string" && body.data.orderId) identifiers.declineOrderId = body.data.orderId;
  } catch {
    // An unreadable body costs the cleanup, never the leg.
  }
}

/** Both settlements, named: which confirms settled, how fast, and how the retry got there. */
function describeDeclines(settledMs: readonly number[]): string {
  const spelled = settledMs.map((ms, index) => `decline ${index + 1} settled after ${ms} ms`).join("; ");
  return ` [${spelled || "no decline settled"}; retry: ${retryPath}]`;
}

/** The refusal's own vocabulary: `<code>/<reason>` out of the shipped error envelope. */
async function describeCheckoutRefusal(response: PlaywrightResponse): Promise<string> {
  try {
    const body = await response.json() as { error?: { code?: unknown; details?: { reason?: unknown } } };
    const code = typeof body.error?.code === "string" ? body.error.code : "no code";
    const reason = typeof body.error?.details?.reason === "string" ? body.error.details.reason : "no reason";
    return `(${code}/${reason})`;
  } catch {
    return "(an error envelope this leg could not read)";
  }
}

/**
 * The shipped recovery, taken as a customer would: a deterministic card decline unmounts
 * the panel and returns the payment step with the reason and the method tiles still
 * selected, so the retry is ONE tap on the same CTA - no new order, no new intent.
 */
async function reopenAfterDecline(page: Page): Promise<string | null> {
  const panel = page.getByTestId(STRIPE_PANEL_TESTID);
  const hidden = await panel.waitFor({ state: "hidden", timeout: PANEL_MS }).then(() => true).catch(() => false);
  if (!hidden) return "the declined card did not return the buyer to the payment step, so the retry was not one tap away";
  try {
    // ⛔ The retry does NOT necessarily POST `/api/bff/commerce/checkout` again, and waiting
    // for one is what killed the 20:49Z run ("the payment step was reached but the checkout
    // submit produced no response") AFTER the first decline had already settled. The shipped
    // code resumes the SAME order and the SAME payment intent, so the panel can simply
    // remount from the action it already holds. Race the two outcomes and take whichever
    // arrives: a remounted panel IS the success, and a submit that does happen keeps its
    // 4xx handling.
    const resubmitted = page.waitForResponse(isCheckoutSubmitResponse, { timeout: PANEL_MS }).catch(() => null);
    const remounted = panel.waitFor({ state: "visible", timeout: PANEL_MS }).then(() => true).catch(() => false);
    await page.getByTestId(SUBMIT_TESTID).click({ timeout: READY_MS });
    const outcome = await Promise.race([
      remounted.then((visible) => (visible ? "panel" as const : null)),
      resubmitted.then((response) => (response ? { response } : null)),
    ]);
    if (outcome === "panel") { retryPath = "panel remounted without a new checkout POST"; return null; }
    if (outcome && typeof outcome === "object") {
      if (outcome.response.status() >= 400) {
        return `the retry's checkout submit was answered HTTP ${outcome.response.status()} ${await describeCheckoutRefusal(outcome.response)}`;
      }
      retryPath = `a fresh checkout POST answered ${outcome.response.status()}`;
      return await remounted ? null : "the retry's checkout submit was accepted but the Payment Element did not remount";
    }
    // Neither arm won inside the window; fall back to the panel's own final state.
    if (await remounted) { retryPath = "panel remounted without a new checkout POST"; return null; }
    return "the retry was pressed but neither a checkout submit nor a remounted Payment Element followed";
  } catch (error) {
    return `the retry could not be pressed: ${message(error)}`;
  }
}

/**
 * One confirm of Stripe's published declined test card, and the settled failure it must
 * produce. Returns `null` on success, otherwise the reason.
 *
 * ⛔ The single retry click is not a flake tolerance. The Payment Element finishes settling
 * AFTER the confirm button reports enabled, and when it does the button JUMPS - measured
 * 224 px on staging, 3/3 runs (`tests/preview/checkout/helpers/stripe.ts`) - so a first
 * click can be dispatched where the button no longer is and land on nothing. A retry cannot
 * double-charge: the shipped `handleSubmit` returns early while `isSubmitting` is true.
 * `confirmAndPoll` is the helper that owns this and is deliberately NOT reused: its
 * tolerant tail waits up to 30 s for a `/api/bff/commerce/payment-status` response that a
 * deterministic decline never produces, and this leg confirms twice inside 75 s.
 */
async function declineOnce(page: Page, mark: number): Promise<string | null> {
  try {
    await fillStripeCard(page, CARD_DECLINED);
    const submit = payButton(page);
    await expect(submit, "the Payment Element released its confirm").toBeEnabled({ timeout: READY_MS });
    await submit.click();
    if (await awaitObservation(mark, isSettledDecline, CONFIRM_FIRST_MS)) return null;
    await submit.click({ timeout: 5_000 }).catch(() => undefined);
    return await awaitObservation(mark, isSettledDecline, CONFIRM_MS)
      ? null
      : "the declined card was confirmed but no accepted settled-failure observation arrived";
  } catch (error) {
    return `the declined card could not be confirmed: ${message(error)}`;
  }
}

/** Mint a session through the shipped mechanics, then follow the real email link in the browser. */
async function signIn(page: Page): Promise<Leg> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  const email = (process.env.CUSTOMER_AUTH_SMOKE_EMAIL ?? "").trim().toLowerCase();
  // The runner already refused a production project and an unapproved recipient; without
  // its approval this leg does not reach for a credential at all.
  if (process.env.CUSTOMER_DIAGNOSTIC_JOURNEY_APPROVED !== "1" || !supabaseUrl || !serviceRoleKey || !anonKey || !email) {
    return { id: "magic-link-sign-in", status: "unknown", detail: "the runner did not approve the authenticated legs (no approved recipient, or no staging Supabase credentials); they were not driven" };
  }
  try {
    const auth = { persistSession: false, autoRefreshToken: false } as const;
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth });
    const anon = createClient(supabaseUrl, anonKey, { auth });
    const redirectTo = new URL("/konto/auth/callback", page.url() || "http://127.0.0.1").toString();
    const generate = async () => {
      const generated = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
      if (generated.error) throw generated.error;
      return generated.data as unknown as Record<string, unknown>;
    };
    // The bounded retry is the shipped one: a single-use link can be consumed or throttled
    // between generate and verify, and every attempt regenerates rather than replaying.
    await mintCustomerSessionWithRetry({
      generateTokenHash: async () => tokenHash(await generate()),
      verify: (tokenHash) => anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash }),
    });
    // A FRESH link for the browser: the verify above consumed the first one.
    const link = actionLink(await generate());
    if (!link) return { id: "magic-link-sign-in", status: "unknown", detail: "Supabase returned no action link for the browser leg" };
    // Read the candidate origin BEFORE navigating: once the link redirects, `page.url()` is
    // wherever Supabase sent the session, which is the very thing this leg has to judge.
    const candidateOrigin = originOf(page.url()) || originOf(process.env.CUSTOMER_DIAGNOSTIC_STAGING_URL ?? "");
    const mark = observations.length;
    await page.goto(link, { waitUntil: "domcontentloaded" });
    const landing = await awaitAccountLanding(page, candidateOrigin);
    if (landing) return { id: "magic-link-sign-in", status: "unknown", detail: landing };
    await page.waitForSelector(ACCOUNT_MAIN, { timeout: READY_MS });
    // Rendering `#main-content` proves a page, not a session. Only an accepted
    // `auth_callback`/`auth_bootstrap` observation proves the shipped SPA actually
    // bootstrapped one on this origin.
    const authenticated = await awaitObservation(mark, (row) => AUTH_ACTIONS.has(row.action ?? ""), AUTH_OBSERVATION_MS);
    if (!authenticated) {
      return { id: "magic-link-sign-in", status: "unknown", detail: "the account route rendered but no accepted auth observation arrived; the session was not proven" };
    }
    return { id: "magic-link-sign-in", status: "pass", detail: `the real email link established a session in the shipped SPA ('${authenticated.action}')` };
  } catch (error) {
    return { id: "magic-link-sign-in", status: "unknown", detail: `the magic-link leg could not be driven: ${message(error)}` };
  }
}

/**
 * Where the magic link actually landed. Returns `null` when the browser is on the candidate
 * origin under `/konto`, and otherwise the reason it is not.
 *
 * On 2026-09-15 the Supabase redirect allow-list sent an immutable candidate's session to
 * the project Site URL: `#main-content` rendered, the leg passed, and every beacon after it
 * was anonymous. Only the HOST is ever named here - the landing URL's query and fragment
 * carry the single-use token and the session it mints, and neither may reach a leg detail.
 */
async function awaitAccountLanding(page: Page, candidateOrigin: string): Promise<string | null> {
  if (!candidateOrigin) return "the candidate origin could not be derived, so the landing origin could not be judged";
  const deadline = Date.now() + LANDING_MS;
  let host = "";
  let onCandidate = false;
  for (;;) {
    const current = safeUrl(page.url());
    if (current) {
      host = current.host;
      onCandidate = current.origin === candidateOrigin;
      if (onCandidate && current.pathname.startsWith(ACCOUNT_PATH)) return null;
    }
    if (Date.now() >= deadline) break;
    await delay(POLL_MS);
  }
  return onCandidate
    ? `landed on the candidate origin but never reached ${ACCOUNT_PATH}`
    : `landed on ${host || "an unreadable location"}, not the candidate origin (check the Supabase redirect allow-list)`;
}

function actionLink(data: Record<string, unknown>): string {
  return typeof properties(data).action_link === "string" ? properties(data).action_link as string : "";
}

/**
 * The single-use hash out of a `generateLink` response. A local helper rather than the
 * shared one: the shared implementation lives in a withheld module and this file is
 * retained, so the four shapes GoTrue answers with are spelled out here.
 */
function tokenHash(data: Record<string, unknown>): string {
  const direct = properties(data).hashed_token ?? properties(data).token_hash ?? data.hashed_token ?? data.token_hash;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const link = actionLink(data);
  const fromUrl = link ? new URL(link).searchParams.get("token_hash") ?? new URL(link).searchParams.get("token") : null;
  if (fromUrl) return fromUrl;
  throw new Error("Supabase generateLink response did not include a token hash");
}

function properties(data: Record<string, unknown>): Record<string, unknown> {
  return data.properties && typeof data.properties === "object" ? data.properties as Record<string, unknown> : {};
}

/**
 * How many beacons the ingest REFUSED since a leg's mark, and with what status.
 *
 * A leg that saw no accepted observation has two very different causes - the producer never
 * fired, or the ingest refused what it produced - and on 2026-09-15 the receipt could not
 * tell them apart. Appended to every `unknown` that turns on a missing observation.
 */
function rejectionsSince(mark: number): string {
  const refused = since(mark).filter((row) => row.status < 200 || row.status >= 300);
  if (refused.length === 0) return "";
  const byStatus = new Map<number, number>();
  for (const row of refused) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  const spelled = [...byStatus.entries()].sort(([left], [right]) => left - right)
    .map(([status, count]) => `${count} with HTTP ${status}`).join(", ");
  return ` (${refused.length} beacon(s) rejected since this leg started: ${spelled})`;
}

/**
 * Wait until this tab has admission headroom again, WITHOUT touching the page.
 *
 * ⛔ The ingest admits at most 20 events per SEGMENT per rolling minute
 * (`supabase/migrations/20260914120000_customer_diagnostic_ingress_identity.sql`, the
 * `rate_limited` outcome). That is a RAIL INVARIANT, not a defect: it is what stops a
 * runaway tab filling the table. A seven-step configurator walk spends the whole budget on
 * its own - on 2026-09-15 19:45Z the anonymous segment held exactly 20 events and every
 * later beacon in it, including the `checkout_submit` carrying `relatedRequestId`, came back
 * `429`.
 *
 * ⛔ Rotating the segment instead was TRIED and is gone. Dropping the tab's credential is not
 * enough on its own (`customerJourneyReporter.ts` falls back to a module-level
 * `memoryCredential`), so it needed a reload - and the 19:58Z run proved the reload does not
 * bring the buyer back to a released payment step, whatever the draft codec persists. Both
 * configurator legs then reported `unknown` for a reason the harness had invented. Waiting
 * touches nothing: the page, the draft, the quote and the segment all stay exactly as the
 * leg left them.
 *
 * The window is counted ACROSS THE TAB rather than per segment, because a browser cannot see
 * segment ids. That over-counts whenever the tab has rotated, which is safe in the only
 * direction that matters: it can make a leg wait it need not have, never admit one it should
 * not. `needed` is the headroom the caller is about to spend - a handful of beacons for a
 * refused submit or a card confirm.
 */
async function awaitHeadroom(needed: number): Promise<boolean> {
  const deadline = Date.now() + HEADROOM_MS;
  for (;;) {
    if (acceptedInWindow(CAP_WINDOW_MS) <= ADMISSION_CAP - needed) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

/** Accepted beacons this tab saw in the trailing window - the cap's own unit. */
function acceptedInWindow(windowMs: number): number {
  const floor = Date.now() - windowMs;
  return accepted(observations).filter((row) => row.at >= floor).length;
}

/** Observe the producers without becoming one: read-only request/response inspection. */
function watch(page: Page): void {
  page.on("response", (response) => {
    if (!response.url().includes(INGEST_PATH)) return;
    // Per-status, not just a total. The 2026-09-15 19:45Z run recorded 29 rejections and
    // read as four mute legs; `rejected_429` on its own names the admission cap.
    if (response.status() < 200 || response.status() >= 300) {
      const key = `rejected_${response.status()}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(response.request().postData() ?? "{}") as Record<string, unknown>; } catch { /* a body we cannot read is still a request we saw */ }
    observations.push({
      status: response.status(),
      // When the ingest answered. The admission cap is a ROLLING minute, so a leg that has
      // to wait for headroom needs the clock, not just the order.
      at: Date.now(),
      action: typeof body.action === "string" ? body.action : undefined,
      phase: typeof body.phase === "string" ? body.phase : undefined,
      code: typeof body.code === "string" ? body.code : undefined,
      clientActionKey: typeof body.clientActionKey === "string" ? body.clientActionKey : undefined,
      // The browser-reported request reference. It is what the readback's
      // `request_correlation` probe looks for, and it reaches the ingest ONLY on a
      // checkout submit the BFF rejected with a request-id-bearing error envelope.
      relatedRequestId: typeof body.relatedRequestId === "string" ? body.relatedRequestId : undefined,
    });
  });
}

async function visit(page: Page, path: string, selector: string): Promise<boolean> {
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(selector, { timeout: READY_MS });
    // A short settle for the route's own first paint. It is NOT what decides a leg any
    // more - `awaitObservation` waits for the evidence - so it is kept small to leave the
    // per-test budget to the bounded polls that actually judge.
    await page.waitForTimeout(500);
    return true;
  } catch { return false; }
}

async function credential(page: Page): Promise<string | null> {
  try {
    return await page.evaluate((key: string) => window.sessionStorage.getItem(key), CREDENTIAL_KEY);
  } catch { return null; }
}

async function leg(id: string, run: () => Promise<Leg | Omit<Leg, "id">>): Promise<void> {
  try {
    const outcome = await run();
    record(id, outcome.status, outcome.detail);
  } catch (error) {
    record(id, "unknown", `the leg threw before it could decide: ${message(error)}`);
  }
}

const pass = (detail: string): Omit<Leg, "id"> => ({ status: "pass", detail });
const fail = (detail: string): Omit<Leg, "id"> => ({ status: "fail", detail });
const unknown = (detail: string): Omit<Leg, "id"> => ({ status: "unknown", detail });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
