import { act, renderHook } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_CONFIGURATOR_DRAFT_SCOPE } from "@/checkout/composer/configuratorDraftStore";
import { persistCheckoutContinuation, readCheckoutContinuation } from "./checkoutNavigation";
import { takeCheckoutDeclineNotice } from "./checkoutDeclineNotice";
import { CHECKOUT_ATTEMPT_STORAGE_KEY } from "./checkoutAttemptStore";
import { verifyCommercePaymentNowBounded } from "@/domains/commerce/paymentVerifyClient";
import { useConfiguratorCheckoutTerminalRouting } from "./useConfiguratorCheckoutTerminalRouting";

// The failed branch asks the backend to read the provider now (bounded); the
// hook must navigate regardless of the verify outcome.
vi.mock("@/domains/commerce/paymentVerifyClient", () => ({
  verifyCommercePaymentNowBounded: vi.fn().mockResolvedValue(null),
}));

/**
 * ⛔ Stubbed at the OUTER seam (the commerce client), never at
 * `resolvePendingResume` and never at `applyPendingResume`. Stubbing the resolver
 * would let the resume tests below pass against a decision this repository can no
 * longer produce, and stubbing the executor would remove the only thing they
 * check. The status route's answer goes in; the real resolver and the real
 * executor decide what comes out.
 */
const getCommercePaymentStatus = vi.fn();
vi.mock("@/domains/commerce/commerceClient", () => ({
  getCommercePaymentStatus: (...args: unknown[]) => getCommercePaymentStatus(...args),
}));

const paths = {
  thankYou: "/dziekujemy",
  paymentFailed: "/platnosc-nieudana",
  paymentPath: "/platnosc",
};

const JOURNEY_ID = "checkout:11111111-1111-4111-8111-111111111111";

const stripePay = {
  orderId: "order-id",
  orderRef: "order-ref",
  paymentIntentId: "intent-id",
  clientId: "client-id",
  clientSecret: "secret",
  awaitingWebhook: false,
};

function setup(accountStatusPath?: string) {
  const navigate = vi.fn() as unknown as NavigateFunction;
  const { result } = renderHook(() =>
    useConfiguratorCheckoutTerminalRouting({
      navigate,
      paths,
      ...(accountStatusPath ? { accountStatusPath } : {}),
      draftScope: PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
    }),
  );
  act(() => result.current.setStripePay(stripePay));
  return { navigate, result };
}

/**
 * A live attempt with a resume marker already written, ready to settle. There is
 * one marker shape now, so there is one arming path: every marker carries the
 * journey and action kind it belongs to, and therefore has somewhere to record a
 * phase — which is what the retryable branch below acts on.
 */
function armRetryable(accountStatusPath?: string) {
  const harness = setup(accountStatusPath);
  sessionStorage.setItem(
    CHECKOUT_ATTEMPT_STORAGE_KEY,
    JSON.stringify({ fingerprint: "journey", key: JOURNEY_ID }),
  );
  persistCheckoutContinuation({
    ...stripePay,
    journeyId: JOURNEY_ID,
    actionKind: "embedded",
    phase: "confirm_dispatched",
  });
  return harness;
}
describe("useConfiguratorCheckoutTerminalRouting", () => {
  beforeEach(() => {
    sessionStorage.clear();
    getCommercePaymentStatus.mockReset();
  });

  it("returns a failed public confirmation to the payment step after verify-now", async () => {
    const { navigate, result } = setup();
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );

    await act(async () => result.current.onConfirmSettled("failed"));

    // verify-now is unchanged and still mandatory: the browser is the only
    // witness of a pre-charge rejection, and it is what terminalizes the attempt.
    expect(verifyCommercePaymentNowBounded).toHaveBeenCalledWith({
      orderId: "order-id",
      paymentIntentId: "intent-id",
      clientId: "client-id",
    });
    // The buyer is NOT thrown out of the funnel any more.
    expect(navigate).not.toHaveBeenCalled();
    // Dropping the panel state is what unmounts <Elements> and re-renders the
    // payment step, and the notice is what tells the step why.
    expect(result.current.stripePay).toBeNull();
    expect(takeCheckoutDeclineNotice()).toBe("checkout:errors.paymentDeclinedCard");
    // The retry still gets its own execution-idempotency namespace.
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBe(1);
  });

  it("still returns to the payment step when verify-now rejects unexpectedly", async () => {
    vi.mocked(verifyCommercePaymentNowBounded).mockRejectedValueOnce(new Error("network"));
    const { result } = setup();

    await act(async () => result.current.onConfirmSettled("failed"));

    expect(result.current.stripePay).toBeNull();
    expect(takeCheckoutDeclineNotice()).toBe("checkout:errors.paymentDeclinedCard");
  });

  it("keeps failed confirmations inside the account terminal", async () => {
    const { navigate, result } = setup("/konto/zamowienie/status");
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );

    await act(async () => result.current.onConfirmSettled("failed"));

    expect(verifyCommercePaymentNowBounded).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      "/konto/zamowienie/status?order=order-ref&orderId=order-id&paymentIntentId=intent-id&clientId=client-id",
    );
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBeUndefined();
  });

  it("marks a succeeded confirmation as awaiting its webhook", () => {
    const { navigate, result } = setup();

    act(() => result.current.onConfirmSettled("succeeded"));

    expect(result.current.stripePay).toEqual({ ...stripePay, awaitingWebhook: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps an unknown public confirmation pending and starts canonical polling", () => {
    const { navigate, result } = setup();
    persistCheckoutContinuation({ ...stripePay, journeyId: JOURNEY_ID, actionKind: "embedded" });

    act(() => result.current.onConfirmSettled("unknown"));

    expect(result.current.stripePay).toEqual({ ...stripePay, awaitingWebhook: true });
    expect(readCheckoutContinuation()).toMatchObject({ orderId: stripePay.orderId });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps an unknown account confirmation pending instead of routing to retry", () => {
    const { navigate, result } = setup("/konto/zamowienie/status");
    persistCheckoutContinuation({ ...stripePay, journeyId: JOURNEY_ID, actionKind: "embedded" });

    act(() => result.current.onConfirmSettled("unknown"));

    expect(result.current.stripePay).toEqual({ ...stripePay, awaitingWebhook: true });
    expect(readCheckoutContinuation()).toMatchObject({ orderId: stripePay.orderId });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([undefined, "/konto/zamowienie/status"])(
    "walks the continuation marker back to action_issued after a retryable local error (%s)",
    (accountStatusPath) => {
      // A locally retryable error proves the provider was never reached. Keeping
      // the marker at `confirm_dispatched` would let a later refresh send the
      // buyer to the status poller for a PaymentIntent with no payment method —
      // the readback there normalizes to `failed` and writes a decline nobody
      // made. Clearing it outright would throw away an action the server can
      // still hand back. Lowering the phase is the only move that does neither.
      const { navigate, result } = armRetryable(accountStatusPath);

      act(() => result.current.onConfirmSettled("retryable"));

      expect(readCheckoutContinuation()).toMatchObject({
        orderId: stripePay.orderId,
        phase: "action_issued",
      });
      expect(result.current.stripePay).toEqual(stripePay);
      expect(navigate).not.toHaveBeenCalled();
      expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBeUndefined();
    },
  );

  it("follows the redirect the marker still owes, instead of parking the submit on the poller", async () => {
    // ⛔ THE falsifier for "one decision, two meanings". `follow_redirect` names a
    // URL the buyer has not visited yet and must, because that page is where the
    // provider takes the money. The mount-time resume always obeyed it. This
    // submit-time twin did not: the decision is an object, so it failed the
    // `reopen_embedded` test, was not `"unknown"`, was not `"discard"` — and fell
    // into the poller branch, which navigated to /platnosc and threw the URL away.
    // The buyer then waited for a payment that could not settle, because nothing
    // had sent them to the only page that could complete it.
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { navigate, result } = setup();
    persistCheckoutContinuation({ ...stripePay, journeyId: JOURNEY_ID, actionKind: "redirect" });
    getCommercePaymentStatus.mockResolvedValue({
      status: "pending_provider_action",
      nextAction: { kind: "redirect", url: "https://payments.example/continue" },
    });

    await act(async () => {
      expect(await result.current.resumeBeforeSubmit()).toBe(true);
    });

    expect(assign).toHaveBeenCalledWith("https://payments.example/continue");
    // ⛔ The mutant detector: route this decision to the poller again and the
    // redirect is lost while this line still passes on `assign` never firing.
    expect(navigate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
