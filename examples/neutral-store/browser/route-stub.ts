// The single owner of "stub the first matching request" in the starter's browser specs.
// Use stubFirst instead of a `page.route(..., { times })` route: when an expiring route is the page's last one,
// Playwright turns request interception off without waiting, and can drop the page's next request from its `request`
// and `response` events, so a `waitForResponse` or request listener for it times out. This route stays installed: it
// answers the first matching request with `first` and passes later ones to the next matching route or the network
// (`route.fallback()`).
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
