import { describe, expect, it, vi } from "vitest";
import { createPostgresSubscriptionCommands, createPostgresSubscriptionCommandStore } from "../../src/subscriptions/postgresCommandStore.js";
import type { SubscriptionCommand } from "../../src/subscriptions/contracts/commands.js";
import type { SubscriptionQueryExecutor } from "../../src/subscriptions/postgresRenewalStore.js";

const id = "11111111-1111-4111-8111-111111111111";
function fixture(response?: Record<string, unknown>) {
  const query = vi.fn<SubscriptionQueryExecutor["query"]>(async sql => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("WITH stored")) return { rows: response ? [{ response }] : [] };
    if (sql.includes("subscription_command_preview(")) return { rows: [{ response: { status: "previewed", quoteHash: "retained" } }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const futureTerms = vi.fn(async () => ({ coreLines: [{ variantId: id, qty: 1 }], addonLines: [], compositionConstraint: {} }));
  const binding = { withTransaction: async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => work({ query }), futureTerms };
  const command: Extract<SubscriptionCommand, { action: "edit_future_terms" }> = {
    actor: { kind: "customer", actorId: id, clientId: id }, subscriptionId: id, idempotencyKey: "future-terms-key", now: "1999-01-01T00:00:00Z",
    action: "edit_future_terms", shippingAddressId: id, planDays: 21, cadenceDays: 21, expectedTemplateVersion: 1,
    acceptedQuoteHash: "", confirmedChargeTiming: true, coreLines: [{ sku: "ITEM-A", quantity: 1 }], addonLines: [], compositionConstraint: "host-constraint",
  };
  return { query, futureTerms, command, commands: createPostgresSubscriptionCommands(binding), store: createPostgresSubscriptionCommandStore(binding) };
}
describe("native future-terms cadence admission", () => {
  it.each(["cadenceDays", "planDays"] as const)("refuses fresh out-of-range %s before host translation or SQL dispatch", async field => {
    for (const days of [0, 3661]) for (const operation of ["preview", "apply"] as const) {
      const f = fixture(); f.command[field] = days;
      await expect(f.commands[operation](f.command)).resolves.toMatchObject({ reason: "subscription_command_invalid_input" });
      expect(f.futureTerms).not.toHaveBeenCalled(); expect(f.query).toHaveBeenCalledTimes(2);
      expect(f.query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
      expect(f.query.mock.calls[1][0]).toContain("WITH stored");
    }
  });
  it.each([1, 3660])("admits a fresh %i-day preview through translation and native dispatch", async days => {
    const f = fixture(); f.command.cadenceDays = days; f.command.planDays = days;
    await expect(f.commands.preview(f.command)).resolves.toMatchObject({ status: "previewed" });
    expect(f.futureTerms).toHaveBeenCalledOnce(); expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls[2][0]).toContain("subscription_command_preview(");
  });
  it("replays a completed 3661-day preview receipt before current admission", async () => {
    const saved = { status: "previewed", quoteHash: "original", cadenceDays: 3661 };
    const f = fixture(saved); f.command.cadenceDays = 3661; f.command.planDays = 3661;
    await expect(f.commands.preview(f.command)).resolves.toEqual(saved);
    expect(f.futureTerms).not.toHaveBeenCalled(); expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(["replayed", "refused"])("preserves an authenticated %s response before current limits", async status => {
    const response = { status, reason: "subscription_command_idempotency_conflict", commandFingerprint: "retained", subscriptionId: id,
      subscriptionStatus: "active", templateVersion: 1, nextCycleAt: null, eventId: null };
    const f = fixture(response); f.command.cadenceDays = 3661; f.command.planDays = 3661;
    const result = await f.commands.apply(f.command);
    expect(result).toMatchObject(status === "refused" ? { outcome: "refused", reason: response.reason } : { outcome: "replayed", commandFingerprint: "retained" });
    expect(f.futureTerms).not.toHaveBeenCalled(); expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(["update_package_template", "update_bundle", "resize_bundle", "update_plan_length"])("also fences a fresh direct native %s preview before dispatch", async action => {
    const f = fixture();
    await expect(f.store.preview({ actorId: id, clientId: id, subscriptionId: id, idempotencyKey: "direct-terms-key", now: f.command.now,
      action, payload: { cadenceDays: 3661, planDays: 21 } })).resolves.toMatchObject({ status: "refused", reason: "subscription_command_invalid_input" });
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("preserves native optional cadence carriers when only planDays is supplied", async () => {
    const f = fixture();
    await expect(f.store.preview({ actorId: id, clientId: id, subscriptionId: id, idempotencyKey: "direct-terms-key", now: f.command.now,
      action: "update_package_template", payload: { planDays: 21 } })).resolves.toMatchObject({ status: "previewed" });
    expect(f.query).toHaveBeenCalledTimes(3);
  });
});
