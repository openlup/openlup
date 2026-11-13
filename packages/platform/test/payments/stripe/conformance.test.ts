import { paymentTestingDefects } from "../testingDefects.testFixtures.js";
import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/testing/index.js";
import { stripeSafetyFixture } from "./conformance.testFixtures.js";

it("passes every named safety case with the extracted scripted client across two currencies and attempts", async () => {
  const fixture = stripeSafetyFixture();
  expect(fixture.subjects[0].adapter.capabilities).toMatchObject({ unattendedChargeFlow: "off_session_payment",
    payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
    methodHealth: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
    terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
    mandateUpsertIsSubscriptionScoped: false });
  const report = await runPaymentAdapterConformance(fixture.subjects);
  expect(report.subjects.map(row => row.subjectId)).toEqual(["attempt-a", "attempt-b"]);
  expect(report.cases.filter(row => row.name.includes("capability:"))).toHaveLength(34);
  expect(report.cases.filter(row => row.name.includes("never settles"))).toHaveLength(6);
  expect(report.cases.every(row => row.passed)).toBe(true);
  expect(report.subjects.map(row => row.execution.dispatch)).toEqual([{"kind": "dispatched", "providerPaymentRef": "pi_a"}, {"kind": "dispatched", "providerPaymentRef": "pi_b"}]);
  for (const subject of report.subjects) {
    expect(subject.execution.dispatch.kind).toBe("dispatched");
    expect(subject.execution).not.toHaveProperty("handoff");
    expect(JSON.stringify(report)).not.toContain("transient_");
  }
  expect(fixture.unattendedRequests.length).toBeGreaterThan(0);
  fixture.fake.assertDrained();
});

paymentTestingDefects("stripe", stripeSafetyFixture);
