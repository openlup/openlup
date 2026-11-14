import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import { createCapturedFulfillmentAdapter, runFulfillmentAdapterConformance as run } from "../../src/fulfillment/testing/index.js";
import type { FulfillmentAdapterTestSubject } from "../../src/fulfillment/testing/index.js";
import { request } from "./fixtures.js";

it("types every sync slot with mutually exclusive success and failure roles", () => {
  type Kit = NonNullable<FulfillmentAdapterTestSubject["certification"]>;
  type Row = NonNullable<Kit["stockSync"]>[number] | NonNullable<Kit["productSync"]>[number];
  type AcceptsMixed<R extends Row> = R extends Row ? {
    input: R["success"]["input"]; expected: R["success"]["expected"]; throws: R["failure"]["throws"];
  } extends R["success"] | R["failure"] ? true : false : never;
  expectTypeOf<AcceptsMixed<Row>>().toEqualTypeOf<false>();
  expectTypeOf<Row["success"]>().not.toExtend<Row["failure"]>();
  expectTypeOf<Row["failure"]>().not.toExtend<Row["success"]>();
  type Ensure = Extract<NonNullable<Kit["productSync"]>[number], { operation: "ensureProduct" }>;
  expectTypeOf<Ensure["success"]["expected"]["replayed"]>().toEqualTypeOf<false>();
  expectTypeOf<NonNullable<Kit["paging"]>["failure"]["expected"]["kind"]>().toEqualTypeOf<"failed">();
  expectTypeOf<NonNullable<Kit["paging"]>["exhausted"]["expected"]["kind"]>().toEqualTypeOf<"page_exhausted">();
});

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

it("rejects unknown replay declared on a preparation refusal instead of an executed replay", async () => {
  const subject = capturedSubject(), rows = subject.fixtures.dispatch;
  const unknown = rows.find(row => row.expectedDispatch?.kind === "unknown")!;
  subject.fixtures.dispatch = rows.map(row => row.expectedPrepare.kind === "refused"
    ? { ...row, expectedDispatch: unknown.expectedDispatch, replay: true }
    : { ...row, replay: row === unknown ? false : row.replay });
  await expect(run([subject], { mode: "full" })).rejects.toThrow("refused preparation cannot declare dispatch or replay");
});

it("rejects a dispatch-only adapter that refuses every preparation despite declared dispatch outcomes", async () => {
  const subject = capturedSubject();
  const refused = { kind: "refused" as const, refusal: { reason: "not_dispatchable" as const, phase: "prepare" as const, retryable: false } };
  const prepare = subject.adapter.dispatch.prepare;
  subject.adapter.dispatch.prepare = input => input.selection.providerRef ? Promise.resolve(refused) : prepare(input);
  subject.fixtures.dispatch = subject.fixtures.dispatch.map(row => ({ ...row, expectedPrepare: refused }));
  await expect(run([subject], { mode: "full" })).rejects.toThrow("refused preparation cannot declare dispatch or replay");
});

it.each(["baseline", "full"] as const)("rejects unreachable dispatch expectations and replay flags in %s mode", async mode => {
  for (const declaration of ["expectedDispatch", "replay"] as const) {
    const subject = capturedSubject(), rows = subject.fixtures.dispatch;
    subject.fixtures.dispatch = rows.map(row => row.expectedPrepare.kind === "refused"
      ? { ...row, ...(declaration === "expectedDispatch" ? { expectedDispatch: rows[0]!.expectedDispatch } : { replay: true }) } : row);
    await expect(run([subject], { mode })).rejects.toThrow("refused preparation cannot declare dispatch or replay");
  }
});

it("requires an executed unknown replay even when unknown dispatch itself was compared", async () => {
  const subject = capturedSubject();
  subject.fixtures.dispatch = subject.fixtures.dispatch.map(row => ({ ...row, replay: row.expectedDispatch?.kind === "unknown" ? false : row.replay }));
  await expect(run([subject], { mode: "full" })).rejects.toThrow("full unknown replay required");
});

it.each(["unknown", "not_dispatched"] as const)("rejects a %s discriminant with a contradictory effect flag", async kind => {
  const subject = capturedSubject(), dispatch = subject.adapter.dispatch.dispatch;
  const row = subject.fixtures.dispatch.find(row => row.expectedDispatch?.kind === kind)!;
  Object.assign(row.expectedDispatch!, { effectMayHaveSucceeded: kind !== "unknown" });
  subject.adapter.dispatch.dispatch = async (...input) => {
    const result = await dispatch(...input);
    return result.kind === kind && !input[1].commandFingerprint.endsWith(":mismatch")
      ? Object.assign(result, { effectMayHaveSucceeded: kind !== "unknown" }) : result;
  };
  await expect(run([subject], { mode: "full" })).rejects.toThrow("dispatch fixture contradictory result");
});
