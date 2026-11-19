import { describe, expect, it } from "vitest";
import { createPostgresFulfillmentDispatchComposition } from "../../src/fulfillment/native/dispatchComposition.js";
import type { PgExecutor } from "../../src/fulfillment/postgresDispatchStore.js";

function candidateRow(id: string) {
  return {
    requestKey: `req:${id}`,
    fulfillmentRef: id,
    orderRef: `ord:${id}`,
    orderNumber: `ORD-${id}`,
    parcelRef: `parcel:${id}`,
    lines: [],
    contact: {
      schemaVersion: 1,
      source: "checkout",
      revision: 1,
      recipient: {
        name: "Example Recipient",
        email: "recipient@example.test",
        phone: "+12025550123",
        line1: "123 Example Street",
        line2: null,
        city: "Example City",
        postalCode: "10001",
        country: "US",
        deliveryInstructions: null,
        courierInstructions: null,
      },
      selection: {
        providerRef: "warehouse-a",
        carrierRef: "carrier-a",
        serviceRef: "service-a",
        deliveryKind: "courier",
        pickupPoint: null,
      },
    },
  };
}

describe("createPostgresFulfillmentDispatchComposition batch listCandidates", () => {
  it("hydrates N candidates in 2 queries using unnest WITH ORDINALITY", async () => {
    const queries: string[] = [];
    const db: PgExecutor = {
      async query(text) {
        queries.push(text);
        if (text.includes("fulfillment_native_dispatch_candidate_ids")) {
          return { rows: [{ shipment_id: "s-1" }, { shipment_id: "s-2" }, { shipment_id: "s-3" }] };
        }
        if (text.includes("FROM unnest")) {
          return {
            rows: [
              { shipment_id: "s-1", response: candidateRow("s-1") },
              { shipment_id: "s-2", response: null },
              { shipment_id: "s-3", response: candidateRow("s-3") },
            ],
          };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const comp = createPostgresFulfillmentDispatchComposition(db, { portKey: "warehouse", providerRef: "warehouse-a" });
    const list = await comp.listCandidates(10);
    expect(list.map((c) => c.fulfillmentRef)).toEqual(["s-1", "s-3"]);
    expect(queries).toHaveLength(2);
  });

  it("falls back to per-row isolation when batch read hits SQLSTATE 22023", async () => {
    const db: PgExecutor = {
      async query(text, values) {
        if (text.includes("fulfillment_native_dispatch_candidate_ids")) {
          return { rows: [{ shipment_id: "s-bad" }, { shipment_id: "s-ok" }] };
        }
        if (text.includes("FROM unnest")) {
          throw Object.assign(new Error("row refused"), { code: "22023" });
        }
        if (text.includes("fulfillment_native_dispatch_read_candidate")) {
          if (values?.[0] === "s-bad") throw Object.assign(new Error("row refused"), { code: "22023" });
          return { rows: [{ response: candidateRow("s-ok") }] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const comp = createPostgresFulfillmentDispatchComposition(db, { portKey: "warehouse", providerRef: "warehouse-a" });
    const list = await comp.listCandidates(10);
    expect(list.map((c) => c.fulfillmentRef)).toEqual(["s-ok"]);
  });
});
