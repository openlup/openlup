import { describe, expect, it, vi } from "vitest";
import {
  createManagedSubscriptionRenewalDuePort,
} from "./subscriptionRenewalDuePort.js";

function harness(response: {
  data: unknown;
  error: { code?: string; message?: string } | null;
}) {
  const rpc = vi.fn(async () => response);
  return { rpc, port: createManagedSubscriptionRenewalDuePort({ rpc }) };
}

describe("createManagedSubscriptionRenewalDuePort", () => {
  it("lists due subscriptions through the renewal RPC", async () => {
    const { rpc, port } = harness({
      data: [
        {
          subscription_id: "sub-1",
          client_id: "client-1",
          next_cycle_at: "2026-07-20T08:00:00.000Z",
          currency: "XTS",
          provider_kind: null,
          provider_customer_ref: "cus_1",
          provider_method_ref: "pm_1",
          method_kind: "card",
          payer_email: "anna@example.com",
          payer_name: "Anna",
          method_status: "active",
          method_active: true,
          method_expires_at: "2026-08-01T00:00:00.000Z",
          method_client_id: "client-1",
        },
      ],
      error: null,
    });

    await expect(port.listDue(50)).resolves.toEqual([
      {
        subscriptionId: "sub-1",
        clientId: "client-1",
        nextCycleAt: "2026-07-20T08:00:00.000Z",
        currency: "XTS",
        providerKind: "",
        providerCustomerRef: "cus_1",
        providerMethodRef: "pm_1",
        methodKind: "card",
        payerEmail: "anna@example.com",
        payerName: "Anna",
        methodStatus: "active",
        methodActive: true,
        methodExpiresAt: "2026-08-01T00:00:00.000Z",
        methodClientId: "client-1",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("subscription_list_due_for_renewal", { p_limit: 50 });
  });

  it("passes an explicit as-of instant only when requested", async () => {
    const { rpc, port } = harness({ data: [], error: null });
    const asOf = new Date("2026-07-29T12:00:00.000Z");
    await expect(port.listDue(50, asOf)).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledWith("subscription_list_due_for_renewal", {
      p_limit: 50,
      p_as_of: "2026-07-29T12:00:00.000Z",
    });
  });

  it("fails with an RPC-scoped reason when the renewal RPC errors", async () => {
    const { port } = harness({
      data: null,
      error: { code: "XX000", message: "boom" },
    });

    await expect(port.listDue(10)).rejects.toThrow(
      "rpc_list_due: boom",
    );
  });
});
