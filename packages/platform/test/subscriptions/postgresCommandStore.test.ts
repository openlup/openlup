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

describe("direct apply SAVEPOINT preview guard", () => {
  function applyFixture(previewStatus: "noop" | "refused" = "refused") {
    const executedSql: string[] = [];
    const query = vi.fn<SubscriptionQueryExecutor["query"]>(async sql => {
      executedSql.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("WITH stored")) return { rows: [] };
      if (sql.startsWith("SAVEPOINT") || sql.startsWith("ROLLBACK TO SAVEPOINT") || sql.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
      if (sql.includes("subscription_command_preview(")) {
        return { rows: [{ response: previewStatus === "noop"
          ? { status: "noop", subscriptionId: id, subscriptionStatus: "active", templateVersion: 1, nextCycleAt: null, eventId: null }
          : { status: "refused", reason: "subscription_command_preview_unsupported" } }] };
      }
      if (sql.includes("subscription_command_apply(")) {
        return { rows: [{ response: { status: "applied", subscriptionId: id, subscriptionStatus: "active", templateVersion: 1, nextCycleAt: null, eventId: null } }] };
      }
      if (sql.includes("SELECT command_fingerprint FROM public.subscription_command_receipts")) {
        return { rows: [{ command_fingerprint: "fp-1" }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const binding = {
      withTransaction: async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => work({ query }),
      futureTerms: vi.fn(async () => ({ coreLines: [{ variantId: id, qty: 1 }], addonLines: [], compositionConstraint: {} })),
    };
    return {
      executedSql,
      store: createPostgresSubscriptionCommandStore(binding),
      commands: createPostgresSubscriptionCommands(binding),
    };
  }

  it.each(["pause", "resume", "cancel", "skip_next_cycle", "order_now", "reactivate"])(
    "skips SAVEPOINT and preview probe on direct apply for %s",
    async action => {
      const f = applyFixture();
      const result = await f.store.apply({
        actorId: id, clientId: id, subscriptionId: id, idempotencyKey: `lifecycle-${action}-key`,
        now: "1999-01-01T00:00:00Z", action, payload: {},
      });
      expect(result).toMatchObject({ status: "applied", commandFingerprint: "fp-1" });
      expect(f.executedSql.some(sql => sql.includes("SAVEPOINT"))).toBe(false);
      expect(f.executedSql.some(sql => sql.includes("subscription_command_preview("))).toBe(false);
      expect(f.executedSql.some(sql => sql.includes("subscription_command_apply("))).toBe(true);
    },
  );

  it.each([
    "slide_next_cycle", "update_bundle", "resize_bundle", "update_package_template",
    "update_plan_length", "add_addon", "remove_addon", "update_addon_quantity",
  ])(
    "retains SAVEPOINT noop probe on direct apply without acceptedQuoteHash for %s",
    async action => {
      const fNoop = applyFixture("noop");
      const noopResult = await fNoop.store.apply({
        actorId: id, clientId: id, subscriptionId: id, idempotencyKey: `noop-${action}-key`,
        now: "1999-01-01T00:00:00Z", action, payload: {},
      });
      expect(noopResult).toMatchObject({ status: "noop", commandFingerprint: "fp-1" });
      expect(fNoop.executedSql.some(sql => sql.startsWith("SAVEPOINT"))).toBe(true);
      expect(fNoop.executedSql.some(sql => sql.includes("subscription_command_preview("))).toBe(true);
      expect(fNoop.executedSql.some(sql => sql.includes("subscription_command_apply("))).toBe(false);

      const fApply = applyFixture("refused");
      const applyResult = await fApply.store.apply({
        actorId: id, clientId: id, subscriptionId: id, idempotencyKey: `apply-${action}-key`,
        now: "1999-01-01T00:00:00Z", action, payload: {},
      });
      expect(applyResult).toMatchObject({ status: "applied", commandFingerprint: "fp-1" });
      expect(fApply.executedSql.some(sql => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
      expect(fApply.executedSql.some(sql => sql.includes("subscription_command_apply("))).toBe(true);
    },
  );

  it("skips SAVEPOINT for typed skip command while keeping it for typed slide command", async () => {
    const actor = { kind: "customer" as const, actorId: id, clientId: id };
    const skipFixture = applyFixture();
    await expect(skipFixture.commands.apply({
      actor, subscriptionId: id, idempotencyKey: "typed-skip-key", now: "1999-01-01T00:00:00Z", action: "skip",
    })).resolves.toMatchObject({ outcome: "applied" });
    expect(skipFixture.executedSql.some(sql => sql.includes("SAVEPOINT"))).toBe(false);

    const slideFixture = applyFixture("noop");
    await expect(slideFixture.commands.apply({
      actor, subscriptionId: id, idempotencyKey: "typed-slide-key", now: "1999-01-01T00:00:00Z", action: "slide",
      newNextCycleAt: "1999-01-15T00:00:00Z",
    })).resolves.toMatchObject({ outcome: "noop" });
    expect(slideFixture.executedSql.some(sql => sql.startsWith("SAVEPOINT"))).toBe(true);
  });

  it("skips SAVEPOINT on direct apply for unknown actions and delegates directly to subscription_command_apply", async () => {
    const f = applyFixture();
    await expect(f.store.apply({
      actorId: id, clientId: id, subscriptionId: id, idempotencyKey: "unknown-action-key",
      now: "1999-01-01T00:00:00Z", action: "unknown_action", payload: {},
    })).resolves.toMatchObject({ status: "applied" });
    expect(f.executedSql.some(sql => sql.includes("SAVEPOINT"))).toBe(false);
    expect(f.executedSql.some(sql => sql.includes("subscription_command_apply("))).toBe(true);
  });
});
