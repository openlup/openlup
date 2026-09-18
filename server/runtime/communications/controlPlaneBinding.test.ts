import { describe, expect, it, vi } from "vitest";
import { resolveCommunicationsControlPlaneBinding } from "./controlPlaneBinding.js";

const OPERATOR = "9f576216-011a-4f67-8404-3f28f7f624d5";

describe("communications control-plane binding", () => {
  it("fails closed on missing bundle configuration", () => {
    expect(resolveCommunicationsControlPlaneBinding(
      { PLATFORM_BUNDLE: "node-postgres" }, { operatorId: OPERATOR },
    )).toEqual({ error: "database_url_required" });
    expect(resolveCommunicationsControlPlaneBinding({}, { operatorId: OPERATOR }))
      .toEqual({ error: "supabase_env_required" });
  });

  it("maps managed semantic routines without exposing a generic gateway", async () => {
    const rpc = vi.fn(async (name: string) => name === "communications_list_delivery_operations"
      ? { data: [], error: null }
      : name === "communications_delivery_health"
        ? { data: [{ attempted: 0, accepted: 0, failed: 0 }], error: null }
        : name === "communications_delivery_readiness"
          ? { data: [{ required_control_count: 0, disabled_control_keys: [] }], error: null }
          : { data: [], error: null });
    const resolved = resolveCommunicationsControlPlaneBinding({
      SUPABASE_URL: "https://managed.example",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    }, { operatorId: OPERATOR, managedClientFactory: () => ({ rpc }) });

    await expect(resolved.binding?.run((port) => port.getDeliveryOperations({ page: 0, pageSize: 10 })))
      .resolves.toMatchObject({ totalCount: 0, health: { attempted: 0 }, controls: [], templates: [] });
    expect(rpc).toHaveBeenCalledWith("communications_list_delivery_operations", {
      p_operator_id: OPERATOR, p_page: 0, p_page_size: 10,
    });
  });

  it("settles the managed first send across separate semantic RPC transactions", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "communications_prepare_delivery_command") {
        return { data: [{ action: "proceed", attempt_count: 1 }], error: null };
      }
      if (name === "communications_record_delivery_accepted") {
        return { data: [{
          idempotency_key: "managed-send-1", state: "accepted",
          delivery_reference: "managed:delivery-1", attempt_count: 1,
        }], error: null };
      }
      return { data: [], error: null };
    });
    const deliver = vi.fn(async () => ({ deliveryReference: "managed:delivery-1" }));
    const resolved = resolveCommunicationsControlPlaneBinding({
      SUPABASE_URL: "https://managed.example",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    }, {
      operatorId: OPERATOR,
      managedClientFactory: () => ({ rpc }),
      capturedFactory: () => ({ deliver }),
    });

    await expect(resolved.binding?.run((port) => port.sendEmail({
      recipientId: "managed-recipient", templateSlug: "managed-template",
      idempotencyKey: "managed-send-1",
    }))).resolves.toMatchObject({ message: { id: "managed:delivery-1" } });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "communications_prepare_delivery_command", "communications_record_delivery_accepted",
    ]);
    expect(deliver).toHaveBeenCalledOnce();
  });
});
