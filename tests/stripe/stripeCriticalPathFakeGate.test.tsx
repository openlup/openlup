/** @vitest-environment jsdom */
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const fake = vi.hoisted(() => ({
  activeWallet: "applePay" as "applePay" | "googlePay",
  confirmPayment: vi.fn(),
  elementsSubmit: vi.fn(),
  elementsOptions: vi.fn(),
  expressOptions: vi.fn(),
  submitCheckout: vi.fn(),
  checkoutKinds: [] as string[],
}));

vi.mock("@/domains/commerce/commerceClient", () => ({
  submitCheckout: (...args: unknown[]) => fake.submitCheckout(...args),
}));
vi.mock("@/domains/commerce/paymentVerifyClient", () => ({
  verifyCommercePaymentNowBounded: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/checkout/machine/buildCheckoutIntent", () => ({
  buildCheckoutIntent: (data: { subscription?: boolean }) => ({
    mode: data.subscription ? "subscription" : "one_time",
    contact: { email: "stripe-gate@example.test" },
    idempotencyKey: "checkout:pending",
  }),
}));
vi.mock("@/checkout/machine/checkoutInvoicePreference", () => ({
  buildCheckoutInvoicePreference: () => undefined,
}));
vi.mock("@/checkout/adapters/tpayCheckoutDraft", () => ({
  buildTpayCheckoutRequestPatch: () => null,
}));
vi.mock("@/checkout/adapters/tpayCheckoutRequestOptions", () => ({
  checkoutRequestOptionsForTpay: async () => ({}),
}));
vi.mock("@/checkout/machine/checkoutAttemptStore", () => ({
  getOrCreateCheckoutAttemptKey: () => "checkout:stripe-critical-path",
  readCheckoutPaymentAttempt: () => 0,
  clearCheckoutAttemptKey: vi.fn(),
  bumpCheckoutPaymentAttempt: vi.fn(),
}));
// Partial mock: override the one gate this suite steers and take every other
// export from the real module. Enumerating the rest would model it completely
// but name vendors this guarded surface is pinned against.
vi.mock("@/checkout/adapters/tpayCheckoutFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tpayCheckoutScaffoldingEnabled: () => false,
}));
vi.mock("@/checkout/adapters/stripeCheckoutFlags", () => ({ stripeCheckoutUiEnabled: () => true }));
vi.mock("@/checkout/composer/deliverySelectionFlags", () => ({ dhlOnlyDeliveryEnabled: () => false }));
vi.mock("@/checkout/machine/checkoutResumeGuard", () => ({ isPendingResumable: async () => false }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  subscriptionCheckoutContractEnabled: () => true,
}));
vi.mock("@/checkout/machine/useLiveQuote", () => ({
  useLiveQuote: () => ({ loading: false, error: null, quote: { totalGross: { amountMinor: 12_900, currency: "PLN" } } }),
}));
vi.mock("@/checkout/composer/useEffectiveConfiguratorPackage", () => ({
  useEffectiveConfiguratorPackage: () => ({ snapshot: null }),
}));
vi.mock("@/domains/payment/components/useStripePromise", () => ({
  useStripePromise: () => ({}),
  useStripeLoader: () => ({ stripePromise: {}, status: "ready", retry: () => {} }),
  STRIPE_LOAD_TIMEOUT_MS: 10_000,
}));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children, options }: { children: React.ReactNode; options: unknown }) => {
    fake.elementsOptions(options);
    return <>{children}</>;
  },
  ExpressCheckoutElement: ({
    onClick,
    onConfirm,
    onReady,
    options,
  }: {
    onClick: (event: { resolve: () => void }) => void;
    onConfirm: () => void;
    onReady: (event: { availablePaymentMethods: Record<string, boolean> }) => void;
    options: unknown;
  }) => {
    fake.expressOptions(options);
    return (
      <>
        <button type="button" onClick={() => onReady({ availablePaymentMethods: { [fake.activeWallet]: true } })}>
          fake-wallet-ready
        </button>
        <button type="button" onClick={() => onClick({ resolve: vi.fn() })}>fake-wallet-open</button>
        <button type="button" onClick={onConfirm}>fake-wallet-confirm</button>
      </>
    );
  },
  // ⛔ THE FAKE MUST REPORT READINESS, because the real element does and the
  // panel now believes it.
  //
  // `PaymentForm` gates its pay button, its 10-second timeout and a fixed-height
  // placeholder on the provider's own `onReady` callback rather than on "the SDK
  // handed us an elements object" — the two are not the same fact, and treating
  // them as one is what left a live pay button over an empty box and moved that
  // button out from under the buyer's click when the fields finally painted.
  //
  // A fake that never calls `onReady` therefore holds this rig's panel in its
  // skeleton forever, and every button past the payment step stops existing.
  // Firing on mount is the faithful model: the real element calls it once, after
  // the iframe paints. `onLoadError` is deliberately NOT called — this rig
  // exercises the healthy path.
  PaymentElement: ({ onReady }: { onReady?: () => void }) => {
    useEffect(() => {
      onReady?.();
      // Once, on mount, exactly as the provider does. Depending on the callback
      // identity would re-fire it on every re-render it caused.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="fake-payment-element" />;
  },
  useElements: () => ({ submit: (...args: unknown[]) => fake.elementsSubmit(...args) }),
  useStripe: () => ({ confirmPayment: (...args: unknown[]) => fake.confirmPayment(...args) }),
}));
vi.mock("@/domains/payment/components/PaymentStatusPoller", () => ({
  PaymentStatusPoller: ({ onTerminal }: { onTerminal: (status: "paid" | "timeout") => void }) => (
    <>
      <button type="button" onClick={() => onTerminal("paid")}>fake-poll-paid</button>
      <button type="button" onClick={() => onTerminal("timeout")}>fake-poll-timeout</button>
    </>
  ),
}));

import { requirePaymentProviderCapability } from "../../server/adapters/paymentProviderCapabilityRegistry.js";
import { createStripeSandboxPaymentExecutionAdapter } from "../../server/adapters/stripe/stripeSandboxPaymentExecutionAdapter.js";
import {
  chargeSubscriptionCycleOffSession,
  type ChargeDeps,
  type DueSubscription,
} from "../../server/domains/subscription/chargeSubscriptionCycleOffSession.js";
import { createSupabaseCycleChargeFailurePropagationPort } from "../../server/adapters/supabase/subscription/cycleChargeFailurePropagation.js";
import { createManagedSubscriptionRenewalPersistencePort } from "../../server/adapters/managed/subscription/subscriptionRenewalDuePort.js";
import { createStarterPackCyclePort } from "../../server/adapters/supabase/subscription/starterPackCycle.js";
import type { PreparedProviderAttemptRuntimePort } from "@/domains/commerce/ports.js";
import { SkomponujPakietStripePayPanel } from "@/checkout/adapters/SkomponujPakietStripePayPanel.js";
import { useConfiguratorCheckout } from "@/checkout/machine/useConfiguratorCheckout.js";
import { takeCheckoutDeclineNotice } from "@/checkout/machine/checkoutDeclineNotice";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore.js";
import {
  paymentFailedUrlFor,
  paymentStatusUrlFor,
  thankYouUrlFor,
} from "@/checkout/machine/checkoutNavigation.js";
import { WalletExpressRow } from "@/checkout/adapters/WalletExpressRow.js";

/** Line γ seam fixture: the composition vocabulary a composition root supplies. */
const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

const CARD_CELLS = [
  ["public", "one_time"],
  ["public", "subscription"],
  ["account", "one_time"],
  ["account", "subscription"],
] as const;
const WALLET_CELLS = [
  ["public", "one_time", "applePay"],
  ["public", "one_time", "googlePay"],
  ["public", "subscription", "applePay"],
  ["public", "subscription", "googlePay"],
  ["account", "one_time", "applePay"],
  ["account", "one_time", "googlePay"],
  ["account", "subscription", "applePay"],
  ["account", "subscription", "googlePay"],
] as const;
const RENEWAL_ORIGINS = ["card", "apple_pay", "google_pay"] as const;
const paymentContext = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderRef: "order_11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
};

type Entry = (typeof CARD_CELLS)[number][0];
type CheckoutMode = (typeof CARD_CELLS)[number][1];
type HarnessRef = { submit: () => Promise<void> };

describe("Stripe critical path fake gate", () => {
  beforeEach(() => {
    fake.activeWallet = "applePay";
    fake.confirmPayment.mockReset().mockResolvedValue({ paymentIntent: { status: "processing" } });
    fake.elementsSubmit.mockReset().mockResolvedValue({});
    fake.elementsOptions.mockReset();
    fake.expressOptions.mockReset();
    fake.checkoutKinds = [];
    fake.submitCheckout.mockReset().mockImplementation((request: { intent: { mode: CheckoutMode } }) => {
      const response = stripeProcessingResponse(request.intent.mode);
      fake.checkoutKinds.push(response.checkoutKind);
      return Promise.resolve(response);
    });
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(CARD_CELLS)("drives %s %s card from step 6 through confirmation and terminal routing", async (entry, mode) => {
    const navigate = navigateMock();
    const ref = { current: null as HarnessRef | null };
    renderWithProviders(<CardHarness ref={ref} entry={entry} mode={mode} navigate={navigate} />);

    await act(async () => ref.current?.submit());
    expect(await screen.findByTestId("stripe-pay-panel")).toBeInTheDocument();
    expectCheckoutRequest(entry, mode, { accountReturnContext: true });
    expect(fake.checkoutKinds).toEqual([mode === "subscription" ? "subscription_initial" : "one_time"]);

    expect(screen.getByTestId("fake-payment-element")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));
    await waitFor(() => expect(fake.confirmPayment).toHaveBeenCalledWith({
      elements: expect.any(Object),
      confirmParams: { return_url: expectedCardReturnUrl(entry) },
      redirect: "if_required",
    }));
    fireEvent.click(await screen.findByRole("button", { name: "fake-poll-paid" }));

    expect(navigate).toHaveBeenCalledWith(expectedTerminalPath(entry));
  });

  it.each(WALLET_CELLS)("drives %s %s %s from step 6 through Stripe Elements and status routing", async (entry, mode, wallet) => {
    fake.activeWallet = wallet;
    const navigate = navigateMock();
    renderWithProviders(<WalletHarness entry={entry} mode={mode} navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-ready" }));
    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-open" }));
    expect(fake.submitCheckout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-confirm" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expectedStatusPath(entry)));
    expect(fake.elementsSubmit).toHaveBeenCalledTimes(1);
    expect(fake.elementsSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      fake.submitCheckout.mock.invocationCallOrder[0],
    );
    expect(fake.submitCheckout.mock.invocationCallOrder[0]).toBeLessThan(
      fake.confirmPayment.mock.invocationCallOrder[0],
    );
    expect(fake.submitCheckout).toHaveBeenCalledTimes(1);
    expectCheckoutRequest(entry, mode);
    expect(fake.checkoutKinds).toEqual([mode === "subscription" ? "subscription_initial" : "one_time"]);
    expect(fake.elementsOptions).toHaveBeenCalledWith(expect.objectContaining({
      paymentMethodTypes: ["card"],
      setupFutureUsage: mode === "subscription" ? "off_session" : undefined,
    }));
    expect(fake.expressOptions).toHaveBeenCalledWith(expect.objectContaining({
      paymentMethods: expect.objectContaining({ [wallet]: "auto" }),
    }));
    expect(fake.confirmPayment).toHaveBeenCalledWith(expect.objectContaining({
      confirmParams: { return_url: expect.stringContaining(entry === "account" ? "/konto/zamowienie/status" : "/skomponuj-pakiet/platnosc") },
    }));
  });

  it("replays a post-dispatch timeout to status rather than reopening the card", async () => {
    // The server owns a live readback for this exact attempt, so its account of
    // the attempt outranks the action the replay happened to carry. Its former
    // twin — reopen the replayed action instead — was the gated lane and is
    // gone with the gate: reopening a form for an attempt the server has already
    // moved past is what the readback precedence exists to prevent.
    fake.submitCheckout
      .mockRejectedValueOnce(new TypeError("response lost after Stripe accepted the request"))
      .mockResolvedValueOnce(stripeProcessingResponse("one_time"));
    const navigate = navigateMock();
    const ref = { current: null as HarnessRef | null };
    renderWithProviders(<CardHarness ref={ref} entry="public" mode="one_time" navigate={navigate} />);

    await act(async () => ref.current?.submit());

    expect(fake.submitCheckout).toHaveBeenCalledTimes(2);
    expect(fake.submitCheckout.mock.calls[1]?.[0]).toEqual(fake.submitCheckout.mock.calls[0]?.[0]);
    expect(screen.queryByTestId("stripe-pay-panel")).not.toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith(paymentStatusUrlFor(
      "/skomponuj-pakiet/platnosc",
      { ...paymentContext, providerPaymentId: "pi_stripe_critical_path" },
    ));
  });

  it("blocks a wallet double confirmation and hands a missing webhook to persistent status", async () => {
    let releaseSubmit: (() => void) | undefined;
    fake.elementsSubmit.mockReturnValue(new Promise<{ error?: undefined }>((resolve) => {
      releaseSubmit = () => resolve({});
    }));
    const navigate = navigateMock();
    renderWithProviders(<WalletHarness entry="public" mode="one_time" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-ready" }));
    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-open" }));
    expect(fake.submitCheckout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "fake-wallet-confirm" }));
    expect(fake.elementsSubmit).toHaveBeenCalledTimes(1);
    expect(fake.submitCheckout).not.toHaveBeenCalled();

    releaseSubmit?.();
    await waitFor(() => expect(fake.submitCheckout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expectedStatusPath("public")));
    expect(fake.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("keeps a post-confirmation poll timeout on payment status instead of declaring a missing webhook failed", async () => {
    const navigate = navigateMock();
    const ref = { current: null as HarnessRef | null };
    renderWithProviders(<CardHarness ref={ref} entry="public" mode="one_time" navigate={navigate} />);
    await act(async () => ref.current?.submit());
    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));
    fireEvent.click(await screen.findByRole("button", { name: "fake-poll-timeout" }));
    expect(navigate).toHaveBeenCalledWith(expectedStatusPath("public"));
  });

  it("routes an explicit card decline through the bounded readback and back to the payment step", async () => {
    fake.confirmPayment.mockResolvedValueOnce({
      error: { type: "card_error", code: "card_declined", message: "declined" },
    });
    const navigate = navigateMock();
    const ref = { current: null as HarnessRef | null };
    renderWithProviders(<CardHarness ref={ref} entry="public" mode="one_time" navigate={navigate} />);

    await act(async () => ref.current?.submit());
    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    // The bounded readback is unchanged — it is still what terminalizes the
    // attempt and mints the recovery token. What changed is where the buyer
    // lands: the panel unmounts and the payment step takes them back, carrying
    // the reason, instead of the standalone failure page.
    await waitFor(() => expect(takeCheckoutDeclineNotice()).toBe("checkout:errors.paymentDeclinedCard"));
    expect(navigate).not.toHaveBeenCalledWith(expectedFailurePath("public"));
  });

  it("keeps a requires-action/3DS card confirmation on the webhook-authoritative poller", async () => {
    fake.confirmPayment.mockResolvedValueOnce({ paymentIntent: { status: "requires_action" } });
    const navigate = navigateMock();
    const ref = { current: null as HarnessRef | null };
    renderWithProviders(<CardHarness ref={ref} entry="account" mode="subscription" navigate={navigate} />);

    await act(async () => ref.current?.submit());
    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    expect(await screen.findByRole("button", { name: "fake-poll-paid" })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(RENEWAL_ORIGINS)("renews a subscription saved after %s through one local cycle and one off-session Stripe attempt", async (origin) => {
    const createPaymentIntent = vi.fn().mockResolvedValue({
      id: `pi_renewal_${origin}`,
      status: "succeeded",
      customer: "cus_renewal",
      payment_method: `pm_saved_after_${origin}`,
      latest_charge: `ch_renewal_${origin}`,
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({
      client: { createPaymentIntent, createSetupIntent: vi.fn() },
      defaultFlow: "off_session_payment",
    });
    const renewal = renewalClient();
    const paymentPort = renewalPaymentPort();
    const due = renewalDue(`pm_saved_after_${origin}`);
    const result = await chargeSubscriptionCycleOffSession(
      renewalDeps(renewal.client, paymentPort, adapter, due),
      due,
    );

    expect(createPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
      customer: "cus_renewal",
      paymentMethod: `pm_saved_after_${origin}`,
      offSession: true,
    }), { idempotencyKey: expect.stringContaining("openlup:stripe:") });
    expect(result).toMatchObject({
      outcome: "charged",
      cycleId: renewalIds.cycleId,
      orderId: renewalIds.orderId,
      paymentIntentId: renewalIds.paymentIntentId,
      attemptStatus: "processing",
    });
    expect(paymentPort.createIntent).toHaveBeenCalledTimes(1);
    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(1);
    expect(renewal.rpcCalls.filter(({ name }) => name === "subscription_create_cycle_order_with_outbox")).toHaveLength(1);

    renewal.markCycleReplay();
    const replay = renewalPaymentPort({ replayed: true, status: "processing" });
    const replayResult = await chargeSubscriptionCycleOffSession(
      renewalDeps(renewal.client, replay, adapter, due),
      due,
    );
    expect(replayResult).toMatchObject({ outcome: "charged", replayed: true, cycleId: renewalIds.cycleId });
    const cycleOrderCalls = renewal.rpcCalls.filter(({ name }) => name === "subscription_create_cycle_order_with_outbox");
    expect(cycleOrderCalls).toHaveLength(2);
    expect(cycleOrderCalls[1]?.args.p_idempotency_key).toBe(cycleOrderCalls[0]?.args.p_idempotency_key);
    expect(new Set([result.cycleId, replayResult.cycleId])).toEqual(new Set([renewalIds.cycleId]));
    expect(new Set([result.orderId, replayResult.orderId])).toEqual(new Set([renewalIds.orderId]));
    expect(new Set([result.paymentIntentId, replayResult.paymentIntentId])).toEqual(new Set([renewalIds.paymentIntentId]));
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(replay.finalizeProviderAttempt).not.toHaveBeenCalled();
  });
});

const CardHarness = forwardRef<HarnessRef, { entry: Entry; mode: CheckoutMode; navigate: NavigateFunction }>(
  function CardHarness({ entry, mode, navigate }, ref) {
    const checkout = useCheckout(entry, navigate);
    useImperativeHandle(ref, () => ({
      submit: () => checkout.handleComplete(formData(mode), { paymentMethod: "card" } as never),
    }), [checkout, mode]);
    return checkout.stripePay ? <SkomponujPakietStripePayPanel
      state={checkout.stripePay}
      onConfirmSettled={checkout.onConfirmSettled}
      onPollerTerminal={checkout.onPollerTerminal}
      returnPath={entry === "account" ? "/konto/zamowienie/status" : undefined}
    /> : <div data-testid="step-6-card" />;
  },
);

function WalletHarness({ entry, mode, navigate }: { entry: Entry; mode: CheckoutMode; navigate: NavigateFunction }) {
  const checkout = useCheckout(entry, navigate);
  return <WalletExpressRow
    data={formData(mode)}
    checkoutMode={mode}
    onSettled={checkout.handleWalletSettled}
    returnPath={entry === "account" ? "/konto/zamowienie/status" : "/skomponuj-pakiet/platnosc"}
    knownCompositionSlugs={KNOWN_COMPOSITION_SLUGS}
  />;
}

function useCheckout(entry: Entry, navigate: NavigateFunction) {
  const account = entry === "account";
  return useConfiguratorCheckout({
    navigate,
    lang: "pl",
    knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS,
    paths: {
      thankYou: "/skomponuj-pakiet/dziekujemy",
      paymentFailed: "/skomponuj-pakiet/platnosc-nieudana",
      paymentPath: "/skomponuj-pakiet/platnosc",
      ...(account ? { accountStatusPath: "/konto/zamowienie/status", accountDashboardPath: "/konto" } : {}),
    },
    ...(account ? { onAccountOrderComplete: vi.fn() } : {}),
  });
}

function formData(mode: CheckoutMode): ConfiguratorFormData {
  return {
    dogName: "Lida",
    subscription: mode === "subscription",
    paymentMethod: "card",
    checkoutQuoteExpectation: { totalGross: { amountMinor: 12_900, currency: "PLN" } },
    lengthDays: 21,
    promoCodes: [],
  } as unknown as ConfiguratorFormData;
}

function stripeProcessingResponse(mode: CheckoutMode) {
  return {
    contractVersion: "commerce.checkout.v2" as const,
    checkoutKind: mode === "subscription" ? "subscription_initial" as const : "one_time" as const,
    status: "processing" as const,
    ...paymentContext,
    providerPaymentId: "pi_stripe_critical_path",
    clientAction: { kind: "provider_embedded" as const, provider: "stripe" as const, clientSecret: "pi_stripe_critical_path_secret" },
  };
}

function expectCheckoutRequest(
  entry: Entry,
  mode: CheckoutMode,
  options: { accountReturnContext?: boolean } = {},
) {
  const request = fake.submitCheckout.mock.calls[0]?.[0];
  expect(request).toEqual(expect.objectContaining({
    paymentProvider: "stripe",
    intent: expect.objectContaining({ mode, idempotencyKey: "checkout:stripe-critical-path" }),
    expectedQuote: formData(mode).checkoutQuoteExpectation,
    ...(options.accountReturnContext && entry === "account" ? { returnContext: "account" } : {}),
  }));
  if (!options.accountReturnContext || entry === "public") expect(request).not.toHaveProperty("returnContext");
}

function expectedStatusPath(entry: Entry) {
  return paymentStatusUrlFor(entry === "account" ? "/konto/zamowienie/status" : "/skomponuj-pakiet/platnosc", paymentContext);
}

function expectedTerminalPath(entry: Entry) {
  return entry === "account" ? expectedStatusPath(entry) : thankYouUrlFor("/skomponuj-pakiet/dziekujemy", paymentContext);
}

function expectedFailurePath(entry: Entry) {
  if (entry === "account") return expectedStatusPath(entry);
  return paymentFailedUrlFor(
    "/skomponuj-pakiet/platnosc-nieudana",
    paymentContext,
  );
}

function expectedCardReturnUrl(entry: Entry) {
  return `${window.location.origin}${expectedStatusPath(entry)}`;
}

const renewalIds = {
  subscriptionId: "00000000-0000-4000-8000-000000000001",
  orderId: "00000000-0000-4000-8000-000000000aaa",
  orderRef: "order_00000000-0000-4000-8000-000000000aaa",
  cycleId: "00000000-0000-4000-8000-000000000ccc",
  paymentIntentId: "00000000-0000-4000-8000-000000000ddd",
  paymentId: "00000000-0000-4000-8000-000000000eee",
  paymentAttemptId: "00000000-0000-4000-8000-000000000fff",
};

/**
 * Composes the renewal charge exactly as the cron does: the rail's capability
 * comes from the REAL published registry, keyed by the row's own provider kind,
 * so this gate keeps proving the dispatch production takes. Typed as
 * `ChargeDeps` on purpose — `tests/**` is in no tsconfig project, so this
 * annotation is the only thing that can catch a missing dependency here.
 */
function renewalDeps(
  client: Parameters<typeof createManagedSubscriptionRenewalPersistencePort>[0]
    & ChargeDeps["deliveryAlignment"],
  paymentPort: ChargeDeps["paymentPort"],
  executionPort: ChargeDeps["executionPort"],
  due: DueSubscription,
): ChargeDeps {
  return {
    persistence: createManagedSubscriptionRenewalPersistencePort(client),
    deliveryAlignment: client,
    chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never),
    paymentPort,
    executionPort,
    capability: requirePaymentProviderCapability(due.providerKind),
  };
}

function renewalDue(providerMethodRef: string): DueSubscription {
  return {
    subscriptionId: renewalIds.subscriptionId,
    clientId: paymentContext.clientId,
    nextCycleAt: "2026-07-24T00:00:00.000Z",
    currency: "PLN",
    providerKind: "stripe",
    providerCustomerRef: "cus_renewal",
    providerMethodRef,
    methodKind: "card",
    payerEmail: "stripe-gate@example.test",
    payerName: "Stripe Gate",
  };
}

function renewalClient() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let replayedCycle = false;
  const client = {
    admitDeliveryAlignment: vi.fn().mockResolvedValue({ allowed: true, state: "none", reason: "on_time" }),
    rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "subscription_current_template_snapshot") {
        return Promise.resolve({
          data: {
            cadence_days: 28,
            currency: "PLN",
            region_code: "PL",
            edit_window_hours: 72,
            size_constraint: {},
            lines: [{ variant_id: "v-1", qty: 1, sort_order: 0, is_addon: false }],
          },
          error: null,
        });
      }
      if (name === "subscription_create_cycle_order_with_outbox") {
        return Promise.resolve({
          data: {
            subscriptionCycleOrder: {
              cycleId: renewalIds.cycleId,
              orderId: renewalIds.orderRef,
              paymentId: `payment_${renewalIds.paymentId}`,
              status: "payment_pending",
              idempotencyKey: args.p_idempotency_key,
              replayed: replayedCycle,
            },
          },
          error: null,
        });
      }
      if (name === "subscription_cycle_reservation_preflight") {
        return Promise.resolve({ data: { ok: true, itemsChecked: 1, reacquired: 0 }, error: null });
      }
      throw new Error(`unexpected renewal RPC ${name}`);
    }),
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "subscriptions") {
        // Harness extension only: the snapshot builder reads the subscription's
        // starter-pack state. No marker, so this gate behaves exactly as before.
        return renewalThenable([{ starter_pack: null, template_version: 1, cadence_days: 28 }]);
      }
      if (table === "subscription_lines") {
        return renewalThenable([
          {
            variant_id: "v-1",
            qty: 1,
            sort_order: 0,
            line_metadata: {
              productSnapshot: {
                quoteLine: renewalQuoteLine(),
              },
            },
          },
        ]);
      }
      if (table === "subscription_cycles") return renewalThenable([]);
      throw new Error(`unexpected renewal table ${table}`);
    }),
  };
  return {
    // Mirror the production renewal composition: snapshot persistence consumes
    // the neutral starter-pack port, not methods assumed to exist on the raw DB client.
    client: Object.assign(client, createStarterPackCyclePort(client as never)) as never,
    rpcCalls,
    markCycleReplay: () => { replayedCycle = true; },
  };
}

function renewalThenable(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"] as const) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data, error: null });
  return builder as never;
}

function renewalQuoteLine() {
  const gross = 12_900;
  const net = Math.round((gross * 10_000) / 10_800);
  return {
    sku: "VEL-STRIPE-GATE",
    productSlug: "stripe-gate",
    quantity: 1,
    unitPriceGross: { amountMinor: gross, currency: "PLN" },
    lineSubtotalGross: { amountMinor: gross, currency: "PLN" },
    tax: {
      included: true,
      country: "PL",
      category: "pet_food",
      vatRateBps: 800,
      legalBasis: "PL VAT Annex 3 item 10c",
      netAmount: { amountMinor: net, currency: "PLN" },
      vatAmount: { amountMinor: gross - net, currency: "PLN" },
      grossAmount: { amountMinor: gross, currency: "PLN" },
    },
  };
}

function renewalPaymentPort(
  prepared: { replayed?: boolean; status?: "created" | "processing" } = {},
): PreparedProviderAttemptRuntimePort {
  return {
    createIntent: vi.fn().mockResolvedValue({
      paymentIntentId: renewalIds.paymentIntentId,
      paymentId: renewalIds.paymentId,
      status: "created",
      replayed: false,
    }),
    prepareProviderAttempt: vi.fn().mockResolvedValue({
      paymentAttemptId: renewalIds.paymentAttemptId,
      status: prepared.status ?? "created",
      replayed: prepared.replayed ?? false,
      providerAttemptId: prepared.replayed ? "pi_replayed" : null,
      providerSessionId: prepared.replayed ? "pi_replayed" : null,
      nextActionKind: null,
    }),
    finalizeProviderAttempt: vi.fn().mockImplementation(async (input) => ({
      paymentAttemptId: renewalIds.paymentAttemptId,
      status: input.attemptStatus,
      replayed: false,
      providerAttemptId: input.providerAttemptId,
      providerSessionId: input.providerSessionId,
      nextActionKind: input.nextActionKind,
    })),
    recordAttempt: vi.fn(),
    applyResult: vi.fn(),
  } as unknown as PreparedProviderAttemptRuntimePort;
}

function navigateMock(): NavigateFunction {
  return vi.fn() as unknown as NavigateFunction;
}
