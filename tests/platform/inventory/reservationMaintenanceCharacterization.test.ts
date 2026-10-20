import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommerceReservationSweepCron as manual } from "../../../api/cron/commerce-reservation-sweep.js";
import { runCommerceReservationAutoExpiryCron as automatic } from "../../../api/cron/commerce-reservation-auto-expiry.js";

const env = { CRON_SECRET: "test-secret", SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-secret",
  COMMERCE_RESERVATION_SWEEP_ENABLED: "true", COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: "true",
  COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES: "1440" };
const request = (method = "POST") => ({ method, headers: { authorization: "Bearer test-secret" } }) as never;
function gateway(acquired: boolean) {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === "platform_claim_job_run") return { data: [{ acquired, run_id: acquired ? "run-a" : null, reason: "control_disabled" }], error: null };
    if (name === "commerce_sweep_expired_reservation_holds") return { data: { sweep: {
      ordersChecked: 3, ordersExpired: 1, reservationsReleased: 2, skippedPaid: 1, skippedTerminal: 0, skippedSubscription: 1,
    } }, error: null };
    if (name === "commerce_sweep_expired_retry_holds") return { data: { retrySweep: { holdsChecked: 2, holdsReleased: 1, skippedPaid: 1 } }, error: null };
    if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
    throw new Error(`unexpected mutation ${name}`);
  });
  const asService = vi.fn(async (callback: (client: unknown) => unknown) => callback({ rpc }));
  const factory = vi.fn(() => ({ asService }));
  return { rpc, asService, factory };
}

describe("W3 distinct manual repair and automatic expiry traces", () => {
  afterEach(() => vi.useRealTimers());
  it("isolates the manual POST/auth surface from the automatic GET surface", async () => {
    const f = gateway(false);
    expect((await manual(request("GET"), env, f.factory as never)).status).toBe(405);
    expect((await manual({ method: "POST", headers: {} } as never, env, f.factory as never)).status).toBe(401);
    expect(f.factory).not.toHaveBeenCalled();
    expect((await automatic(request("GET"), env, f.factory as never)).body).toMatchObject({ skipped: true });
    expect(f.rpc).toHaveBeenCalledOnce();
  });
  it("skips both disabled flags before gateway work rather than claiming a lease", async () => {
    const f = gateway(true);
    const disabled = { ...env, COMMERCE_RESERVATION_SWEEP_ENABLED: "false", COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: "false" };
    expect((await manual(request(), disabled, f.factory as never)).body).toMatchObject({ skipped: "sweep_disabled", ordersExpired: 0 });
    expect((await automatic(request(), disabled, f.factory as never)).body).toMatchObject({ skipped: "reservation_auto_expiry_disabled", ordersExpired: 0 });
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("retains gateway + distinct claim identities on control denial, invoking neither sweep", async () => {
    const f = gateway(false);
    for (const run of [manual, automatic]) {
      expect((await run(request(), env, f.factory as never)).body).toEqual({ ok: true, skipped: true, reason: "control_disabled" });
    }
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.asService).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(["platform_claim_job_run", "platform_claim_job_run"]);
    expect(vi.mocked(f.rpc).mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ p_job_name: "commerce-reservation-sweep", p_driver: "manual_admin" }),
      expect.objectContaining({ p_job_name: "commerce-reservation-auto-expiry", p_driver: "vercel_cron" }),
    ]);
  });
  it("keeps both sweep counts and finish evidence without a subscription/dunning writer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00.000Z"));
    for (const run of [manual, automatic]) {
      const f = gateway(true);
      const result = await run(request(), env, f.factory as never);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ordersChecked: 3, ordersExpired: 1, reservationsReleased: 2,
        skippedSubscription: 1, retrySweep: { holdsChecked: 2, holdsReleased: 1, skippedPaid: 1 } });
      expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(["platform_claim_job_run", "commerce_sweep_expired_reservation_holds",
        "commerce_sweep_expired_retry_holds", "platform_finish_job_run_v2"]);
      expect(f.rpc.mock.calls.slice(1, 3)).toEqual([
        ["commerce_sweep_expired_reservation_holds", {
          p_idempotency_prefix: "commerce-reservation-sweep-run", p_now: "2026-10-20T10:00:00.000Z", p_limit: 50,
        }],
        ["commerce_sweep_expired_retry_holds", { p_now: "2026-10-20T10:00:00.000Z", p_limit: 50 }],
      ]);
      expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_checked: 5, p_updated: 2, p_status: "success" });
    }
  });
});
