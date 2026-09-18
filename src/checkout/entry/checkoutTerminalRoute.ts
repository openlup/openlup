import type { LocalizedRoute } from "@/lib/i18nRoutes";

/**
 * The path the neutral subscribe funnel mounts its own terminal on.
 *
 * The last segment IS written twice, and this constant does not prevent that:
 * `SubscribeRoutes` mounts a literal `"thank-you"` child and this owner publishes
 * the whole path, so the two can disagree. What refuses the disagreement is
 * `SubscribeThankYouPage.journey.test.tsx`, which walks the funnel through a real
 * router - the payment adapter navigates to whatever THIS constant says, and the
 * test asserts the terminal actually renders. A segment that drifts apart lands
 * that navigation on a path the router does not mount, and the terminal never
 * appears. The alternative, importing this constant into the route table, buys
 * nothing the journey does not already prove, because the router mounts children
 * relative to `/subscribe/*` and would still have to slice the segment back out.
 */
export const SUBSCRIBE_THANK_YOU_PATH = "/subscribe/thank-you";

/**
 * Public/default owner of `#checkout-terminal-route`: where a deployment's
 * checkout hands a customer whose money has actually moved.
 *
 * WHY this is a seam at all. The published payment adapter
 * (`src/checkout/adapters/PlatnoscPage`) and the published recovery hook
 * (`src/pages/account/useCheckoutRecoveryPay`) are shared: one deployment
 * finishes in its own storefront's terminal, another has only the platform's.
 * Before this seam BOTH navigated to a route key whose only component lives in a
 * withheld tree, so a published tree took the money and then handed the customer
 * a route it does not mount. The terminal is therefore a fact about the
 * deployment, exactly like its email presentation or its dispatch timetable.
 *
 * ⛔ Legal as a `#` seam ONLY because neither consumer is reachable from an
 * `api/**` entrypoint. A hosted serverless function resolves package-imports
 * WITHOUT the private deployment condition, so a seam behind `api/**` serves
 * production this default instead of the deployment's own value. Both consumers
 * are browser/SSR modules that the bundler resolves with the condition set;
 * `scripts/api-reachable-overlay-seams.test.ts` keeps that true by measuring the
 * closure rather than by asking a reader to remember it.
 *
 * Only the `en` member is declared, deliberately: the neutral funnel mounts one
 * unlocalized path (`/subscribe/*`), so that is the only value there is and
 * `useLocalizedRoute` falls back to it for every language. A deployment that
 * localizes its terminal declares the other members in its own owner.
 */
export const CHECKOUT_TERMINAL_ROUTE: LocalizedRoute = { en: SUBSCRIBE_THANK_YOU_PATH };
