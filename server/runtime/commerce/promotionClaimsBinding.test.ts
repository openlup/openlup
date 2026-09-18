import { describe, expect, it, vi } from "vitest";

import {
  resolvePromotionClaimsBinding,
  runPromotionClaimSweepOnce,
} from "./promotionClaimsBinding.js";

describe("promotion claims binding", () => {
  it("fails closed on missing bundle-specific persistence", () => {
    expect(resolvePromotionClaimsBinding({ PLATFORM_BUNDLE: "node-postgres" }))
      .toEqual({ error: "database_url_required" });
    expect(resolvePromotionClaimsBinding({ PLATFORM_BUNDLE: "managed" }))
      .toEqual({ error: "supabase_env_required" });
  });

  it("opens and closes the capability-local Postgres lane", async () => {
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({
      query: vi.fn(async () => ({ rows: [] })),
    }));
    const createLane = vi.fn(() => ({ run, close }));
    const resolution = resolvePromotionClaimsBinding({
      PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local",
    }, { createLane: createLane as never });
    expect(resolution.binding).toBeDefined();
    await expect(resolution.binding!.run(async (context) => ({
      promo: typeof context.promoDataPort.listActivePromotions,
      sweep: typeof context.sweepPort.sweep,
      lease: typeof context.jobRunLedger.claimJobRun,
    }))).resolves.toEqual({ promo: "function", sweep: "function", lease: "function" });
    expect(createLane).toHaveBeenCalledWith({ connectionString: "postgres://local" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs one claimed sweep and records its neutral result", async () => {
    const claimJobRun = vi.fn(async () => ({ acquired: true, runId: "run-1", reason: "acquired" }));
    const finishJobRun = vi.fn(async () => true);
    const resolution = {
      binding: {
        run: async (work: (context: never) => Promise<unknown>) => work({
          promoDataPort: {} as never,
          sweepPort: { sweep: vi.fn(async () => ({ checked: 4, cancelled: 1, skipped: 3 })) },
          jobRunLedger: {
            claimJobRun,
            finishJobRun,
          },
        } as never),
      },
    };
    await expect(runPromotionClaimSweepOnce({
      env: { COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED: "true" },
      invocation: { triggerKind: "worker", invocationSource: "worker" },
      now: () => "2026-08-17T12:00:00.000Z",
      resolveBinding: () => resolution as never,
    })).resolves.toEqual({
      status: 200, body: { ok: true, checked: 4, cancelled: 1, skipped: 3 },
    });
    expect(claimJobRun).toHaveBeenCalledWith(
      "promotion-claim-sweep",
      { triggerKind: "worker", invocationSource: "worker" },
      5 * 60,
    );
    expect(finishJobRun).toHaveBeenCalledWith(
      "promotion-claim-sweep", "run-1",
      { triggerKind: "worker", invocationSource: "worker" }, "success",
      { checked: 4, updated: 1, failures: 0, skipped: false },
      { driver: "worker", skippedUnsafe: 3 },
    );
  });
});
