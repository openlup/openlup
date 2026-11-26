import type { PageHandle, StorefrontObserver } from "../../../src/storefront/testing/index.js";

/**
 * Fault switches of the store double. Each changes one behaviour of the
 * correct double, which keeps one order per command key, replays the first
 * answer, keeps the key across a reload, reads the purchase status after a
 * reload and guards its place-order control while a create is unanswered.
 */
export type StoreDoubleSwitches = {
  /** Every server answer resolves on a later turn, released only by the double's scheduler inside `settled`. */
  readonly async?: boolean;
  /** The place-order control stays enabled while a create is unanswered, and each click sends a new key. */
  readonly noSubmitGuard?: boolean;
  /** The command key is not kept across a reload. */
  readonly newKeyOnReload?: boolean;
  /** A replayed create also reserves stock on a second, non-payable order. */
  readonly holdOnReplay?: boolean;
  /** A replayed create makes a second payable order. */
  readonly secondPayableOrder?: boolean;
  /** `state:paid` shows beside `awaiting_payment` with no capture. */
  readonly showPaidEarly?: boolean;
  /** `state:paid` appears on the second settle with no page action in between, that is in the settle window. */
  readonly showPaidAfterSettle?: boolean;
  /** `state:awaiting_payment` is in the page but hidden. */
  readonly hideAwaitingPayment?: boolean;
  /** No state anchor shows after the order is placed. */
  readonly noStateAnchor?: boolean;
  /** `state:declined` shows instead of `state:awaiting_payment`. */
  readonly wrongState?: boolean;
  /** After a reload the page answers place-order from its own cache, with no status read and no create. */
  readonly replayFromCache?: boolean;
  /** The first place-order click sends nothing (a client-side check). */
  readonly firstSubmitSendsNothing?: boolean;
  /** Each create also creates a payable order for another buyer. */
  readonly createsForOtherBuyer?: boolean;
  /** Another buyer's payable order is paid during the first create. */
  readonly otherBuyerPays?: boolean;
  /** The observer rejects every ledger read. */
  readonly observerRejects?: boolean;
  /** `navigate` rejects. */
  readonly navigateRejects?: boolean;
  /** The page resends its create three more times after each answer. */
  readonly resubmitLoop?: boolean;
};

type View = "blank" | "cart" | "checkout" | "awaiting_payment";
type Order = { email: string; key: string; payable: boolean; hold: boolean };
type Target = Parameters<PageHandle["find"]>[0];
type Decide = Parameters<PageHandle["intercept"]>[0];

const FIELDS = ["email", "first_name", "last_name", "phone", "address_line1", "city", "postal_code", "terms_accepted"];
const OTHER_BUYER = "other-buyer@example.test";

/**
 * A scripted page, in-memory server and observer sharing one state. `events`
 * records server and observer events in order (`create:start`,
 * `create:answered`, `ledger`); `calls` records every page handle call;
 * `keysSent` every command key the page sent; `withheld` the create answers
 * the server produced that the page never received, per buyer.
 */
export function storeDouble(switches: StoreDoubleSwitches = {}, options: { readonly locators?: Readonly<Record<string, string>>; readonly exclusive?: boolean } = {}) {
  const events: string[] = [];
  const calls: string[] = [];
  const keysSent: string[] = [];
  const withheld = new Map<string, number>();
  const orders: Order[] = [{ email: OTHER_BUYER, key: "seed", payable: true, hold: true }];
  const answers = new Map<string, number>();
  const queue: Array<() => void> = [];
  const tasks = new Set<Promise<unknown>>();
  let decide: Decide | null = null;
  let view: View = "blank";
  let fields: Record<string, string | boolean> = {};
  // Session storage: survives a reload and a navigation.
  const storage: { key?: string; cached?: boolean; reloaded?: boolean } = {};
  let placing = false;
  let firstSubmitSkipped = false;
  let keyCount = 0;
  let settlesSinceAction = 0;
  let paidRevealed = false;

  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const track = <T>(task: Promise<T>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
    return task;
  };
  const acted = (call: string) => {
    calls.push(call);
    settlesSinceAction = 0;
  };
  const newKey = () => {
    keyCount += 1;
    return `key-${keyCount}-d1c3a9`;
  };

  const serve = async (method: string, path: string, key: string | null, email: string) => {
    if (switches.async === true) await new Promise<void>((resolve) => queue.push(resolve));
    if (method === "POST" && path === "/api/orders" && key !== null) {
      events.push("create:answered");
      const first = answers.get(key);
      if (first !== undefined) {
        if (switches.holdOnReplay === true) orders.push({ email, key, payable: false, hold: true });
        if (switches.secondPayableOrder === true) orders.push({ email, key, payable: true, hold: true });
        return true;
      }
      answers.set(key, orders.length);
      orders.push({ email, key, payable: true, hold: true });
      if (switches.createsForOtherBuyer === true) orders.push({ email: OTHER_BUYER, key: `${key}-other`, payable: true, hold: false });
      if (switches.otherBuyerPays === true && orders[0]!.payable) orders[0]!.payable = false;
      return true;
    }
    return true;
  };

  /** Sends one request through the installed interceptor; resolves whether the page received an answer. */
  const send = async (method: string, path: string, key: string | null) => {
    const email = typeof fields.email === "string" ? fields.email : "";
    if (key !== null) keysSent.push(key);
    if (method === "POST" && path === "/api/orders") events.push("create:start");
    const decision = decide === null ? "pass" : await decide({ method, path, header: (name) => name === "idempotency-key" ? key : null });
    if (decision === "block") return false;
    await serve(method, path, key, email);
    if (decision === "withhold") {
      if (method === "POST" && path === "/api/orders") withheld.set(email, (withheld.get(email) ?? 0) + 1);
      return false;
    }
    return true;
  };

  const load = () => {
    if (switches.newKeyOnReload === true) delete storage.key;
    if (storage.key !== undefined && switches.replayFromCache !== true) void track(send("GET", "/api/orders/status", null));
  };

  const submit = async (key: string) => {
    let delivered = await send("POST", "/api/orders", key);
    if (switches.resubmitLoop === true) for (let again = 0; again < 3; again += 1) delivered = await send("POST", "/api/orders", key);
    placing = false;
    if (delivered) {
      view = "awaiting_payment";
      storage.cached = true;
      delete storage.key;
    }
  };

  /** Anchors in the page now, with whether each is shown. */
  const present = (): Map<string, boolean> => {
    const shown = new Map<string, boolean>();
    if (view === "cart") shown.set("action:proceed_to_checkout", true);
    if (view === "checkout") {
      shown.set("action:place_order", true);
      for (const field of FIELDS) shown.set(`field:${field}`, true);
    }
    if (view === "awaiting_payment") {
      if (switches.wrongState === true) shown.set("state:declined", true);
      else if (switches.noStateAnchor !== true) shown.set("state:awaiting_payment", switches.hideAwaitingPayment !== true);
      shown.set("action:continue_payment", true);
      if (switches.showPaidEarly === true || paidRevealed) shown.set("state:paid", true);
    }
    return shown;
  };
  const nameOf = (target: Target) => "locator" in target ? options.locators?.[target.locator] ?? `missing:${target.locator}` : `${target.attribute}:${target.value}`;
  const measure = (shown: boolean) => ({ width: 120, height: 40, insideScrollArea: true, hidden: !shown, transparent: false, coveredAtCentre: false });

  const page: PageHandle = {
    async navigate(path) {
      acted(`navigate ${path}`);
      if (switches.navigateRejects === true) throw new Error("net::ERR_CONNECTION_REFUSED at https://shop.example.test/select?token=secret-token-value");
      view = path.startsWith("/select/") ? "cart" : "blank";
      fields = {};
      load();
    },
    async reload() {
      acted("reload");
      storage.reloaded = true;
      fields = {};
      if (view === "awaiting_payment") view = "checkout";
      load();
    },
    path: () => ({ blank: "/", cart: "/cart", checkout: "/checkout", awaiting_payment: "/checkout/pay" })[view],
    width: () => 1280,
    async find(target, _options) {
      const name = nameOf(target);
      calls.push(`find ${name}`);
      const shown = present().get(name);
      return shown === undefined ? null : measure(shown);
    },
    async anchors(locators = {}) {
      const custom = new Set(Object.keys(locators));
      const names = new Set<string>();
      for (const [name, shown] of present()) if (shown && !name.startsWith("field:") && !custom.has(name)) names.add(name);
      for (const [name, locator] of Object.entries(locators)) {
        const mapped = options.locators?.[locator];
        if (mapped !== undefined && present().get(mapped) === true) names.add(name);
      }
      return [...names].sort();
    },
    async perform(target) {
      const name = nameOf(target);
      acted(`perform ${name}`);
      if (present().get(name) !== true) return false;
      if (name === "action:proceed_to_checkout") {
        view = "checkout";
        fields = {};
        void track(send("POST", "/api/quote", null));
        return true;
      }
      if (name === "action:place_order") {
        if (placing && switches.noSubmitGuard !== true) return false;
        if (switches.firstSubmitSendsNothing === true && !firstSubmitSkipped) {
          firstSubmitSkipped = true;
          return true;
        }
        if (switches.replayFromCache === true && storage.reloaded === true && storage.key !== undefined) {
          view = "awaiting_payment";
          return true;
        }
        placing = true;
        if (switches.noSubmitGuard === true || storage.key === undefined) storage.key = newKey();
        void track(submit(storage.key));
        return true;
      }
      return true;
    },
    async fill(target, value) {
      const name = nameOf(target);
      acted(`fill ${name}`);
      if (present().get(name) === undefined) return false;
      fields[name.slice("field:".length)] = value;
      return true;
    },
    async intercept(next) {
      calls.push("intercept");
      decide = next;
      return async () => {
        calls.push("unintercept");
        decide = null;
      };
    },
    async settled() {
      calls.push("settled");
      settlesSinceAction += 1;
      if (switches.showPaidAfterSettle === true && settlesSinceAction >= 2 && view === "awaiting_payment") paidRevealed = true;
      for (;;) {
        await turn();
        if (queue.length > 0) {
          queue.shift()!();
          continue;
        }
        if (tasks.size === 0) return;
      }
    },
  };

  const observer: StorefrontObserver = {
    kind: "store",
    async ledger(subject) {
      events.push("ledger");
      if (switches.observerRejects === true) throw new Error("connection refused: postgres://owner:secret@db/store");
      const own = orders.filter((order) => order.email === subject);
      return { orders: own.length, payableOrders: own.filter((order) => order.payable).length, holds: own.filter((order) => order.hold).length, attempts: 0, captures: 0 };
    },
    ...(options.exclusive === true ? { payableOrdersInDatabase: async () => orders.filter((order) => order.payable).length } : {}),
  };

  return { page, observer, events, calls, keysSent, withheld };
}
