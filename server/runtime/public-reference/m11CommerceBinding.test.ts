import { expect, it, vi } from "vitest";
import type { ReadinessReport } from "@openlup/core/readiness";
import { createOrderReviewHandlers, createCheckoutCompensationRpcAdapter } from "@openlup/platform/commerce/server";
import { createM11CommerceReferenceBinding } from "./m11CommerceBinding.js";

function report(state: ReadinessReport["state"]): ReadinessReport {
  return { state, candidate: { artifact: "fixture", configuration: "fixture", environment: "disposable", database: "fixture", schema: "complete" }, loadedPackages: [], issues: [] };
}
function options(state: ReadinessReport["state"] = "ready") {
  return { executor: { query: vi.fn(async () => ({ rows: [{ result: { enqueued_1h: 1, enqueued_20h: 0 } }] })) },
    commerce: { start: vi.fn(async (key: string) => ({ key })) }, requiredObjects: [],
    version: "test", catalogue: { version: "complete", migration: "host" }, readiness: vi.fn(async () => report(state)),
  };
}

it.each([undefined, false])("keeps construction and every default-off entrance cold (%s)", async enabled => {
  const input = options(), run = input.commerce.start;
  const binding = createM11CommerceReferenceBinding({ ...input, enabled,
    handlers: [{ eventType: "commerce.order.paid", timeoutMs: 1000 }],
    routes: [{ id: "/selected", handle: run }], schedules: [{ id: "selected", cadenceSeconds: 60, run }],
  });
  expect(input.readiness).not.toHaveBeenCalled(); expect(input.executor.query).not.toHaveBeenCalled();
  expect(await binding.readiness()).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.start("request")).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.abandonedReminders(1, "")).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.recoveryReminders(1)).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.authorizeReminder({ eventId: "event", claimToken: "claim" })).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.pruneOutbox(1)).toEqual({ kind: "refused", code: "disabled" });
  expect(binding.ports).toEqual({}); expect(binding.routes).toEqual({}); expect(binding.triggers).toEqual({});
  expect(binding.contributions[0].manifest).toMatchObject({ handles: [], routes: [], schedules: [] });
  expect(input.readiness).not.toHaveBeenCalled(); expect(input.executor.query).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});

it.each(["unknown", "unsatisfied"] as const)("refuses %s before work and leaves the host's serving selection intact", async state => {
  const input = options(state), run = input.commerce.start;
  const incumbent = { id: "serving" }; let serving: unknown = incumbent;
  const install = vi.fn((candidate: unknown) => { serving = candidate; });
  const binding = createM11CommerceReferenceBinding({ ...input, enabled: true,
    routes: [{ id: "/selected", handle: run }], schedules: [{ id: "selected", cadenceSeconds: 60, run }],
  });
  if ((await binding.readiness()).kind === "ready") install(binding);
  const refusal = { kind: "refused", code: `schema_${state}` };
  expect(await binding.services.start("request")).toEqual(refusal);
  expect(await binding.services.abandonedReminders(1, "")).toEqual(refusal);
  expect(await binding.services.recoveryReminders(1)).toEqual(refusal);
  expect(await binding.services.authorizeReminder({ eventId: "event", claimToken: "claim" })).toEqual(refusal);
  expect(await binding.services.pruneOutbox(1)).toEqual(refusal);
  expect(await binding.contributions[0].routes[0].handle()).toEqual(refusal);
  expect(await binding.contributions[0].schedules[0].run()).toEqual(refusal);
  expect(input.executor.query).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled(); expect(serving).toBe(incumbent);
  expect(input.readiness).toHaveBeenCalledWith(binding.schema);
});

it("shares one guarded executor across each operation, route and trigger, preserving arguments, result and thrown identity", async () => {
  const input = options(), run = input.commerce.start, result = { key: "request" };
  run.mockResolvedValue(result);
  const binding = createM11CommerceReferenceBinding({ ...input, enabled: true,
    routes: [{ id: "/selected", handle: run }], schedules: [{ id: "selected", cadenceSeconds: 60, run }],
  });
  expect(input.readiness).not.toHaveBeenCalled(); expect(input.executor.query).not.toHaveBeenCalled();
  expect(Object.keys(binding.ports)).toHaveLength(5);
  for (const [name, execute] of Object.entries(binding.services)) expect(binding.ports[`@openlup/platform/commerce:${name}`]).toBe(execute);
  expect(binding.contributions[0].routes[0].handle).toBe(binding.services.start);
  expect(binding.contributions[0].schedules[0].run).toBe(binding.services.start);
  expect(Object.values(binding.routes)).toEqual([binding.services.start]); expect(Object.values(binding.triggers)).toEqual([binding.services.start]);
  expect(await binding.services.start("request")).toBe(result); expect(run).toHaveBeenCalledExactlyOnceWith("request");
  expect(await binding.services.recoveryReminders(7)).toEqual({ enqueued1h: 1, enqueued20h: 0 });
  expect(input.executor.query).toHaveBeenCalledExactlyOnceWith("SELECT public.commerce_enqueue_checkout_recovery_reminders($1::integer) AS result", [7]);
  const error = new Error("original_failure"); run.mockRejectedValueOnce(error);
  await expect(binding.services.start("failed")).rejects.toBe(error);
  input.readiness.mockResolvedValue(report("unsatisfied"));
  expect(await binding.services.start("later")).toEqual({ kind: "refused", code: "schema_unsatisfied" });
  expect(run).toHaveBeenCalledTimes(2);
});

it("composes the actual package review and compensation callables without another command implementation", async () => {
  const read = vi.fn(async () => null), rpc = vi.fn(async () => ({ data: { cancelled: true }, error: null }));
  const review = createOrderReviewHandlers({ read, submit: vi.fn(), createMediaIntent: vi.fn(), confirmMedia: vi.fn(), moderate: vi.fn(), revoke: vi.fn() });
  const compensation = createCheckoutCompensationRpcAdapter({ rpc });
  const binding = createM11CommerceReferenceBinding({ ...options(), enabled: true,
    commerce: { reviewRead: review.read, cancelAbandonedOrder: compensation.cancelAbandonedOrder },
  });
  expect(await binding.services.reviewRead("grant")).toEqual({ ok: false, error: { kind: "unavailable" } });
  expect(read).toHaveBeenCalledExactlyOnceWith("grant");
  expect(await binding.services.cancelAbandonedOrder({ idempotencyKey: "request-key", orderId: "order", reason: "pre_dispatch" })).toEqual({ cancelled: true });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("commerce_cancel_abandoned_checkout", {
    p_idempotency_key: "request-key:abandon", p_order_id: "order", p_reason: "pre_dispatch",
  });
});

it.each(["abandonedReminders", "recoveryReminders", "authorizeReminder", "pruneOutbox"])("refuses a second %s executor", name => {
  expect(() => createM11CommerceReferenceBinding({ ...options(), enabled: true, commerce: { [name]: vi.fn() } })).toThrow(`commerce_duplicate_operation:${name}`);
});
it("refuses an entry that would introduce an unselected executor", () => {
  expect(() => createM11CommerceReferenceBinding({ ...options(), enabled: true, routes: [{ id: "/unselected", handle: vi.fn() }] })).toThrow("commerce_entry_operation_required");
});
