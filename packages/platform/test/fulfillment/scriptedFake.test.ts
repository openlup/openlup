import { expect, it } from "vitest";
import { createScriptedFulfillmentFake, ScriptedFulfillmentTransportError } from "../../src/fulfillment/testing/index.js";

it("keeps independent operation FIFOs, refuses missing scripts and drains without recording values", async () => {
  const fake = createScriptedFulfillmentFake<{ submit: string; read: number }>();
  fake.enqueue("submit", { kind: "success", value: "private-response" }, { kind: "success", value: "next" });
  fake.enqueue("read", { kind: "success", value: 4 });
  expect(() => fake.assertDrained()).toThrow("unconsumed:submit:2");
  expect(await fake.invoke("read")).toBe(4);
  expect(await fake.invoke("submit")).toBe("private-response");
  expect(await fake.invoke("submit")).toBe("next");
  await expect(fake.invoke("submit")).rejects.toThrow("unscripted:submit");
  fake.assertDrained();
  expect(fake.calls).toEqual([{ call: "read", kind: "success" }, { call: "submit", kind: "success" }, { call: "submit", kind: "success" }]);
  expect(JSON.stringify(fake.calls)).not.toContain("private-response");
});

it("returns injected HTTP failures and retains transport uncertainty without performing I/O", async () => {
  const fake = createScriptedFulfillmentFake<{ submit: Response }>();
  const response = new Response("{}", { status: 503 });
  fake.enqueue("submit", { kind: "http-failure", status: 503, response }, { kind: "http-failure", status: 502 },
    { kind: "transport-before-submission" }, { kind: "transport-after-submission" });
  expect(await fake.invoke("submit")).toBe(response);
  await expect(fake.invoke("submit")).rejects.toMatchObject({ status: 502 });
  await expect(fake.invoke("submit")).rejects.toMatchObject({ name: "AbortError", submissionAttempted: false, mayHaveSucceeded: false });
  await expect(fake.invoke("submit")).rejects.toMatchObject({ name: "AbortError", submissionAttempted: true, mayHaveSucceeded: true });
  expect(new ScriptedFulfillmentTransportError("transport-after-submission")).toBeInstanceOf(Error);
  fake.assertDrained();
});

it("audit 13 exposes immutable snapshots while its authenticated fault log stays private", async () => {
  const fake = createScriptedFulfillmentFake<{ submit: string }>(), handle = fake.calls;
  expect(Object.isFrozen(fake)).toBe(true);
  expect(Reflect.set(fake, "invoke", async () => "forged")).toBe(false);
  expect(Reflect.defineProperty(fake, "calls", { value: [] })).toBe(false);
  expect(() => (handle as unknown as unknown[]).push({ kind: "transport-after-submission" })).toThrow();
  fake.enqueue("submit", { kind: "success", value: "response" }); await fake.invoke("submit");
  expect(handle).toHaveLength(0); expect(fake.calls).toEqual([{ call: "submit", kind: "success" }]);
});
