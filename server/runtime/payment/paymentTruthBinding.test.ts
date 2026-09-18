import { describe, expect, it, vi } from "vitest";
import { resolvePaymentTruthBinding } from "./paymentTruthBinding.js";

describe("payment truth production binding", () => {
  it("is absent outside the direct bundle and without DATABASE_URL", () => {
    expect(resolvePaymentTruthBinding({ PLATFORM_BUNDLE: "supabase" })).toBeNull();
    expect(resolvePaymentTruthBinding({ PLATFORM_BUNDLE: "node-postgres" })).toBeNull();
  });

  it("opens the direct port for one runtime unit and always closes the pool", async () => {
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: [{ response: { claimed: 0, settledIgnored: 0, eventIds: [] } }] }));
    const binding = resolvePaymentTruthBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgresql://local/payment_truth",
    }, { createPool: () => ({ query, end }) });

    await expect(binding?.run((port) => port.sweepOpenEvents({
      now: "2026-08-15T13:00:00.000Z", limit: 5,
    }))).resolves.toEqual({ claimed: 0, settledIgnored: 0, eventIds: [] });
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the pool after an operation failure", async () => {
    const end = vi.fn(async () => undefined);
    const binding = resolvePaymentTruthBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgresql://local/payment_truth",
    }, { createPool: () => ({ query: vi.fn(async () => { throw new Error("db_down"); }), end }) });
    await expect(binding?.run((port) => port.readEvent("11111111-1111-4111-8111-111111111111")))
      .rejects.toThrow("db_down");
    expect(end).toHaveBeenCalledOnce();
  });
});
