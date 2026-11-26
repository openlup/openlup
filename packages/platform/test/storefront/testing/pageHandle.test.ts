import { describe, expect, it } from "vitest";
import { createPageHandle } from "../../../src/storefront/testing/index.js";
import { anchorVisibility } from "../../../src/storefront/testing/anchorVisibility.js";

type Decision = "pass" | "withhold" | "block";
type FakeRequest = { method(): string; url(): string; headers(): Record<string, string>; redirectedFrom(): FakeRequest | null };
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
    on(event: "request" | "requestfinished" | "requestfailed", listener: (request: FakeRequest) => void) {
      log.push(`on ${event}`);
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
      return page;
    },
    off(event: "request" | "requestfinished" | "requestfailed", listener: (request: FakeRequest) => void) { log.push(`off ${event}`); listeners.get(event)?.delete(listener); return page; },
    locator: (selector: string) => locator(selector, false),
    async route(url: string, handler: (route: unknown) => Promise<void>) { log.push(`route ${url}`); routes.set(url, handler); },
    async unroute(url: string, handler: (route: unknown) => Promise<void>) { log.push(`unroute ${url}`); expect(routes.get(url)).toBe(handler); routes.delete(url); },
  };
  /** Sends one request through the installed route and records what the handler did with it. */
  const send = (method: string, url: string, headers: Record<string, string> = {}) => {
    const calls: string[] = [];
    const request: FakeRequest = { method: () => method, url: () => url, headers: () => headers, redirectedFrom: () => null };
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
  const emit = (event: "request" | "requestfinished" | "requestfailed", request: FakeRequest) => {
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
    expect(fake.log).toEqual(["on request", "on requestfinished", "on requestfailed", "route **/*"]);
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
    fake.emit("requestfinished", { method: () => "GET", url: () => "https://shop.example.test/other", headers: () => ({}), redirectedFrom: () => null });
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

  it("follows a redirect: settling waits for the hop the browser reports after the routed request finished", async () => {
    const fake = fakePage();
    const handle = createPageHandle(fake.page);
    await handle.intercept(() => "pass");
    const create = fake.send("POST", "https://shop.example.test/api/create");
    await create.handled;
    const settled = tracked(handle.settled({ quietMs: 5 }));
    // As a browser reports it: the redirected request finishes, then its unrouted hop starts.
    fake.emit("requestfinished", create.request);
    await flush();
    expect(fake.waits).toHaveLength(1);
    const hop: FakeRequest = { method: () => "GET", url: () => "https://shop.example.test/orders/1", headers: () => ({}), redirectedFrom: () => create.request };
    fake.emit("request", hop);
    // A hop of a request no decide saw is not claimed.
    fake.emit("request", { ...hop, redirectedFrom: () => ({ ...hop, redirectedFrom: () => null }) });
    fake.release();
    await flush();
    expect(settled.done, "the hop started inside the quiet window").toBe(false);
    expect(fake.waits, "the hop is still in flight").toHaveLength(0);
    fake.emit("requestfinished", hop);
    await flush();
    expect(fake.waits).toHaveLength(1);
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
    expect(fake.log.filter((line) => line.startsWith("unroute") || line.startsWith("off"))).toEqual(["unroute **/*", "off request", "off requestfinished", "off requestfailed"]);
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
 * 400 × 300 over a scrollable area of 400 × 3000, boxes in document coordinates
 * (a `position: fixed` box in viewport coordinates). The root element is the
 * scrolling element and carries `overflow-x: hidden`, as many stores' styles do:
 * like a browser, its box starts at minus the scroll offset and its client
 * height is the viewport's. An element's box moves with the window's and its
 * ancestors' scroll positions; `scrollIntoView` scrolls every overflow ancestor
 * in the element's containing-block chain (nearest first, centred, clamped) and
 * then the window, and moves nothing for a fixed box; `elementFromPoint` answers
 * null outside the viewport and skips `pointer-events: none`, elements clipped
 * by their own or an ancestor's `clip` or `clip-path`, and points outside an
 * overflow ancestor in the containing-block chain; an element without a box
 * measures 0 × 0. `scrollTo` calls are logged with their behaviour.
 */
function fakeDocument(styles: { root?: Record<string, string>; body?: Record<string, string>; pageWidth?: number } = {}) {
  type Box = { left: number; top: number; width: number; height: number };
  type ScrollOptions = { left?: number; top?: number; behavior?: string };
  type FakeElement = {
    nodeType: 1; style: Record<string, string>; attributes: Record<string, string>; parentElement: FakeElement | null; ownerDocument: unknown;
    box: Box; scrollTop: number; scrollLeft: number; scrollHeight: number; scrollWidth: number; clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number;
    getAttribute(name: string): string | null; hasAttribute(name: string): boolean; contains(other: FakeElement): boolean;
    getBoundingClientRect(): Box; scrollIntoView(options: unknown): void; scrollTo(options: ScrollOptions): void;
  };
  const scrolls: string[] = [];
  const view = {
    scrollX: 0, scrollY: 0, innerWidth: 400, innerHeight: 300,
    getComputedStyle: (element: FakeElement) => ({
      display: "block", visibility: "visible", opacity: "1", position: "static", clip: "auto", clipPath: "none",
      transform: "none", filter: "none", perspective: "none", contain: "none", willChange: "auto", backdropFilter: "none",
      overflowX: element.style.overflow ?? "visible", overflowY: element.style.overflow ?? "visible", ...element.style,
    }),
    scrollTo(x: number | ScrollOptions, y?: number) {
      if (typeof x === "number") { scrolls.push("window positional"); view.scrollX = x; view.scrollY = y ?? 0; return; }
      scrolls.push(`window ${x.behavior ?? "auto"}`);
      view.scrollX = x.left ?? view.scrollX; view.scrollY = x.top ?? view.scrollY;
    },
  };
  const all: FakeElement[] = [];
  const position = (node: FakeElement) => node.style.position ?? "static";
  const ancestors = (element: FakeElement) => { const found: FakeElement[] = []; for (let node = element.parentElement; node; node = node.parentElement) found.push(node); return found; };
  // The overflow ancestors that clip `element`: those in its containing-block chain, never the root scroller.
  const clipping = (element: FakeElement) => {
    const found: FakeElement[] = [];
    let awaiting = position(element);
    for (const node of ancestors(element)) {
      const inChain = awaiting === "static" || awaiting === "relative" || (awaiting === "absolute" && position(node) !== "static");
      if (!inChain) continue;
      if (node.style.overflow !== undefined && !rootScroller(node)) found.push(node);
      awaiting = position(node);
    }
    return found;
  };
  // The viewport's scrollers: the root element, and body while the root's overflow is visible.
  const rootScroller = (node: FakeElement) => node === root || (node === body && root.style.overflow === undefined);
  const inside = (x: number, y: number, box: Box) => x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
  const clippedAway = (element: FakeElement) => [element, ...ancestors(element)].some((node) => (node.style.clip ?? "auto") !== "auto" || (node.style.clipPath ?? "none") !== "none");
  const document: { defaultView: typeof view; documentElement: FakeElement | null; scrollingElement: FakeElement | null; body: FakeElement | null; elementFromPoint(x: number, y: number): FakeElement | null } = {
    defaultView: view, documentElement: null, scrollingElement: null, body: null,
    elementFromPoint(x: number, y: number) {
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return null;
      return all.filter((element) => element.style.pointerEvents !== "none" && !clippedAway(element))
        .filter((element) => inside(x, y, element.getBoundingClientRect()))
        .filter((element) => clipping(element).every((node) => inside(x, y, node.getBoundingClientRect())))
        .at(-1) ?? null;
    },
  };
  const element = (box: Box, options: { parent?: FakeElement; style?: Record<string, string>; attributes?: Record<string, string>; scrollHeight?: number; scrollWidth?: number; clientHeight?: number } = {}): FakeElement => {
    const created: FakeElement = {
      nodeType: 1, style: options.style ?? {}, attributes: options.attributes ?? {}, parentElement: options.parent ?? null, ownerDocument: document, box,
      scrollTop: 0, scrollLeft: 0, scrollHeight: options.scrollHeight ?? box.height, scrollWidth: options.scrollWidth ?? box.width,
      clientLeft: 0, clientTop: 0, clientWidth: box.width, clientHeight: options.clientHeight ?? box.height,
      getAttribute: (name) => created.attributes[name] ?? null,
      hasAttribute: (name) => Object.hasOwn(created.attributes, name),
      contains(other) { for (let node: FakeElement | null = other; node; node = node.parentElement) if (node === created) return true; return false; },
      getBoundingClientRect: () => {
        if (position(created) === "fixed") return { ...box };
        const scrolled = ancestors(created).reduce((sum, node) => ({ x: sum.x + node.scrollLeft, y: sum.y + node.scrollTop }), { x: view.scrollX, y: view.scrollY });
        return { left: box.left - scrolled.x, top: box.top - scrolled.y, width: box.width, height: box.height };
      },
      scrollIntoView() {
        if (position(created) === "fixed") return;
        let centre = box.top + box.height / 2;
        for (const node of clipping(created)) {
          node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, centre - node.box.top - node.clientHeight / 2));
          centre -= node.scrollTop;
        }
        view.scrollY = Math.max(0, Math.min(3000 - view.innerHeight, centre - view.innerHeight / 2));
        view.scrollX = Math.max(0, Math.min(root.scrollWidth - view.innerWidth, box.left + box.width / 2 - view.innerWidth / 2));
      },
      scrollTo(options: ScrollOptions) {
        scrolls.push(`element ${options.behavior ?? "auto"}`);
        created.scrollLeft = options.left ?? created.scrollLeft; created.scrollTop = options.top ?? created.scrollTop;
      },
    };
    all.push(created);
    return created;
  };
  const root = element({ left: 0, top: 0, width: 400, height: 3000 }, { style: styles.root ?? { overflowX: "hidden", overflowY: "auto", overflow: "hidden auto" }, scrollHeight: 3000, scrollWidth: styles.pageWidth ?? 400, clientHeight: 300 });
  const body = element({ left: 0, top: 0, width: 400, height: 3000 }, { parent: root, style: styles.body ?? {} });
  document.documentElement = root; document.scrollingElement = root; document.body = body;
  return { view, element, body, scrolls };
}

/** The real-browser cases as element-like objects; each names the anchor and its expected measurement. */
function visibilityCases() {
  const { view, element, body, scrolls } = fakeDocument();
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
  // A 140 × 50 carousel the buyer cannot scroll; the anchor sits in its second slide.
  const carousel = element({ left: 250, top: 20, width: 140, height: 50 }, { parent: body, style: { overflow: "hidden" }, scrollHeight: 100 });
  const secondSlide = element({ left: 250, top: 70, width: 140, height: 50 }, { parent: carousel });
  const inSecondSlide = element({ left: 260, top: 75, width: 60, height: 20 }, { parent: secondSlide });
  // A 140 × 50 list the buyer can scroll; the anchor sits 100 px down its content.
  const list = element({ left: 250, top: 100, width: 140, height: 50 }, { parent: body, style: { overflow: "auto" }, scrollHeight: 150 });
  const inList = element({ left: 260, top: 200, width: 60, height: 20 }, { parent: list });
  // Visually hidden text: a 1 × 1 wrapper clipped to nothing inside a sized container.
  const srContainer = element({ left: 250, top: 240, width: 140, height: 40 }, { parent: body });
  const srWrapper = element({ left: 260, top: 250, width: 1, height: 1 }, { parent: srContainer, style: { position: "absolute", overflow: "hidden", clip: "rect(0px, 0px, 0px, 0px)" } });
  const srOnly = element({ left: 260, top: 250, width: 106, height: 18 }, { parent: srWrapper });
  // An ancestor clipped to nothing by `clip-path: inset(50%)`.
  const clipPath = element({ left: 250, top: 280, width: 140, height: 20 }, { parent: body, style: { clipPath: "inset(50%)" } });
  const underClipPath = element({ left: 260, top: 282, width: 60, height: 16 }, { parent: clipPath });
  // A fixed cart bar at the bottom of the viewport, inside a short overflow: hidden page wrapper.
  const shortWrapper = element({ left: 0, top: 0, width: 400, height: 8 }, { parent: body, style: { overflow: "hidden" } });
  const cartBar = element({ left: 0, top: 262, width: 230, height: 36 }, { parent: shortWrapper, style: { position: "fixed" } });
  // An absolute anchor whose positioned containing block lies outside the overflow: hidden wrapper around it.
  const positionedOuter = element({ left: 250, top: 320, width: 140, height: 100 }, { parent: body, style: { position: "relative" } });
  const thinWrapper = element({ left: 250, top: 320, width: 140, height: 20 }, { parent: positionedOuter, style: { overflow: "hidden" } });
  const escaping = element({ left: 260, top: 380, width: 60, height: 20 }, { parent: thinWrapper, style: { position: "absolute" } });
  return {
    view, carousel, list, scrolls,
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
      ["the second slide of a carousel the buyer cannot scroll", inSecondSlide, result({ width: 60, height: 20, insideScrollArea: false })],
      ["further down a list the buyer can scroll", inList, result({ width: 60, height: 20 })],
      ["inside a visually hidden wrapper", srOnly, result({ width: 106, height: 18, coveredAtCentre: true })],
      ["under an ancestor clipped by clip-path", underClipPath, result({ width: 60, height: 16, coveredAtCentre: true })],
      ["a fixed cart bar inside a short overflow: hidden wrapper", cartBar, result({ width: 230, height: 36 })],
      ["an absolute anchor whose containing block is outside the overflow: hidden wrapper", escaping, result({ width: 60, height: 20 })],
    ] as const,
  };
}

describe("the visibility function is self-contained (H3)", () => {
  const rebuilt = new Function(`return ${anchorVisibility.toString()}`)() as typeof anchorVisibility;

  it.each(visibilityCases().cases.map(([name]) => name))("measures %s", (name) => {
    const { view, cases, carousel, list, scrolls } = visibilityCases();
    const [, element, expected] = cases.find(([candidate]) => candidate === name)!;
    view.scrollTo(0, 7);
    list.scrollTop = 10;
    scrolls.length = 0;
    expect(rebuilt([element as unknown as Element], [])).toEqual([expected]);
    // Restoring must not animate under `scroll-behavior: smooth`, or the next anchor reads a moving page.
    expect(scrolls.length, "every scroll position is restored through scrollTo").toBeGreaterThan(0);
    expect(scrolls.filter((call) => !call.endsWith(" instant")), "every restore is instant").toEqual([]);
    expect([view.scrollX, view.scrollY], "the window scroll position is restored").toEqual([0, 7]);
    expect([carousel.scrollTop, list.scrollTop], "every container's scroll position is restored").toEqual([0, 10]);
  });

  it.each([
    ["the root's overflow: hidden (an app shell)", { root: { overflow: "hidden" } }, false],
    ["the root's overflow-y: hidden", { root: { overflowX: "visible", overflowY: "hidden", overflow: "visible hidden" } }, false],
    ["body's overflow: hidden, propagated to the viewport (a scroll lock)", { root: {}, body: { overflow: "hidden" } }, false],
    ["the root's overflow-x: hidden", { root: { overflowX: "hidden", overflowY: "auto", overflow: "hidden auto" } }, true],
    ["the root's overflow-y: scroll", { root: { overflowX: "auto", overflowY: "scroll", overflow: "auto scroll" } }, true],
    ["no overflow on the root or body", { root: {} }, true],
  ] as const)("treats an anchor below the fold under %s as reachable only when the buyer can scroll the viewport", (_name, styles, reachable) => {
    const { view, element, body } = fakeDocument(styles);
    const belowFold = element({ left: 10, top: 2500, width: 120, height: 40 }, { parent: body });
    expect(rebuilt([belowFold as unknown as Element], [])).toEqual([{ ...shown, insideScrollArea: reachable }]);
    expect([view.scrollX, view.scrollY], "the window scroll position is restored").toEqual([0, 0]);
  });

  it.each([
    ["an off-canvas drawer widening the page under the root's overflow-x: hidden", { root: { overflowX: "hidden", overflowY: "auto", overflow: "hidden auto" }, pageWidth: 1100 }, { left: 330, top: 20, width: 60, height: 20 }],
    ["an off-canvas drawer widening the page under body's overflow-x: hidden", { root: {}, body: { overflowX: "hidden", overflowY: "auto", overflow: "hidden auto" }, pageWidth: 1100 }, { left: 330, top: 20, width: 60, height: 20 }],
    ["a body scroll lock, the anchor already on screen", { root: {}, body: { overflow: "hidden" } }, { left: 10, top: 200, width: 120, height: 40 }],
  ] as const)("keeps an anchor already in view reachable under %s, moving nothing", (_name, styles, box) => {
    const { view, element, body, scrolls } = fakeDocument(styles);
    const anchor = element(box, { parent: body });
    expect(rebuilt([anchor as unknown as Element], [])).toEqual([{ ...shown, width: box.width, height: box.height }]);
    expect([view.scrollX, view.scrollY]).toEqual([0, 0]);
    expect(scrolls.filter((call) => !call.endsWith(" instant"))).toEqual([]);
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
