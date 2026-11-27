import { storefrontAnchor } from "../index.js";
import { anchorVisibility } from "./anchorVisibility.js";
import { clientStorage } from "./clientStorage.js";
import type { PageHandle } from "./contracts.js";

type StructuralRequest = { method(): string; url(): string; headers(): Record<string, string>; redirectedFrom(): StructuralRequest | null };
type StructuralRoute = { request(): StructuralRequest; continue(): Promise<void>; fetch(): Promise<unknown>; abort(): Promise<void> };
type StructuralLocator = {
  waitFor(options: { state: "attached"; timeout: number }): Promise<void>;
  evaluateAll<R>(pageFunction: (elements: never[], attributes: string[]) => R | Promise<R>, attributes: string[]): Promise<R>;
  isEnabled(options: { timeout: number }): Promise<boolean>;
  click(options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  setChecked(checked: boolean, options: { timeout: number }): Promise<void>;
};
type RequestEvent = "request" | "requestfinished" | "requestfailed";
/** The browser context members `clearClientState` uses; a Playwright context has both. */
type StructuralContext = {
  setStorageState?(state: { cookies: []; origins: [] }): Promise<void>;
  clearCookies?(): Promise<void>;
};

/**
 * The page `createPageHandle` reads: the members of a Playwright page it uses,
 * typed structurally so this module imports no browser library.
 */
type StructuralPage = {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  url(): string;
  viewportSize(): { width: number; height: number } | null;
  waitForTimeout(timeout: number): Promise<void>;
  on(event: RequestEvent, listener: (request: StructuralRequest) => void): unknown;
  off(event: RequestEvent, listener: (request: StructuralRequest) => void): unknown;
  locator(selector: string): Pick<StructuralLocator, "evaluateAll"> & { first(): StructuralLocator };
  route(url: string, handler: (route: StructuralRoute) => Promise<void>): Promise<unknown>;
  unroute(url: string, handler: (route: StructuralRoute) => Promise<void>): Promise<unknown>;
  /** Read only by `clearClientState`; a page without it cannot clear client state. */
  context?(): StructuralContext;
};

type Target = Parameters<PageHandle["find"]>[0];
type Measurement = Awaited<ReturnType<typeof anchorVisibility>>[number];

const EVERY_REQUEST = "**/*";
/** How long `settled` waits by default before it refuses. */
const SETTLE_TIMEOUT_MS = 30_000;
const FINISHED: readonly RequestEvent[] = ["requestfinished", "requestfailed"];

function invalid(message: string): TypeError {
  return new TypeError(`storefront_page_input_invalid: ${message}`);
}

/** Playwright treats a timeout of 0 as no timeout; the handle never waits without a bound. */
function bound(timeoutMs: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw invalid("timeoutMs must be a finite number of milliseconds, 0 or more.");
  return Math.max(1, timeoutMs);
}

function cssString(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\"" || character === "\\") escaped += `\\${character}`;
    else if (code < 0x20 || code === 0x7f) escaped += `\\${code.toString(16)} `;
    else escaped += character;
  }
  return `"${escaped}"`;
}

function selectorOf(target: Target): string {
  if ("locator" in target) return target.locator;
  if (!Object.hasOwn(storefrontAnchor.attribute, target.attribute)) throw invalid(`unknown anchor attribute group ${String(target.attribute)}.`);
  return `[${storefrontAnchor.attribute[target.attribute]}=${cssString(target.value)}]`;
}

function visible(measurement: Measurement): boolean {
  return measurement.width > 0 && measurement.height > 0 && measurement.insideScrollArea
    && !measurement.hidden && !measurement.transparent && !measurement.coveredAtCentre;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

const isWebOrigin = (origin: string) => origin.startsWith("http://") || origin.startsWith("https://");

/** Waits for the first match to be attached; `false` when none appeared in time. */
async function appeared(locator: StructuralLocator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "attached", timeout });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return false;
    throw error;
  }
}

/**
 * Wraps a browser page as a storefront `PageHandle`. It accepts a Playwright
 * page today and reads only through the members it uses: `goto`, `reload`,
 * `url`, `viewportSize`, `waitForTimeout`, `on` and `off` (`request`,
 * `requestfinished`, `requestfailed`), `locator` with `first`, `waitFor`,
 * `evaluateAll`, `isEnabled`, `click`, `fill`, `setChecked`, and `route` and
 * `unroute` with `request()`, `continue()`, `fetch()` and `abort()`; a request
 * reads `method()`, `url()`, `headers()` and `redirectedFrom()`, so a redirect
 * hop, which the browser does not route, is claimed from its own `request`
 * event. `options.origin` resolves
 * relative paths for `navigate`; without it the page's own base URL does.
 *
 * `clearClientState` follows the table on `PageHandle`, the one statement of
 * what it clears on each path and document. It reads `context()`
 * (`setStorageState`, else `clearCookies`) and runs one self-contained
 * function over the `:root` locator's `evaluateAll`. It reads the document's
 * origin in the page first: when `options.origin` is given, a document on
 * another `http:` or `https:` origin rejects
 * `storefront_page_client_state_foreign_origin` before anything is cleared.
 * Then `setStorageState({ cookies: [], origins: [] })`, or without it
 * `clearCookies()` and a local-storage clear in the page; last, on the store's
 * origin, session storage is cleared in the page. A page without `context`
 * rejects `storefront_page_input_invalid`.
 *
 * `withhold` is `fetch()` then `abort()`: the request reaches the server, its
 * response is discarded and the page sees a failure. `block` is `abort()`. All
 * waiting uses the page's own `waitFor` and `waitForTimeout`; the handle reads
 * no clock. Anchor visibility is measured in the page by one self-contained
 * function.
 *
 * @experimental
 */
export function createPageHandle(page: StructuralPage, options: { readonly origin?: string } = {}): PageHandle {
  // Every request a `decide` saw and has not yet finished, with the function that releases its waiter.
  const pending = new Map<StructuralRequest, { owner: object; label: string; finish(): void; done: Promise<void> }>();
  // Every request a `decide` saw, and every redirect hop of one: the browser routes no hop, so its own request event claims it.
  const claimed = new WeakSet<StructuralRequest>();
  const claim = (request: StructuralRequest, owner: object) => {
    claimed.add(request);
    seen += 1;
    const existing = pending.get(request);
    if (existing !== undefined) return existing;
    let finish = () => undefined as void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const entry = { owner, label: `${request.method()} ${pathOf(request.url())}`, done, finish: () => { pending.delete(request); finish(); } };
    pending.set(request, entry);
    return entry;
  };
  let seen = 0;

  const measureFirst = async (target: Target, timeoutMs: number) => {
    const first = page.locator(selectorOf(target)).first();
    if (!(await appeared(first, bound(timeoutMs)))) return null;
    const [measurement] = await first.evaluateAll(anchorVisibility, []);
    return measurement ?? null;
  };

  return Object.freeze({
    async clearClientState() {
      const context = typeof page.context === "function" ? page.context() : undefined;
      const setStorageState = context?.setStorageState?.bind(context);
      const clearCookies = context?.clearCookies?.bind(context);
      if (setStorageState === undefined && clearCookies === undefined) {
        throw invalid("the page has no browser context; pass a Playwright page or a page whose context() offers setStorageState or clearCookies.");
      }
      // The store's origin as `options.origin` gives it; without it any web origin counts as the store's.
      const storeOrigin = options.origin === undefined ? null : new URL(options.origin).origin;
      // The root element reaches the document's own window; its origin decides what may be cleared.
      const root = page.locator(":root");
      const origin = await root.evaluateAll(clientStorage, []);
      const web = isWebOrigin(origin);
      if (web && storeOrigin !== null && origin !== storeOrigin) {
        throw new Error(`storefront_page_client_state_foreign_origin: the page is on ${origin} while the store's origin is ${storeOrigin} (options.origin). `
          + "Cause: session storage can be cleared only from a document of the store's origin, so the store's would stay for the next buyer. "
          + "Fix: keep the page on the store's origin between runs, or start the run in a fresh browser context. Recheck: run the scenario again.");
      }
      if (setStorageState !== undefined) await setStorageState({ cookies: [], origins: [] });
      else await clearCookies!();
      const names = [...(setStorageState === undefined ? ["localStorage"] : []), ...(web ? ["sessionStorage"] : [])];
      if (names.length > 0) await root.evaluateAll(clientStorage, names);
    },
    async navigate(path: string) {
      await page.goto(options.origin === undefined ? path : new URL(path, options.origin).href);
    },
    async reload() {
      await page.reload();
    },
    path: () => pathOf(page.url()),
    width: () => page.viewportSize()?.width ?? null,
    async find(target, { timeoutMs }) {
      const measurement = await measureFirst(target, timeoutMs);
      if (measurement === null) return null;
      const { width, height, insideScrollArea, hidden, transparent, coveredAtCentre } = measurement;
      return { width, height, insideScrollArea, hidden, transparent, coveredAtCentre };
    },
    async anchors(locators = {}) {
      const { state, action } = storefrontAnchor.attribute;
      const names = new Set<string>();
      const measured = await page.locator(`[${state}],[${action}]`).evaluateAll(anchorVisibility, [state, action]);
      for (const measurement of measured.filter(visible)) {
        const [stateValue, actionValue] = measurement.attributes;
        for (const name of [stateValue === null ? null : `state:${stateValue}`, actionValue === null ? null : `action:${actionValue}`]) {
          if (name !== null && !Object.hasOwn(locators, name)) names.add(name);
        }
      }
      for (const [name, locator] of Object.entries(locators)) {
        if ((await page.locator(locator).evaluateAll(anchorVisibility, [])).some(visible)) names.add(name);
      }
      return [...names].sort();
    },
    async perform(target, { timeoutMs }) {
      const timeout = bound(timeoutMs);
      const first = page.locator(selectorOf(target)).first();
      if (!(await appeared(first, timeout)) || !(await first.isEnabled({ timeout }))) return false;
      await first.click({ timeout });
      return true;
    },
    async fill(target, value, { timeoutMs }) {
      const timeout = bound(timeoutMs);
      const first = page.locator(selectorOf(target)).first();
      if (!(await appeared(first, timeout))) return false;
      if (typeof value === "boolean") await first.setChecked(value, { timeout });
      else await first.fill(value, { timeout });
      return true;
    },
    async intercept(decide) {
      const owner = {};
      const finished = (request: StructuralRequest) => pending.get(request)?.finish();
      const started = (request: StructuralRequest) => {
        const from = request.redirectedFrom();
        if (from !== null && claimed.has(from)) claim(request, owner);
      };
      page.on("request", started);
      for (const event of FINISHED) page.on(event, finished);
      const handler = async (route: StructuralRoute) => {
        const request = route.request();
        const entry = claim(request, owner);
        let decision: string;
        try {
          const headers = request.headers();
          decision = await decide({
            method: request.method(),
            path: pathOf(request.url()),
            header: (name: string) => headers[name.toLowerCase()] ?? null,
          });
        } catch {
          decision = "block";
        }
        try {
          if (decision === "pass") await route.continue();
          else if (decision === "withhold") {
            await route.fetch().catch(() => undefined);
            await route.abort();
          } else await route.abort();
        } catch {
          // The page or request is gone: no event will finish it.
          entry.finish();
        }
      };
      await page.route(EVERY_REQUEST, handler);
      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        await page.unroute(EVERY_REQUEST, handler);
        page.off("request", started);
        for (const event of FINISHED) page.off(event, finished);
        // Nothing reports these requests any longer, so no settle waits for them.
        for (const entry of [...pending.values()]) if (entry.owner === owner) entry.finish();
      };
    },
    async settled({ quietMs, timeoutMs = SETTLE_TIMEOUT_MS }) {
      const quiet = bound(quietMs);
      const limit = bound(timeoutMs);
      const work = (async () => {
        for (;;) {
          while (pending.size > 0) await Promise.all([...pending.values()].map((entry) => entry.done));
          const before = seen;
          await page.waitForTimeout(quiet);
          if (seen === before && pending.size === 0) return "settled" as const;
        }
      })();
      // The bound is the page's own timer; a request left open (a stream, a long poll, a page closed mid-request)
      // ends the wait with a refusal naming it instead of keeping the step pending for ever.
      const deadline = page.waitForTimeout(limit).then(() => "expired" as const, () => "expired" as const);
      if (await Promise.race([work, deadline]) === "settled") return;
      work.catch(() => undefined);
      const open = [...pending.values()].map((entry) => entry.label);
      throw new Error(`storefront_page_settle_timeout: ${open.length} request${open.length === 1 ? "" : "s"} did not finish within ${limit} ms`
        + `${open.length > 0 ? `: ${open.join(", ")}` : ""}. Cause: a stream, a long poll or a request left open keeps the page from settling, `
        + "or new requests kept starting inside the quiet window. Fix: let decide block the stream's path, or give settled a larger timeoutMs. "
        + "Recheck: run the step again.");
    },
  } satisfies PageHandle);
}
