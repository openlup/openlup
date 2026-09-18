import { expect, type FrameLocator, type Page } from "@playwright/test";

import {
  seedCookieConsent,
  type Address,
  type AllergenSlug,
  type Consents,
  type Dog,
  type FlavorSlug,
  type Invoice,
  type LengthDays,
  type Owner,
} from "../checkout/helpers/fixtures.ts";

/**
 * The configurator and Payment Element drive for the customer-diagnostic journey.
 *
 * ⛔ WHY THIS DUPLICATES `tests/preview/checkout/helpers/`. `journey.spec.ts` is RETAINED for
 * publication, and a retained source may not reach a withheld module. Both helpers it used
 * are WITHHELD through their own imports - `helpers/configuratorFlow.ts` pulls
 * `helpers/env.ts` (the preview base-URL and bypass-token chain) and `helpers/stripe.ts`
 * pulls `src/checkout/machine/checkoutNavigation`. `verify-closure`
 * (`scripts/generate-oss-neutralization-registry.test.ts`) fails on exactly that edge, and
 * the withhold list in `config/oss-core-readiness-blockers.json` is FROZEN, so the closure
 * cannot be answered by adding an entry. `helpers/fixtures.ts` IS retained and is still
 * imported: nothing is copied that does not have to be.
 *
 * Two deliberate differences from the originals, both of which remove a withheld reach:
 *
 * - Navigation is RELATIVE, resolved against the project's own `baseURL`
 *   (`playwright.account.config.ts`, the `customer-diagnostic` project pins the candidate
 *   origin), instead of `appUrl()`. The same config supplies `x-vercel-protection-bypass`
 *   for the whole context, so no per-page header call is needed either.
 * - Nothing here imports `src/**`. `stripe.ts`'s only such import feeds a diagnostic string
 *   in a failure path these legs do not use, and the key it names carries the brand, so it
 *   is not retyped - it is simply absent.
 *
 * Everything else is the shipped page object's own behaviour, testids and waits, kept
 * deliberately close to the originals so a configurator change is fixed in both places by
 * one reading rather than two.
 */

const PATHS = {
  configurator: "/skomponuj-pakiet",
  paymentStatus: "/skomponuj-pakiet/platnosc",
} as const;

export const TEST_EXPIRY = "12 / 34";
export const TEST_CVC = "123";
export const TEST_POSTAL = "00-001";
/** Stripe's PUBLISHED declined test card; deterministic only against a test-mode account. */
export const CARD_DECLINED = "4000 0000 0000 0002";
export const STRIPE_PANEL_TESTID = "stripe-pay-panel";
export const CHECKOUT_SUBMIT_PATH = "/api/bff/commerce/checkout";

export function localizedPath(page: keyof typeof PATHS): string {
  return PATHS[page];
}

export function isCheckoutSubmitUrl(url: string): boolean {
  try {
    return new URL(url).pathname === CHECKOUT_SUBMIT_PATH;
  } catch {
    return url.split("?")[0]?.endsWith(CHECKOUT_SUBMIT_PATH) ?? false;
  }
}

export function isCheckoutSubmitResponse(response: { request(): { method(): string }; url(): string }): boolean {
  return response.request().method() === "POST" && isCheckoutSubmitUrl(response.url());
}

/** Read the current step number from `configurator-step-current`'s data-step. */
export async function currentStep(page: Page): Promise<number> {
  return Number(await page.getByTestId("configurator-step-current").getAttribute("data-step"));
}

/** Wait until the configurator reports `step` as active (post-transition). */
export async function expectStep(page: Page, step: number): Promise<void> {
  await expect(page.getByTestId("configurator-step-current")).toHaveAttribute("data-step", String(step));
}

/**
 * Boot a deterministic run: clear the persisted draft so the hero gate shows, seed cookie
 * consent, enter the configurator, name the pet and submit into step 1.
 *
 * The `?offer=` pin is not cosmetic: which offer step 5 leads with is a runtime merchandising
 * setting an operator can change, so an unpinned journey starts failing the moment the shop
 * is re-merchandised, with no code change to point at.
 */
export async function startFromHero(
  page: Page,
  { dogName, offer = "subscription" }: { dogName: string; offer?: "subscription" | "one-time" | "starter" | null },
): Promise<void> {
  await seedCookieConsent(page);
  await page.addInitScript(() => {
    // Init scripts run again on each reload. Reset only the FIRST document in this tab, or a
    // saved draft disappears while a customer returns to checkout.
    try {
      const resetMarker = "openlup:e2e:configurator-reset:v1";
      if (window.sessionStorage.getItem(resetMarker)) return;
      for (const key of [
        "configurator-form", "openlup:configurator:v1", "openlup:configurator:step:v1",
        "openlup:configurator:maxstep:v1", "openlup:configurator:draft:v2",
      ]) window.localStorage.removeItem(key);
      window.sessionStorage.setItem(resetMarker, "1");
    } catch {
      // Opaque origins can reject storage before the first configurator route.
    }
  });
  const entry = PATHS.configurator;
  await page.goto(offer ? `${entry}?offer=${offer}` : entry);
  const heroInput = page.getByTestId("configurator-hero-dogname");
  await expect(heroInput).toBeVisible();
  await heroInput.fill(dogName);
  await page.getByTestId("configurator-hero-start").click();
  await expectStep(page, 1);
}

/** Step 1 - pet name, breed, weight, age, activity, body-condition score. */
export async function fillStep1(page: Page, dog: Dog): Promise<void> {
  await expectStep(page, 1);
  await page.getByTestId("pet-name").fill(dog.name);
  await page.getByTestId("pet-breed").fill(dog.breed);
  await page.getByTestId("pet-weight").fill(dog.weightKg);
  await page.getByTestId("pet-age").selectOption(dog.age);
  await page.getByTestId("pet-activity").selectOption(dog.activity);
  await page.getByTestId("pet-bcs").selectOption(dog.bcs);
}

/** Step 2 - allergies. The no-allergies card is selected by default. */
export async function fillStep2(
  page: Page,
  { hasAllergies, allergens = [] }: { hasAllergies: boolean; allergens?: readonly AllergenSlug[] },
): Promise<void> {
  await expectStep(page, 2);
  if (!hasAllergies) return;
  await page.getByTestId("allergies-toggle").click();
  for (const slug of allergens) {
    const chip = page.getByTestId(`allergen-${slug}`);
    await expect(chip).toBeVisible();
    if ((await chip.getAttribute("aria-checked")) !== "true") await chip.click();
  }
}

/** Step 3 - flavors. Selects the given cards, skipping any the catalog has disabled. */
export async function fillStep3(page: Page, flavors: readonly FlavorSlug[]): Promise<void> {
  await expectStep(page, 3);
  for (const slug of flavors) {
    const card = page.getByTestId(`flavor-${slug}`);
    await expect(card).toBeVisible();
    if (await card.isDisabled()) continue;
    if ((await card.getAttribute("aria-checked")) !== "true") await card.click();
    // An uncommitted toggle leaves step 3 invalid and `configurator-next` silently no-ops.
    await expect(card, `flavor-${slug} selected`).toHaveAttribute("aria-checked", "true");
  }
}

/**
 * Step 3 - take up to `count` flavors that are actually offered, without naming a slug.
 * Availability is server-authored (out-of-stock flavors are removed, not merely disabled).
 */
export async function selectAvailableFlavors(page: Page, count: number): Promise<void> {
  await expectStep(page, 3);
  const tiles = page.locator('button[data-testid^="flavor-"]');
  await expect(tiles.first()).toBeVisible();
  const total = await tiles.count();
  let picked = 0;
  for (let index = 0; index < total && picked < count; index += 1) {
    const card = tiles.nth(index);
    if (await card.isDisabled()) continue;
    if ((await card.getAttribute("aria-checked")) !== "true") await card.click();
    await expect(card, "selected flavor commits").toHaveAttribute("aria-checked", "true");
    picked += 1;
  }
  expect(picked, `expected at least one available flavor (wanted ${count})`).toBeGreaterThan(0);
}

/** Step 4 - owner identity, asked after the pet and the flavors. */
export async function fillOwner(page: Page, owner: Owner): Promise<void> {
  await expectStep(page, 4);
  await page.getByTestId("owner-firstName").fill(owner.firstName);
  await page.getByTestId("owner-lastName").fill(owner.lastName);
  await page.getByTestId("owner-email").fill(owner.email);
  await page.getByTestId("owner-phone").fill(owner.phone);
}

/**
 * True when step 5 rendered the single full-width starter-pack SAMPLER instead of the
 * purchase-mode step. The race is only a settle-wait; the verdict is the direct read after
 * it, so a deployment where neither variant paints returns false rather than "starter".
 */
export async function starterOfferShown(page: Page): Promise<boolean> {
  await expectStep(page, 5);
  const starterPanel = page.getByTestId("starter-pack-panel");
  const packageControls = page.locator(
    '[data-testid="purchase-mode-one_time"], [data-testid="purchase-mode-subscription"], [data-testid="subscription-toggle"]',
  );
  await Promise.race([
    starterPanel.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
    packageControls.first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
  ]);
  return starterPanel.isVisible().catch(() => false);
}

/** Step 5 - purchase mode and bundle length. Callers check {@link starterOfferShown} first. */
export async function fillPackageStep(
  page: Page,
  { lengthDays, subscription }: { lengthDays: LengthDays; subscription: boolean },
): Promise<void> {
  await expectStep(page, 5);
  const mode = page.getByTestId(subscription ? "purchase-mode-subscription" : "purchase-mode-one_time");
  if (await mode.isVisible().catch(() => false)) {
    if ((await mode.getAttribute("aria-checked")) !== "true") await mode.click();
    await expect(mode, "purchase mode selected").toHaveAttribute("aria-checked", "true");
  } else {
    const toggle = page.getByTestId("subscription-toggle");
    if ((await toggle.getAttribute("aria-pressed")) !== String(subscription)) await toggle.click();
    await expect(toggle, "legacy subscription mode selected").toHaveAttribute("aria-pressed", String(subscription));
  }
  // Length tiles are server-authored per pet package, so a nominal length is not guaranteed;
  // absent, the server's own default selection stands and is equally checkoutable.
  const tile = page.getByTestId(`length-${lengthDays}`);
  if (await tile.isVisible().catch(() => false)) {
    await tile.click();
    await expect(tile, `length-${lengthDays} selected`).toHaveAttribute("aria-checked", "true");
  }
}

/** Step 6 - address, delivery, invoice choice and consents. */
export async function fillAddressStep(
  page: Page,
  { address, invoice, consents }: { address: Address; invoice: Invoice; consents: Consents },
): Promise<void> {
  await expectStep(page, 6);
  await page.getByTestId("ship-street").fill(address.street);
  await page.getByTestId("ship-postalCode").fill(address.postalCode);
  await page.getByTestId("ship-city").fill(address.city);
  await page.getByTestId("ship-country").selectOption(address.country);
  await chooseDelivery(page, address);
  if (invoice.kind === "b2b") {
    const toggle = page.getByTestId("invoice-toggle");
    if (!(await toggle.isChecked())) await toggle.check();
    await page.getByTestId("invoice-nip").fill(invoice.nip);
  }
  await setConsent(page, "consent-gdpr", consents.gdpr);
  await setConsent(page, "consent-terms", consents.terms);
  await setConsent(page, "consent-marketing", consents.marketing);
}

/** Step 7 - pick a payment method tile and assert it became the selected method. */
export async function choosePayment(page: Page, method: "card" | "blik" | "transfer"): Promise<void> {
  await expectStep(page, 7);
  const tile = page.getByTestId(`payment-method-${method}`);
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(tile, `payment-method-${method} selected`).toHaveAttribute("aria-checked", "true");
}

/** Advance one step via `configurator-next`, asserting the step actually changed. */
export async function next(page: Page): Promise<void> {
  const before = await currentStep(page);
  await page.getByTestId("configurator-next").click();
  // The caloric-magic reveal intercepts the contact -> package transition. It is matched by
  // TESTID, never copy: its label flips with the live-quote outcome.
  const skip = page.getByTestId("caloric-magic-skip");
  await expect(async () => {
    const advanced = (await currentStep(page)) === before + 1;
    const modalOpen = await skip.isVisible().catch(() => false);
    expect(advanced || modalOpen, "step advanced or caloric-magic modal opened").toBe(true);
  }).toPass({ timeout: 15_000 });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => undefined);
  await expect(page.getByTestId("configurator-step-current"))
    .toHaveAttribute("data-step", String(before + 1), { timeout: 15_000 });
}

/**
 * Leave the contact step through the caloric-magic reveal, dismissing it at the FIRST moment
 * it is dismissible. The reveal normally runs 16-21 s; this journey's budget cannot spend it.
 */
export async function advanceSkippingCaloricReveal(page: Page): Promise<void> {
  const before = await currentStep(page);
  await page.getByTestId("configurator-next").click();
  const skip = page.getByTestId("caloric-magic-skip");
  await expect(skip, "caloric-magic reveal intercepted the transition").toBeVisible({ timeout: 15_000 });
  await skip.click({ timeout: 5_000 }).catch(async (error: unknown) => {
    // Detached between the check and the click: the reveal finished on its own.
    if (await skip.isVisible().catch(() => false)) throw error;
  });
  await expect(page.getByTestId("configurator-step-current"))
    .toHaveAttribute("data-step", String(before + 1), { timeout: 15_000 });
}

export interface WalkOptions {
  dog: Dog;
  owner: Owner;
  allergies?: { hasAllergies: boolean; allergens?: readonly AllergenSlug[] };
  /** Named slugs, or omitted to take whatever the offer-availability layer is rendering. */
  flavors?: readonly FlavorSlug[];
  availableFlavors?: number;
}

/**
 * Hero -> pet (1) -> allergies (2) -> flavors (3) -> contact (4) -> package (5).
 * The step ORDER lives here and nowhere else in this journey.
 */
export async function walkToPackageStep(
  page: Page,
  { dog, owner, allergies = { hasAllergies: false }, flavors, availableFlavors = 2 }: WalkOptions,
): Promise<void> {
  await startFromHero(page, { dogName: dog.name });
  await fillStep1(page, dog);
  await next(page);
  await fillStep2(page, allergies);
  await next(page);
  if (flavors) await fillStep3(page, flavors);
  else await selectAvailableFlavors(page, availableFlavors);
  await next(page);
  await fillOwner(page, owner);
  await advanceSkippingCaloricReveal(page);
  await expectStep(page, 5);
}

/**
 * The Payment Element's app-owned confirm button. The card fields live in cross-origin
 * Stripe iframes; only this button is in the parent DOM, so it is the sole submit under the
 * panel testid.
 */
export function payButton(page: Page) {
  return page.getByTestId(STRIPE_PANEL_TESTID).locator('button[type="submit"]');
}

/** Fill the Payment Element's card fields, which live in cross-origin Stripe iframes. */
export async function fillStripeCard(page: Page, cardNumber: string): Promise<void> {
  const panel = page.getByTestId(STRIPE_PANEL_TESTID);
  await expect(panel).toBeVisible();
  const frames = panel.frameLocator("iframe");
  await fillStripeField(frames, ["cardnumber", "number"], /card number|numer karty/iu, cardNumber);
  await fillStripeField(frames, ["exp-date", "expiry"], /expir|wyga|MM\s*\/\s*YY/iu, TEST_EXPIRY);
  await fillStripeField(frames, ["cvc", "cvc2"], /cvc|cvv|kod/iu, TEST_CVC);
  // Billing country is NOT filled: Stripe pre-selects it from the browser locale. The postal
  // field is a no-op on the Element this journey drives and is optional for that reason.
  await fillStripeField(frames, ["postal", "postalCode", "billingPostalCode"], /postal|zip|kod pocztowy/iu, TEST_POSTAL, true);
}

async function fillStripeField(
  frames: FrameLocator,
  names: readonly string[],
  labelPattern: RegExp,
  value: string,
  optional = false,
): Promise<void> {
  for (const name of names) {
    const byName = frames.locator(`input[name="${name}"]`).first();
    if (await byName.count().then((count) => count > 0).catch(() => false)) {
      try {
        await byName.fill(value, { timeout: 5_000 });
        return;
      } catch {
        // Fall through to the label-based locator.
      }
    }
  }
  try {
    await frames.getByLabel(labelPattern).first().fill(value, { timeout: 5_000 });
  } catch {
    if (!optional) throw new Error(`Could not locate Stripe field (tried names ${names.join(", ")})`);
  }
}

async function chooseDelivery(page: Page, address: Address): Promise<void> {
  const tile = page.getByTestId(`delivery-${address.delivery}`);
  if (await tile.isVisible().catch(() => false)) {
    await tile.click();
    return;
  }
  // Older shape: a radio rather than a tile. Either way the journey only needs courier.
  const radio = page.getByRole("radio", { name: /kurier|courier/iu }).first();
  if (await radio.isVisible().catch(() => false)) await radio.click();
}

async function setConsent(page: Page, testId: string, on: boolean): Promise<void> {
  const box = page.getByTestId(testId);
  if ((await box.getAttribute("aria-checked")) !== String(on)) await box.click();
}
