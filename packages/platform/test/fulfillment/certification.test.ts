import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createCapturedFulfillmentAdapter, runFulfillmentAdapterConformance as run } from "../../src/fulfillment/testing/index.js";
import type { FulfillmentAdapterTestSubject } from "../../src/fulfillment/testing/index.js";
import { request } from "./fixtures.js";

function capturedSubject(): FulfillmentAdapterTestSubject {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(value) ?? "null";
  const captures = ["accepted", "unknown", "not_dispatched"].map((kind, index) => ({ request: { ...request(), requestKey: `request-${index}` },
    outcome: kind === "accepted" ? { kind: "accepted" as const, externalRef: "external-a" } : { kind: kind as "unknown" | "not_dispatched" } }));
  const adapter = createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", selected: true, captures });
  return { subjectId: "captured-dispatch", adapter, readIoCount: adapter.readSubmissionCount, sensitiveValues: ["Example"], certification: { profile: "dispatch-only" },
    fixtures: { dispatch: [...captures.map(capture => {
      const commandFingerprint = createHash("sha256").update(canonical(capture.request)).digest("hex");
      const evidence = { commandFingerprint, contactRevision: capture.request.contactRevision, providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a" };
      return { input: capture.request, expectedPrepare: { kind: "prepared" as const, evidence }, replay: true,
        expectedDispatch: capture.outcome.kind === "accepted" ? { kind: "accepted" as const, externalRef: "external-a", evidence,
          providerAttemptKey: `captured-attempt:${commandFingerprint}`, labelKey: `captured-receipt:${commandFingerprint}` }
          : capture.outcome.kind === "unknown" ? { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: { reason: "io_failure" as const, phase: "dispatch" as const, retryable: true } }
            : { kind: "not_dispatched" as const, effectMayHaveSucceeded: false as const, refusal: { reason: "not_dispatchable" as const, phase: "dispatch" as const, retryable: false } } };
    }), { input: { ...request(), lines: [] }, expectedPrepare: { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } } }] } };
}

it("qualifies the captured adapter only for its dispatch profile, including unknown replay", async () => {
  const result = await run([capturedSubject()], { mode: "full" });
  expect(result.cases.at(-1)?.operation).toBe("full:dispatch-only (no other capability certified)");
  expect(result.cases.some(row => row.operation.includes("paging"))).toBe(false);
});

it("retains baseline callers and fails full qualification on omitted fixtures or an inflated profile", async () => {
  const baseline = capturedSubject(); delete baseline.certification;
  await expect(run([baseline])).resolves.toHaveProperty("subjects");
  await expect(run([baseline], { mode: "full" })).rejects.toThrow("full certification fixtures required");
  await expect(run([], { mode: "full" })).rejects.toThrow("full subjects required");
  const missing = capturedSubject(); missing.fixtures.dispatch = missing.fixtures.dispatch.filter(row => row.expectedDispatch?.kind !== "unknown");
  await expect(run([missing], { mode: "full" })).rejects.toThrow("unknown replay required");
  const inflated = capturedSubject(); inflated.adapter.capabilities.operations = { ...inflated.adapter.capabilities.operations, pickupPoint: { supported: true } };
  await expect(run([inflated], { mode: "full" })).rejects.toThrow("dispatch-only capability profile");
});
