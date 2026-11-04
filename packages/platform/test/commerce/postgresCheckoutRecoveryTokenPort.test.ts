import { describe, expect, it } from "vitest";
import {
  createPostgresCheckoutRecoveryTokenPort,
} from "../../src/commerce/server/postgresCheckoutRecoveryTokenPort.js";
import { hashCheckoutRecoveryToken, classifyCheckoutRecoveryTokenState } from "../../src/commerce/server/checkoutRecoveryToken.js";

const base = { tokenId: "token-id", orderId: "order-id", clientId: "client-id", mode: "one_time_order",
  status: "pending_payment", subscriptionId: null, tokenState: "active" };
function fixture(value: unknown, extra: Record<string, unknown> = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const port = createPostgresCheckoutRecoveryTokenPort({ run: async work => work({
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: sql.includes("pg_has_role") ? [{ allowed: true }] : [{ value, ...extra }] };
    },
  }) });
  return { port, calls };
}

describe("PostgreSQL recovery state translation", () => {
  it.each([
    ["active", "active", "pending_payment", true, "continuation"],
    ["active", "active", "paid", false, "continuation"],
    ["revoked", "revoked", "paid", false, "refused"],
    ["expired", "expired", "paid", false, "expired_policy"],
    ["consumed", "order_not_recoverable", "paid", false, "continuation"],
    ["future_state", "unknown", "pending_payment", false, "refused"],
    ["used", "unknown", "pending_payment", false, "refused"],
    ["order_not_found", "unknown", "pending_payment", false, "refused"],
    ["order_not_recoverable", "unknown", "pending_payment", false, "refused"],
  ])("maps %s/%s on %s without widening payment authority", async (state, expected, status, payable, classification) => {
    const { port, calls } = fixture({ ...base, tokenState: state, status });
    const at = new Date("2026-01-01T00:00:00Z");
    expect((await port.inspect("opaque-input", at))?.tokenState).toBe(expected);
    expect(classifyCheckoutRecoveryTokenState(expected as string)).toBe(classification);
    expect(Boolean(await port.validate("opaque-input", at))).toBe(payable);
    const reads = calls.filter(call => call.sql.includes("customer_checkout_recovery_token_inspect"));
    expect(reads).toHaveLength(2);
    expect(reads.every(call => JSON.stringify(call.values) === JSON.stringify([hashCheckoutRecoveryToken("opaque-input"), at.toISOString()]))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("opaque-input");
  });

  it("keeps inspection scoped and refuses missing or contradictory subscription facts", async () => {
    expect(await fixture(null).port.inspect("missing")).toBeNull();
    for (const extra of [
      { draft_context: { mode: "subscription" } },
      { draft_context: { mode: "subscription", cadenceDays: 35 }, activation_cadence: 28 },
      { draft_context: { mode: "one_time" }, quote_context: { mode: "subscription", cadenceDays: 35 } },
      { draft_context: { mode: "unexpected" } },
    ]) await expect(fixture(base, extra).port.inspect("opaque-input")).rejects.toThrow("checkout_recovery_response_invalid");
    expect(await fixture(base, { activation_cadence: 35 }).port.inspect("opaque-input")).toMatchObject({ mode: "subscription_cycle", cadenceDays: 35 });
    expect(await fixture({ ...base, mode: "subscription_cycle" }, { quote_context: { mode: "subscription", cadenceDays: 35 } }).port.inspect("opaque-input"))
      .toMatchObject({ mode: "subscription_cycle", cadenceDays: 35 });
    await expect(fixture({ ...base, mode: "future" }).port.inspect("opaque-input")).rejects.toThrow("checkout_recovery_response_invalid");
  });

  it("redacts infrastructure and commit failures without causes or raw credentials", async () => {
    const raw = "sensitive-opaque-input";
    const port = createPostgresCheckoutRecoveryTokenPort({ run: async () => {
      throw Object.assign(new Error(`query detail ${raw}`), { detail: raw, cause: raw });
    } });
    for (const operation of [() => port.inspect(raw), () => port.validate(raw),
      () => port.issue({ orderId: "invalid", rawToken: raw, expiresAt: "invalid" })]) {
      const error = await operation().catch(value => value as Error);
      expect(error).toEqual(new Error("checkout_recovery_storage_failed"));
      expect(JSON.stringify(error)).not.toContain(raw);
      expect(String(error)).not.toContain(raw);
      expect(error).not.toHaveProperty("cause");
    }
  });
});
