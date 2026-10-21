import { expect, it, vi } from "vitest";
import { bindM07Payments, bindM07PaymentIngress } from "./m07PaymentBinding.js";

it("keeps the cold host default-off and uses exactly one selected executor", async () => {
  const sweepOpenEvents = vi.fn(async () => ({ claimed: 0, settledIgnored: 0, eventIds: [] }));
  const close = vi.fn(async () => {});
  const openTruth = vi.fn(async () => ({ port: { sweepOpenEvents } as never, close }));
  const options = { schema: { truth: "supported" as const }, openTruth };
  expect(bindM07Payments(undefined, options)).toBeNull();
  expect(bindM07Payments("off", options)).toBeNull();
  expect(() => bindM07Payments("unknown", options)).toThrow("payment_binding_unknown_selection");
  expect(() => bindM07Payments("truth", { schema: { truth: "unsupported" }, openTruth })).toThrow("payment_binding_truth_unavailable");
  expect(openTruth).not.toHaveBeenCalled();
  await bindM07Payments("truth", options)!.run(port => port.sweepOpenEvents({ now: "2026-10-21T00:00:00Z", limit: 1 }));
  expect(openTruth).toHaveBeenCalledOnce();
  expect(sweepOpenEvents).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  const verifyAndNormalize = vi.fn(async () => ({ kind: "refusal" as const, reason: "signature" as const }));
  const ingressOptions = { provider: "example", verifyPort: { verifyAndNormalize }, paymentControlPort: { ingestPaymentEvent: vi.fn() } };
  expect(bindM07PaymentIngress(undefined, ingressOptions)).toBeNull();
  expect(() => bindM07PaymentIngress("unknown", ingressOptions)).toThrow("payment_binding_unknown_selection");
  expect(verifyAndNormalize).not.toHaveBeenCalled();
  await expect(bindM07PaymentIngress("verified", ingressOptions)!.receive({ rawBody: new Uint8Array(), headers: {}, receivedAt: "2026-10-21T00:00:00Z" })).resolves.toMatchObject({ status: 400 });
  expect(verifyAndNormalize).toHaveBeenCalledOnce();
});
