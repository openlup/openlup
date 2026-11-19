import { describe, expect, it, vi } from "vitest";

import { runAbandonedCartReminderCron } from "../_cron/abandonedCartReminderJob.js";
import * as postgres from "../../server/adapters/postgres/dataGateway.js";
import handler from "./abandoned-cart-reminder.ts";

// Request/response types derive from the handler's own signature so this
// companion pins no hosting-SDK vocabulary and follows the signature if it moves.
type HandlerArgs = Parameters<typeof handler>;

describe("cron route handler (companion)", () => {
  it("executes the handler and denies by default without cron auth", async () => {
    const req = { method: "GET", headers: {} } as HandlerArgs[0];
    let statusCode = 0;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as HandlerArgs[1];

    await handler(req, res);

    // No CRON_SECRET / bearer in the test env → the job denies before any work.
    expect(statusCode).toBeGreaterThanOrEqual(400);
    expect(body).toMatchObject({ ok: false });
  });

  it("reports the full native cart grant hint in the response and job ledger", async () => {
    const connectionString = "postgresql://fixture:synthetic@db.invalid/test";
    const message = "checkout_recovery_cart_runtime_grant_required";
    const hint = "GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer)"
      + " TO separate_cart_reminder_worker_for_installation_long_role_name;";
    const refusal = Object.assign(new Error(message), { code: "42501", hint, detail: connectionString });
    const runId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true, run_id: runId, reason: "claimed" }] })
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({ rows: [{ released: true }] });
    const lane = vi.spyOn(postgres, "createPostgresCheckoutRecoveryOperationsTransactionLane").mockReturnValue({
      run: async (work) => work({ query }),
      close: async () => undefined,
    });
    try {
      const result = await runAbandonedCartReminderCron(
        { method: "GET", headers: { authorization: "Bearer fixture" } } as HandlerArgs[0],
        {
          CRON_SECRET: "fixture",
          COMMERCE_ABANDONED_CART_ENABLED: "true",
          PLATFORM_BUNDLE: "node-postgres",
          DATABASE_URL: connectionString,
        },
      );
      const reason = `${message}\n${hint}`;
      expect(result).toMatchObject({ status: 502, body: { ok: false, reason } });
      expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("platform_finish_job_run_v3"),
        expect.arrayContaining([runId, "failed", reason, expect.objectContaining({ reason })]));
    } finally {
      lane.mockRestore();
    }
  });
});
