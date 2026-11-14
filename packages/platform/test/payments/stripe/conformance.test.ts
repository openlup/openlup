import { paymentTestingDefects } from "../testingDefects.testFixtures.js";
import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/testing/index.js";
import { createStripeConformanceFixture, stripeSafetyFixture } from "./conformance.testFixtures.js";

it("passes every named safety case with the extracted scripted client across two currencies and attempts", async () => {
  const fixture = stripeSafetyFixture();
  expect(fixture.subjects[0].adapter.capabilities).toMatchObject({ unattendedChargeFlow: "off_session_payment",
    payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
    methodHealth: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
    terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
    mandateUpsertIsSubscriptionScoped: false });
  const report = await runPaymentAdapterConformance(fixture.subjects);
  expect(report.subjects.map(row => row.subjectId)).toEqual(["attempt-a", "attempt-b"]);
  expect(report.cases.filter(row => row.name.includes("capability:"))).toHaveLength(26);
  expect(report.cases.filter(row => row.name.startsWith("host-consumed declaration:"))).toHaveLength(10);
  expect(report.cases.filter(row => row.name.includes("never settles"))).toHaveLength(6);
  expect(report.cases.every(row => row.passed)).toBe(true);
  expect(report.subjects.map(row => row.execution.dispatch)).toEqual([{"kind": "dispatched", "providerPaymentRef": "pi_a"}, {"kind": "dispatched", "providerPaymentRef": "pi_b"}]);
  for (const [index, subject] of report.subjects.entries()) {
    expect(subject.execution.dispatch.kind).toBe("dispatched");
    expect(subject.readback).toMatchObject({ kind: "failed", identity: fixture.subjects[index].readbackInput.identity,
      observedMoney: fixture.subjects[index].readbackInput.expectedMoney });
    expect(subject.execution).not.toHaveProperty("handoff");
    expect(JSON.stringify(report)).not.toContain("transient_");
  }
  expect(fixture.unattendedRequests.length).toBeGreaterThan(0);
  fixture.fake.assertDrained();
});

it("retains exactly two create and read calls for the baseline subjects", async () => {
  const fixture = createStripeConformanceFixture();
  const report = await runPaymentAdapterConformance(fixture.subjects);
  expect(report.cases).toHaveLength(2);
  expect(fixture.client.createPaymentIntent).toHaveBeenCalledTimes(2);
  expect(fixture.client.retrievePaymentIntent).toHaveBeenCalledTimes(2);
});

it("demonstrates two handoffs for the same family regardless of declaration order", async () => {
  const fixture = stripeSafetyFixture();
  const subject = fixture.subjects[0];
  const { execute } = subject.adapter.attemptPort;
  subject.adapter = { ...subject.adapter, capabilities: { ...subject.adapter.capabilities,
    captureFlows: [{ kind: "redirect-card", handoff: "redirect", methodFamilies: ["card"] }, ...subject.adapter.capabilities.captureFlows] },
  attemptPort: { ...subject.adapter.attemptPort, execute: async input => {
    const result = await execute(input);
    return input.methodSelection?.family === "card" && input.money.currency === "EUR"
      ? { ...result, handoff: { kind: "redirect", url: "https://example.test/authorize" } } : result;
  } } };
  await expect(runPaymentAdapterConformance(fixture.subjects)).resolves.toBeDefined();
});

it("rejects a declared flow family with no capability execution", async () => {
  const fixture = stripeSafetyFixture();
  const subject = fixture.subjects[0];
  subject.safety!.capabilityInputs = subject.safety!.capabilityInputs.filter(input => input.methodSelection?.family !== "wallet");
  await expect(runPaymentAdapterConformance(fixture.subjects)).rejects.toThrow("capture flow card_payment:client-confirmed:wallet");
});

paymentTestingDefects("stripe", stripeSafetyFixture);
