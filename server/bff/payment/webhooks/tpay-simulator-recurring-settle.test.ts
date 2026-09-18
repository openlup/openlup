import { describe, expect, it, vi } from "vitest";

import {
  sweepSimulatorRecurringSettlements,
  type StuckRecurringAttempt,
} from "./tpay-simulator-recurring-settle.js";
import type {
  ParsedSimulatorRequest,
  SimulatorSettlementOutcome,
} from "../../../adapters/supabase/payment/tpaySimulatorSettlement.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";

const gateway = {} as DataGatewayPort;

function attempt(id: string, amountMinor: number | null = 41540): StuckRecurringAttempt {
  return { providerPaymentId: id, amountMinor };
}

describe("sweepSimulatorRecurringSettlements", () => {
  it("settles each stuck attempt as a succeeded off-session recurring charge (no alias)", async () => {
    const settle = vi.fn(
      async (_g: DataGatewayPort, _p: ParsedSimulatorRequest): Promise<SimulatorSettlementOutcome> => ({
        matched: true,
        paymentIntentId: "intent-1",
        paymentEventId: "event-1",
        resultStatus: "succeeded",
        aliasResult: null,
        methodRefReplayed: null,
        replayed: false,
      }),
    );
    const summary = await sweepSimulatorRecurringSettlements(gateway, {
      readStuck: async () => [attempt("tpay_sim_a"), attempt("tpay_sim_b")],
      settle,
    });

    expect(summary).toEqual({ scanned: 2, settled: 2, alreadySettled: 0, unmatched: 0, failures: 0 });
    // The sweep drives a SUCCEEDED result with no alias params (renewal mandate already exists).
    expect(settle).toHaveBeenCalledWith(
      gateway,
      expect.objectContaining({
        providerPaymentId: "tpay_sim_a",
        resultStatus: "succeeded",
        amountMinor: 41540,
        aliasResult: null,
        clientId: null,
        subscriptionId: null,
        providerMethodRef: null,
      }),
    );
  });

  it("classifies outcomes: a 23505 re-delivery is alreadySettled, an unmatched event and a hard error are counted apart", async () => {
    const settle = vi.fn(async (_g: DataGatewayPort, p: ParsedSimulatorRequest): Promise<SimulatorSettlementOutcome> => {
      if (p.providerPaymentId === "tpay_sim_conflict") throw new Error("payment_control_result_idempotency_conflict");
      if (p.providerPaymentId === "tpay_sim_unmatched") return { matched: false };
      if (p.providerPaymentId === "tpay_sim_boom") throw new Error("db exploded");
      return {
        matched: true, paymentIntentId: "i", paymentEventId: "e", resultStatus: "succeeded",
        aliasResult: null, methodRefReplayed: null, replayed: false,
      };
    });

    const summary = await sweepSimulatorRecurringSettlements(gateway, {
      readStuck: async () => [
        attempt("tpay_sim_ok"),
        attempt("tpay_sim_conflict"),
        attempt("tpay_sim_unmatched"),
        attempt("tpay_sim_boom"),
      ],
      settle,
    });

    expect(summary).toEqual({ scanned: 4, settled: 1, alreadySettled: 1, unmatched: 1, failures: 1 });
  });

  it("returns a zero summary when nothing is stuck", async () => {
    const summary = await sweepSimulatorRecurringSettlements(gateway, {
      readStuck: async () => [],
      settle: vi.fn(),
    });
    expect(summary).toEqual({ scanned: 0, settled: 0, alreadySettled: 0, unmatched: 0, failures: 0 });
  });
});
