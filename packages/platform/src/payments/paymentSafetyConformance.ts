import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import type { PaymentAdapterCapabilities, PaymentExecutionEnvelope } from "./contracts/adapter.js";
import { createVerifiedPaymentIngress } from "./verifiedIngress.js";
import { projectVerifiedEvidence } from "./verifiedEvidenceProjection.js";
import type { PaymentAdapterTestSubject, PaymentWebhookFixture } from "./paymentTestingScenarios.js";

/** The original conformance runner owns these optional, named safety probes. */
export async function runPaymentSafetyConformance(subject: PaymentAdapterTestSubject): Promise<string[]> {
  const { safety, adapter } = subject;
  if (!safety) return [];
  const names: string[] = [];
  const check = async (name: string, proof: () => void | Promise<void>) => {
    await proof(); names.push(name);
  };
  const capabilities = adapter.capabilities;
  const executions: PaymentAdapterTestSubject["executionInput"][] = [];
  for (const input of safety.capabilityInputs) {
    if (input.purpose === "renewal-unattended" && capabilities.unattended === "unsupported") {
      const result = await adapter.attemptPort.execute(input);
      requireFact(result.outcome.kind === "decline" && result.dispatch.kind === "notDispatched"
        && result.dispatch.evidence.exact, "unattended typed refusal");
      continue;
    }
    adapter.attemptPort.validateInput(input);
    const result = await adapter.attemptPort.execute(input);
    requireFact(result.dispatch.kind === "dispatched" && result.outcome.kind === "attempt", "capability execution dispatched");
    if (input.purpose !== "renewal-unattended") {
      const flow = capabilities.captureFlows.find(row => row.methodFamilies.includes(input.methodSelection!.family));
      requireFact(flow !== undefined, "capture flow declared");
      requireFact(flow!.handoff === "customer-authorization" ? Boolean(input.customerAuthorization)
        : result.handoff?.kind === flow!.handoff, "capture flow handoff");
    }
    executions.push(input);
  }
  // Adding an overlay field requires a typed proof here, without another registry.
  type Overlay = Omit<PaymentAdapterCapabilities, keyof Omit<PaymentProviderCapabilityDescriptor, "captureFlows">>;
  const proofs: Record<keyof Overlay, () => void | Promise<void>> = {
    captureFlows: () => {
      for (const flow of capabilities.captureFlows) for (const family of flow.methodFamilies) {
        requireFact(executions.some(input => input.purpose !== "renewal-unattended"
          && input.methodSelection?.family === family), `capture flow ${flow.kind}:${family}`);
      }
    },
    supportedCurrencies: () => {
      requireFact(capabilities.supportedCurrencies.length > 0, "declared currencies");
      for (const currency of capabilities.supportedCurrencies) {
        requireFact(executions.some(input => input.money.currency === currency), `currency ${currency}`);
      }
      const input = safety.unsupportedCurrencyInput;
      requireFact(!capabilities.supportedCurrencies.includes(input.money.currency), "unsupported currency fixture");
      let refused = false;
      try { adapter.attemptPort.validateInput(input); } catch { refused = true; }
      requireFact(refused, "unsupported currency refuses before dispatch");
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
  for (const [name, proof] of Object.entries(proofs)) await check(`capability:${name}`, proof);
  if (capabilities.payerContext.requiresPayerBlock) {
    await check("missing required input exact notDispatched", async () => {
      requireFact(safety.missingRequiredInput !== undefined && !safety.missingRequiredInput.payer, "missing payer fixture");
      const result = await adapter.attemptPort.execute(safety.missingRequiredInput!);
      requireFact(result.outcome.kind === "decline" && result.dispatch.kind === "notDispatched"
        && result.dispatch.evidence.exact && result.dispatch.evidence.phase === "before-dispatch", "missing required input exact notDispatched");
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
