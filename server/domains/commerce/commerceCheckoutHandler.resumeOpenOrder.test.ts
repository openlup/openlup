import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_CONTRACT_VERSION } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CommerceResumableOrderReadPort } from "../../../src/domains/commerce/ports.js";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import type { CommerceCheckoutHandlerDeps } from "./commerceCheckoutHandler.js";
import {
  CLIENT_ID,
  ORDER_ID,
  createPorts,
  createResponse,
  intent,
  quoteSnapshot,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

// W11.7+ duplicate-charge guard: when an in-flight order already exists for the
// client, the handler must RESUME it (route the FE to the existing order's
// payment-status page) instead of minting a second order + PaymentIntent.

const RESUMABLE_ORDER_ID = "66666666-6666-4666-8666-666666666666";
const RESUMABLE_PI_ID = "77777777-7777-4777-8777-777777777777";

function resumablePort(
  result: Awaited<ReturnType<CommerceResumableOrderReadPort["findResumableOrderForClient"]>> | Error,
): CommerceResumableOrderReadPort {
  return {
    findResumableOrderForClient: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function depsWithResume(
  port: CommerceResumableOrderReadPort,
  overrides: Partial<CommerceCheckoutHandlerDeps> = {},
): CommerceCheckoutHandlerDeps {
  return {
    ...createPorts(),
    resumableOrderPort: port,
    ...overrides,
  };
}

describe("commerce checkout handler — resume-open-order guard", () => {
  it("resumes an in-flight order instead of creating a second one", async () => {
    const res = createResponse();
    const port = resumablePort({
      orderId: RESUMABLE_ORDER_ID,
      paymentIntentId: RESUMABLE_PI_ID,
      status: "processing",
      sameJourney: false,
      metadata: {
        selectedDelivery: intent().selectedDelivery,
        quoteSnapshot: quoteSnapshot(),
      },
    });
    const ports = depsWithResume(port);

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(port.findResumableOrderForClient)).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        withinMinutes: 60,
        journeyKey: intent().idempotencyKey,
      }),
    );
    // The quote IS now computed before the guard runs, and that is the change:
    // the guard has to answer "may I re-offer this order" against the money the
    // buyer was just shown, which does not exist until the quote is accepted.
    // What must still be skipped is everything that could mint a second order or
    // a second charge.
    expect(vi.mocked(ports.quotePort.createQuote)).toHaveBeenCalled();
    expect(vi.mocked(ports.orderDraftPort.createOrderDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.applyPaymentResult)).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        checkoutKind: "one_time",
        orderRef: `order_${RESUMABLE_ORDER_ID}`,
        orderId: RESUMABLE_ORDER_ID,
        status: "processing",
        paymentIntentId: RESUMABLE_PI_ID,
        clientId: CLIENT_ID,
        clientAction: { kind: "none" },
        statusUrl: `/api/bff/commerce/payment-status?orderId=${RESUMABLE_ORDER_ID}&paymentIntentId=${RESUMABLE_PI_ID}&clientId=${CLIENT_ID}`,
        subscription: { requested: false, cadenceDays: null, activationStatus: "not_applicable" },
        payment: { requiresReusablePaymentMethod: false },
      },
      meta: { contractVersion: CHECKOUT_CONTRACT_VERSION },
    });
  });

  it("creates a new order when there is no resumable order (regression)", async () => {
    const res = createResponse();
    const port = resumablePort(null);
    const ports = depsWithResume(port);

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(port.findResumableOrderForClient)).toHaveBeenCalledTimes(1);
    // Falls through to the normal saga -> rehearsal provider settles paid.
    expect(vi.mocked(ports.orderDraftPort.createOrderDraft)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ orderId: ORDER_ID, status: "paid" }),
      }),
    );
  });

  it("fails OPEN: a resume-lookup error never blocks a real checkout", async () => {
    const res = createResponse();
    const port = resumablePort(new Error("supabase unreachable"));
    const ports = depsWithResume(port);

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(port.findResumableOrderForClient)).toHaveBeenCalledTimes(1);
    // Lookup threw -> swallow and proceed to create the order normally.
    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: expect.objectContaining({ status: "paid" }) }),
    );
  });

  it("does not consult a resume port that was never wired", async () => {
    // Supplying the port IS the switch now that the gate is gone, and this is
    // the guarantee the composition root leans on: `checkout.ts` deliberately
    // passes `resumableOrderPort: undefined` until journey identity and cart
    // comparison land, so an absent port must mean an ordinary checkout — never
    // a resumed one, and never a lookup.
    const res = createResponse();
    const port = resumablePort({
      orderId: RESUMABLE_ORDER_ID,
      paymentIntentId: RESUMABLE_PI_ID,
      status: "processing",
      sameJourney: false,
      metadata: { selectedDelivery: intent().selectedDelivery },
    });
    const ports = depsWithResume(port, { resumableOrderPort: undefined });

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(port.findResumableOrderForClient)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
