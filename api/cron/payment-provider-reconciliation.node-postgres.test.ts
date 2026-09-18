import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runPaymentProviderReconciliationCron } from "./payment-provider-reconciliation.js";

const ENV = {
  PLATFORM_BUNDLE: "node-postgres",
  DATABASE_URL: "postgres://activation.test/db",
  CRON_SECRET: "cron-secret",
  COMMERCE_PSP_OBSERVABILITY_ENABLED: "true",
};

describe("payment-provider-reconciliation direct activation adopter", () => {
  it("repairs captured activation gaps before any managed gateway or provider is built", async () => {
    const reconcilePaidActivationGaps = vi.fn(async () => ({ repaired: 2, overdue: 0 }));
    const run = vi.fn(async (work) => work({ reconcilePaidActivationGaps }));
    const gatewayFactory = vi.fn();
    const providerFactory = vi.fn();
    const settlementReaderFactory = vi.fn();
    const activationBindingResolver = vi.fn(() => ({ run }));

    const result = await runPaymentProviderReconciliationCron(
      request(), ENV, gatewayFactory as never, providerFactory, settlementReaderFactory,
      activationBindingResolver as never,
    );

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        checked: 2,
        corrected: 2,
        failures: 0,
        paidActivationGaps: { repaired: 2, overdue: 0 },
        providerCalls: 0,
        reason: "direct_captured_activation_reconciliation",
      },
    });
    expect(activationBindingResolver).toHaveBeenCalledWith(ENV);
    expect(reconcilePaidActivationGaps).toHaveBeenCalledOnce();
    expect(gatewayFactory).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
    expect(settlementReaderFactory).not.toHaveBeenCalled();
  });

  it("fails closed when the direct binding is missing or leaves an overdue gap", async () => {
    const missing = await runPaymentProviderReconciliationCron(
      request(), ENV, vi.fn() as never, vi.fn(), vi.fn(), vi.fn(() => null),
    );
    expect(missing).toMatchObject({
      status: 503,
      body: { ok: false, error: "subscription_activation_binding_missing" },
    });

    const overdue = await runPaymentProviderReconciliationCron(
      request(), ENV, vi.fn() as never, vi.fn(), vi.fn(),
      vi.fn(() => ({
        run: (work: (activation: unknown) => Promise<unknown>) => work({
          reconcilePaidActivationGaps: async () => ({ repaired: 1, overdue: 1 }),
        }),
      })) as never,
    );
    expect(overdue).toMatchObject({
      status: 502,
      body: { ok: false, corrected: 1, failures: 1 },
    });
  });
});

function request(): VercelRequest {
  return { method: "POST", headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } } as never;
}
