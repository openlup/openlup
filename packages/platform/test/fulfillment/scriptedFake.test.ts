import { expect, it } from "vitest";
import { createScriptedFulfillmentFake, ScriptedFulfillmentTransportError } from "../../src/fulfillment/testing/index.js";

it("captures closed outcome data at enqueue without executing getters or retaining caller values", async () => {
  const fake = createScriptedFulfillmentFake<{ submit: { body: string; status: number } }>(); let reads = 0;
  const getter = { get kind() { reads++; return reads === 1 ? "transport-after-submission" : "success"; }, value: { body: "{}", status: 200 } };
  expect(() => fake.enqueue("submit", getter as never)).toThrow("validation:uncloneable_data"); expect(reads).toBe(0);
  for (const value of [{ kind: "invented" }, { kind: "success" }, { kind: "transport-before-submission", value: "extra" }, { kind: "http-failure", status: "503" }]) expect(() => fake.enqueue("submit", value as never)).toThrow();
  expect(() => fake.enqueue({} as never, { kind: "transport-after-submission" })).toThrow("validation:call");
  const outcome = { kind: "http-failure" as const, status: 503, response: { body: "captured", status: 503 } };
  fake.enqueue("submit", outcome); Object.assign(outcome, { kind: "success", status: 200 }); outcome.response.body = "changed";
  const captured = await fake.invoke("submit"), response = new Response(captured.body, { status: captured.status });
  expect(await response.text()).toBe("captured"); expect(response.status).toBe(503); expect(fake.calls).toEqual([{ call: "submit", kind: "http-failure" }]); fake.assertDrained();
});

it.each(["buffer", "typed-array", "data-view", "shadowed-buffer"])("refuses shared memory in scripted %s data", shape => {
  const fake = createScriptedFulfillmentFake<{ read: unknown }>(), buffer = new SharedArrayBuffer(4);
  const value = shape === "buffer" ? buffer : shape === "data-view" ? new DataView(buffer) : new Uint8Array(buffer);
  if (shape === "shadowed-buffer") Object.defineProperty(value, "buffer", { value: new ArrayBuffer(4) });
  expect(() => fake.enqueue("read", { kind: "success", value })).toThrow("validation:shared_memory"); fake.assertDrained();
});

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
  const fake = createScriptedFulfillmentFake<{ submit: { body: string; status: number } }>();
  const response = { body: "{}", status: 503 };
  fake.enqueue("submit", { kind: "http-failure", status: 503, response }, { kind: "http-failure", status: 502 },
    { kind: "transport-before-submission" }, { kind: "transport-after-submission" });
  expect(await fake.invoke("submit")).toEqual(response);
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
