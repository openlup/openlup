import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { runCommerceReservationSweepCron as manual } from "../../../api/cron/commerce-reservation-sweep.js";
import { runCommerceReservationAutoExpiryCron as automatic } from "../../../api/cron/commerce-reservation-auto-expiry.js";
import { createManagedReservationSweepPort } from "../../../server/adapters/managed/commerce/reservationSweepPort.js";

const env = { CRON_SECRET: "synthetic-test", SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-test",
  COMMERCE_RESERVATION_SWEEP_ENABLED: "true", COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: "true", COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES: "1440" };
const request = (method = "POST") => ({ method, headers: { authorization: "Bearer synthetic-test" } }) as never;
it("keeps manual repair unscheduled and separate from automatic expiry, provider sync and recount", async () => {
  const manualSource = readFileSync("api/cron/commerce-reservation-sweep.ts", "utf8");
  const automaticSource = readFileSync("api/cron/commerce-reservation-auto-expiry.ts", "utf8");
  expect(manualSource).toContain('const MANUAL_REPAIR_DRIVER = "manual_admin"');
  expect(automaticSource).toContain('const DRIVER = "vercel_cron"');
  const gateway = vi.fn();
  expect((await manual(request("GET"), env, gateway)).status).toBe(405);
  expect((await automatic({ method: "GET", headers: {} } as never, env, gateway)).status).toBe(401);
  expect(gateway).not.toHaveBeenCalled();
  for (const source of [manualSource, automaticSource]) {
    expect(source).not.toMatch(/inventory_recount|stock_sync|cancelSubscription|dunning/);
    expect(source).toContain("sweepRetryHolds");
  }
  // No new scheduler is installed; actual deployment/staging controls remain PENDING.
  expect(manualSource).not.toMatch(/cron\.schedule|setInterval|registerJob/);
});
it("refuses flag and lease admission before either release operation", async () => {
  const rpc = vi.fn(async () => ({ data: [{ acquired: false, run_id: null, reason: "control_disabled" }], error: null }));
  const factory = vi.fn(() => ({ asService: async (callback: (client: unknown) => unknown) => callback({ rpc }) }));
  expect((await manual(request(), { ...env, COMMERCE_RESERVATION_SWEEP_ENABLED: "false" }, factory as never)).body).toMatchObject({ skipped: "sweep_disabled" });
  expect((await automatic(request(), { ...env, COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: "false" }, factory as never)).body).toMatchObject({ skipped: "reservation_auto_expiry_disabled" });
  expect(factory).not.toHaveBeenCalled();
  for (const run of [manual, automatic]) expect((await run(request(), env, factory as never)).body).toEqual({ ok: true, skipped: true, reason: "control_disabled" });
  expect(rpc.mock.calls).toHaveLength(2);
});
it("retry maintenance issues only the release RPC, propagates failure and never owns lifecycle writes", async () => {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: { retrySweep: { holdsChecked: 3, holdsReleased: 2, skippedPaid: 1 } }, error: null as { message: string } | null }));
  const port = createManagedReservationSweepPort({ rpc });
  expect(await port.sweepRetryHolds({ now: "2026-10-20T12:00:00Z", limit: 50 })).toEqual({ holdsChecked: 3, holdsReleased: 2, skippedPaid: 1 });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("commerce_sweep_expired_retry_holds", { p_now: "2026-10-20T12:00:00Z", p_limit: 50 });
  rpc.mockResolvedValueOnce({ data: { retrySweep: { holdsChecked: 0, holdsReleased: 0, skippedPaid: 0 } }, error: { message: "synthetic refusal" } });
  await expect(port.sweepRetryHolds({ now: "2026-10-20T12:00:00Z", limit: 50 })).rejects.toThrow("rpc_retry_hold_sweep: synthetic refusal");
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(["commerce_sweep_expired_retry_holds", "commerce_sweep_expired_retry_holds"]);
});
