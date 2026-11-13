import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../src/payments/testing/index.js";
import type { PaymentAdapterTestSubject, PaymentTransportScenario, PaymentWebhookFixture } from "../../src/payments/testing/index.js";
import type { PaymentExecutionEnvelope } from "../../src/payments/contracts/index.js";

// Plants are scoped to fresh fixture objects. No production adapter is modified.
export function paymentTestingDefects(provider: string, fixture: () => { subjects: PaymentAdapterTestSubject[] }) {
  it(`${provider}: detects a refused execution reaching a client payload assertion`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const renewal = subject.safety!.capabilityInputs.find(input => input.purpose === "renewal-unattended")!;
    const { execute, validateInput } = subject.adapter.attemptPort;
    const { assessMandate } = subject.adapter.capabilities;
    let requestsBeforePlant = Infinity;
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities,
      assessMandate: mandate => mandate.recurringModel === "unsupported" ? { chargeable: false } : assessMandate(mandate) },
    attemptPort: {
      validateInput(input) {
        if (input.storedMethod?.mandate.recurringModel === "unsupported") throw new Error("refused mandate");
        validateInput(input);
      },
      async execute(input) {
        if (input.storedMethod?.mandate.recurringModel !== "unsupported") return execute(input);
        requestsBeforePlant = subject.safety!.providerRequests();
        await execute({ ...renewal, money: { ...renewal.money, amountMinor: 1 } });
        return exactDecline();
      },
    } };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("assessed mandate refuses execution no provider requests");
    expect(subject.safety!.providerRequests()).toBeGreaterThan(requestsBeforePlant);
  });
  for (const defect of ["dispatch", "unknown refusal"] as const) {
    it(`${provider}: detects unsupported currency ${defect} despite correct validation`, async () => {
      const subjects = fixture().subjects;
      const subject = subjects[0];
      const { execute } = subject.adapter.attemptPort;
      const currency = subject.safety!.unsupportedCurrencyInput.money.currency;
      subject.adapter = { ...subject.adapter, attemptPort: { ...subject.adapter.attemptPort, execute: async input => {
        if (input.money.currency !== currency) return execute(input);
        if (defect === "unknown refusal") return { ...exactDecline(), dispatch: { kind: "unknown" } };
        await execute({ ...input, money: { ...input.money, currency: subject.executionInput.money.currency } });
        return exactDecline();
      } } };
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(defect === "dispatch"
        ? "unsupported currency refuses execution no provider requests" : "unsupported currency refuses execution");
    });
  }
  it(`${provider}: detects validation accepting an unsupported currency`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const { validateInput } = subject.adapter.attemptPort;
    subject.adapter = { ...subject.adapter, attemptPort: { ...subject.adapter.attemptPort,
      validateInput: input => validateInput({ ...input, money: { ...input.money, currency: subject.executionInput.money.currency } }) } };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("unsupported currency refuses before dispatch");
  });
  it(`${provider}: detects an additional undemonstrated flow for an exercised family`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const first = subject.adapter.capabilities.captureFlows[0];
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities,
      captureFlows: [...subject.adapter.capabilities.captureFlows, { kind: "additional-flow",
        handoff: first.handoff === "redirect" ? "client-confirmed" : "redirect", methodFamilies: [first.methodFamilies[0]] }] } };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("capture flow additional-flow:");
  });
  it(`${provider}: detects a successful capture with no declared handoff`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const capture = subject.safety!.capabilityInputs.find(input => input.methodSelection && !input.customerAuthorization)!;
    subject.safety!.capabilityInputs = [...subject.safety!.capabilityInputs, { ...capture }];
    const { execute } = subject.adapter.attemptPort;
    subject.adapter = { ...subject.adapter, attemptPort: { ...subject.adapter.attemptPort, execute: async input => {
      const result = await execute(input);
      return input === capture ? { ...result, handoff: undefined } : result;
    } } };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("capture flow handoff");
  });
  for (const operation of ["close", "absence"] as const) {
    it(`${provider}: detects a present ${operation} port ignoring its unsupported declaration`, async () => {
      const subjects = fixture().subjects;
      const subject = subjects[0];
      subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities },
        readbackPort: { ...subject.adapter.readbackPort } };
      if (operation === "close") subject.adapter.readbackPort.close = async input => ({ ...input, kind: "unknown", reason: "timeout" });
      else {
        subject.absenceInput = { identity: subject.readbackInput.identity, expectedMoney: subject.readbackInput.expectedMoney };
        subject.adapter.absencePort = { proveAbsence: async input => ({ ...input, kind: "unknown", reason: "truncated" }) };
      }
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(operation === "close" ? "close refuses" : "absence capability");
    });
  }
  for (const failure of ["cached exact decline", "throw"] as const) {
    it(`${provider}: detects the first unsupported unattended dispatch before ${failure}`, async () => {
      const subjects = fixture().subjects;
      const subject = subjects[0];
      const renewal = subject.safety!.capabilityInputs.find(input => input.purpose === "renewal-unattended")!;
      const { execute, validateInput } = subject.adapter.attemptPort;
      const refusal = exactDecline();
      let first = true;
      let requestsBeforePlant = Infinity;
      subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities, unattended: "unsupported" },
      attemptPort: {
        validateInput(input) {
          if (input.purpose === "renewal-unattended") throw new Error("unattended unsupported");
          validateInput(input);
        },
        async execute(input) {
          if (input.purpose !== "renewal-unattended") return execute(input);
          if (first) {
            first = false;
            requestsBeforePlant = subject.safety!.providerRequests();
            await execute(renewal);
            if (failure === "throw") throw new Error("failure after provider request");
          }
          return refusal;
        },
      } };
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("unattended typed refusal no provider requests");
      expect(subject.safety!.providerRequests()).toBeGreaterThan(requestsBeforePlant);
    });
  }
  it(`${provider}: rejects an unsupported unattended throw without a provider request`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const { execute } = subject.adapter.attemptPort;
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities, unattended: "unsupported" },
    attemptPort: { ...subject.adapter.attemptPort, execute: async input => {
      if (input.purpose === "renewal-unattended") throw new Error("typed refusal required");
      return execute(input);
    } } };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("typed refusal required");
  });
  for (const failure of ["throw", "exact decline"] as const) {
    it(`${provider}: detects a provider request followed by ${failure} for a refused mandate`, async () => {
      const subjects = fixture().subjects;
      const subject = subjects[0];
      const renewal = subject.safety!.capabilityInputs.find(input => input.purpose === "renewal-unattended")!;
      const { assessMandate } = subject.adapter.capabilities;
      const { execute, validateInput } = subject.adapter.attemptPort;
      const refused = (input: typeof renewal) => input.storedMethod?.mandate.recurringModel === "unsupported";
      let requestsBeforePlant = Infinity;
      subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities,
        assessMandate: mandate => mandate.recurringModel === "unsupported" ? { chargeable: false } : assessMandate(mandate) },
      attemptPort: {
        validateInput(input) { if (refused(input)) throw new Error("refused mandate"); validateInput(input); },
        async execute(input) {
          if (!refused(input)) return execute(input);
          requestsBeforePlant = subject.safety!.providerRequests();
          await execute(renewal);
          if (failure === "throw") throw new Error("failure after provider request");
          return exactDecline();
        },
      } };
      await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("assessed mandate refuses execution no provider requests");
      expect(subject.safety!.providerRequests()).toBeGreaterThan(requestsBeforePlant);
    });
  }
  it(`${provider}: detects a payer requirement enforced only on initial attempts`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const payer = subject.executionInput.payer ?? { email: "payer@example.test", name: "Fixture Person" };
    subject.executionInput = { ...subject.executionInput, payer };
    subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.map(input => ({ ...input, payer: input.payer ?? payer }));
    const { execute, validateInput } = subject.adapter.attemptPort;
    subject.safety!.missingRequiredInput = { ...subject.executionInput, payer: undefined };
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities,
      payerContext: { ...subject.adapter.capabilities.payerContext, requiresPayerBlock: true } },
    attemptPort: {
      validateInput(input) {
        if (!input.payer && input.purpose === "initial") throw new Error("payer required");
        validateInput({ ...input, payer: input.payer ?? payer });
      },
      execute: input => !input.payer && input.purpose === "initial" ? Promise.resolve(exactDecline())
        : execute({ ...input, payer: input.payer ?? payer }),
    } };
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow("payer context required no provider requests");
  });
  it(`${provider}: records the payer proof as not applicable when unattended is unsupported`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    const { execute, validateInput } = subject.adapter.attemptPort;
    let missingPayerProbes = 0;
    subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.map(input => input.purpose === "renewal-unattended"
      ? { ...input, payer: input.payer ?? { email: "payer@example.test" } } : input);
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities, unattended: "unsupported",
      payerContext: { ...subject.adapter.capabilities.payerContext, requiresPayerBlock: true } },
    attemptPort: {
      validateInput(input) {
        if (input.purpose === "renewal-unattended") throw new Error("unattended unsupported");
        validateInput(input);
      },
      execute(input) {
        if (input.purpose === "renewal-unattended" && !input.payer) missingPayerProbes++;
        return input.purpose === "renewal-unattended" ? Promise.resolve(exactDecline()) : execute(input);
      },
    } };
    const report = await runPaymentAdapterConformance(subjects);
    expect(report.cases.some(row => row.name === "capability:payerContext.requiresPayerBlock:not applicable (unattended unsupported)"
      && row.passed)).toBe(true);
    expect(missingPayerProbes).toBe(0);
  });
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
    ["payerContext.requiresPayerBlock", /payer context|missing required input/, subject => {
      subject.adapter.capabilities.payerContext = { ...subject.adapter.capabilities.payerContext,
        requiresPayerBlock: !subject.adapter.capabilities.payerContext.requiresPayerBlock };
    }],
    ["captureFlows", "capture flow", subject => { subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.filter(input => !subject.adapter.capabilities.captureFlows[0].methodFamilies.some(family => family === input.methodSelection?.family)); }],
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
  const wellFormednessPlants: [string, (subject: PaymentAdapterTestSubject) => void][] = [
    ["unattendedChargeFlow", subject => { subject.adapter.capabilities.unattendedChargeFlow = ""; }],
    ["payerContext.customerRefFallsBackToContactEmail", subject => {
      subject.adapter.capabilities.payerContext = { ...subject.adapter.capabilities.payerContext, customerRefFallsBackToContactEmail: undefined! };
    }],
    ["methodHealth", subject => { subject.adapter.capabilities.methodHealth = { ...subject.adapter.capabilities.methodHealth, requiresCustomerRef: undefined! }; }],
    ["terminalOutcomeReporting", subject => {
      subject.adapter.capabilities.terminalOutcomeReporting = { ...subject.adapter.capabilities.terminalOutcomeReporting, silenceBecomesSuspectAfterMinutes: 0 };
    }],
    ["mandateUpsertIsSubscriptionScoped", subject => { subject.adapter.capabilities.mandateUpsertIsSubscriptionScoped = undefined!; }],
  ];
  for (const [declaration, plant] of wellFormednessPlants) it(`${provider}: well-formedness plant for host-consumed declaration ${declaration}`, async () => {
    const subjects = fixture().subjects;
    const subject = subjects[0];
    subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities } };
    plant(subject);
    await expect(runPaymentAdapterConformance(subjects)).rejects.toThrow(`host-consumed declaration:${declaration} well-formedness`);
  });
}

function exactDecline(): PaymentExecutionEnvelope {
  const reason = { code: "fix_and_retry_customer_action" as const, hints: ["dataInvalid" as const] };
  return { outcome: { kind: "decline", refusal: reason },
    dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason } }, diagnostics: {} };
}
