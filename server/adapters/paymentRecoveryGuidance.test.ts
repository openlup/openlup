import { describe, expect, it } from "vitest";
import { createPaymentRecoveryEvidenceNormalizer } from "./paymentRecoveryGuidance.js";
import type { PaymentFailureEvidence } from "./paymentFailureEvidence.js";
import { tpayFailureEvidence } from "./tpay/tpayFailureEvidence.js";

const observation = (patch: Partial<PaymentFailureEvidence> = {}): PaymentFailureEvidence => ({
  version: 1, source: "execution", disposition: "present", refusalVerified: true,
  providerPaymentId: "pi_same", providerChargeId: "ch_same", code: "card_declined",
  declineCode: "insufficient_funds", adviceCode: null, adviceOrigin: "provider",
  operation: "one_time_payment", method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" },
  methodSource: "provider", ...patch,
});
const normalize = createPaymentRecoveryEvidenceNormalizer();

describe("diagnostic recovery composition", () => {
  it("agrees across duplicate observed facts without returning protected codes", () => {
    const result = normalize({ provider: "stripe", evidence: [observation(), observation({ source: "webhook" })] });
    expect(result).toMatchObject({ cause: "insufficient_funds", certainty: "verified", refusalVerified: true });
    expect(JSON.stringify(result)).not.toMatch(/pi_same|ch_same|declineCode|adviceOrigin/);
  });
  it("keeps conflicting safe causes generic and restricted causes undisclosed", () => {
    expect(normalize({ provider: "stripe", evidence: [observation(), observation({ declineCode: "expired_card" })] }))
      .toMatchObject({ cause: "generic_decline", certainty: "unknown" });
    expect(normalize({ provider: "stripe", evidence: [observation(), observation({ declineCode: "fraudulent" })] }))
      .toMatchObject({ cause: "generic_decline", disclosure: "restricted" });
  });
  it.each([
    [observation(), observation({ providerChargeId: "ch_old" })],
    [observation(), observation({ providerPaymentId: "pi_other" })],
    [observation(), { ...observation(), customerEmail: "private@example.invalid" }],
    [observation({ methodSource: "unknown" })],
    [observation(), observation({ refusalVerified: false, disposition: "unreadable", method: null, methodSource: "unknown" })],
    [observation({ code: "free form words" })],
    Array.from({ length: 33 }, () => observation()),
  ])("refuses ambiguous, malformed, unproven or truncated evidence %#", (...evidence) => {
    expect(normalize({ provider: "stripe", evidence })).toBeNull();
  });
  it("does not infer numeric Tpay codes or a method from a PSP name", () => {
    expect(normalize({ provider: "tpay", evidence: [observation({ declineCode: "63", method: null, methodSource: "unknown" })] }))
      .toMatchObject({ cause: "generic_decline", method: null, advice: null });
    expect(normalize({ provider: "uninstalled", evidence: [observation()] })).toBeNull();
  });
  it("does not pick one method or operation from contradictory observations", () => {
    expect(normalize({ provider: "stripe", evidence: [observation(), observation({
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" }, operation: "recurring_setup",
    })] })).toMatchObject({ method: null, operation: null });
  });
  it.each([false, true])("retains known Tpay checkout context with an unknown-flow readback, reversed=%s", (reverse) => {
    const build = (source: "execution" | "readback", flow: string | null) => tpayFailureEvidence({
      source, flow, providerPaymentId: "tx_same", refusalVerified: true,
      observation: { code: "105", disposition: "present" },
    });
    const evidence = [build("execution", "blik_recurring_activation"), build("readback", null)];
    expect(normalize({ provider: "tpay", evidence: reverse ? evidence.reverse() : evidence })).toEqual({
      refusalVerified: true, cause: "generic_decline", certainty: "unknown", disclosure: "safe",
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" },
      operation: "recurring_setup", advice: null,
    });
  });
  it("retains agreeing known context without promoting cause or advice absent from another observation", () => {
    const known = observation({ adviceCode: "do_not_try_again" });
    const unknown = observation({ source: "readback", method: null, methodSource: "unknown",
      operation: null, declineCode: "generic_decline", adviceCode: null });
    expect(normalize({ provider: "stripe", evidence: [unknown, known, known] })).toMatchObject({
      cause: "generic_decline", certainty: "unknown", method: known.method,
      operation: known.operation, advice: null,
    });
  });
  it("keeps method and operation unknown when no verified observation supplies them", () => {
    const unknown = observation({ method: null, methodSource: "unknown", operation: null });
    expect(normalize({ provider: "stripe", evidence: [unknown, unknown] }))
      .toMatchObject({ method: null, operation: null });
    expect(normalize({ provider: "stripe", evidence: [unknown, observation({ refusalVerified: false })] }))
      .toMatchObject({ method: null, operation: null });
  });
  it.each([
    { method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" as const }, operation: "recurring_setup" as const },
    { method: { kind: "card", recoveryMethodKey: "another_card_choice", interaction: "new_instrument" as const }, operation: "recurring_setup" as const },
    { method: { kind: "card", recoveryMethodKey: "card", interaction: "stored_instrument" as const }, operation: "stored_method_payment" as const },
  ])("does not discard known conflicts in the presence of unknown fields: %j", (conflict) => {
    const unknown = observation({ method: null, methodSource: "unknown", operation: null });
    for (const evidence of [[unknown, observation(), observation(conflict)], [observation(conflict), observation(), unknown]]) {
      expect(normalize({ provider: "stripe", evidence })).toMatchObject({ method: null, operation: null });
    }
  });
  it("does not use unverified observations to contradict verified context", () => {
    const known = observation();
    const unverified = observation({ refusalVerified: false, operation: "stored_method_payment",
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "stored_instrument" } });
    expect(normalize({ provider: "stripe", evidence: [known, unverified] }))
      .toMatchObject({ method: known.method, operation: known.operation });
    expect(normalize({ provider: "stripe", evidence: [unverified] })).toBeNull();
  });
  it("rejects duplicate adapter keys", () => {
    const adapter = { provider: "third", normalize: () => ({}) as never };
    expect(() => createPaymentRecoveryEvidenceNormalizer([adapter, adapter])).toThrow("duplicate_payment_recovery_adapter");
  });
});
