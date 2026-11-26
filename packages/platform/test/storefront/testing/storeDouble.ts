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
  /** The place-order control stays enabled while a create is unanswered, but a second click reuses the key. */
  readonly noSubmitGuardSameKey?: boolean;
  /** Each new order records two payment attempts. */
  readonly twoAttempts?: boolean;
  /** Each new order records two captured payments. */
  readonly doubleCapture?: boolean;
  /** `state:awaiting_payment` shows without `action:continue_payment`. */
  readonly noContinuePayment?: boolean;
  /** When the status read after a reload gets no answer, the page shows `awaiting_payment` from its own state. */
  readonly progressFromPageState?: boolean;
  /** With `progressFromPageState`, the selection entry keeps showing that state, so no arrangement is possible. */
  readonly stuckInPageState?: boolean;
  /** With `stuckInPageState`, navigating away from that state rejects. */
  readonly stuckNavigateRejects?: boolean;
  /** Entering checkout without a stored key sends a status read; nothing after a reload does (with `replayFromCache`). */
  readonly statusReadOnFirstCheckout?: boolean;
  /** A repeated create with changed details updates the order in place; the correct double refuses it and shows `details_changed`. */
  readonly updateInPlace?: boolean;
  /** Like `updateInPlace`, but only for the control run's buyer: the store answers the two runs under different policies. */
  readonly updateInPlaceForControl?: boolean;
  /** After a decline the server retries and settles the payment by itself, and the page learns it over a request no matcher matches. */
  readonly progressWithoutRetry?: boolean;
  /** After a decline the page retries the payment by itself, the sandbox settles that retry at once, and the page reads the status. */
  readonly autoRetry?: boolean;
  /** When a status poll gets no answer while the page shows `awaiting_authority`, the page shows `paid` from its own state. */
  readonly paidFromLocalState?: boolean;
  /** A reload during a payment starts a new payment attempt. */
  readonly newAttemptOnReload?: boolean;
  /** `state:paid` shows beside `state:paid_pending_activation`. */
  readonly showPaidWhilePending?: boolean;
  /** When a status read during a payment gets no answer, the page falls back to `awaiting_payment`. */
  readonly awaitingPaymentWhenReadFails?: boolean;
  /** The continue-payment control starts no payment attempt. */
  readonly continueSendsNothing?: boolean;
  /** A retry click starts two payment attempts. */
  readonly retryStartsTwo?: boolean;
  /** The outcome driver rejects every outcome. */
  readonly driverRejects?: boolean;
  /** The outcome driver never declines a payment. */
  readonly neverDeclines?: boolean;
};

/** Every outcome kind the double's driver can produce. */
export const ALL_OUTCOMES = ["activation_pending", "declined", "pending", "settled", "settled_after_pending"] as const;

type View = "blank" | "cart" | "checkout" | "awaiting_payment" | "details_changed" | PaymentView;
type PaymentView = "paying" | "awaiting_authority" | "declined" | "paid" | "paid_pending_activation";
type PaymentStatus = "open" | "pending" | "declined" | "settled" | "activation_pending";
type Order = { email: string; key: string; payable: boolean; hold: boolean; firstName: string };
type Payment = { email: string; status: PaymentStatus };
type Target = Parameters<PageHandle["find"]>[0];
type Decide = Parameters<PageHandle["intercept"]>[0];

const FIELDS = ["email", "first_name", "last_name", "phone", "address_line1", "city", "postal_code", "terms_accepted"];
const OTHER_BUYER = "other-buyer@example.test";
const PAYMENT_VIEWS: ReadonlySet<View> = new Set(["paying", "awaiting_authority", "declined", "paid", "paid_pending_activation"]);
const VIEW_OF: Readonly<Record<PaymentStatus, PaymentView>> = {
  open: "paying", pending: "awaiting_authority", declined: "declined", settled: "paid", activation_pending: "paid_pending_activation",
};

/**
 * A scripted page, in-memory server and observer sharing one state. `events`
 * records server and observer events in order (`create:start`,
 * `create:answered`, `ledger`); `calls` records every page handle call;
 * `keysSent` every command key the page sent; `withheld` the create answers
 * the server produced that the page never received, per buyer; `produced`
 * every outcome the driver was asked for, as `[subject, outcome]`.
 *
 * The page starts a payment attempt on `continue_payment` and `retry_payment`
 * and shows `paying`; it learns an outcome by a status poll after the driver
 * produced it, and after a reload during a payment it reads the status and
 * shows the state it last knew when that read gets no answer.
 */
export function storeDouble(switches: StoreDoubleSwitches = {}, options: {
  readonly locators?: Readonly<Record<string, string>>;
  readonly exclusive?: boolean;
  readonly capabilities?: readonly string[];
} = {}) {
  const events: string[] = [];
  // Click number of each create, in the order the server received them.
  const arrivals: number[] = [];
  // Every anchor wait the runner asked for, as [anchor, timeoutMs].
  const findTimeouts: [string, number][] = [];
  const attempts = new Map<string, number>();
  const captures = new Map<string, number>();
  let clicks = 0;
  let stuck = false;
  const calls: string[] = [];
  const keysSent: string[] = [];
  const withheld = new Map<string, number>();
  const orders: Order[] = [{ email: OTHER_BUYER, key: "seed", payable: true, hold: true, firstName: "Seed" }];
  const payments: Payment[] = [];
  const produced: [string, string][] = [];
  const answers = new Map<string, number>();
  const queue: Array<() => void> = [];
  const tasks = new Set<Promise<unknown>>();
  let decide: Decide | null = null;
  let view: View = "blank";
  let fields: Record<string, string | boolean> = {};
  // Session storage: survives a reload and a navigation.
  const storage: { key?: string; cached?: boolean; reloaded?: boolean; email?: string; lastView?: View } = {};
  // Anchor reads while the page showed a decline, since the last buyer action; the page's own retry fires after two.
  let declinedReads = 0;
  let autoFired = false;
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
    declinedReads = 0;
    autoFired = false;
  };
  const buyer = () => typeof fields.email === "string" && fields.email !== "" ? fields.email : storage.email ?? "";
  const show = (next: View) => {
    view = next;
    if (PAYMENT_VIEWS.has(next)) storage.lastView = next;
  };
  const settlePayment = (payment: Payment, status: PaymentStatus) => {
    payment.status = status;
    captures.set(payment.email, (captures.get(payment.email) ?? 0) + 1);
    for (const order of orders) if (order.email === payment.email) order.payable = false;
  };
  const newKey = () => {
    keyCount += 1;
    return `key-${keyCount}-d1c3a9`;
  };

  const serve = async (method: string, path: string, key: string | null, email: string, click: number, firstName: string): Promise<string> => {
    if (switches.async === true) await new Promise<void>((resolve) => queue.push(resolve));
    if (method === "POST" && path === "/api/payments") {
      payments.push({ email, status: "open" });
      return "ok";
    }
    if (method === "POST" && path === "/api/orders" && key !== null) {
      events.push("create:answered");
      arrivals.push(click);
      const first = answers.get(key);
      if (first !== undefined) {
        const order = orders[first]!;
        if (order.firstName !== firstName) {
          const inPlace = switches.updateInPlace === true || (switches.updateInPlaceForControl === true && email.endsWith("-control@example.test"));
          if (!inPlace) return "refused";
          order.firstName = firstName;
          return "updated";
        }
        if (switches.holdOnReplay === true) orders.push({ email, key, payable: false, hold: true, firstName });
        if (switches.secondPayableOrder === true) orders.push({ email, key, payable: true, hold: true, firstName });
        return "replayed";
      }
      answers.set(key, orders.length);
      orders.push({ email, key, payable: true, hold: true, firstName });
      attempts.set(email, (attempts.get(email) ?? 0) + (switches.twoAttempts === true ? 2 : 0));
      captures.set(email, (captures.get(email) ?? 0) + (switches.doubleCapture === true ? 2 : 0));
      if (switches.createsForOtherBuyer === true) orders.push({ email: OTHER_BUYER, key: `${key}-other`, payable: true, hold: false, firstName });
      if (switches.otherBuyerPays === true && orders[0]!.payable) orders[0]!.payable = false;
      return "created";
    }
    return "ok";
  };

  /** Sends one request through the installed interceptor; resolves the server's answer, or `null` when the page received none. */
  const send = async (method: string, path: string, key: string | null, click = 0): Promise<string | null> => {
    const email = buyer();
    const firstName = typeof fields.first_name === "string" ? fields.first_name : "";
    if (key !== null) keysSent.push(key);
    if (method === "POST" && path === "/api/orders") events.push("create:start");
    const decision = decide === null ? "pass" : await decide({ method, path, header: (name) => name === "idempotency-key" ? key : null });
    if (decision === "block") return null;
    const answer = await serve(method, path, key, email, click, firstName);
    if (decision === "withhold") {
      if (method === "POST" && path === "/api/orders") withheld.set(email, (withheld.get(email) ?? 0) + 1);
      return null;
    }
    return answer;
  };

  /** Reads the payment status: an answer shows the buyer's latest payment; no answer keeps the page's own state, or a faulty fallback. */
  const readStatus = (poll: boolean) => track(send("GET", "/api/orders/status", null).then((answer) => {
    if (answer !== null) {
      const latest = payments.filter((payment) => payment.email === buyer()).at(-1);
      if (latest !== undefined) show(VIEW_OF[latest.status]);
      return;
    }
    if (switches.awaitingPaymentWhenReadFails === true) view = "awaiting_payment";
    else if (poll && switches.paidFromLocalState === true && view === "awaiting_authority") show("paid");
  }));

  const load = (reloaded: boolean) => {
    if (switches.newKeyOnReload === true) delete storage.key;
    if (storage.key !== undefined && switches.replayFromCache !== true) {
      void track(send("GET", "/api/orders/status", null).then((answered) => {
        if (answered !== null || !reloaded || switches.progressFromPageState !== true) return;
        view = "awaiting_payment";
        stuck = switches.stuckInPageState === true;
      }));
    }
  };

  const submit = async (key: string, click: number) => {
    let answer = await send("POST", "/api/orders", key, click);
    if (switches.resubmitLoop === true) for (let again = 0; again < 3; again += 1) answer = await send("POST", "/api/orders", key);
    placing = false;
    if (answer !== null) {
      view = answer === "refused" ? "details_changed" : "awaiting_payment";
      storage.cached = true;
      delete storage.key;
    }
  };

  /** Starts a payment attempt for the page's buyer and shows `paying`. */
  const pay = (attempts: number) => {
    storage.email = buyer();
    show("paying");
    for (let attempt = 0; attempt < attempts; attempt += 1) void track(send("POST", "/api/payments", null));
  };

  /** The page's or the server's own progress after a decline, two anchor reads after it was shown. */
  const progressOnItsOwn = () => {
    if (view !== "declined" || declinedReads < 2 || autoFired) return;
    autoFired = true;
    const email = buyer();
    if (switches.autoRetry === true) {
      void track((async () => {
        await send("POST", "/api/payments", null);
        const retry = payments.filter((payment) => payment.email === email).at(-1);
        if (retry !== undefined && retry.status === "open") settlePayment(retry, "settled");
        await readStatus(true);
      })());
    }
    if (switches.progressWithoutRetry === true) {
      const retry: Payment = { email, status: "open" };
      payments.push(retry);
      settlePayment(retry, "settled");
      void track(send("GET", "/api/payment-events", null).then((answer) => {
        if (answer !== null) show("paid");
      }));
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
      if (switches.noContinuePayment !== true) shown.set("action:continue_payment", true);
      if (switches.showPaidEarly === true || paidRevealed) shown.set("state:paid", true);
    }
    if (view === "details_changed") {
      shown.set("state:details_changed", true);
      shown.set("action:continue_payment", true);
      shown.set("action:start_over", true);
    }
    if (view === "awaiting_authority") shown.set("state:awaiting_authority", true);
    if (view === "declined") {
      shown.set("state:declined", true);
      shown.set("action:retry_payment", true);
    }
    if (view === "paid") shown.set("state:paid", true);
    if (view === "paid_pending_activation") {
      shown.set("state:paid_pending_activation", true);
      if (switches.showPaidWhilePending === true) shown.set("state:paid", true);
    }
    return shown;
  };
  const nameOf = (target: Target) => "locator" in target ? options.locators?.[target.locator] ?? `missing:${target.locator}` : `${target.attribute}:${target.value}`;
  const measure = (shown: boolean) => ({ width: 120, height: 40, insideScrollArea: true, hidden: !shown, transparent: false, coveredAtCentre: false });

  const page: PageHandle = {
    async navigate(path) {
      acted(`navigate ${path}`);
      if (switches.navigateRejects === true) throw new Error("net::ERR_CONNECTION_REFUSED at https://shop.example.test/select?token=secret-token-value");
      if (stuck && switches.stuckNavigateRejects === true) throw new Error("net::ERR_ABORTED");
      if (!stuck) view = path.startsWith("/select/") ? "cart" : "blank";
      fields = {};
      load(false);
    },
    async reload() {
      acted("reload");
      storage.reloaded = true;
      fields = {};
      if (PAYMENT_VIEWS.has(view)) {
        // During a payment the page reads the status and shows the state it last knew until an answer arrives.
        view = storage.lastView ?? "paying";
        if (switches.newAttemptOnReload === true) void track(send("POST", "/api/payments", null));
        void readStatus(false);
        return;
      }
      if (view === "awaiting_payment") view = "checkout";
      load(true);
    },
    path: () => ({
      blank: "/", cart: "/cart", checkout: "/checkout", awaiting_payment: "/checkout/pay", details_changed: "/checkout/changed",
      paying: "/checkout/pay", awaiting_authority: "/checkout/pay", declined: "/checkout/pay", paid: "/checkout/done", paid_pending_activation: "/checkout/done",
    } satisfies Record<View, string>)[view],
    width: () => 1280,
    async find(target, { timeoutMs }) {
      const name = nameOf(target);
      calls.push(`find ${name}`);
      findTimeouts.push([name, timeoutMs]);
      const shown = present().get(name);
      return shown === undefined ? null : measure(shown);
    },
    async anchors(locators = {}) {
      if (view === "declined") declinedReads += 1;
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
        if (switches.statusReadOnFirstCheckout === true && storage.key === undefined) void track(send("GET", "/api/orders/status", null));
        return true;
      }
      if (name === "action:place_order") {
        if (placing && switches.noSubmitGuard !== true && switches.noSubmitGuardSameKey !== true) return false;
        if (switches.firstSubmitSendsNothing === true && !firstSubmitSkipped) {
          firstSubmitSkipped = true;
          return true;
        }
        if (switches.replayFromCache === true && storage.reloaded === true && storage.key !== undefined) {
          view = "awaiting_payment";
          return true;
        }
        placing = true;
        storage.email = buyer();
        if (switches.noSubmitGuard === true || storage.key === undefined) storage.key = newKey();
        clicks += 1;
        void track(submit(storage.key, clicks));
        return true;
      }
      if (name === "action:continue_payment") {
        pay(switches.continueSendsNothing === true ? 0 : 1);
        return true;
      }
      if (name === "action:retry_payment") {
        pay(switches.retryStartsTwo === true ? 2 : 1);
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
      progressOnItsOwn();
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
      if (switches.observerRejects === true) throw new Error("observer_unreachable: connect postgres://owner:secret@db.example.test/store?sslmode=require failed. Retry later.");
      const own = orders.filter((order) => order.email === subject);
      return {
        orders: own.length, payableOrders: own.filter((order) => order.payable).length, holds: own.filter((order) => order.hold).length,
        attempts: (attempts.get(subject) ?? 0) + payments.filter((payment) => payment.email === subject).length, captures: captures.get(subject) ?? 0,
      };
    },
    ...(options.exclusive === true ? { payableOrdersInDatabase: async () => orders.filter((order) => order.payable).length } : {}),
  };

  /**
   * The outcome driver: acts on the subject's latest payment attempt, does
   * nothing when there is none it can act on, then lets the page poll.
   */
  const outcomes = {
    capabilities: options.capabilities ?? ALL_OUTCOMES,
    async produce(outcome: string, { subject }: { readonly subject: string }) {
      produced.push([subject, outcome]);
      if (switches.driverRejects === true) throw new Error("outcome_driver_unavailable: the sandbox refused https://sandbox.example.test/pay?key=secret-sandbox-key. Retry later.");
      const own = payments.filter((payment) => payment.email === subject);
      const latest = own.at(-1);
      if (latest?.status === "open") {
        if (outcome === "declined" && switches.neverDeclines !== true) latest.status = "declined";
        if (outcome === "pending") latest.status = "pending";
        if (outcome === "settled") settlePayment(latest, "settled");
        if (outcome === "activation_pending") settlePayment(latest, "activation_pending");
      }
      const pending = own.findLast((payment) => payment.status === "pending");
      if (outcome === "settled_after_pending" && pending !== undefined) settlePayment(pending, "settled");
      if (PAYMENT_VIEWS.has(view) && buyer() === subject) void readStatus(true);
    },
  };

  return { page, observer, outcomes, events, calls, keysSent, withheld, arrivals, findTimeouts, produced };
}
