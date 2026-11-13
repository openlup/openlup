import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../src/payments/testing/index.js";
import type { PaymentAdapterTestSubject, PaymentTransportScenario, PaymentWebhookFixture } from "../../src/payments/testing/index.js";
import type { PaymentExecutionEnvelope } from "../../src/payments/contracts/index.js";

// Plants are scoped to fresh fixture objects. No production adapter is modified.
export function paymentTestingDefects(provider: string, fixture: () => { subjects: PaymentAdapterTestSubject[] }) {
  for (const scenario of ["timeout-before-dispatch", "provider-5xx-before-dispatch", "timeout-after-dispatch", "redelivery-409"] as const) {
    it(`${provider}: detects a settling transport result for ${scenario}`, async () => {
      const subjects = fixture().subjects;
    const subject = subjects[0];
      const transport = subject.safety!.transport[scenario as PaymentTransportScenario];
      const execute = transport.execute;
      transport.execute = async () => {
        try { await execute(); } catch { /* Plant an adapter swallowing the fault. */ }
        return ({ outcome: { kind: "attempt", status: "succeeded" },
        dispatch: { kind: "unknown" }, diagnostics: {} }) as unknown as PaymentExecutionEnvelope;
      };
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(`${scenario} never success`);
    });
  }
  for (const scenario of ["timeout-after-dispatch", "redelivery-409"] as const) {
    it(`${provider}: detects invented exact non-dispatch after ${scenario}`, async () => {
      const subjects = fixture().subjects;
      const transport = subjects[0].safety!.transport[scenario];
      const execute = transport.execute;
      transport.execute = async () => {
        try { await execute(); } catch { /* Plant false certainty after the real fault. */ }
        const reason = { code: "soft_retryable" as const, hints: ["transient" as const] };
        return { outcome: { kind: "decline", refusal: reason }, dispatch: {
          kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason } }, diagnostics: {} };
      };
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(`${scenario} preserves dispatch uncertainty`);
    });
  }
  for (const probe of ["baseline", "capability", "transport"] as const) {
    it(`${provider}: detects reuse of the first attempt reference in ${probe}`, async () => {
      const subjects = fixture().subjects;
      const first = subjects[0].readbackInput.identity.providerPaymentRef;
      if (first === null) throw new Error("missing remote reference fixture");
      const second = subjects[1];
      const original = second.adapter.attemptPort.execute;
      if (probe === "transport") {
        const transport = second.safety!.transport["timeout-after-dispatch"];
        const execute = transport.execute;
        transport.execute = async () => {
          try { await execute(); } catch { /* Preserve uncertainty with the wrong remote object. */ }
          return { outcome: { kind: "attempt", status: "processing" }, dispatch: { kind: "dispatched", providerPaymentRef: first }, diagnostics: {} };
        };
      } else {
        second.adapter = { ...second.adapter, attemptPort: { ...second.adapter.attemptPort, execute: async input => {
          const result = await original(input);
          return input.attemptRef === second.executionInput.attemptRef && (probe === "baseline" || input !== second.executionInput)
            ? { ...result, dispatch: { kind: "dispatched", providerPaymentRef: first } } : result;
        } } };
      }
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("execution provider payment reference");
    });
  }
  for (const probe of ["capability", "transport"] as const) for (const escaped of [false, true]) {
    it(`${provider}: detects ${escaped ? "escaped" : "raw"} diagnostics leak in ${probe}`, async () => {
      const subjects = fixture().subjects;
    const subject = subjects[0];
      const payer = { email: 'payer"fixture@example.test', name: 'Fixture "Person"' };
      if (probe === "capability") {
        subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.map(input => ({ ...input, payer }));
        const execute = subject.adapter.attemptPort.execute;
        subject.adapter = { ...subject.adapter, attemptPort: { ...subject.adapter.attemptPort, execute: async input => {
          const result = await execute(input);
          return input.payer === payer ? { ...result, diagnostics: { leak: escaped ? JSON.stringify(payer.email).slice(1, -1) : payer.email } } : result;
        } } };
      } else {
        subject.executionInput = { ...subject.executionInput, payer };
        const transport = subject.safety!.transport["timeout-after-dispatch"];
        const execute = transport.execute;
        transport.execute = async () => {
          try { await execute(); } catch { /* Plant diagnostics on the returned failure envelope. */ }
          return { outcome: { kind: "attempt", status: "processing" }, dispatch: { kind: "unknown" },
            diagnostics: { leak: escaped ? JSON.stringify(payer.email).slice(1, -1) : payer.email } };
        };
      }
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("execution diagnostics and taxonomy");
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
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const row = subject.safety!.webhooks[scenario];
    plant(row, subject.safety!.webhooks.valid);
    const verify = subject.adapter.verifyPort.verifyAndNormalize;
    subject.adapter.verifyPort = { verifyAndNormalize: async input => input === row.input ? row.expected : verify(input) };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(error);
  });

  const capabilityPlants: [string, string | RegExp, (subject: PaymentAdapterTestSubject) => void][] = [
    ["providerKind", "verified provider identity", subject => { subject.adapter.capabilities.providerKind = "planted-provider"; }],
    ["assessMandate", "unattended mandate admitted", subject => {
      const original = subject.adapter.capabilities.assessMandate;
      subject.adapter.capabilities.assessMandate = snapshot => ({ chargeable: !original(snapshot).chargeable });
    }],
    ["requiresStoredMandateEvidence", "stored mandate evidence declaration", subject => {
      subject.adapter.capabilities.requiresStoredMandateEvidence = !subject.adapter.capabilities.requiresStoredMandateEvidence;
    }],
    ["unattendedChargeFlow", "unattended flow descriptor", subject => { subject.adapter.capabilities.unattendedChargeFlow = ""; }],
    ["payerContext", /payer context|missing required input/, subject => {
      subject.adapter.capabilities.payerContext = { ...subject.adapter.capabilities.payerContext,
        requiresPayerBlock: !subject.adapter.capabilities.payerContext.requiresPayerBlock };
    }],
    ["methodHealth", "method health descriptor", subject => { subject.adapter.capabilities.methodHealth = { ...subject.adapter.capabilities.methodHealth, requiresCustomerRef: undefined! }; }],
    ["terminalOutcomeReporting", "terminal reporting descriptor", subject => {
      subject.adapter.capabilities.terminalOutcomeReporting = { ...subject.adapter.capabilities.terminalOutcomeReporting, silenceBecomesSuspectAfterMinutes: 0 };
    }],
    ["mandateUpsertIsSubscriptionScoped", "mandate scope descriptor only", subject => { subject.adapter.capabilities.mandateUpsertIsSubscriptionScoped = undefined!; }],
    ["captureFlows", "capture flow", subject => { subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.filter(input => input.methodSelection?.family !== subject.adapter.capabilities.captureFlows[0].methodFamilies[0]); }],
    ["supportedCurrencies", "currency ZZZ", subject => { subject.adapter.capabilities.supportedCurrencies = [...subject.adapter.capabilities.supportedCurrencies, "ZZZ"]; }],
    ["unattended", "mandate assessment fixture", subject => { subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.filter(input => input.purpose !== "renewal-unattended"); }],
    ["readback", "readback capability", subject => { subject.adapter.capabilities.readback = "unsupported"; }],
    ["close", "close method present", subject => { subject.adapter.capabilities.close = "supported"; }],
    ["exactAbsence", "absence port present", subject => { subject.adapter.capabilities.exactAbsence = "supported"; }],
    ["refundObservation", "refund observation capability", subject => { subject.adapter.capabilities.refundObservation = "unsupported"; }],
    ["refundCreate", "refundCreate structurally unsupported", subject => { Object.assign(subject.adapter, { refundCreate: () => {} }); }],
    ["authorizationCaptureSplit", "authorizationCaptureSplit structurally unsupported", subject => { Object.assign(subject.adapter, { authorizationCaptureSplit: () => {} }); }],
  ];
  for (const [capability, error, plant] of capabilityPlants) it(`${provider}: detects undemonstrated ${capability}`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities } };
    plant(subject);
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(error);
  });
}
