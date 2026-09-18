import { describe, expect, it } from "vitest";
import {
  createSupabaseShipmentsOverviewPort,
  type ShipmentsOverviewSupabaseClient,
} from "./shipmentsOverviewPort.js";

describe("createSupabaseShipmentsOverviewPort", () => {
  it("preserves the four characterized tester projections and shipped fallback", async () => {
    const { client, calls } = fakeClient({
      approved: [{
        id: "approved-1", first_name: "Ada", last_name: "A", city: "Warsaw",
        postal_code: "00-001", dog_weight_kg: 12, cat_weight_kg: null, pet_type: "dog",
      }],
      packing: [{
        id: "packing-1", first_name: "Bob", last_name: "B", email: "b@example.test",
        phone: null, street: "Main", city: "Warsaw", postal_code: "00-002",
        tracking_number: null, label_url: null, dhl_shipment_id: null, dhl_shipment_date: null,
      }],
      shipped: [{
        id: "shipped-1", first_name: "Cy", last_name: "C", city: "Gdansk", status: null,
        status_updated_at: "2026-08-13T08:00:00.000Z", delivered_at: null,
        tracking_number: "TRACK-1", tracking_url: "https://tracking.example/1",
      }],
      shippedToday: 3,
    });

    await expect(createSupabaseShipmentsOverviewPort(client).getShipmentsOverview({ shippedFilter: "all" }))
      .resolves.toEqual({
        approved: [expect.objectContaining({ id: "approved-1" })],
        packing: [expect.objectContaining({ id: "packing-1" })],
        shippedToday: 3,
        shipped: [expect.objectContaining({ id: "shipped-1", status: "shipped" })],
      });

    expect(calls.map(({ select }) => select)).toEqual(expect.arrayContaining([
      "id, first_name, last_name, city, postal_code, dog_weight_kg, cat_weight_kg, pet_type",
      "id, first_name, last_name, email, phone, street, city, postal_code, tracking_number, label_url, dhl_shipment_id, dhl_shipment_date",
      "*",
      "id, first_name, last_name, city, status, status_updated_at, delivered_at, tracking_number, tracking_url",
    ]));
    expect(calls.find(({ select }) => select.includes("status_updated_at, delivered_at"))?.inValues)
      .toEqual(["shipped", "in_transit", "delivered", "feedback_mid", "feedback_final", "feedback_reminder", "completed"]);
  });

  it("fails the whole overview when any characterized query fails", async () => {
    const { client } = fakeClient({ approved: [], packing: [], shipped: [], shippedToday: 0, failStatus: "packing" });
    await expect(createSupabaseShipmentsOverviewPort(client).getShipmentsOverview({ shippedFilter: "7d" }))
      .rejects.toEqual({ message: "packing_failed" });
  });
});

function fakeClient(options: {
  approved: unknown[];
  packing: unknown[];
  shipped: unknown[];
  shippedToday: number;
  failStatus?: string;
}) {
  const calls: Array<{ select: string; status: string | null; inValues: readonly string[] | null; gte: unknown | null }> = [];
  const client = {
    from() {
      let select = "";
      let status: string | null = null;
      let inValues: readonly string[] | null = null;
      let gte: unknown | null = null;
      let head = false;
      const builder = {
        select(columns: string, selectOptions?: { count?: "exact"; head?: boolean }) {
          select = columns;
          head = selectOptions?.head === true;
          return builder;
        },
        in(_column: string, values: readonly string[]) { inValues = values; return builder; },
        order() { return builder; },
        eq(_column: string, value: unknown) { status = String(value); return builder; },
        gte(_column: string, value: unknown) { gte = value; return builder; },
        then(resolve: (value: { data: unknown[] | null; error: { message: string } | null; count?: number }) => unknown) {
          calls.push({ select, status, inValues, gte });
          const key = head ? "shippedToday" : status === "approved" ? "approved" : status === "packing" ? "packing" : "shipped";
          const error = options.failStatus === status ? { message: `${status}_failed` } : null;
          const data = head ? null : options[key as "approved" | "packing" | "shipped"];
          return Promise.resolve({ data, error, ...(head ? { count: options.shippedToday } : {}) }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as ShipmentsOverviewSupabaseClient, calls };
}
