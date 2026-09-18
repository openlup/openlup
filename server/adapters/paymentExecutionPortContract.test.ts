import { describe, expect, it } from "vitest";
import {
  describePaymentExecutionPortContract,
  describeUnattendedChargeConformance,
  paymentExecutionBaseContractInput,
  paymentExecutionContractInput,
  type UnattendedChargeConformanceSubject,
} from "./paymentExecutionPortContract.testFixtures.js";
import {
  DUNNING_CONFORMANCE_SCENARIOS,
  type DunningConformanceScenarioId,
} from "./dunningConformanceKit.testFixtures.js";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";

/**
 * The third conformance subject: a provider that exists only here.
 *
 * A kit proven only against the two shipped adapters proves the kit MATCHES
 * those two adapters. This minimal implementation is what shows the scenarios
 * are satisfiable by any conforming provider, and it is the template a new
 * adapter starts from.
 */
const simulatorCapability: PaymentProviderCapabilityDescriptor = {
  providerKind: "example_pay",
  captureFlows: [{ kind: "card_on_file_setup", handoff: "embedded_client_secret" }],
  requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }),
  unattendedChargeFlow: "off_session_payment",
  payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
  methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
  mandateUpsertIsSubscriptionScoped: false,
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
};

const simulatorSubject: UnattendedChargeConformanceSubject = {
  name: "public-shape simulator provider",
  capability: simulatorCapability,
  chargeInput: paymentExecutionContractInput,
  createSoftDecliningPort: () => ({
    async execute(input) {
      return {
        provider: simulatorCapability.providerKind,
        providerAttemptId: null,
        providerSessionId: null,
        attemptStatus: "processing",
        nextActionKind: null,
        providerDecline: {
          code: "simulated_refusal",
          mandateUnsupported: false,
          neutralReasonHints: ["transient"],
        },
        webhookExpected: false,
        requestPayload: {
          providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.providerRequestFingerprint,
        },
        responsePayload: { providerDeclined: true },
      };
    },
  }),
  createNonDeclineFailurePort: () => ({
    async execute() {
      throw new Error("simulated transport failure");
    },
  }),
  chargeableMandate: {},
  unchargeableMandate: null,
  declineCorrelation: "withheld",
};

describeUnattendedChargeConformance(simulatorSubject);

describe("payment execution port contract fixture", () => {
  describePaymentExecutionPortContract({
    name: "public-shape fake provider",
    createSubject: () => ({
      async execute(input) {
        return {
          provider: "example_pay",
          providerAttemptId: "attempt_contract",
          providerSessionId: null,
          attemptStatus: "requires_action",
          nextActionKind: "redirect",
          requestPayload: {
            providerIdempotencyKey: input.providerIdempotencyKey,
            providerRequestFingerprint: input.providerRequestFingerprint,
          },
          responsePayload: { normalized: true },
        };
      },
    }),
    scenarios: [{
      allowedNextActionKinds: ["redirect"],
      expectedProvider: "example_pay",
      input: paymentExecutionBaseContractInput,
      name: "accepts a structural non-openlup provider",
      assertResult: ({ result }) => {
        expect(result.provider).toBe("example_pay");
      },
    }],
  });
});

/**
 * The kit's own shape, asserted where the kit's third subject lives.
 *
 * Deliberately NOT a second existence check: whether a delegated pin still
 * resolves is asserted inside the kit itself, once per subject, so a moved pin
 * breaks every rail's suite rather than one bookkeeping test. What this block
 * owns is the property the per-subject runs cannot see: that the table covers
 * the audit and covers it once.
 */
describe("dunning conformance kit manifest", () => {
  const AUDIT_SCENARIOS: readonly DunningConformanceScenarioId[] = [
    "mandate_unfit_preflight",
    "reconciliation_discovered_decline",
    "webhook_less_rail",
    "every_persisted_preflight_reason",
  ];

  it("names each of the audit's four mandatory scenarios exactly once", () => {
    const ids = DUNNING_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id);
    expect(ids).toHaveLength(AUDIT_SCENARIOS.length);
    expect([...ids].sort()).toEqual([...AUDIT_SCENARIOS].sort());
  });

  it("gives every entry a demand a reader can check the code against", () => {
    for (const scenario of DUNNING_CONFORMANCE_SCENARIOS) {
      expect(scenario.name.length, scenario.id).toBeGreaterThan(20);
      expect(scenario.demand.length, scenario.id).toBeGreaterThan(20);
    }
  });

  it("delegates exactly the scenarios no execution port can produce", () => {
    // Three of the four happen at a write this fixture holds no port for: a
    // preflight record made before any provider call, a reconciliation column
    // written by a poller, and a table of persisted reason strings. Only the
    // webhook-less refusal is producible from a subject's own fake, and a
    // seam entry that ever became port-carried would be a real capability gain
    // rather than a bookkeeping edit.
    const byMode = (mode: string) => DUNNING_CONFORMANCE_SCENARIOS
      .filter((scenario) => scenario.carriedBy === mode)
      .map((scenario) => scenario.id);

    expect(byMode("port")).toEqual(["webhook_less_rail"]);
    expect(byMode("seam")).toHaveLength(3);
    for (const scenario of DUNNING_CONFORMANCE_SCENARIOS) {
      expect(scenario.delegatesTo.length > 0, scenario.id).toBe(scenario.carriedBy === "seam");
    }
  });

  it("points no two entries at the same pin", () => {
    // A pin claimed by two scenarios would let one of them go green on the
    // other's evidence, which is the exact failure the delegation replaces.
    const pins = DUNNING_CONFORMANCE_SCENARIOS
      .flatMap((scenario) => scenario.delegatesTo)
      .map((pin) => `${pin.directory}::${pin.title}`);
    expect(new Set(pins).size).toBe(pins.length);
  });
});
