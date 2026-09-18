import { describe, expect, it, vi } from "vitest";
import {
  claimCheckoutRecoveryOperationsRun,
  finishCheckoutRecoveryOperationsRun,
  resolveCheckoutRecoveryOperationsBinding,
} from "./checkoutRecoveryOperationsBinding.js";

describe("checkout recovery operations binding", () => {
  it("fails closed on missing bundle-specific persistence", () => {
    expect(resolveCheckoutRecoveryOperationsBinding({ PLATFORM_BUNDLE: "node-postgres" }))
      .toEqual({ error: "database_url_required" });
    expect(resolveCheckoutRecoveryOperationsBinding({ PLATFORM_BUNDLE: "vercel-supabase" }))
      .toEqual({ error: "supabase_env_required" });
  });

  it("opens one role-free direct lane, composes every port, and closes it", async () => {
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({
      query: vi.fn(async () => ({ rows: [{ result: {} }] })),
    }));
    const createLane = vi.fn(() => ({ run, close }));
    const resolved = resolveCheckoutRecoveryOperationsBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://local",
    }, { createLane: createLane as never });

    await expect(resolved.binding!.run(async (context) => ({
      bundle: context.bundleId,
      abandoned: typeof context.abandonedReminders.enqueue,
      recovery: typeof context.recoveryReminders.enqueue,
      prune: typeof context.outboxPrune.pruneOutbox,
      authorize: typeof context.deliveryAuthorization?.authorize,
      claim: typeof context.jobRunLedger?.claimJobRun,
      managed: context.managedClient,
    }))).resolves.toEqual({
      bundle: "node-postgres",
      abandoned: "function",
      recovery: "function",
      prune: "function",
      authorize: "function",
      claim: "function",
      managed: undefined,
    });
    expect(createLane).toHaveBeenCalledWith({ connectionString: "postgres://local" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the managed gateway client and private delivery-prune adjunct inside the managed binding", async () => {
    const client = { rpc: vi.fn() };
    const asService = vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(client));
    const gatewayFactory = vi.fn(() => ({ asService }));
    const resolved = resolveCheckoutRecoveryOperationsBinding({
      PLATFORM_BUNDLE: "vercel-supabase",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    }, { gatewayFactory: gatewayFactory as never });

    await expect(resolved.binding!.run(async (context) => ({
      bundle: context.bundleId,
      runtimeBaseUrl: context.runtimeBaseUrl,
      managed: context.managedClient === client,
      deliveryPrune: typeof context.deliveryPrune?.pruneDeliveries,
      directLedger: context.jobRunLedger,
    }))).resolves.toEqual({
      bundle: "vercel-supabase",
      runtimeBaseUrl: "https://example.supabase.co",
      managed: true,
      deliveryPrune: "function",
      directLedger: undefined,
    });
    expect(asService).toHaveBeenCalledOnce();
  });

  it("uses the direct durable ledger without invoking managed callbacks", async () => {
    const claimJobRun = vi.fn(async () => ({ acquired: true, runId: "run", reason: "claimed" }));
    const finishJobRun = vi.fn(async () => true);
    const context = { jobRunLedger: { claimJobRun, finishJobRun } } as never;
    const invocation = { triggerKind: "scheduler", invocationSource: "node_cron" } as const;
    const managedClaim = vi.fn();
    const managedFinish = vi.fn();

    await expect(claimCheckoutRecoveryOperationsRun(
      context, "checkout-recovery-dispatch", invocation, 120, managedClaim,
    )).resolves.toEqual({ acquired: true, runId: "run", reason: "claimed" });
    await finishCheckoutRecoveryOperationsRun(
      context,
      "checkout-recovery-dispatch",
      "run",
      invocation,
      "success",
      { checked: 2, updated: 2, failures: 0, skipped: false },
      { driver: "node_cron" },
      managedFinish,
    );
    expect(claimJobRun).toHaveBeenCalledWith("checkout-recovery-dispatch", invocation, 120);
    expect(finishJobRun).toHaveBeenCalledWith(
      "checkout-recovery-dispatch",
      "run",
      invocation,
      "success",
      { checked: 2, updated: 2, failures: 0, skipped: false },
      { driver: "node_cron" },
    );
    expect(managedClaim).not.toHaveBeenCalled();
    expect(managedFinish).not.toHaveBeenCalled();
  });
});
