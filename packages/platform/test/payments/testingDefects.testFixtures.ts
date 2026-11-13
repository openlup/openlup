import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../src/payments/testing/index.js";
import type { PaymentAdapterTestSubject, PaymentTransportScenario, PaymentWebhookFixture } from "../../src/payments/testing/index.js";
import type { PaymentExecutionEnvelope } from "../../src/payments/contracts/index.js";

// Plants are scoped to fresh fixture objects. No production adapter is modified.
export function paymentTestingDefects(provider: string, fixture: () => { subjects: PaymentAdapterTestSubject[] }) {
  for (const scenario of ["timeout-before-dispatch", "provider-5xx-before-dispatch", "timeout-after-dispatch", "redelivery-409"] as const) {
    it(`${provider}: detects a settling transport result for ${scenario}`, async () => {
      const subject = fixture().subjects[0];
      const transport = subject.safety!.transport[scenario as PaymentTransportScenario];
      const execute = transport.execute;
      transport.execute = async () => {
        try { await execute(); } catch { /* Plant an adapter swallowing the fault. */ }
        return ({ outcome: { kind: "attempt", status: "succeeded" },
        dispatch: { kind: "unknown" }, diagnostics: {} }) as unknown as PaymentExecutionEnvelope;
      };
      await expect(runPaymentAdapterConformance([subject])).rejects.toThrow(`${scenario} never success`);
    });
  }
  const plants: [keyof NonNullable<PaymentAdapterTestSubject["safety"]>["webhooks"], string, (fixture: PaymentWebhookFixture, valid: PaymentWebhookFixture) => void][] = [
    ["duplicate", "duplicate identity", row => { if (row.expected.kind !== "refusal") row.expected = { ...row.expected, fingerprint: "planted-drift" }; }],
    ["signatureMismatch", "signature refusal", (row, valid) => { row.expected = valid.expected; }],
    ["partialAmount", "partial exact money", row => {
      if (row.expected.kind === "money" && row.expected.money) row.expected = { ...row.expected,
        money: { ...row.expected.money, amountMinor: 1000 }, ...(row.expected.refund && "refundedMoney" in row.expected.refund
          ? { refund: { ...row.expected.refund, refundedMoney: { ...row.expected.refund.refundedMoney, amountMinor: 1000 } } } : {}) };
    }],
    ["zeroAmount", "invalid money unusable", (row, valid) => { row.expected = valid.expected; }],
    ["missingAmount", "invalid money unusable", (row, valid) => { row.expected = valid.expected; }],
    ["missingCurrency", "settling currency declared", (row, valid) => {
      row.expected = valid.expected.kind === "money" ? { ...valid.expected, money: { ...valid.expected.money!, currency: "ZZZ" } } : valid.expected;
    }],
    ["chargeback", "chargeback identity and refund class", (row, valid) => {
      if (row.expected.kind === "money" && valid.expected.kind === "money") row.expected = { ...row.expected,
        providerEventId: valid.expected.providerEventId, fingerprint: valid.expected.fingerprint };
    }],
  ];
  for (const [scenario, error, plant] of plants) it(`${provider}: detects ${scenario} defect`, async () => {
    const subject = fixture().subjects[0];
    const row = subject.safety!.webhooks[scenario];
    plant(row, subject.safety!.webhooks.valid);
    const verify = subject.adapter.verifyPort.verifyAndNormalize;
    subject.adapter.verifyPort = { verifyAndNormalize: async input => input === row.input ? row.expected : verify(input) };
    await expect(runPaymentAdapterConformance([subject])).rejects.toThrow(error);
  });

  const capabilityPlants: [string, string, (subject: PaymentAdapterTestSubject) => void][] = [
    ["captureFlows", "capture flow", subject => { subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.filter(input => input.methodSelection?.family !== subject.adapter.capabilities.captureFlows[0].methodFamilies[0]); }],
    ["supportedCurrencies", "currency ZZZ", subject => { subject.adapter.capabilities.supportedCurrencies = [...subject.adapter.capabilities.supportedCurrencies, "ZZZ"]; }],
    ["unattended", "unattended demonstrated", subject => { subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.filter(input => input.purpose !== "renewal-unattended"); }],
    ["readback", "readback capability", subject => { subject.adapter.capabilities.readback = "unsupported"; }],
    ["close", "close method present", subject => { subject.adapter.capabilities.close = "supported"; }],
    ["exactAbsence", "absence port present", subject => { subject.adapter.capabilities.exactAbsence = "supported"; }],
    ["refundObservation", "refund observation capability", subject => { subject.adapter.capabilities.refundObservation = "unsupported"; }],
    ["refundCreate", "refundCreate structurally unsupported", subject => { Object.assign(subject.adapter, { refundCreate: () => {} }); }],
    ["authorizationCaptureSplit", "authorizationCaptureSplit structurally unsupported", subject => { Object.assign(subject.adapter, { authorizationCaptureSplit: () => {} }); }],
  ];
  for (const [capability, error, plant] of capabilityPlants) it(`${provider}: detects undemonstrated ${capability}`, async () => {
    const subject = fixture().subjects[0];
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities } };
    plant(subject);
    await expect(runPaymentAdapterConformance([subject])).rejects.toThrow(error);
  });
}
