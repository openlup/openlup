import { describe, expect, it, vi } from "vitest";
import { createPaymentServices } from "@openlup/platform/payments";
import { createBundleComposer } from "@openlup/platform/composition";
import type { PaymentTruthPort } from "@openlup/platform/payments/contracts";

describe("payment service binding", () => {
  it("is absent when truth readiness or the selected capability is unavailable", () => {
    const openTruth = vi.fn();
    expect(createPaymentServices({ openTruth })).toBeNull();
    expect(createPaymentServices({ schema: { truth: "unsupported" }, openTruth })).toBeNull();
    expect(createPaymentServices({ schema: { truth: "supported" } })).toBeNull();
    expect(openTruth).not.toHaveBeenCalled();
    const composer = createBundleComposer({ blob: () => null,
      payments: () => createPaymentServices({ schema: { truth: "unsupported" }, openTruth }) });
    expect(composer({}).ports.payments).toBeNull();
    expect(openTruth).not.toHaveBeenCalled();
  });

  it("runs selected truth through one scoped port and closes on success and failure", async () => {
    const port = { readEvent: vi.fn(async () => null) } as unknown as PaymentTruthPort;
    const close = vi.fn(async () => {});
    const openTruth = vi.fn(async () => ({ port, close }));
    const services = createPaymentServices({ schema: { truth: "supported" }, openTruth })!;
    expect(openTruth).not.toHaveBeenCalled();
    await expect(services.run(truth => truth.readEvent("event-a"))).resolves.toBeNull();
    expect(openTruth).toHaveBeenCalledOnce();
    expect(port.readEvent).toHaveBeenCalledWith("event-a");
    expect(close).toHaveBeenCalledOnce();
    await expect(services.run(async () => { throw Error("operation_failed"); })).rejects.toThrow("operation_failed");
    expect(close).toHaveBeenCalledTimes(2);
    const composer = createBundleComposer({ blob: () => null, payments: () => services });
    expect(composer({}).ports.payments).toBe(services);
    expect(openTruth).toHaveBeenCalledTimes(2);
  });
});
