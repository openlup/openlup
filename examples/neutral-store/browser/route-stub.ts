// The single owner of "stub the first matching request" in the starter's browser specs.
// A `page.route(..., { times })` route turns request interception off when it expires, without waiting for that to
// finish. Playwright 1.62 can lose the `request` and `response` events of a request the page starts in that moment, so
// a `waitForResponse` or request listener for it times out although the browser got the answer. This route stays
// installed: it answers the first matching request with `first` and lets every later one through. ESLint refuses
// `times` in route options under browser/ and tests/preview/.
import type { Page, Route } from '@playwright/test';

export interface StubCounter {
  /** Matching requests seen so far, the stubbed first one included. */
  readonly hits: number;
}

export async function stubFirst(page: Page, url: Parameters<Page['route']>[0],
  first: (route: Route) => Promise<void>): Promise<StubCounter> {
  let hits = 0;
  await page.route(url, route => ++hits === 1 ? first(route) : route.fallback());
  return { get hits() { return hits; } };
}
