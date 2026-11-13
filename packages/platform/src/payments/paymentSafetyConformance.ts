import { validatePaymentExecutionContractResult } from "@openlup/core/testing";
import type { PaymentAdapterCapabilities, PaymentExecutionEnvelope } from "./contracts/adapter.js";
import { createVerifiedPaymentIngress } from "./verifiedIngress.js";
import { projectVerifiedEvidence } from "./verifiedEvidenceProjection.js";
import type { PaymentAdapterTestSubject, PaymentWebhookFixture } from "./paymentTestingScenarios.js";

/** The original conformance runner owns these optional, named safety probes. */
export async function runPaymentSafetyConformance(subject: PaymentAdapterTestSubject, subjects: readonly PaymentAdapterTestSubject[]): Promise<string[]> {
  const { safety, adapter } = subject;
  if (!safety) return [];
  const names: string[] = [];
  const check = async (name: string, proof: () => void | Promise<void>) => {
    await proof(); names.push(name);
  };
  const capabilities = adapter.capabilities;
  const executions: PaymentAdapterTestSubject["executionInput"][] = [];
  const demonstratedPairs = new Map<PaymentAdapterCapabilities["captureFlows"][number], Set<string>>();
  const execute = async (input: PaymentAdapterTestSubject["executionInput"]) => {
    const owner = subjects.find(row => row.executionInput.intentRef === input.intentRef
      && row.executionInput.attemptRef === input.attemptRef);
    requireFact(owner !== undefined, "capability execution subject present");
    const result = await adapter.attemptPort.execute(input);
    assertPaymentExecution(owner!, input, result);
    return result;
  };
  const refuses = async (input: PaymentAdapterTestSubject["executionInput"], label: string) => {
    const before = safety.providerRequests();
    let result: PaymentExecutionEnvelope;
    try { result = await adapter.attemptPort.execute(input); }
    catch { return; }
    finally { requireFact(safety.providerRequests() === before, `${label} no provider requests`); }
    assertPaymentExecution(subject, input, result);
    requireFact(result.outcome.kind === "decline" && result.dispatch.kind === "notDispatched"
      && result.dispatch.evidence.exact && result.dispatch.evidence.phase === "before-dispatch", label);
  };
  for (const input of safety.capabilityInputs) {
    if (input.purpose === "renewal-unattended" && capabilities.unattended === "unsupported") {
      const before = safety.providerRequests();
      let result: PaymentExecutionEnvelope;
      try { result = await execute(input); }
      finally { requireFact(safety.providerRequests() === before, "unattended typed refusal no provider requests"); }
      requireFact(result.outcome.kind === "decline" && result.dispatch.kind === "notDispatched"
        && result.dispatch.evidence.exact && result.dispatch.evidence.phase === "before-dispatch", "unattended typed refusal");
      continue;
    }
    if (input.purpose === "renewal-unattended") requireFact(capabilities.assessMandate(input.storedMethod?.mandate ?? {}).chargeable,
      "unattended mandate admitted");
    adapter.attemptPort.validateInput(input);
    const result = await execute(input);
    requireFact(result.dispatch.kind === "dispatched" && result.outcome.kind === "attempt", "capability execution dispatched");
    if (input.purpose !== "renewal-unattended") {
      const flows = capabilities.captureFlows.filter(row => row.methodFamilies.includes(input.methodSelection!.family));
      requireFact(flows.length > 0, "capture flow declared");
      const matched = flows.filter(flow => flow.handoff === "customer-authorization" ? Boolean(input.customerAuthorization)
        : result.handoff?.kind === flow.handoff);
      requireFact(matched.length > 0, "capture flow handoff");
      matched.forEach(flow => {
        const families = demonstratedPairs.get(flow) ?? new Set<string>();
        families.add(input.methodSelection!.family);
        demonstratedPairs.set(flow, families);
      });
    }
    executions.push(input);
  }
  // Every key, inherited or local, requires an explicit check when the type grows.
  // The five host-consumed declarations get well-formedness checks only;
  // adapter witnesses pin their values, without demonstrating host behavior.
  const proofs: Record<keyof PaymentAdapterCapabilities, () => void | Promise<void>> = {
    providerKind: async () => {
      const evidence = await adapter.verifyPort.verifyAndNormalize(safety.webhooks.valid.input);
      requireFact(evidence.kind !== "refusal" && evidence.provider === capabilities.providerKind
        && subject.readbackInput.identity.provider === capabilities.providerKind, "provider identity");
    },
    assessMandate: async () => {
      const renewal = safety.capabilityInputs.find(input => input.purpose === "renewal-unattended");
      requireFact(renewal?.storedMethod !== undefined, "mandate assessment fixture");
      for (const mandate of [renewal!.storedMethod!.mandate, {}, { recurringModel: null }, { recurringModel: "O" }, { recurringModel: "A" }, { recurringModel: "unsupported" }]) {
        const assessment = capabilities.assessMandate(mandate);
        const input = { ...renewal!, storedMethod: { reference: renewal!.storedMethod!.reference, mandate } };
        if (assessment.chargeable && capabilities.unattended === "supported") {
          let validated = true;
          try { adapter.attemptPort.validateInput(input); } catch { validated = false; }
          requireFact(validated, "assessed mandate admitted validation");
          const result = await execute(input);
          requireFact(result.dispatch.kind === "dispatched" && result.outcome.kind === "attempt", "assessed mandate admitted");
        } else {
          let validated = true;
          try { adapter.attemptPort.validateInput(input); } catch { validated = false; }
          requireFact(!validated, "assessed mandate refuses validation");
          await refuses(input, "assessed mandate refuses execution");
        }
      }
    },
    requiresStoredMandateEvidence: async () => {
      const renewal = safety.capabilityInputs.find(input => input.purpose === "renewal-unattended");
      requireFact(renewal?.storedMethod !== undefined, "stored mandate fixture");
      const input = { ...renewal!, storedMethod: { reference: renewal!.storedMethod!.reference, mandate: {} } };
      const assessment = capabilities.assessMandate({});
      requireFact(capabilities.requiresStoredMandateEvidence ? !assessment.chargeable
        : assessment.chargeable === capabilities.assessMandate(renewal!.storedMethod!.mandate).chargeable, "stored mandate evidence declaration");
      if (capabilities.requiresStoredMandateEvidence) await refuses(input, "stored mandate evidence required");
      else if (capabilities.unattended === "supported" && assessment.chargeable) requireFact((await execute(input)).dispatch.kind === "dispatched", "stored mandate evidence unnecessary");
    },
    unattendedChargeFlow: () => requireFact(typeof capabilities.unattendedChargeFlow === "string"
      && capabilities.unattendedChargeFlow.trim().length > 0, "host-consumed declaration:unattendedChargeFlow well-formedness"),
    payerContext: async () => {
      await check("host-consumed declaration:payerContext.customerRefFallsBackToContactEmail well-formedness", () => {
        requireFact(typeof capabilities.payerContext.customerRefFallsBackToContactEmail === "boolean",
          "host-consumed declaration:payerContext.customerRefFallsBackToContactEmail well-formedness");
      });
      if (capabilities.unattended === "unsupported") return;
      const renewal = safety.capabilityInputs.find(input => input.purpose === "renewal-unattended");
      requireFact(renewal !== undefined, "payer context unattended fixture");
      const input = { ...renewal!, payer: undefined };
      if (capabilities.payerContext.requiresPayerBlock) await refuses(input, "payer context required");
      else {
        let validated = true;
        try { adapter.attemptPort.validateInput(input); } catch { validated = false; }
        requireFact(validated, "payer context optional validation");
        requireFact((await execute(input)).dispatch.kind === "dispatched", "payer context optional");
      }
    },
    methodHealth: () => requireFact(typeof capabilities.methodHealth.requiresCustomerRef === "boolean"
      && typeof capabilities.methodHealth.requiresPayerContact === "boolean"
      && (capabilities.methodHealth.requiredMethodKind === null || typeof capabilities.methodHealth.requiredMethodKind === "string"), "host-consumed declaration:methodHealth well-formedness"),
    terminalOutcomeReporting: () => requireFact(["status_field", "attempt_records", "inbound_event"].includes(capabilities.terminalOutcomeReporting.kind)
      && Number.isFinite(capabilities.terminalOutcomeReporting.silenceBecomesSuspectAfterMinutes)
      && capabilities.terminalOutcomeReporting.silenceBecomesSuspectAfterMinutes > 0, "host-consumed declaration:terminalOutcomeReporting well-formedness"),
    mandateUpsertIsSubscriptionScoped: () => requireFact(typeof capabilities.mandateUpsertIsSubscriptionScoped === "boolean", "host-consumed declaration:mandateUpsertIsSubscriptionScoped well-formedness"),
    captureFlows: () => {
      for (const flow of capabilities.captureFlows) {
        for (const family of flow.methodFamilies) {
          requireFact(demonstratedPairs.get(flow)?.has(family) === true, `capture flow ${flow.kind}:${flow.handoff}:${family}`);
        }
      }
    },
    supportedCurrencies: async () => {
      requireFact(capabilities.supportedCurrencies.length > 0, "declared currencies");
      for (const currency of capabilities.supportedCurrencies) {
        requireFact(executions.some(input => input.money.currency === currency), `currency ${currency}`);
      }
      const input = safety.unsupportedCurrencyInput;
      requireFact(!capabilities.supportedCurrencies.includes(input.money.currency), "unsupported currency fixture");
      let refused = false;
      try { adapter.attemptPort.validateInput(input); } catch { refused = true; }
      requireFact(refused, "unsupported currency refuses before dispatch");
      await refuses(input, "unsupported currency refuses execution");
    },
    unattended: () => requireFact(capabilities.unattended === "supported"
      ? executions.some(input => input.purpose === "renewal-unattended")
      : safety.capabilityInputs.some(input => input.purpose === "renewal-unattended"), "unattended demonstrated"),
    // Readback/close/absence are invoked and checked by the baseline runner.
    readback: () => {}, close: () => {}, exactAbsence: () => {},
    refundObservation: async () => {
      const result = await adapter.verifyPort.verifyAndNormalize(safety.webhooks.chargeback.input);
      requireFact(capabilities.refundObservation === "supported"
        ? result.kind === "money" && (result.outcome === "refunded" || result.outcome === "disputed")
        : result.kind === "refusal" && result.reason === "unsupported-event", "refund observation capability");
    },
    refundCreate: () => absentOperation("refundCreate"),
    authorizationCaptureSplit: () => absentOperation("authorizationCaptureSplit"),
  };
  function absentOperation(name: "refundCreate" | "authorizationCaptureSplit") {
    requireFact(capabilities[name] === "unsupported" && ![adapter, adapter.attemptPort, adapter.readbackPort]
      .some(port => name in port), `${name} structurally unsupported`);
  }
  const hostConsumed = ["unattendedChargeFlow", "methodHealth", "terminalOutcomeReporting", "mandateUpsertIsSubscriptionScoped"];
  for (const [name, proof] of Object.entries(proofs)) {
    const label = hostConsumed.includes(name) ? `host-consumed declaration:${name} well-formedness`
      : name === "payerContext" ? `capability:payerContext.requiresPayerBlock${capabilities.unattended === "unsupported" ? ":not applicable (unattended unsupported)" : ""}`
        : `capability:${name}`;
    await check(label, proof);
  }
  if (capabilities.unattended === "supported" && capabilities.payerContext.requiresPayerBlock) {
    await check("missing required input exact notDispatched", async () => {
      requireFact(safety.missingRequiredInput !== undefined && !safety.missingRequiredInput.payer, "missing payer fixture");
      await refuses(safety.missingRequiredInput!, "missing required input exact notDispatched");
    });
  }
  for (const name of ["timeout-before-dispatch", "provider-5xx-before-dispatch", "timeout-after-dispatch", "redelivery-409"] as const) {
    const fixture = safety.transport[name];
    requireFact(typeof fixture?.execute === "function", `${name} fixture present`);
    await check(name, async () => {
      // Existing adapters may propagate network errors to the host. Do not turn
      // that into a new no-charge or retry claim in a test helper.
      const before = fixture.calls.length;
      let result: PaymentExecutionEnvelope | undefined;
      try { result = await fixture.execute(); } catch { /* Host owns thrown network failures. */ }
      const kind = name === "provider-5xx-before-dispatch" ? "provider-5xx" : name;
      requireFact(fixture.calls.length > before && fixture.calls.at(-1)?.kind === kind, `${name} scripted fault exercised`);
      if (!result) return;
      requireFact(result.outcome.kind === "decline" || ["pending", "processing", "requires_action", "failed"]
        .includes(result.outcome.status), `${name} never success`);
      if (name === "timeout-after-dispatch" || name === "redelivery-409") {
        requireFact(result.dispatch.kind !== "notDispatched", `${name} preserves dispatch uncertainty`);
      }
      assertPaymentExecution(subject, subject.executionInput, result);
    });
  }
  const fixtures = safety.webhooks;
  const verify = async (fixture: PaymentWebhookFixture) => {
    const evidence = await adapter.verifyPort.verifyAndNormalize(fixture.input);
    requireFact(JSON.stringify(evidence) === JSON.stringify(fixture.expected), "safety verified fixture");
    if (evidence.kind === "money" && evidence.money) {
      requireFact(capabilities.supportedCurrencies.includes(evidence.money.currency), "settling currency declared");
    }
    return evidence;
  };
  // This in-memory host proves ingress calls and replay identity only. Durable
  // idempotency remains the store's conformance obligation.
  const events = new Map<string, string>();
  const applied = new Set<string>();
  let ingests = 0;
  let conflict = false;
  const ingress = createVerifiedPaymentIngress({ provider: capabilities.providerKind, verifyPort: adapter.verifyPort,
    paymentControlPort: {
      async ingestPaymentEvent(event) {
        ingests++;
        if (conflict) throw new Error("commerce_idempotency_conflict");
        const evidence = event.rawPayload.openlupEvidence as { fingerprint: string };
        const previous = events.get(event.providerEventId);
        if (previous && previous !== evidence.fingerprint) throw new Error("commerce_idempotency_conflict");
        events.set(event.providerEventId, evidence.fingerprint);
        return { paymentEventId: event.providerEventId, paymentIntentId: subject.executionInput.intentRef,
          paymentAttemptId: subject.executionInput.attemptRef, replayed: previous !== undefined };
      },
      async applyPaymentResult(input) {
        const replayed = applied.has(input.idempotencyKey);
        applied.add(input.idempotencyKey);
        return { replayed };
      },
    } });
  const valid = await verify(fixtures.valid);
  requireFact(valid.kind === "money" && valid.money !== null, "valid money fixture");
  await check("duplicate webhook replay identity and one effect", async () => {
    const duplicate = await verify(fixtures.duplicate);
    requireFact(duplicate.kind !== "refusal" && valid.kind !== "refusal"
      && duplicate.providerEventId === valid.providerEventId && duplicate.fingerprint === valid.fingerprint, "duplicate identity");
    requireFact((await ingress.receive(fixtures.valid.input)).status === 200, "first webhook accepted");
    const replay = await ingress.receive(fixtures.duplicate.input);
    requireFact(replay.status === 200 && replay.data.replayed === true && events.size === 1 && applied.size === 1, "duplicate one effect");
  });
  await check("409 on redelivery preserves replay identity", async () => {
    conflict = true;
    requireFact((await ingress.receive(fixtures.duplicate.input)).status === 409, "409 conflict retained");
    conflict = false;
    const replay = await ingress.receive(fixtures.duplicate.input);
    requireFact(replay.status === 200 && replay.data.replayed === true && applied.size === 1, "redelivery replays after conflict");
  });
  await check("signature mismatch persists nothing", async () => {
    const result = await verify(fixtures.signatureMismatch);
    requireFact(result.kind === "refusal" && result.reason === "signature", "signature refusal");
    const before = ingests;
    requireFact((await ingress.receive(fixtures.signatureMismatch.input)).status === 400 && before === ingests, "signature no persistence");
  });
  await check("partial amount exact money", async () => {
    const evidence = await verify(fixtures.partialAmount);
    requireFact(evidence.kind === "money" && evidence.money !== null, "partial money present");
    if (evidence.kind !== "money" || !evidence.money) return;
    const money = evidence.refund && "refundedMoney" in evidence.refund ? evidence.refund.refundedMoney : evidence.money;
    requireFact(money.amountMinor === safety.partialMoney.amountMinor && money.currency === safety.partialMoney.currency
      && money.amountMinor > 0 && valid.kind === "money" && money.amountMinor < valid.money!.amountMinor, "partial exact money");
    if (evidence.refund) requireFact(projectVerifiedEvidence(evidence, fixtures.partialAmount.input, "require-evidence").refundKind === "partial", "partial refund classification");
  });
  for (const name of ["zeroAmount", "missingAmount", "missingCurrency"] as const) {
    await check(`${name} never settles invented money`, async () => {
      const evidence = await verify(fixtures[name]);
      const declaredBinding = name === "missingCurrency" && capabilities.supportedCurrencies.length === 1;
      if (declaredBinding && evidence.kind === "money" && evidence.money !== null) {
        requireFact(evidence.money.currency === capabilities.supportedCurrencies[0], "single declared currency binding");
        return;
      }
      requireFact(evidence.kind === "refusal" || evidence.kind === "money" && (evidence.money === null
        || !["succeeded", "refunded", "disputed"].includes(evidence.outcome)), "invalid money unusable");
      const before = ingests;
      const response = await ingress.receive(fixtures[name].input);
      requireFact(response.status !== 200 && before === ingests, "invalid settling money never persisted");
    });
  }
  await check("chargeback distinct event on same payment", async () => {
    const evidence = await verify(fixtures.chargeback);
    if (capabilities.refundObservation === "unsupported") {
      requireFact(evidence.kind === "refusal" && evidence.reason === "unsupported-event", "chargeback typed refusal");
      return;
    }
    requireFact(evidence.kind === "money" && valid.kind === "money" && evidence.providerPaymentRef === valid.providerPaymentRef
      && evidence.providerEventId !== valid.providerEventId && evidence.fingerprint !== valid.fingerprint
      && ["refunded", "disputed"].includes(evidence.outcome), "chargeback identity and refund class");
  });
  return names;
}
function requireFact(value: boolean, label: string): void {
  if (!value) throw new Error(`payment_adapter_conformance:${label}`);
}

/** Shared by baseline, capability, refusal and transport executions. */
export function assertPaymentExecution(subject: PaymentAdapterTestSubject,
  input: PaymentAdapterTestSubject["executionInput"], result: PaymentExecutionEnvelope): void {
  if (result.dispatch.kind === "dispatched") requireFact(result.dispatch.providerPaymentRef === subject.readbackInput.identity.providerPaymentRef,
    "execution provider payment reference");
  const { handoff } = result;
  const forms = (values: (string | undefined)[]) => values.filter((value): value is string => Boolean(value?.length))
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  const sensitive = forms([input.payer?.email, input.payer?.name, input.customerAuthorization,
    handoff?.kind === "client-confirmed" ? handoff.payload : handoff?.url]);
  const validation = validatePaymentExecutionContractResult({
    input: { idempotencyKey: input.attemptRef, providerIdempotencyKey: input.providerIdempotencyKey,
      providerRequestFingerprint: input.fingerprint, paymentIntentId: input.intentRef,
      amountMinor: input.money.amountMinor, currency: input.money.currency, mode: "one_time" },
    expectedProvider: subject.adapter.capabilities.providerKind, sensitiveValues: sensitive,
    result: { provider: subject.adapter.capabilities.providerKind,
      providerAttemptId: result.dispatch.kind === "dispatched" ? result.dispatch.providerPaymentRef : null,
      providerSessionId: null, attemptStatus: result.outcome.kind === "attempt" ? result.outcome.status : "processing",
      nextActionKind: null, requestPayload: { providerIdempotencyKey: input.providerIdempotencyKey,
        providerRequestFingerprint: input.fingerprint }, responsePayload: result.diagnostics },
  });
  requireFact(validation.ok && !Object.values(result.diagnostics).some(value => typeof value === "string"
    && sensitive.some(secret => value.includes(secret))), "execution diagnostics and taxonomy");
  requireFact(!forms([input.payer?.email, input.payer?.name]).some(value => JSON.stringify(result).includes(value)), "execution payer redaction");
}
