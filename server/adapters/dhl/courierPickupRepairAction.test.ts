/* eslint-disable @typescript-eslint/no-explicit-any -- fluent Supabase fake mirrors an untyped query boundary. */
import { describe, expect, it, vi } from "vitest";
import { createCarrierPickupRepairAction } from "./courierPickupRepairAction.js";
import { CARRIER_PERSISTENCE } from "./courierPickupStore.js";

const request = { accessToken: "admin-token", pickupId: "pickup-1", mode: "dry_run" as const, sendEmails: false, expectedCourierOrderId: "ORD-1", expectedShipmentCount: 1 };

describe("carrier pickup repair action", () => {
  it("returns a repair precondition result without an access token", async () => {
    const action = createCarrierPickupRepairAction({ client: {} as never });
    await expect(action({ ...request, accessToken: null })).resolves.toMatchObject({ success: false, error: "Brak tokenu autoryzacji" });
  });

  it("reads raw-response recovery and historical email status without offering a mutation", async () => {
    const fake = repairClient({ status: "indeterminate", raw: "<bookCourierResult><item>ORD-1</item></bookCourierResult>" });
    const action = createCarrierPickupRepairAction({ client: fake.client });
    await expect(action(request)).resolves.toMatchObject({ success: true, canCommit: false, courierOrderId: "ORD-1", emailDedupPreview: { sendEmails: false, alreadySentCount: 1, requestCount: 0 }, testerStatuses: [{ emailStatus: "sent", emailAlreadySent: true, willRequestEmail: false }] });
    expect(fake.testerUpdates).toHaveLength(0);
  });

  it.each([
    { mode: "commit" as const, sendEmails: false },
    { mode: "dry_run" as const, sendEmails: true },
  ])("rejects retired mutation %# before client IO", async (retired) => {
    const client = new Proxy({}, { get: () => { throw new Error("client IO forbidden"); } });
    await expect(createCarrierPickupRepairAction({ client: client as never })({
      ...request, ...retired,
    })).resolves.toEqual({
      success: false,
      error: "Standalone DHL repair mutation and email are retired",
      errorCode: "REPAIR_MUTATION_RETIRED",
    });
  });

  it("keeps an unresolved or inconsistent diagnosis non-committable", async () => {
    const rawMissing = createCarrierPickupRepairAction({ client: repairClient({ status: "indeterminate", raw: null }).client });
    await expect(rawMissing(request)).resolves.toMatchObject({ success: true, canCommit: false });
    const mismatch = createCarrierPickupRepairAction({ client: repairClient({ status: "succeeded", storedOrder: "OTHER", raw: null }).client });
    await expect(mismatch(request)).resolves.toMatchObject({ success: true, canCommit: false });
  });
});

function repairClient(options: { status: string; storedOrder?: string | null; raw: string | null }) {
  const testerUpdates: Record<string, unknown>[] = [];
  const pickup = { id: "pickup-1", status: options.status, courier_order_id: options.storedOrder ?? null, shipments_count: 1, raw_response_excerpt: options.raw };
  const shipment = {
    tester_id: "tester-1",
    tracking_number_snapshot: "TRK-1",
    [CARRIER_PERSISTENCE.shipmentDispatchIdSnapshot]: "SHIP-1",
    [CARRIER_PERSISTENCE.shipmentDateSnapshot]: "2026-08-17",
  };
  const tester = {
    id: "tester-1",
    status: "packing",
    tracking_number: "TRK-1",
    label_url: "label-1",
    [CARRIER_PERSISTENCE.shipmentDispatchId]: "SHIP-1",
    [CARRIER_PERSISTENCE.shipmentDate]: "2026-08-17",
  };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from(table: string) {
      let update: Record<string, unknown> | null = null;
      const query: any = {
        select: () => query,
        eq: () => table === "testers" && update ? (testerUpdates.push(update), Promise.resolve({ error: null })) : query,
        in: () => table === "testers" ? Promise.resolve({ data: [tester], error: null }) : query,
        maybeSingle: () => Promise.resolve({ data: table === "admin_users" ? { id: "admin-1" } : pickup, error: null }),
        update: (values: Record<string, unknown>) => { update = values; return query; },
      };
      if (table === CARRIER_PERSISTENCE.pickupShipmentTable) {
        query.eq = () => Promise.resolve({ data: [shipment], error: null });
      }
      if (table === "email_sends") { query.in = () => query; query.eq = () => Promise.resolve({ data: [{ tester_id: "tester-1", status: "sent" }], error: null }); }
      return query;
    },
  };
  return { client: client as never, testerUpdates };
}
