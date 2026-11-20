import { describe, expect, it, vi } from "vitest";
import { createPostgresNativeCheckoutSubscriptionPort } from "../../src/subscriptions/postgresNativeCheckoutSubscriptionPort.js";

describe("createPostgresNativeCheckoutSubscriptionPort", () => {
  it("delegates provisional activation and subscription checkout reads cleanly", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("subscription_activations")) return { rows: [{ cadence_days: 30 }] };
      if (sql.includes("pending_activation")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("template_version")) return { rows: [{ template_version: 4 }] };
      if (sql.includes("subscription_command_receipts")) return { rows: [{ version: "3" }] };
      return { rows: [] };
    });

    const port = createPostgresNativeCheckoutSubscriptionPort({ query });
    await port.declareProvisionalActivation({
      idempotencyKey: "k:declare",
      orderId: "00000000-0000-4000-8000-000000000101",
      cadenceDays: 30,
      now: "2026-11-20T00:00:00.000Z",
    });
    expect(await port.readActivationCadenceDays("00000000-0000-4000-8000-000000000101")).toBe(30);
    expect(await port.clientHasLiveOrPendingSubscription("00000000-0000-4000-8000-000000000202")).toBe(true);
    expect(await port.readTemplateVersion({ subscriptionId: "sub-1", clientId: "client-1" })).toBe(4);
    expect(await port.readCommandReceiptExpectedVersion({ actorId: "actor-1", idempotencyKey: "k:addr" })).toBe(3);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("returns null / false when no rows exist", async () => {
    const port = createPostgresNativeCheckoutSubscriptionPort({ query: vi.fn(async () => ({ rows: [] })) });
    expect(await port.readActivationCadenceDays("00000000-0000-4000-8000-000000000101")).toBeNull();
    expect(await port.clientHasLiveOrPendingSubscription("00000000-0000-4000-8000-000000000202")).toBe(false);
    expect(await port.readTemplateVersion({ subscriptionId: "sub-1", clientId: "client-1" })).toBeNull();
    expect(await port.readCommandReceiptExpectedVersion({ actorId: "actor-1", idempotencyKey: "k:addr" })).toBeNull();
  });
});
