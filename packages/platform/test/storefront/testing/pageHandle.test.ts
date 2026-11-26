import { describe, expect, it } from "vitest";
import { createPageHandle } from "../../../src/storefront/testing/index.js";
import { anchorVisibility } from "../../../src/storefront/testing/anchorVisibility.js";

type Decision = "pass" | "withhold" | "block";
type FakeRequest = { method(): string; url(): string; headers(): Record<string, string> };
type Measured = { attributes: (string | null)[]; width: number; height: number; insideScrollArea: boolean; hidden: boolean; transparent: boolean; coveredAtCentre: boolean };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const timeoutError = () => Object.assign(new Error("Timeout exceeded."), { name: "TimeoutError" });
const shown: Measured = { attributes: [], width: 120, height: 40, insideScrollArea: true, hidden: false, transparent: false, coveredAtCentre: false };

/**
 * A recording page with Playwright's shape: every call lands in `log`, element
 * queries answer from `elements` (selector to measured elements; an absent
 * selector never appears) and `disabled`, and `waitForTimeout` resolves only
 * when the test releases it.
 */
function fakePage(state: { url?: string; viewport?: { width: number; height: number } | null; elements?: Record<string, Measured[]>; disabled?: Set<string> } = {}) {
  const log: string[] = [];
  const listeners = new Map<string, Set<(request: FakeRequest) => void>>();
  const routes = new Map<string, (route: unknown) => Promise<void>>();
  const waits: Array<() => void> = [];
  const elements = state.elements ?? {};
  const locator = (selector: string, first: boolean) => ({
    first: () => locator(selector, true),
    async waitFor(options: { state: "attached"; timeout: number }) {
      log.push(`waitFor ${selector} ${options.state} ${options.timeout}`);
      if (!elements[selector]?.length) throw timeoutError();
    },
    async evaluateAll(pageFunction: unknown, arg: unknown) {
      log.push(`evaluateAll ${selector} ${JSON.stringify(arg)}`);
      expect(pageFunction).toBe(anchorVisibility);
      const found = elements[selector] ?? [];
      return first ? found.slice(0, 1) : found;
    },
    async isEnabled(options: { timeout: number }) { log.push(`isEnabled ${selector} ${options.timeout}`); return !state.disabled?.has(selector); },
    async click(options: { timeout: number }) { log.push(`click ${selector} ${options.timeout}`); },
    async fill(value: string, options: { timeout: number }) { log.push(`fill ${selector} ${value} ${options.timeout}`); },
    async setChecked(checked: boolean, options: { timeout: number }) { log.push(`setChecked ${selector} ${checked} ${options.timeout}`); },
  });
  const page = {
    async goto(url: string) { log.push(`goto ${url}`); return null; },
    async reload() { log.push("reload"); return null; },
    url: () => state.url ?? "https://shop.example.test/checkout/pay?token=secret#summary",
    viewportSize: () => state.viewport === undefined ? { width: 390, height: 844 } : state.viewport,
    waitForTimeout(timeout: number) { log.push(`waitForTimeout ${timeout}`); return new Promise<void>((resolve) => waits.push(resolve)); },
    on(event: "requestfinished" | "requestfailed", listener: (request: FakeRequest) => void) {
      log.push(`on ${event}`);
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
      return page;
    },
    off(event: "requestfinished" | "requestfailed", listener: (request: FakeRequest) => void) { log.push(`off ${event}`); listeners.get(event)?.delete(listener); return page; },
    locator: (selector: string) => locator(selector, false),
    async route(url: string, handler: (route: unknown) => Promise<void>) { log.push(`route ${url}`); routes.set(url, handler); },
    async unroute(url: string, handler: (route: unknown) => Promise<void>) { log.push(`unroute ${url}`); expect(routes.get(url)).toBe(handler); routes.delete(url); },
  };
  /** Sends one request through the installed route and records what the handler did with it. */
  const send = (method: string, url: string, headers: Record<string, string> = {}) => {
    const calls: string[] = [];
    const request: FakeRequest = { method: () => method, url: () => url, headers: () => headers };
    const route = {
      request: () => request,
      async continue() { calls.push("continue"); },
      async fetch() { calls.push("fetch"); return { status: () => 201 }; },
      async abort() { calls.push("abort"); },
    };
    const handler = [...routes.values()][0];
    expect(handler, "a route is installed").toBeDefined();
    return { request, calls, handled: handler!(route) };
  };
  const emit = (event: "requestfinished" | "requestfailed", request: FakeRequest) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(request);
  };
  const release = () => { const next = waits.shift(); expect(next, "a quiet wait is pending").toBeDefined(); next!(); };
  return { page, log, send, emit, release, waits, listeners, routes };
}

function tracked<T>(promise: Promise<T>) {
  const state = { done: false };
  void promise.then(() => { state.done = true; });
  return state;
}

describe("createPageHandle over a recording page (H1)", () => {
  it("maps pass to continue, withhold to fetch then abort, and block to abort", async () => {
    const fake = fakePage();
    const handle = createPageHandle(fake.page);
    const seen: Array<{ method: string; path: string; key: string | null; absent: string | null }> = [];
    const decisions: Record<string, Decision> = { "/api/pass": "pass", "/api/withhold": "withhold", "/api/block": "block" };
    await handle.intercept((request) => {
      seen.push({ method: request.method, path: request.path, key: request.header("Idempotency-Key"), absent: request.header("x-absent") });
      return decisions[request.path]!;
    });
    expect(fake.log).toEqual(["on requestfinished", "on requestfailed", "route **/*"]);
    const pass = fake.send("GET", "https://shop.example.test/api/pass?token=secret#x");
    const withhold = fake.send("POST", "https://shop.example.test/api/withhold", { "idempotency-key": "k-1" });
    const block = fake.send("POST", "https://shop.example.test/api/block");
    await Promise.all([pass.handled, withhold.handled, block.handled]);
    expect(pass.calls).toEqual(["continue"]);
    expect(withhold.calls).toEqual(["fetch", "abort"]);
    expect(block.calls).toEqual(["abort"]);
    expect(seen).toEqual([
      { method: "GET", path: "/api/pass", key: null, absent: null },
      { method: "POST", path: "/api/withhold", key: "k-1", absent: null },
      { method: "POST", path: "/api/block", key: null, absent: null },
    ]);
  });

  it("holds a request while decide is pending and blocks it when decide throws", async () => {
    const fake = fakePage();
    const handle = createPageHandle(fake.page);
    let release: (decision: Decision) => void = () => undefined;
    await handle.intercept((request) => {
      if (request.path === "/api/throw") throw new Error("decide failed");
      return new Promise<Decision>((resolve) => { release = resolve; });
    });
    const held = fake.send("POST", "https://shop.example.test/api/hold");
    await flush();
    expect(held.calls).toEqual([]);
    release("pass");
    await held.handled;
    expect(held.calls).toEqual(["continue"]);
    const thrown = fake.send("POST", "https://shop.example.test/api/throw");
    await thrown.handled;
    expect(thrown.calls).toEqual(["abort"]);
  });

  it("settles only after every routed request finished and a quiet window passed with no new request", async () => {
    const fake = fakePage();
    const handle = createPageHandle(fake.page);
    await handle.intercept((request) => request.path === "/api/block" ? "block" : "pass");
    const first = fake.send("POST", "https://shop.example.test/api/create");
    const second = fake.send("POST", "https://shop.example.test/api/block");
    await Promise.all([first.handled, second.handled]);
    const settled = tracked(handle.settled({ quietMs: 250 }));
    await flush();
    expect(fake.waits, "no quiet window while requests are in flight").toHaveLength(0);
    // An event for a request the interceptor never saw changes nothing.
    fake.emit("requestfinished", { method: () => "GET", url: () => "https://shop.example.test/other", headers: () => ({}) });
    fake.emit("requestfinished", first.request);
    await flush();
    expect(fake.waits).toHaveLength(0);
    fake.emit("requestfailed", second.request);
    await flush();
    expect(fake.waits).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("waitForTimeout 250");
    // A request during the quiet window starts the wait over once it has finished.
    const third = fake.send("GET", "https://shop.example.test/api/read");
    await third.handled;
    fake.release();
    await flush();
    expect(settled.done).toBe(false);
    expect(fake.waits).toHaveLength(0);
    fake.emit("requestfinished", third.request);
    await flush();
    expect(fake.waits).toHaveLength(1);
    expect(settled.done).toBe(false);
    fake.release();
    await flush();
    expect(settled.done).toBe(true);
  });

  it("settles after one quiet window when nothing was routed, and the removal function unroutes and detaches", async () => {
    const fake = fakePage();
    const handle = createPageHandle(fake.page);
    const settled = tracked(handle.settled({ quietMs: 10 }));
    await flush();
    expect(settled.done).toBe(false);
    fake.release();
    await flush();
    expect(settled.done).toBe(true);
    const remove = await handle.intercept(() => "pass");
    const pending = fake.send("GET", "https://shop.example.test/api/read");
    await pending.handled;
    await remove();
    await remove();
    expect(fake.routes.size).toBe(0);
    expect([...fake.listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(fake.log.filter((line) => line.startsWith("unroute") || line.startsWith("off"))).toEqual(["unroute **/*", "off requestfinished", "off requestfailed"]);
    // After removal no request is claimed, so settling waits only for the quiet window.
    const after = tracked(handle.settled({ quietMs: 10 }));
    await flush();
    fake.release();
    await flush();
    expect(after.done).toBe(true);
  });

  it("navigates, reloads and reads the path without query or fragment and the width", async () => {
    const fake = fakePage();
    await createPageHandle(fake.page, { origin: "https://shop.example.test" }).navigate("/cart?mode=one_time");
    await createPageHandle(fake.page).navigate("/cart");
    const handle = createPageHandle(fake.page);
    await handle.reload();
    expect(fake.log).toEqual(["goto https://shop.example.test/cart?mode=one_time", "goto /cart", "reload"]);
    expect(handle.path()).toBe("/checkout/pay");
    expect(handle.width()).toBe(390);
    expect(createPageHandle(fakePage({ viewport: null }).page).width()).toBeNull();
  });

  it("finds an anchor by attribute or custom locator, and resolves null when none appeared", async () => {
    const fake = fakePage({ elements: {
      "[data-openlup-state=\"paid\"]": [{ ...shown, coveredAtCentre: true }],
      "#pay": [shown],
      "[data-openlup-field=\"a\\\"b\\\\c\"]": [shown],
    } });
    const handle = createPageHandle(fake.page);
    expect(await handle.find({ attribute: "state", value: "paid" }, { timeoutMs: 500 })).toEqual({
      width: 120, height: 40, insideScrollArea: true, hidden: false, transparent: false, coveredAtCentre: true,
    });
    expect(await handle.find({ locator: "#pay" }, { timeoutMs: 500 })).not.toBeNull();
    expect(await handle.find({ attribute: "field", value: "a\"b\\c" }, { timeoutMs: 500 })).not.toBeNull();
    expect(await handle.find({ attribute: "action", value: "absent" }, { timeoutMs: 20 })).toBeNull();
    expect(fake.log).toEqual([
      "waitFor [data-openlup-state=\"paid\"] attached 500", "evaluateAll [data-openlup-state=\"paid\"] []",
      "waitFor #pay attached 500", "evaluateAll #pay []",
      "waitFor [data-openlup-field=\"a\\\"b\\\\c\"] attached 500", "evaluateAll [data-openlup-field=\"a\\\"b\\\\c\"] []",
      "waitFor [data-openlup-action=\"absent\"] attached 20",
    ]);
  });

  it("rethrows a page failure that is not a timeout", async () => {
    const fake = fakePage();
    const page = { ...fake.page, locator: () => ({ first: () => ({ waitFor: async () => { throw new Error("Target page, context or browser has been closed"); } }) }) };
    await expect(createPageHandle(page as unknown as typeof fake.page).find({ locator: "#x" }, { timeoutMs: 5 })).rejects.toThrow("has been closed");
  });

  it("performs only an enabled anchor and fills text or a checkbox", async () => {
    const fake = fakePage({ elements: { "#go": [shown], "#off": [shown], "#email": [shown], "#terms": [shown] }, disabled: new Set(["#off"]) });
    const handle = createPageHandle(fake.page);
    expect(await handle.perform({ locator: "#off" }, { timeoutMs: 100 })).toBe(false);
    expect(await handle.perform({ locator: "#missing" }, { timeoutMs: 100 })).toBe(false);
    expect(await handle.perform({ locator: "#go" }, { timeoutMs: 100 })).toBe(true);
    expect(await handle.fill({ locator: "#email" }, "buyer@example.test", { timeoutMs: 100 })).toBe(true);
    expect(await handle.fill({ locator: "#terms" }, true, { timeoutMs: 100 })).toBe(true);
    expect(await handle.fill({ locator: "#missing" }, "x", { timeoutMs: 100 })).toBe(false);
    expect(fake.log.filter((line) => /^(?:click|fill|setChecked)/.test(line))).toEqual([
      "click #go 100", "fill #email buyer@example.test 100", "setChecked #terms true 100",
    ]);
    expect(fake.log).toContain("isEnabled #off 100");
  });

  it("refuses a negative or non-finite timeout and an unknown anchor attribute", async () => {
    const handle = createPageHandle(fakePage().page);
    await expect(handle.find({ locator: "#x" }, { timeoutMs: -1 })).rejects.toThrow(TypeError);
    await expect(handle.perform({ locator: "#x" }, { timeoutMs: Number.NaN })).rejects.toThrow(TypeError);
    await expect(handle.find({ attribute: "other" as "state", value: "x" }, { timeoutMs: 1 })).rejects.toThrow(TypeError);
  });

  it("lists visible state and action anchors, letting a custom locator replace an attribute anchor", async () => {
    const anchors = "[data-openlup-state],[data-openlup-action]";
    const fake = fakePage({ elements: {
      [anchors]: [
        { ...shown, attributes: ["awaiting_payment", null] },
        { ...shown, attributes: [null, "continue_payment"] },
        { ...shown, attributes: [null, "continue_payment"], hidden: true },
        { ...shown, attributes: [null, "start_over"], transparent: true },
        { ...shown, attributes: [null, "retry_payment"], coveredAtCentre: true },
        { ...shown, attributes: [null, "place_order"], insideScrollArea: false },
        { ...shown, attributes: ["declined", null], width: 0 },
        { ...shown, attributes: ["paid", "proceed_to_checkout"] },
      ],
      "#custom-paid": [{ ...shown, hidden: true }, shown],
      "#custom-hidden": [{ ...shown, hidden: true }],
    } });
    const handle = createPageHandle(fake.page);
    expect(await handle.anchors()).toEqual(["action:continue_payment", "action:proceed_to_checkout", "state:awaiting_payment", "state:paid"]);
    expect(await handle.anchors({ "state:paid": "#custom-hidden", "action:retry_payment": "#custom-paid" }))
      .toEqual(["action:continue_payment", "action:proceed_to_checkout", "action:retry_payment", "state:awaiting_payment"]);
    expect(fake.log).toContain(`evaluateAll ${anchors} ["data-openlup-state","data-openlup-action"]`);
  });
});

/**
 * Element-like objects for the visibility function: one document, a viewport of
 * 400 × 300 over a scrollable area of 400 × 3000, boxes in document coordinates.
 * As in a browser, `elementFromPoint` answers null outside the viewport and skips
 * `pointer-events: none`, and an element without a box measures 0 × 0.
 */
function fakeDocument() {
  type Box = { left: number; top: number; width: number; height: number };
  type FakeElement = {
    nodeType: 1; style: Record<string, string>; attributes: Record<string, string>; parentElement: FakeElement | null; ownerDocument: unknown;
    getAttribute(name: string): string | null; hasAttribute(name: string): boolean; contains(other: FakeElement): boolean;
    getBoundingClientRect(): Box; scrollIntoView(options: unknown): void;
  };
  const view = {
    scrollX: 0, scrollY: 0, innerWidth: 400, innerHeight: 300,
    getComputedStyle: (element: FakeElement) => ({ display: "block", visibility: "visible", opacity: "1", ...element.style }),
    scrollTo(x: number, y: number) { view.scrollX = x; view.scrollY = y; },
  };
  const all: FakeElement[] = [];
  const document = {
    defaultView: view,
    documentElement: { scrollWidth: 400, scrollHeight: 3000 },
    elementFromPoint(x: number, y: number) {
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return null;
      return all.filter((element) => element.style.pointerEvents !== "none").filter((element) => {
        const box = element.getBoundingClientRect();
        return x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
      }).at(-1) ?? null;
    },
  };
  const element = (box: Box, options: { parent?: FakeElement; style?: Record<string, string>; attributes?: Record<string, string> } = {}): FakeElement => {
    const created: FakeElement = {
      nodeType: 1, style: options.style ?? {}, attributes: options.attributes ?? {}, parentElement: options.parent ?? null, ownerDocument: document,
      getAttribute: (name) => created.attributes[name] ?? null,
      hasAttribute: (name) => Object.hasOwn(created.attributes, name),
      contains(other) { for (let node: FakeElement | null = other; node; node = node.parentElement) if (node === created) return true; return false; },
      getBoundingClientRect: () => ({ left: box.left - view.scrollX, top: box.top - view.scrollY, width: box.width, height: box.height }),
      scrollIntoView() { view.scrollY = Math.max(0, Math.min(3000 - view.innerHeight, box.top + box.height / 2 - view.innerHeight / 2)); },
    };
    all.push(created);
    return created;
  };
  const body = element({ left: 0, top: 0, width: 400, height: 3000 });
  return { view, element, body };
}

/** The real-browser cases as element-like objects; each names the anchor and its expected measurement. */
function visibilityCases() {
  const { view, element, body } = fakeDocument();
  const box = (top: number, left = 10) => ({ left, top, width: 120, height: 40 });
  const result = (over: Partial<Measured> = {}): Measured => ({ ...shown, ...over });
  const visible = element(box(10), { parent: body });
  const displayNone = element({ left: 0, top: 0, width: 0, height: 0 }, { parent: body, style: { display: "none" } });
  const visibilityHidden = element(box(110), { parent: body, style: { visibility: "hidden" } });
  const transparentParent = element(box(160), { parent: body, style: { opacity: "0" } });
  const transparentChild = element(box(160), { parent: transparentParent });
  const hiddenAttribute = element(box(210), { parent: body, attributes: { hidden: "" } });
  const belowFold = element(box(2500), { parent: body });
  const outside = element(box(10, -2000), { parent: body });
  const covered = element(box(260), { parent: body });
  element(box(250), { parent: body }); // an overlay above `covered`
  const childHit = element(box(420), { parent: body });
  element(box(420), { parent: childHit }); // a child filling the anchor
  const positioned = element({ left: 10, top: 480, width: 200, height: 80 }, { parent: body });
  const passThrough = element({ left: 20, top: 500, width: 60, height: 20 }, { parent: positioned, style: { pointerEvents: "none" } });
  return {
    view,
    cases: [
      ["visible", visible, result()],
      ["display none", displayNone, result({ width: 0, height: 0, hidden: true, coveredAtCentre: true })],
      ["visibility hidden", visibilityHidden, result({ hidden: true })],
      ["opacity 0 on an ancestor", transparentChild, result({ transparent: true })],
      ["hidden attribute", hiddenAttribute, result({ hidden: true })],
      ["below the fold, visible after scrolling", belowFold, result()],
      ["outside the scroll area", outside, result({ insideScrollArea: false, coveredAtCentre: true })],
      ["covered by an overlay", covered, result({ coveredAtCentre: true })],
      ["centre hits a child", childHit, result()],
      ["the hit is a positioned ancestor", passThrough, result({ width: 60, height: 20 })],
    ] as const,
  };
}

describe("the visibility function is self-contained (H3)", () => {
  const rebuilt = new Function(`return ${anchorVisibility.toString()}`)() as typeof anchorVisibility;

  it.each(visibilityCases().cases.map(([name]) => name))("measures %s", (name) => {
    const { view, cases } = visibilityCases();
    const [, element, expected] = cases.find(([candidate]) => candidate === name)!;
    view.scrollTo(0, 7);
    expect(rebuilt([element as unknown as Element], [])).toEqual([expected]);
    expect([view.scrollX, view.scrollY], "the window scroll position is restored").toEqual([0, 7]);
  });

  it("measures a batch in order and reads the requested attributes", () => {
    const { element, body } = fakeDocument();
    const first = element({ left: 0, top: 0, width: 50, height: 20 }, { parent: body, attributes: { "data-openlup-state": "paid" } });
    const second = element({ left: 0, top: 30, width: 50, height: 20 }, { parent: body, attributes: { "data-openlup-action": "start_over" } });
    expect(rebuilt([first, second] as unknown as Element[], ["data-openlup-state", "data-openlup-action"]).map(({ attributes }) => attributes))
      .toEqual([["paid", null], [null, "start_over"]]);
    expect(rebuilt([], ["data-openlup-state"])).toEqual([]);
  });
});
