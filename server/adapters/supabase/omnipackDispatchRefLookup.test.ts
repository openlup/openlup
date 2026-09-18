import { describe, expect, it } from "vitest";
import {
  findOmnipackDispatchRef as findDispatchRef,
  type OmnipackDispatchRefLookupClient,
} from "./omnipackDispatchRefLookup.js";

describe("Supabase OmniPack dispatch ref lookup", () => {
  it("correlates the number this parcel was dispatched under, and scopes every provider lookup", async () => {
    const client = lookupClient({
      providerRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1", { orderNumber: "ORD-1", sequenceNo: 0 }),
    });

    await expect(findDispatchRef(client, {
      providerOrderId: "  provider-1  ",
      orderNumber: "  ORD-1  ",
    }, "webhook")).resolves.toEqual({
      dispatchRefId: "ref-1",
      fulfillmentOrderId: "fulfillment-1",
      orderId: "order-1",
      providerOrderId: "provider-1",
    });

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "omnipack_dispatch_refs",
      filters: expect.objectContaining({ provider_kind: "omnipack", provider_order_id: "provider-1" }),
    }));
    // Both identities are still trimmed - the order number now through the comparison rather than
    // through a lookup of its own, because a resolved provider id settles the order on its own and
    // the merchant read can no longer change the answer. It is therefore not made.
    expect(client.calls.some((call) => call.table === "commerce_orders")).toBe(false);
  });

  it("fails closed when provider and merchant evidence resolve to different orders", async () => {
    const client = lookupClient({
      providerRef: dispatchRef("ref-b", "fulfillment-b", "order-b", "provider-b", { orderNumber: "ORD-2", sequenceNo: 0 }),
    });

    await expect(findDispatchRef(client, {
      providerOrderId: "provider-b",
      orderNumber: "ORD-1",
    }, "reconciliation")).rejects.toThrow(
      "omnipack_reconciliation_dispatch_ref_correlation_conflict",
    );
  });

  it("fails closed when merchant evidence already belongs to another provider order", async () => {
    const client = lookupClient({
      order: { id: "order-1" },
      providerRef: null,
      merchantRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-existing", { orderNumber: "ORD-1", sequenceNo: 0 }),
    });

    await expect(findDispatchRef(client, {
      providerOrderId: "provider-incoming",
      orderNumber: "  ORD-1  ",
    }, "webhook")).rejects.toThrow("omnipack_webhook_dispatch_ref_correlation_conflict");

    // The merchant read is scoped and trimmed, and picks its single ref deterministically once an
    // order may hold more than one - the same selection `omnipack_dispatch_begin` makes.
    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "commerce_orders",
      filters: { order_number: "ORD-1" },
    }));
    expect(client.calls.find((call) => call.table === "omnipack_dispatch_refs" && call.filters.order_id)).toMatchObject({
      orders: [["created_at", { ascending: false }], ["id", { ascending: false }]],
      limit: 1,
    });
  });

  it("correlates by order, so a second parcel of the same order is not a conflict", async () => {
    // Two parcels of one order, and the evidence is about the original: it carries that parcel's
    // provider id and the order's own number, which is the number the original was dispatched
    // under. The order's newest ref belongs to the replacement, and that is not a disagreement.
    const replaced = lookupClient({
      order: { id: "order-1" },
      providerRef: dispatchRef("ref-0", "fulfillment-0", "order-1", "provider-0", { orderNumber: "ORD-1", sequenceNo: 0 }),
      merchantRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1", { orderNumber: "ORD-1", sequenceNo: 1 }),
    });
    await expect(findDispatchRef(replaced, {
      providerOrderId: "provider-0",
      orderNumber: "ORD-1",
    }, "webhook")).resolves.toEqual({
      dispatchRefId: "ref-0",
      fulfillmentOrderId: "fulfillment-0",
      orderId: "order-1",
      providerOrderId: "provider-0",
    });
  });

  // ⛔ Was a CHARACTERIZATION OF A DEFECT and is now the proof it is gone. R2b made the number we
  // send a function of the parcel, so a replacement dispatches under a suffixed number and the
  // provider echoes that back. `commerce_orders.order_number` is matched exactly, so the suffixed
  // number resolved to no order, and a null merchant match was read as "the two identities
  // disagree" - failing closed on evidence about a parcel we ourselves numbered.
  //
  // D-R7 settles it by computing what this parcel would have been given instead of looking the
  // number up: the provider id resolves to one ref, the ref to one parcel with one ordinal, and
  // the mapper's own function turns those into the number the evidence must carry. Nothing is
  // parsed and no suffix is stripped, so the foreign key remains the only linkage truth.
  it("correlates evidence for a parcel we numbered ourselves - the R2c/R5 blocker, resolved", async () => {
    const client = lookupClient({
      order: null, // no order is numbered `ORD-1-R1`; only its parcel was
      providerRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1", { orderNumber: "ORD-1", sequenceNo: 1 }),
      merchantRef: null,
    });

    await expect(findDispatchRef(client, {
      providerOrderId: "provider-1",
      orderNumber: "ORD-1-R1",
    }, "webhook")).resolves.toEqual({
      dispatchRefId: "ref-1",
      fulfillmentOrderId: "fulfillment-1",
      orderId: "order-1",
      providerOrderId: "provider-1",
    });
    // Resolved without asking `commerce_orders` for a number it does not hold.
    expect(client.calls.some((call) => call.table === "commerce_orders")).toBe(false);
  });

  // The tightening, and the reason D-R7 is not a relaxation of a fail-closed check. Both halves
  // reach the same order as the ref, so the comparison this replaced let both of them through.
  it("fails closed on a number this parcel could never have been given", async () => {
    // A replacement's number against the original's parcel.
    const original = lookupClient({
      order: null,
      providerRef: dispatchRef("ref-0", "fulfillment-0", "order-1", "provider-0", { orderNumber: "ORD-1", sequenceNo: 0 }),
    });
    await expect(findDispatchRef(original, {
      providerOrderId: "provider-0",
      orderNumber: "ORD-1-R1",
      // Matched on the source-independent tail; the sibling cases above pin the full name.
    }, "webhook")).rejects.toThrow("_webhook_dispatch_ref_correlation_conflict");

    // …and the order's own number against a replacement parcel, which is the half that used to
    // resolve: the number named the right order, so nothing looked wrong about it.
    const replacement = lookupClient({
      order: { id: "order-1" },
      providerRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1", { orderNumber: "ORD-1", sequenceNo: 1 }),
      merchantRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1", { orderNumber: "ORD-1", sequenceNo: 1 }),
    });
    await expect(findDispatchRef(replacement, {
      providerOrderId: "provider-1",
      orderNumber: "ORD-1",
    }, "reconciliation")).rejects.toThrow("_reconciliation_dispatch_ref_correlation_conflict");
  });

  it("fails closed when the ref resolves no parcel to compute a number for", async () => {
    // Nothing to expect is not permission to accept: an unresolvable parcel fails closed, the
    // same answer the merchant lookup gave when it resolved to nothing.
    const noParcel = lookupClient({
      providerRef: dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1"),
    });
    await expect(findDispatchRef(noParcel, {
      providerOrderId: "provider-1",
      orderNumber: "ORD-1",
    }, "webhook")).rejects.toThrow("_webhook_dispatch_ref_correlation_conflict");

    // An ordinal we cannot read is not an ordinal of 0. Reading it as one would mint the
    // original's number for a parcel that may be a replacement, and accept the wrong evidence.
    const noOrdinal = lookupClient({
      providerRef: {
        ...dispatchRef("ref-1", "fulfillment-1", "order-1", "provider-1"),
        commerce_fulfillment_orders: {},
        commerce_orders: { order_number: "ORD-1" },
      },
    });
    await expect(findDispatchRef(noOrdinal, {
      providerOrderId: "provider-1",
      orderNumber: "ORD-1",
    }, "webhook")).rejects.toThrow("_webhook_dispatch_ref_correlation_conflict");

    // Evidence that names no number at all contradicts nothing, so the provider identity still
    // settles it alone. Fail-closed answers a disagreement, not silence.
    await expect(findDispatchRef(noParcel, { providerOrderId: "provider-1" }, "webhook"))
      .resolves.toMatchObject({ dispatchRefId: "ref-1" });
  });

  it("returns null for incomplete rows and preserves source-specific database errors", async () => {
    const incomplete = lookupClient({
      order: null,
      providerRef: { id: "ref-1", fulfillment_order_id: "", order_id: "order-1" },
      merchantRef: null,
    });
    await expect(findDispatchRef(incomplete, {
      providerOrderId: "provider-1",
      orderNumber: "ORD-NOT-FOUND",
    }, "webhook")).resolves.toBeNull();

    const failed = lookupClient({ providerError: { code: "DB_DOWN" } });
    await expect(findDispatchRef(failed, {
      providerOrderId: "provider-1",
    }, "reconciliation")).rejects.toThrow(
      "omnipack_reconciliation_dispatch_ref_read_failed:DB_DOWN",
    );
  });
});

interface LookupFixture {
  order?: unknown;
  providerRef?: unknown;
  merchantRef?: unknown;
  providerError?: { code?: string } | null;
}

// `parcel` is the pair the ref's own read embeds: the parcel's ordinal and its order's number.
// Omitting it is a ref whose parcel did not resolve, which is a case of its own.
function dispatchRef(
  id: string,
  fulfillmentOrderId: string,
  orderId: string,
  providerOrderId: string | null,
  parcel?: { orderNumber: string; sequenceNo: number },
) {
  return {
    id,
    fulfillment_order_id: fulfillmentOrderId,
    order_id: orderId,
    provider_order_id: providerOrderId,
    ...(parcel
      ? {
        commerce_fulfillment_orders: { sequence_no: parcel.sequenceNo },
        commerce_orders: { order_number: parcel.orderNumber },
      }
      : {}),
  };
}

function lookupClient(fixture: LookupFixture = {}) {
  type LookupCall = { table: string; filters: Record<string, unknown>; orders: unknown[][]; limit?: number };
  const calls: LookupCall[] = [];
  const client = {
    calls,
    from(table: string) {
      const call: LookupCall = { table, filters: {}, orders: [] };
      calls.push(call);
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) {
          call.filters[column] = value;
          return query;
        },
        // Recorded in sequence: the tie-break only means anything as the *second* key.
        order(...args: unknown[]) {
          call.orders.push(args);
          return query;
        },
        limit(count: number) {
          call.limit = count;
          return query;
        },
        async maybeSingle() {
          if (table === "commerce_orders") return { data: fixture.order ?? null, error: null };
          if (call.filters.provider_order_id) {
            return { data: fixture.providerRef ?? null, error: fixture.providerError ?? null };
          }
          return { data: fixture.merchantRef ?? null, error: null };
        },
        then(resolve: (value: unknown) => void) {
          resolve({ data: null, error: null });
        },
      };
      return query;
    },
  };
  return client as typeof client & OmnipackDispatchRefLookupClient;
}
