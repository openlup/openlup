import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⛔ The status read is stubbed at its OUTER seam (the commerce client), not at
 * `readPendingContinuation`. `resolvePendingResume` closes over the module's own
 * `readPendingContinuation`, so overriding that export would not reach it — and
 * stubbing the resolver instead would mean these cases no longer exercise the
 * expiry rule, the phase rule or the unreadable-status rule at all. Stubbing one
 * level further out keeps the entire resume composition real.
 */
const getCommercePaymentStatus = vi.fn();
vi.mock("@/domains/commerce/commerceClient", () => ({
  submitCheckout: vi.fn(),
  getCommercePaymentStatus: (...args: unknown[]) => getCommercePaymentStatus(...args),
}));
vi.mock("./buildCheckoutIntent", () => ({ buildCheckoutIntent: () => null }));
vi.mock("./checkoutInvoicePreference", () => ({ buildCheckoutInvoicePreference: () => undefined }));
vi.mock("@/checkout/adapters/tpayCheckoutDraft", () => ({ buildTpayCheckoutRequestPatch: () => null }));
vi.mock("@/checkout/adapters/tpayCheckoutRequestOptions", () => ({ checkoutRequestOptionsForTpay: async () => ({}) }));
vi.mock("./checkoutAttemptStore", () => ({
  getOrCreateCheckoutAttemptKey: () => "attempt-key",
  clearCheckoutAttemptKey: vi.fn(),
}));
// Partial mock: override the one gate this suite steers and take every other
// export from the real module. Enumerating the rest would model it completely
// but name vendors this guarded surface is pinned against.
vi.mock("@/checkout/adapters/tpayCheckoutFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tpayCheckoutScaffoldingEnabled: () => false,
}));
vi.mock("@/checkout/adapters/stripeCheckoutFlags", () => ({ stripeCheckoutUiEnabled: () => true }));
vi.mock("@/checkout/composer/deliverySelectionFlags", () => ({
  deliverySelectionUiEnabled: () => false,
  dhlOnlyDeliveryEnabled: () => false,
}));

/** `{ status }` plus an optional `nextAction`, exactly as the status route answers. */
function statusIs(status: string, nextAction: unknown = undefined) {
  getCommercePaymentStatus.mockResolvedValue(
    nextAction === undefined ? { status } : { status, nextAction },
  );
}

// `POST /api/bff/commerce/payment-verify` is the ONLY client path that reaches
// the server's `applyTerminalResult`. `PlatnoscPage` fires it after
// FIRST_PROVIDER_READBACK_DELAY_MS on the status poller, so if the browser is
// never routed to that poller this client can never provoke a decline write.
const verifyCommercePaymentNowBounded = vi.fn().mockResolvedValue(null);
vi.mock("@/domains/commerce/paymentVerifyClient", () => ({
  verifyCommercePaymentNow: (...args: unknown[]) => verifyCommercePaymentNowBounded(...args),
  verifyCommercePaymentNowBounded: (...args: unknown[]) => verifyCommercePaymentNowBounded(...args),
}));

import { useConfiguratorCheckout } from "./useConfiguratorCheckout";
import { PSP_PROVIDER_KINDS } from "@/domains/payment/pspIntegrationPlan";
import { routeConfiguratorCheckoutResult } from "./checkoutSubmitResultRouting";
import { PUBLIC_CONFIGURATOR_DRAFT_SCOPE } from "@/checkout/composer/configuratorDraftStore";
import type { CheckoutResponse } from "@/domains/commerce/checkoutContracts";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import {
  CHECKOUT_CONTINUATION_KEY as CONTINUATION_KEY,
  clearCheckoutContinuation,
  LEGACY_CHECKOUT_CONTINUATION_KEY,
  persistCheckoutContinuation,
  readCheckoutContinuation,
} from "./checkoutNavigation";

import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "@/domains/commerce/paymentContinuationContracts";


/**
 * Line γ seam fixture: the composition vocabulary the composition root supplies in
 * production. Held here as plain data so the machine's tests exercise the seam without
 * importing the vertical's validation module.
 */
const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

const PATHS = {
  thankYou: "/skomponuj-pakiet/dziekujemy",
  paymentFailed: "/skomponuj-pakiet/platnosc-nieudana",
  paymentPath: "/skomponuj-pakiet/platnosc",
};

const PENDING = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderRef: "order_11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  journeyId: "checkout:44444444-4444-4444-8444-444444444444",
  actionKind: "embedded" as const,
};

beforeEach(() => {
  getCommercePaymentStatus.mockReset();
  verifyCommercePaymentNowBounded.mockClear();
  clearCheckoutContinuation();
});
afterEach(() => {
  clearCheckoutContinuation();
  vi.unstubAllGlobals();
});

function mount() {
  const navigate = vi.fn();
  const hook = renderHook(() => useConfiguratorCheckout({ knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, navigate, lang: "pl", paths: PATHS }));
  return { navigate, hook };
}

/** The embedded panel state, read by capability name rather than vendor symbol. */
function paymentPanelOf(hook: ReturnType<typeof mount>["hook"]) {
  return hook.result.current.stripePay;
}

describe("useConfiguratorCheckout resume-on-mount", () => {
  it("does NOT navigate to the poller when there is no stripe-pending marker", async () => {
    // Phantom-order regression: with no marker at all, mounting must keep the
    // buyer on the configurator — never bounce them to /platnosc to spin forever.
    const { navigate } = mount();

    await waitFor(() => {
      expect(getCommercePaymentStatus).not.toHaveBeenCalled();
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("submit then refresh before the card commit reaches no decline write", async () => {
    // THE regression this whole programme exists for, re-pinned against the
    // mechanism that now carries it. Before: submit wrote a marker, the refresh
    // found `nextAction: null`, resume navigated to the status poller, and 8s
    // later — FIRST_PROVIDER_READBACK_DELAY_MS — the poller escalated to
    // payment-verify, the provider answered `requires_payment_method`, the
    // server mapped that to `failed` and wrote it through `applyTerminalResult`:
    // an order killed that the buyer never declined.
    //
    // Removing the gate CHANGES the mechanism and NOT the outcome, which is the
    // claim this wave rests on. Submit now does write a marker — the server can
    // hand the action back, so the marker is worth having — but it is born
    // `action_issued`, and a refresh that cannot get an action back discards it
    // rather than waiting on it. Same end state as the gated lane: the buyer
    // keeps the card form, nothing navigates, and payment-verify is never
    // reached.
    const setCardPanel = vi.fn();

    routeConfiguratorCheckoutResult({
      ...submitDeps(),
      setStripePay: setCardPanel,
      result: embeddedSubmitResponse(),
      source: "submit",
      journeyId: PENDING.journeyId,
    });

    expect(setCardPanel).toHaveBeenCalledWith(expect.objectContaining({
      clientSecret: "pi_refresh_secret",
    }));
    // The marker exists now, and its phase is the whole safety property.
    expect(readCheckoutContinuation()).toMatchObject({ phase: "action_issued" });

    statusIs("pending_provider_action");
    const { navigate } = mount();

    // ⛔ The marker SURVIVES now. It used to be destroyed here, on the reasoning
    // that a status with no usable action means there is nothing to resume. That
    // is true about the ACTION and says nothing about the attempt row the
    // anti-double-charge gate reads, so the destruction left a buyer holding
    // neither the action nor the status page while the gate went on refusing.
    // Nothing is resumed either way: no lookup escalation, no navigation, no panel.
    await waitFor(() => expect(getCommercePaymentStatus).toHaveBeenCalled());
    expect(readCheckoutContinuation()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(verifyCommercePaymentNowBounded).not.toHaveBeenCalled();
  });

  it("drops a stale marker (terminal order) without navigating", async () => {
    persistCheckoutContinuation(PENDING);
    statusIs("failed");

    const { navigate } = mount();

    await waitFor(() => {
      expect(getCommercePaymentStatus).toHaveBeenCalledTimes(1);
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("resume ON: restores the same embedded action instead of navigating to a spinner", async () => {
    persistCheckoutContinuation(PENDING);
    statusIs("pending_provider_action", {
          kind: "provider_embedded",
          provider: PSP_PROVIDER_KINDS[0],
          clientSecret: "pi_same_secret",
      });

    const { hook, navigate } = mount();

    await waitFor(() => {
      expect(paymentPanelOf(hook)?.clientSecret).toBe("pi_same_secret");
    });
    expect(paymentPanelOf(hook)).toMatchObject({
      paymentIntentId: PENDING.paymentIntentId,
      journeyId: PENDING.journeyId,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("resume ON: continues the same redirect without opening another attempt", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    persistCheckoutContinuation({ ...PENDING, actionKind: "redirect" });
    statusIs("pending_provider_action", {
          kind: "redirect",
          url: "https://payments.example/continue",
      });

    const { navigate } = mount();

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("https://payments.example/continue");
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["wrong-rail", { kind: "redirect", url: "https://payments.example/continue" }],
  ])(
    "drops an action_issued marker when the active action is %s, instead of polling",
    async (_label, nextAction) => {
      // THE false-decline row. An `action_issued` marker means the server handed
      // back an action and the buyer never pressed Pay, so its PaymentIntent has
      // no payment method. Sending that browser to the status poller made it
      // escalate to `payment-verify` after FIRST_PROVIDER_READBACK_DELAY_MS, the
      // provider answered `requires_payment_method`, and the server normalized
      // that to `failed` and wrote it through `applyTerminalResult` — a terminal
      // decline on an order nobody attempted to pay. Nothing can be settling, so
      // there is nothing to wait for: drop the marker and leave the card form.
      persistCheckoutContinuation(PENDING);
      statusIs("pending_provider_action", nextAction);

      const { navigate } = mount();

      await waitFor(() => expect(getCommercePaymentStatus).toHaveBeenCalledTimes(1));
      expect(navigate).not.toHaveBeenCalled();
      // Survives for the same reason as above: no usable action is not an answer
      // about the attempt row.
      expect(readCheckoutContinuation()).not.toBeNull();
      expect(verifyCommercePaymentNowBounded).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", null],
    ["wrong-rail", { kind: "redirect", url: "https://payments.example/continue" }],
  ])(
    "still polls a confirm_dispatched marker when the active action is %s",
    async (_label, nextAction) => {
      // The other half of the same rule, and the reason phase exists at all: the
      // buyer committed and the provider WAS called, so a charge may genuinely be
      // settling. An unexplained wait is exactly what the poller is for, and
      // abandoning it here would hide a real payment from its own buyer.
      persistCheckoutContinuation({ ...PENDING, phase: "confirm_dispatched" });
      statusIs("pending_provider_action", nextAction);

      const { navigate } = mount();

      await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
      expect(String(navigate.mock.calls[0][0])).toContain(PATHS.paymentPath);
    },
  );

  it("resumes an actionless BLIK marker to the status page", async () => {
    // The end-to-end claim of this wave: an `actionKind: "none"` marker is not
    // a rail the guard can reopen — there is no embedded secret and no redirect
    // — so it falls through to the phase rule, and `confirm_dispatched` means
    // wait. A buyer who refreshes while the push notification is still sitting
    // in their banking app therefore lands back on the poller instead of on a
    // form that would open a SECOND attempt against a live charge.
    persistCheckoutContinuation({
      ...PENDING,
      actionKind: "none",
      phase: "confirm_dispatched",
    });
    statusIs("pending_provider_action");

    const { navigate } = mount();

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(String(navigate.mock.calls[0][0])).toContain(PATHS.paymentPath);
    expect(verifyCommercePaymentNowBounded).not.toHaveBeenCalled();
  });

  // ⛔ 2026-09-02 P1. A buyer whose payment never settled was recaptured on EVERY
  // return: the mount resume redirected them to the status page, whose 2-minute
  // clock restarted each time, and whose only control re-polled. The marker is now
  // stamped once its wait outlives the cap, and the MOUNT resume stops navigating
  // for a stamped marker. The marker itself stays: the route back is a link, not
  // a cell.
  it("stamped-marker-does-not-capture", async () => {
    persistCheckoutContinuation({
      ...PENDING,
      actionKind: "none",
      phase: "confirm_dispatched",
      waitExhaustedAt: Math.floor(Date.now() / 1000),
    });
    statusIs("pending_provider_action");

    const { navigate } = mount();

    await waitFor(() => expect(getCommercePaymentStatus).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    // ⛔ The marker MUST survive. Dropping it would orphan an attempt the
    // admission gate still counts as open.
    expect(readCheckoutContinuation()).not.toBeNull();
  });

  it("reads a marker with no phase as confirm_dispatched", async () => {
    // Markers written before phases existed cannot be judged by a rule they were
    // never written under, so they keep the pre-deploy behaviour: poll. The
    // conservative half is the correct default because the expensive error is
    // abandoning a real in-flight charge, not one extra poll.
    persistCheckoutContinuation(PENDING);
    const stored = JSON.parse(sessionStorage.getItem(CONTINUATION_KEY) ?? "{}") as Record<string, unknown>;
    delete stored.phase;
    delete stored.expiresAt;
    sessionStorage.setItem(CONTINUATION_KEY, JSON.stringify(stored));
    statusIs("pending_provider_action");

    const { navigate } = mount();

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(String(navigate.mock.calls[0][0])).toContain(PATHS.paymentPath);
  });

  it("keeps the marker when the status could not be read, and reopens on the retry", async () => {
    // ⛔ A transport blip must not be a verdict. Dropping the marker here would
    // delete the only route back to the action the server already issued, while
    // the anti-double-charge gate refuses every re-submit until the
    // reconciliation cron — one lost packet costing the buyer their checkout.
    persistCheckoutContinuation(PENDING);
    getCommercePaymentStatus.mockRejectedValue(new Error("network down"));

    const first = mount();

    await waitFor(() => expect(getCommercePaymentStatus).toHaveBeenCalledTimes(1));
    expect(readCheckoutContinuation()).toMatchObject({
      paymentIntentId: PENDING.paymentIntentId,
      phase: "action_issued",
    });
    expect(first.navigate).not.toHaveBeenCalled();
    expect(paymentPanelOf(first.hook)).toBeNull();
    expect(verifyCommercePaymentNowBounded).not.toHaveBeenCalled();

    // The network comes back: the SAME marker still reopens the same action.
    statusIs("pending_provider_action", {
      kind: "provider_embedded",
      provider: PSP_PROVIDER_KINDS[0],
      clientSecret: "pi_same_secret",
    });
    const second = mount();

    await waitFor(() =>
      expect(paymentPanelOf(second.hook)?.clientSecret).toBe("pi_same_secret"),
    );
    expect(second.navigate).not.toHaveBeenCalled();
  });

  it("ignores a marker left under the retired key, and sweeps it on the next write", async () => {
    // ⛔ THE falsifier for the immortal marker. The retired key was written by the
    // wallet rail without a journey, an action kind, a phase OR an expiry, and
    // read back through an `as` cast that validated four strings and invented the
    // rest. `isContinuationExpired` was therefore unconditionally false: the
    // marker outlived its order, its attempt and the reconciliation window, and a
    // refresh weeks later still routed the buyer to the poller for it.
    //
    // Deleting the read path is what kills it. Not "expire it sooner" — a shape
    // with nowhere to record an expiry cannot be given one — but: nothing reads
    // this key, so no request is spent on it and no route is taken from it.
    sessionStorage.setItem(
      LEGACY_CHECKOUT_CONTINUATION_KEY,
      JSON.stringify({
        orderId: PENDING.orderId,
        orderRef: PENDING.orderRef,
        paymentIntentId: PENDING.paymentIntentId,
        clientId: PENDING.clientId,
      }),
    );
    statusIs("pending_provider_action");

    const { hook, navigate } = mount();

    // Read as nothing: no status lookup, no navigation, no panel, and — the fact
    // the old shape could never produce — no resume at all. Unaffected by this
    // wave: nothing reads the retired key, so there is no marker to keep.
    await waitFor(() => expect(readCheckoutContinuation()).toBeNull());
    expect(getCommercePaymentStatus).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(paymentPanelOf(hook)).toBeNull();

    // And it is swept rather than left to accumulate: the next real marker write
    // removes it, so a browser session that survived the deploy ends up with one
    // key, like every session opened after it.
    persistCheckoutContinuation(PENDING);
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
  });

  it("drops an expired marker without even asking the server", async () => {
    // Past the shared continuation TTL the reconciliation cron owns this attempt
    // and will terminalize it on its own schedule. Acting on the marker after
    // that point can only offer the buyer a wait on something already being
    // decided elsewhere — and expiry is a local fact, so no request is spent
    // establishing it.
    // Aged by rewriting the stamp rather than the clock: the marker is exactly
    // one second past a full TTL, which is the boundary the guard must reject.
    persistCheckoutContinuation({ ...PENDING, phase: "confirm_dispatched" });
    const stored = JSON.parse(sessionStorage.getItem(CONTINUATION_KEY) ?? "{}") as Record<string, unknown>;
    stored.expiresAt = Math.floor(Date.now() / 1000) - 1;
    sessionStorage.setItem(CONTINUATION_KEY, JSON.stringify(stored));
    expect(Number(stored.expiresAt)).toBeLessThan(
      Math.floor(Date.now() / 1000) + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS,
    );
    statusIs("pending_provider_action");

    const { navigate } = mount();

    // The no-request property is unchanged. The marker now survives its own expiry:
    // past the TTL the cron USUALLY owns the attempt, but the claim window is 15 to
    // 45 minutes with a batch cap, so a local clock is not an answer about the
    // payment and must not cost the buyer their route back.
    expect(readCheckoutContinuation()).not.toBeNull();
    // No request was spent establishing a fact the browser already held.
    expect(getCommercePaymentStatus).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(verifyCommercePaymentNowBounded).not.toHaveBeenCalled();
  });
});

function embeddedSubmitResponse(): CheckoutResponse {
  return {
    contractVersion: "commerce.checkout.v2",
    checkoutKind: "one_time",
    status: "processing",
    orderId: PENDING.orderId,
    orderRef: PENDING.orderRef,
    paymentIntentId: PENDING.paymentIntentId,
    clientId: PENDING.clientId,
    clientAction: {
      kind: "provider_embedded",
      provider: PSP_PROVIDER_KINDS[0],
      clientSecret: "pi_refresh_secret",
    },
  };
}

function submitDeps() {
  return {
    data: {} as ConfiguratorFormData,
    navigate: vi.fn(),
    paths: { thankYou: PATHS.thankYou, paymentPath: PATHS.paymentPath },
    accountMode: false,
    hasTpayPatch: false,
    useStripe: true,
    draftScope: PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
    setStripePay: vi.fn(),
  };
}
