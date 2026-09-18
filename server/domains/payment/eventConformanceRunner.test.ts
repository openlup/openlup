import { describe, expect, it } from "vitest";
import { runExecutionConformance } from "./eventConformanceRunner.js";
import { createLocalReferenceDemoPaymentExecutionPort } from "../../adapters/localReferenceStoreAdapter.js";
import { paymentExecutionBaseContractInput } from "../../adapters/paymentExecutionPortContract.testFixtures.js";

describe("payment event port conformance: simulator execution", () => {
  it("proves captured and permanently refused execution without durability claims", async () => {
    const capturedSubject = createLocalReferenceDemoPaymentExecutionPort("captured");
    const capturedLedger: unknown[] = [];
    const captured = { execute: async (request: Parameters<typeof capturedSubject.execute>[0]) => {
      const result = await capturedSubject.execute(request);
      capturedLedger.push(result);
      return result;
    } };
    const refused = createLocalReferenceDemoPaymentExecutionPort("refused");
    const evidence = await runExecutionConformance({
      // Fixture identity of this repository's captured simulator; the shared
      // runner stays free of any provider name.
      expectedProvider: "hidden_rehearsal",
      captured,
      capturedLedger: { cardinality: () => capturedLedger.length },
      refused,
      request: { ...paymentExecutionBaseContractInput, orderRef: "payment-event-conformance" },
    });

    expect(evidence).toEqual({
      capability: { name: "simulator-execution", durabilityClaim: false },
      executions: 2,
      providerCalls: 0,
      capturedEffects: 1,
      permanentRefusals: 1,
    });
  });
});
