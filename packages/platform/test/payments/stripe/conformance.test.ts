import { paymentTestingDefects } from "../testingDefects.testFixtures.js";
import { expect, it } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/testing/index.js";
import { stripeSafetyFixture } from "./conformance.testFixtures.js";

it("passes every named safety case with the extracted scripted client across two currencies and attempts", async () => {
  const fixture = stripeSafetyFixture();
  const report = await runPaymentAdapterConformance(fixture.subjects);
  expect(report.subjects.map(row => row.subjectId)).toEqual(["attempt-a", "attempt-b"]);
  expect(report.cases.filter(row => row.name.includes("capability:"))).toHaveLength(18);
  expect(report.cases.filter(row => row.name.includes("never settles"))).toHaveLength(6);
  expect(report.cases.every(row => row.passed)).toBe(true);
  for (const subject of report.subjects) {
    expect(subject.execution.dispatch.kind).toBe("dispatched");
    expect(subject.execution).not.toHaveProperty("handoff");
    expect(JSON.stringify(report)).not.toContain("transient_");
  }
  fixture.fake.assertDrained();
});

paymentTestingDefects("stripe", stripeSafetyFixture);
