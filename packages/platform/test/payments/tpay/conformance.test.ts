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
  expect(report.subjects.map(row => row.execution.dispatch)).toEqual([{"kind": "dispatched", "providerPaymentRef": "api-a"}, {"kind": "dispatched", "providerPaymentRef": "api-b"}]);
  for (const subject of report.subjects) {
    expect(subject.execution.dispatch.kind).toBe("dispatched");
    expect(subject.readback.kind).toBe("succeeded");
    expect(JSON.stringify(report)).not.toContain("572913");
    expect(JSON.stringify(report)).not.toContain("transient-");
  }
  expect(fixture.unattendedRequests.length).toBeGreaterThan(0);
  fixture.fake.assertDrained();
});

paymentTestingDefects("tpay", tpaySafetyFixture);
