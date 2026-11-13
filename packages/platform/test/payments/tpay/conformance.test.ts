import { paymentTestingDefects } from "../testingDefects.testFixtures.js";
import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/testing/index.js";
import { tpaySafetyFixture } from "./conformance.testFixtures.js";

it("passes every named safety case with the extracted scripted HTTP client, JWS and Model O", async () => {
  const fixture = tpaySafetyFixture();
  expect(fixture.subjects[0].adapter.capabilities).toMatchObject({ unattendedChargeFlow: "recurring_charge",
    payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: false },
    methodHealth: { requiresCustomerRef: false, requiredMethodKind: "blik_payid", requiresPayerContact: true },
    terminalOutcomeReporting: { kind: "attempt_records", silenceBecomesSuspectAfterMinutes: 360 },
    mandateUpsertIsSubscriptionScoped: true });
  const report = await runPaymentAdapterConformance(fixture.subjects);
  expect(report.subjects.map(row => row.subjectId)).toEqual(["attempt-a", "attempt-b"]);
  expect(report.cases.filter(row => row.name.includes("capability:"))).toHaveLength(26);
  expect(report.cases.filter(row => row.name.startsWith("host-consumed declaration:"))).toHaveLength(10);
  expect(report.cases.filter(row => row.name.includes("never settles"))).toHaveLength(6);
  expect(report.cases.every(row => row.passed)).toBe(true);
  expect(report.cases.filter(row => row.name === "execution, verification, capability and exact readback")).toHaveLength(2);
  expect(report.subjects.map(row => row.execution.dispatch)).toEqual([{"kind": "dispatched", "providerPaymentRef": "api-a"}, {"kind": "dispatched", "providerPaymentRef": "api-b"}]);
  for (const [index, subject] of report.subjects.entries()) {
    expect(subject.execution.dispatch.kind).toBe("dispatched");
    expect(subject.readback).toMatchObject({ kind: "succeeded", identity: fixture.subjects[index].readbackInput.identity,
      observedMoney: fixture.subjects[index].readbackInput.expectedMoney });
    expect(subject.execution).not.toHaveProperty("handoff");
    expect(JSON.stringify(report)).not.toContain(`https://example.test/pay/${subject.readback.identity.providerPaymentRef}`);
    expect(JSON.stringify(report)).not.toContain("572913");
    expect(JSON.stringify(report)).not.toContain("transient-");
  }
  expect(fixture.subjects[0].adapter.absencePort).toBeUndefined();
  expect(fixture.subjects[0].adapter.readbackPort.close).toBeUndefined();
  expect(fixture.unattendedRequests.length).toBeGreaterThan(0);
  fixture.fake.assertDrained();
});

paymentTestingDefects("tpay", tpaySafetyFixture);
