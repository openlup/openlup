import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  channelIngestKey,
  runChannelOrderIngest,
  type ChannelOrderIngestSagaDeps,
} from "./channelOrderIngestSaga.js";
import { NoopChannelSettlementNotAllowedError } from "./channelIngestAdmission.js";
import {
  createNoopChannelConnectorAdapter,
  readChannelOrderFixture,
} from "../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import type {
  ChannelIngestChannelRecord,
  ChannelIngestLedger,
  ChannelIngestStatus,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import type { NormalizedChannelOrder } from "../../../src/domains/channels/orderContracts.js";

// The saga against in-memory stand-ins for the five rails it drives. The SQL half of this wave is
// proved separately against a real isolated Postgres; what is proved here is the ORCHESTRATION —
// the step order, the blocked-stock posture, and that a second run of the same order writes nothing
// a second time.

const CHANNEL: ChannelIngestChannelRecord = {
  id: "ca000000-0000-4000-8000-000000000001",
  connectionId: "c0000000-0000-4000-8000-000000000001",
  slug: "sim-market",
  status: "active",
  currency: "EUR",
  connectorProviderKind: "noop_channel",
  settlementProviderKind: "channel_settlement",
  buyerCommsOwner: "channel",
  // The surface has said how it ships. Admission refuses one that has not, so a saga fixture
  // without this would prove the refusal rather than the orchestration these cases are about.
  deliverySelection: { providerKind: "simulator", kind: "courier" },
};

const ORDERED: readonly ChannelIngestStatus[] = [
  "received",
  "buyer_ready",
  "order_created",
  "reserved",
  "settled",
  "done",
];

/**
 * A stand-in that keeps the ONE invariant the real store keeps: a ledger row is identified by
 * (channel, external order ref), so a second run finds the first row rather than opening a second.
 */
function createFakeStore() {
  const ledgers = new Map<string, ChannelIngestLedger & { channelKey: string }>();
  const byKey = new Map<string, string>();
  const clients = new Map<string, string>();
  const orders = new Map<string, string>();
  const quarantined: Array<Record<string, unknown>> = [];
  const paidEvents: string[] = [];
  let sequence = 0;
  const next = (prefix: string) => `${prefix}-${(sequence += 1)}`;

  const store = {
    quarantined,
    paidEvents,
    ledgers,
    orders,
    clients,

    async recordInboundEvent(input: {
      channelId: string;
      externalOrderRef: string;
      externalOrderRevision: string | null;
      providerEventId: string;
      normalized: NormalizedChannelOrder;
    }): Promise<ChannelIngestLedger> {
      const channelKey = `${input.channelId}|${input.externalOrderRef}`;
      const existingId = byKey.get(channelKey);
      if (!existingId) {
        const ledger = {
          id: next("ledger"),
          status: "received" as ChannelIngestStatus,
          orderId: null,
          clientId: null,
          shippingAddressId: null,
          paymentIntentId: null,
          externalOrderRevision: input.externalOrderRevision,
          conflict: null,
          eventReplayed: false,
          replayed: false,
          channelKey,
        };
        ledgers.set(ledger.id, ledger);
        byKey.set(channelKey, ledger.id);
        return { ...ledger };
      }

      const ledger = ledgers.get(existingId)!;
      const created = ["order_created", "reserved", "settled", "done"].includes(ledger.status);
      if (created && ledger.externalOrderRevision !== input.externalOrderRevision) {
        // Mutates nothing, exactly like the RPC.
        return { ...ledger, conflict: "revision_conflict", eventReplayed: true, replayed: true };
      }
      return { ...ledger, eventReplayed: true, replayed: true };
    },

    async upsertBuyer(input: { ledgerId: string }) {
      const ledger = ledgers.get(input.ledgerId)!;
      if (ledger.clientId && ledger.shippingAddressId) {
        return {
          clientId: ledger.clientId,
          shippingAddressId: ledger.shippingAddressId,
          clientCreated: false,
          replayed: true,
        };
      }
      const clientId = clients.get(ledger.channelKey) ?? next("client");
      clients.set(ledger.channelKey, clientId);
      const shippingAddressId = next("address");
      ledger.clientId = clientId;
      ledger.shippingAddressId = shippingAddressId;
      if (ledger.status === "received") ledger.status = "buyer_ready";
      return { clientId, shippingAddressId, clientCreated: true, replayed: false };
    },

    async createChannelOrder(input: { idempotencyKey: string; ledgerId: string }) {
      const ledger = ledgers.get(input.ledgerId)!;
      if (ledger.orderId) {
        return { orderId: ledger.orderId, orderRef: `REF-${ledger.orderId}`, replayed: true };
      }
      const orderId = next("order");
      orders.set(orderId, "draft");
      ledger.orderId = orderId;
      ledger.status = "order_created";
      return { orderId, orderRef: `REF-${orderId}`, replayed: false };
    },

    async advanceLedger(input: {
      ledgerId: string;
      toStatus: ChannelIngestStatus;
      paymentIntentId?: string | null;
      lastError?: string | null;
    }): Promise<ChannelIngestLedger> {
      const ledger = ledgers.get(input.ledgerId)!;
      const rank = (status: ChannelIngestStatus) => ORDERED.indexOf(status) + 1;
      if (rank(input.toStatus) > 0 && rank(input.toStatus) < rank(ledger.status)) {
        throw new Error("channel_ingest_status_regression");
      }
      ledger.status = input.toStatus;
      if (input.paymentIntentId) ledger.paymentIntentId = input.paymentIntentId;
      return { ...ledger };
    },

    async quarantine(input: Record<string, unknown>) {
      quarantined.push(input);
      return {
        id: next("quarantine"),
        reason: input.reason as never,
        status: "open" as const,
        vocabulary: input.vocabulary as string,
      };
    },
  };

  return store;
}

function createDeps(overrides: Partial<Omit<ChannelOrderIngestSagaDeps, "store">> = {}) {
  const store = createFakeStore();
  const reservations = new Map<string, number>();
  const intents = new Map<string, { orderId: string; amountMinor: number; currency: string }>();
  const attempts = new Map<string, string>();
  const events = new Map<string, string>();
  const applied = new Set<string>();
  let stock = 10;

  const deps: Omit<ChannelOrderIngestSagaDeps, "store"> & {
    store: ChannelOrderIngestSagaDeps["store"] & ReturnType<typeof createFakeStore>;
  } = {
    store: store as ChannelOrderIngestSagaDeps["store"] & ReturnType<typeof createFakeStore>,
    channels: { readChannelBySlug: async () => CHANNEL },
    orderItems: {
      readOrderItems: async (orderId) => [
        { orderItemId: `${orderId}-item-1`, skuId: "sku-a", quantity: 2 },
      ],
    },
    reservations: {
      reserveChannelOrderItems: async (input) => {
        if (reservations.has(input.idempotencyKey)) {
          return { reservedItemCount: reservations.get(input.idempotencyKey)! };
        }
        const wanted = input.items.reduce((total, item) => total + item.quantity, 0);
        if (wanted > stock) {
          const failure = new Error("inventory_reservation_insufficient_available_stock") as Error & {
            code?: string;
          };
          failure.code = "23514";
          throw failure;
        }
        stock -= wanted;
        reservations.set(input.idempotencyKey, wanted);
        return { reservedItemCount: wanted };
      },
    },
    payments: {
      createIntent: async (input) => {
        const existing = intents.get(input.idempotencyKey);
        if (existing) return { paymentIntentId: `intent-${input.idempotencyKey}` };
        intents.set(input.idempotencyKey, {
          orderId: input.orderId,
          amountMinor: input.amountMinor,
          currency: input.currency,
        });
        return { paymentIntentId: `intent-${input.idempotencyKey}` };
      },
      recordAttempt: async (input) => {
        attempts.set(input.idempotencyKey, input.providerAttemptId);
        return { paymentAttemptId: `attempt-${input.idempotencyKey}` };
      },
      ingestSettlementEvent: async (input) => {
        const intent = [...intents.entries()].find(
          ([key]) => `intent-${key}` === input.paymentIntentId,
        );
        // The control plane's free money reconciliation, kept here so the saga is proved to feed it
        // the order total rather than some other number.
        if (intent && intent[1].amountMinor !== input.amountMinor) {
          throw new Error("payment_control_result_amount_mismatch");
        }
        events.set(input.providerEventId, input.providerPaymentId);
        return { paymentEventId: `event-${input.providerEventId}` };
      },
      applySucceeded: async (input) => {
        const intent = [...intents.entries()].find(
          ([key]) => `intent-${key}` === input.paymentIntentId,
        );
        const orderId = intent?.[1].orderId ?? "";
        if (!applied.has(input.idempotencyKey)) {
          applied.add(input.idempotencyKey);
          store.orders.set(orderId, "paid");
          // The status trigger's observable consequence, modelled so a blocked order can be proved
          // never to produce one.
          store.paidEvents.push(orderId);
        }
        return { orderId };
      },
    },
    // The fixture channel and the fixture order are both EUR, and the accepted set injected here
    // says EUR — so every case below still exercises the saga rather than its currency gate. The
    // gate itself is proved in channelIngestAdmission.test.ts.
    acceptedCurrencies: [CHANNEL.currency],
    noopSettlementForbidden: false,
    ...overrides,
  };

  return {
    deps,
    store,
    reservations,
    intents,
    attempts,
    events,
    setStock: (value: number) => {
      stock = value;
    },
  };
}

let wellFormed: NormalizedChannelOrder;
let overQuantity: NormalizedChannelOrder;

beforeEach(() => {
  wellFormed = readChannelOrderFixture("order-well-formed.json");
  overQuantity = readChannelOrderFixture("order-over-quantity.json");
});

describe("channel order ingest saga", () => {
  it("drives a normalized order to a settled, fulfillable order", async () => {
    const harness = createDeps();
    const outcome = await runChannelOrderIngest(harness.deps, wellFormed);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(harness.store.orders.get(outcome.orderId)).toBe("paid");
    expect(harness.store.ledgers.get(outcome.ledgerId)?.status).toBe("done");
    expect(harness.store.quarantined).toEqual([]);
  });

  it("satisfies the fulfillment guards' predicates on the settled order", async () => {
    const harness = createDeps();
    const outcome = await runChannelOrderIngest(harness.deps, wellFormed);
    if (outcome.kind !== "settled") throw new Error("expected settlement");

    const ledger = harness.store.ledgers.get(outcome.ledgerId)!;
    const items = await harness.deps.orderItems.readOrderItems(outcome.orderId);
    const reservedQuantity = [...harness.reservations.values()].reduce((a, b) => a + b, 0);

    // The nine fatal guards of commerce_fulfillment_create_order, as predicates over what the saga
    // produced. The real function is exercised against a live database in the container proof; this
    // pins that the ORCHESTRATION cannot leave any of them unsatisfiable.
    expect(harness.store.orders.get(outcome.orderId)).toBe("paid"); // order is fulfillable
    expect(ledger.clientId).toBeTruthy(); // client present
    expect(ledger.shippingAddressId).toBeTruthy(); // shipping address present
    expect(ledger.paymentIntentId).toBeTruthy(); // a succeeded intent exists
    expect(items.length).toBeGreaterThan(0); // order items exist
    expect(items.every((item) => Boolean(item.skuId))).toBe(true); // every line maps to a catalog sku
    expect(reservedQuantity).toBe(items.reduce((total, item) => total + item.quantity, 0)); // full coverage
  });

  // ONE SHELF, ONE AUTHORITY. Before this wave the channel rail passed a hardcoded NULL here, so a
  // marketplace reservation drew on local balances while the identical storefront sale drew on the
  // provider's stock oracle. The boundary stamps the stock authority from this argument, so the
  // whole fix is that the surface's declared provider actually arrives.
  it("reserves against the provider the surface declared, not against local balances", async () => {
    const harness = createDeps();
    const seen: Array<string | null> = [];
    const reserve = harness.deps.reservations.reserveChannelOrderItems;
    harness.deps.reservations.reserveChannelOrderItems = async (input) => {
      seen.push(input.providerKind);
      return reserve(input);
    };

    await runChannelOrderIngest(harness.deps, wellFormed);

    expect(seen).toEqual(["simulator"]);
  });

  it("walks reserve before intent, so no unstockable order can be settled", async () => {
    const order: string[] = [];
    const harness = createDeps();
    const reserve = harness.deps.reservations.reserveChannelOrderItems;
    const createIntent = harness.deps.payments.createIntent;
    harness.deps.reservations.reserveChannelOrderItems = async (input) => {
      order.push("reserve");
      return reserve(input);
    };
    harness.deps.payments.createIntent = async (input) => {
      order.push("intent");
      return createIntent(input);
    };

    await runChannelOrderIngest(harness.deps, wellFormed);

    expect(order).toEqual(["reserve", "intent"]);
  });

  it("keeps a stock-blocked order as a draft and emits no paid event", async () => {
    const harness = createDeps();
    harness.setStock(1);

    const outcome = await runChannelOrderIngest(harness.deps, overQuantity);

    expect(outcome.kind).toBe("blocked_stock");
    if (outcome.kind !== "blocked_stock") return;
    expect(harness.store.orders.get(outcome.orderId)).toBe("draft");
    expect(harness.store.ledgers.get(outcome.ledgerId)?.status).toBe("blocked_stock");
    expect(harness.store.paidEvents).toEqual([]);
    expect(harness.intents.size).toBe(0);
  });

  it("resumes a stock-blocked order into settlement once stock exists, under the same keys", async () => {
    const harness = createDeps();
    harness.setStock(1);
    const blocked = await runChannelOrderIngest(harness.deps, overQuantity);
    if (blocked.kind !== "blocked_stock") throw new Error("expected a block");

    harness.setStock(50);
    const resumed = await runChannelOrderIngest(harness.deps, overQuantity);

    expect(resumed.kind).toBe("settled");
    if (resumed.kind !== "settled") return;
    expect(resumed.orderId).toBe(blocked.orderId);
    expect(resumed.ledgerId).toBe(blocked.ledgerId);
    expect([...harness.reservations.keys()]).toEqual([
      channelIngestKey(CHANNEL.id, overQuantity.externalOrderRef, "inventory"),
    ]);
  });

  it("replays four layers deep without writing anything a second time", async () => {
    const harness = createDeps();

    const first = await runChannelOrderIngest(harness.deps, wellFormed);
    // Layer 1: the same normalized order through the whole saga again.
    const second = await runChannelOrderIngest(harness.deps, wellFormed);
    // Layer 2: an inbound redelivery — the byte-identical fixture from the connector's webhook path.
    const redelivered = await createNoopChannelConnectorAdapter().orders.normalizeWebhook({
      headers: { "x-simulator-signature": "valid" },
      rawBody: JSON.stringify({ fixture: "order-redelivery.json" }),
      signal: new AbortController().signal,
    });
    if (redelivered.kind !== "order") throw new Error("expected an order");
    const third = await runChannelOrderIngest(harness.deps, redelivered.order);

    if (first.kind !== "settled") throw new Error("expected settlement");
    expect(second).toEqual({ kind: "replayed", ledgerId: first.ledgerId, orderId: first.orderId });
    expect(third).toEqual({ kind: "replayed", ledgerId: first.ledgerId, orderId: first.orderId });
    // Layer 3: one ledger row, one order, one client. Layer 4: one of every keyed side effect.
    expect(harness.store.ledgers.size).toBe(1);
    expect(harness.store.orders.size).toBe(1);
    expect(harness.store.clients.size).toBe(1);
    expect(harness.reservations.size).toBe(1);
    expect(harness.intents.size).toBe(1);
    expect(harness.store.paidEvents).toEqual([first.orderId]);
  });

  it("quarantines a revision conflict and mutates nothing", async () => {
    const harness = createDeps();
    const first = await runChannelOrderIngest(harness.deps, wellFormed);
    if (first.kind !== "settled") throw new Error("expected settlement");

    const revised = { ...wellFormed, externalOrderRevision: "r2" };
    const outcome = await runChannelOrderIngest(harness.deps, revised);

    expect(outcome).toMatchObject({ kind: "quarantined", reason: "revision_conflict" });
    expect(harness.store.quarantined).toHaveLength(1);
    expect(harness.store.quarantined[0]).toMatchObject({ reason: "revision_conflict" });
    expect(harness.store.ledgers.get(first.ledgerId)?.externalOrderRevision).toBe("r1");
    expect(harness.store.ledgers.get(first.ledgerId)?.status).toBe("done");
  });

  it("quarantines an unmappable sellable under the far side's own token", async () => {
    const harness = createDeps();
    harness.deps.store.createChannelOrder = async () => {
      throw new Error("channel_order_unmapped_sellable");
    };

    const outcome = await runChannelOrderIngest(harness.deps, wellFormed);

    expect(outcome).toMatchObject({ kind: "quarantined", reason: "unmapped_sellable" });
    expect(harness.store.quarantined[0]).toMatchObject({ vocabulary: "PROBE-A" });
  });

  it("rethrows a transient store fault instead of filing operator work", async () => {
    const harness = createDeps();
    harness.deps.store.createChannelOrder = async () => {
      throw new Error("could not serialize access due to concurrent update");
    };

    await expect(runChannelOrderIngest(harness.deps, wellFormed)).rejects.toThrow(
      /concurrent update/,
    );
    expect(harness.store.quarantined).toEqual([]);
  });

  it("refuses a settlement state this wave does not know how to finish", async () => {
    const harness = createDeps();
    const authorized = {
      ...wellFormed,
      payment: { ...wellFormed.payment, state: "authorized" },
    };

    const outcome = await runChannelOrderIngest(harness.deps, authorized);

    expect(outcome).toMatchObject({ kind: "refused", refusal: "unsupported_payment_state" });
    expect(harness.store.ledgers.size).toBe(0);
  });

  it("raises rather than settles when a simulator is not allowed to settle", async () => {
    const harness = createDeps({ noopSettlementForbidden: true });

    await expect(runChannelOrderIngest(harness.deps, wellFormed)).rejects.toBeInstanceOf(
      NoopChannelSettlementNotAllowedError,
    );
    expect(harness.store.ledgers.size).toBe(0);
  });

  it("records the attempt against the channel settlement kind and the far side's payment ref", async () => {
    const harness = createDeps();
    const recordAttempt = vi.fn(harness.deps.payments.recordAttempt);
    harness.deps.payments.recordAttempt = recordAttempt;

    await runChannelOrderIngest(harness.deps, wellFormed);

    expect(recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "channel_settlement",
        providerAttemptId: wellFormed.payment.externalPaymentRef,
      }),
    );
    expect(harness.events.get(`${wellFormed.payment.externalPaymentRef}:settlement`)).toBe(
      wellFormed.payment.externalPaymentRef,
    );
  });

  it("applies the result at the instant the buyer actually paid", async () => {
    const harness = createDeps();
    const applySucceeded = vi.fn(harness.deps.payments.applySucceeded);
    harness.deps.payments.applySucceeded = applySucceeded;

    await runChannelOrderIngest(harness.deps, wellFormed);

    expect(applySucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: wellFormed.payment.paidAt }),
    );
  });

  it("mints every idempotency key from the channel, the order and the step", () => {
    expect(channelIngestKey("ch-1", "EXT-9", "payment-intent")).toBe(
      "ch:ch-1:ord:EXT-9:payment-intent",
    );
  });
});
