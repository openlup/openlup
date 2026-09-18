import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { appUrl, baseURL } from "./helpers/env.ts";

/**
 * Accessibility + responsiveness sweep of the unauthenticated account +
 * client-facing surfaces.
 *
 * Sibling to `tests/preview/checkout/a11y.spec.ts`: same base-URL resolution,
 * same clean skip when the preview is unreachable, same `AxeBuilder` tag set,
 * and the same serious/critical-only failing gate (moderate/minor are logged as
 * advisories, never fail the run). It walks the routes that render WITHOUT a
 * session:
 *
 *   - the passwordless customer login page (PL `/zaloguj-sie` + EN `/sign-in`),
 *     idle view; and
 *   - a public marketing page (`/waitlist`).
 *
 * Deliberately OUT OF SCOPE (see the report / route comments below):
 *   - the authenticated dashboard (`/konto`, `/account`) and the other
 *     `CustomerProtectedRoute` targets — they redirect to login without a
 *     customer session, so an unauthenticated sweep can never reach their DOM;
 *   - the login "sent" panel — the `?previewState=sent` escape hatch is
 *     DEV-only (`import.meta.env.DEV`) and unreachable in a production preview
 *     build, and driving it for real would fire a magic-link OTP send (BFF +
 *     email side effect), so it is not exercised here.
 *
 * The login routes are build-time gated behind the customer-auth-UI flag; when
 * that surface is not enabled on the target preview the route falls through to
 * the 404 page, so each login scan self-skips (rather than scanning NotFound)
 * when the login form never renders.
 */

test.describe.configure({ mode: "serial" });

/** axe impacts we hard-fail on; moderate/minor are logged only. */
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

/** Readiness selector proving the login idle view (not the 404 fallback) rendered. */
const LOGIN_READY_SELECTOR = "#customer-email";

/** Readiness selector for the public marketing pages (shared main landmark). */
const MARKETING_READY_SELECTOR = "#main-content";

/** Bounded wait for a route's readiness signal before deciding to scan or skip. */
const READY_TIMEOUT_MS = 8_000;

test.beforeEach(async () => {
  // Skip the whole suite (rather than fail) when the preview is unreachable, so
  // it stays portable to environments without secrets / no deployment.
  test.skip(!(await previewReachable()), `preview unreachable at ${baseURL}`);
});

/** True when the configured preview origin responds (any HTTP status). */
async function previewReachable(): Promise<boolean> {
  try {
    const response = await fetch(baseURL, { method: "HEAD" });
    return response.status > 0;
  } catch {
    return false;
  }
}

const LOGIN_ROUTES = [
  { lang: "pl", path: "/zaloguj-sie" },
  { lang: "en", path: "/sign-in" },
] as const;

for (const route of LOGIN_ROUTES) {
  test(`customer login a11y + responsiveness (${route.lang})`, async ({ page }, testInfo) => {
    await page.goto(appUrl(route.path), { waitUntil: "domcontentloaded" });

    // The login routes are flag-gated at build time; when the surface is not
    // enabled the route renders the 404 page instead. Wait a bounded time for
    // the login form and skip (rather than scan NotFound) if it never appears.
    const ready = await waitForReady(page, LOGIN_READY_SELECTOR);
    test.skip(!ready, `customer login surface not enabled at ${appUrl(route.path)}`);

    await scanPage(page, testInfo, `${route.lang}:login`);
    await assertNoHorizontalOverflow(page);
  });
}

test("waitlist marketing page a11y + responsiveness", async ({ page }, testInfo) => {
  await page.goto(appUrl("/waitlist"), { waitUntil: "domcontentloaded" });

  const ready = await waitForReady(page, MARKETING_READY_SELECTOR);
  expect(ready, `waitlist page did not render its main landmark at ${appUrl("/waitlist")}`).toBe(
    true,
  );

  await scanPage(page, testInfo, "pl:waitlist");
  await assertNoHorizontalOverflow(page);
});

/** Wait (bounded) for `selector` to become visible; resolves false on timeout. */
async function waitForReady(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an axe-core scan against the whole page and fail on any serious/critical
 * violation. Moderate/minor findings are attached to the report and logged for
 * triage without breaking the gate — identical policy to the checkout sweep.
 */
async function scanPage(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const isBlocking = (violation: { impact?: string | null }) =>
    violation.impact != null && BLOCKING_IMPACTS.has(violation.impact);

  const blocking = results.violations.filter(isBlocking);
  const advisory = results.violations.filter((violation) => !isBlocking(violation));

  if (advisory.length > 0) {
    // Log moderate/minor findings for triage; do not fail the gate on them.
    const summary = advisory
      .map((violation) => `${violation.impact ?? "unknown"}: ${violation.id} (${violation.nodes.length})`)
      .join(", ");
    console.warn(`[a11y advisory] ${testInfo.project.name} ${label}: ${summary}`);
    await testInfo.attach(`a11y-advisory-${label.replace(/[^a-z0-9]+/gi, "-")}.json`, {
      body: JSON.stringify(advisory, null, 2),
      contentType: "application/json",
    });
  }

  expect(
    blocking,
    `serious/critical a11y violations at ${testInfo.project.name} ${label}: ` +
      blocking.map((violation) => violation.id).join(", "),
  ).toEqual([]);
}

/**
 * Responsiveness check: assert the document does not overflow horizontally
 * (allowing a 1px rounding tolerance) on every project viewport — mirrors the
 * checkout sweep's overflow guard without depending on a page-specific CTA.
 */
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    overflow.scrollWidth,
    `horizontal overflow: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.innerWidth + 1);
}
