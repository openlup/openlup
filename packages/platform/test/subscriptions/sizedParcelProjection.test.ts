import { expect, it, vi } from "vitest";
import { createSizedParcelProjection, type SizedParcelProjectionPorts } from "../../src/subscriptions/sizedParcelProjection.js";
import { ids } from "./sizedFixtures.js";
function fixture(): SizedParcelProjectionPorts {
  return { allowedCadences: [10, 20, 30], readExactPhysicalSize: vi.fn(async id => ({ id, sku: "refill", physicalSize: 250 })),
    read: async () => ({ subscriptionId: ids.subscription, cycleId: "frozen-cycle", binding: "sized.v1",
      cycle: { id: "frozen-cycle", subscriptionId: ids.subscription, number: 2, cadenceDays: 20 },
      lines: [{ sku: "refill", quantity: 4, retainedId: ids.a, capturedId: ids.a }] }) };
}
it("projects exact retained physical identity and frozen cadence without a packing count", async () => {
  const ports = fixture(), projection = createSizedParcelProjection(ports);
  expect(await projection("order", new AbortController().signal)).toEqual({ quantity: 4, sizes: [{ physicalSize: 250, quantity: 4 }], cadenceDays: 20 });
  expect(ports.readExactPhysicalSize).toHaveBeenCalledWith(ids.a);
  const order = await ports.read("order"); order!.lines[0].physicalSize = 375;
  order!.lines.push({ sku: "second", quantity: 2, retainedId: ids.b, physicalSize: 250 }); ports.read = async () => order;
  expect(await projection("order", new AbortController().signal)).toMatchObject({ quantity: 6, sizes: [{ physicalSize: 250, quantity: 2 }, { physicalSize: 375, quantity: 4 }] });
});
it.each(["binding", "acquisition", "cycle", "subscription", "identity", "sku", "quantity", "size", "read"])("omits unprovable %s receipt facts", async reason => {
  const ports = fixture(), order = await ports.read("order");
  if (reason === "binding") order!.binding = "classic";
  if (reason === "acquisition") order!.cycle!.number = 1;
  if (reason === "cycle") order!.cycleId = "other";
  if (reason === "subscription") order!.subscriptionId = ids.client;
  if (reason === "identity") order!.lines[0].capturedId = ids.b;
  if (reason === "sku") ports.readExactPhysicalSize = async id => ({ id, sku: "other", physicalSize: 250 });
  if (reason === "quantity") order!.lines[0].quantity = 0;
  if (reason === "size") order!.lines[0].physicalSize = -1;
  ports.read = reason === "read" ? async () => { throw new Error("unavailable"); } : async () => order;
  expect(await createSizedParcelProjection(ports)("order", new AbortController().signal)).toBeNull();
});
it("omits an unsupported cadence and stops an aborted read", async () => {
  const ports = fixture(), order = await ports.read("order"); order!.cycle!.cadenceDays = 17; ports.read = async () => order;
  expect(await createSizedParcelProjection(ports)("order", new AbortController().signal)).toMatchObject({ cadenceDays: null });
  const controller = new AbortController(); controller.abort(); expect(await createSizedParcelProjection(ports)("order", controller.signal)).toBeNull();
});
