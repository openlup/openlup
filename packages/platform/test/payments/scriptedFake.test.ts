import { expect, it } from "vitest";
import { createScriptedPaymentFake, ScriptedPaymentTransportError } from "../../src/payments/testing/index.js";
import { runPaymentAdapterConformance } from "../../src/payments/testing/index.js";
import { runPaymentAdapterConformance as existingExport } from "../../src/payments/index.js";

it("preserves the existing runner export and isolates FIFO scripts per transport call", async () => {
  expect(runPaymentAdapterConformance).toBe(existingExport);
  const fake = createScriptedPaymentFake<{ create: number; read: string }>();
  fake.enqueue("create", { kind: "success", value: 1 }, { kind: "timeout-before-dispatch" }, { kind: "timeout-after-dispatch" },
    { kind: "provider-5xx" }, { kind: "redelivery-409" }, { kind: "success", value: 2 });
  fake.enqueue("read", { kind: "success", value: "original" });
  expect(await fake.invoke("create")).toBe(1);
  expect(await fake.invoke("read")).toBe("original");
  for (const [kind, status, dispatched] of [["timeout-before-dispatch", undefined, false], ["timeout-after-dispatch", undefined, true],
    ["provider-5xx", 503, false], ["redelivery-409", 409, false]] as const) {
    await expect(fake.invoke("create")).rejects.toMatchObject({ kind, status, dispatched });
  }
  expect(await fake.invoke("create")).toBe(2);
  fake.assertDrained();
  await expect(fake.invoke("create")).rejects.toThrow("unscripted:create");
  expect(fake.calls).toHaveLength(7);
  expect(new ScriptedPaymentTransportError("timeout-after-dispatch")).toBeInstanceOf(Error);
});

it("returns scripted HTTP failures and refuses unused outcomes", async () => {
  const fake = createScriptedPaymentFake<{ http: { status: number } }>();
  fake.enqueue("http", { kind: "provider-5xx", response: { status: 503 } }, { kind: "redelivery-409", response: { status: 409 } });
  expect(() => fake.assertDrained()).toThrow("unconsumed:http:2");
  expect(await fake.invoke("http")).toEqual({ status: 503 });
  expect(await fake.invoke("http")).toEqual({ status: 409 });
  fake.assertDrained();
});
