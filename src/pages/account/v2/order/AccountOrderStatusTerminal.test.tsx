import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatCustomerOrderReference } from "@/lib/orderRef";

import { AccountOrderStatusTerminal, type AccountOrderStatusParams } from "./AccountOrderStatusTerminal";

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framerMotionMock");
  return createFramerMotionMock();
});

const getCommercePaymentStatus = vi.fn();
const applyTpaySimulatorPaymentResult = vi.fn();

vi.mock("@/domains/commerce/commerceClient", () => ({
  getCommercePaymentStatus: (...args: unknown[]) => getCommercePaymentStatus(...args),
  applyTpaySimulatorPaymentResult: (...args: unknown[]) => applyTpaySimulatorPaymentResult(...args),
}));

vi.mock("@/checkout/adapters/tpayCheckoutFlags", () => ({
  tpaySimulatorUiEnabled: () => true,
}));

const params: AccountOrderStatusParams = {
  orderId: "11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  providerPaymentId: "tpay_sim_22222222-2222-4222-8222-222222222222",
  orderRef: "order_acct-terminal-1",
};

function renderTerminal(
  overrides: Partial<AccountOrderStatusParams> = {},
  callbacks: {
    onRetryOrder?: () => void;
    onPaid?: (petId: string | null) => void;
    onRepairSubscription?: (subscriptionId: string | null) => void;
    onPaymentTerminal?: (status: "paid" | "failed" | "expired") => void;
  } = {},
  orderRecap: {
    orderRef: string;
    petId: string | null;
    petName: string | null;
    mode: "one_time" | "subscription";
  } | null = null,
) {
  return render(
    <AccountOrderStatusTerminal
      params={{ ...params, ...overrides }}
      orderRecap={orderRecap}
      recapSettled
      onViewOrders={vi.fn()}
      onManageSubscription={vi.fn()}
      onBackToAccount={vi.fn()}
      onRetryOrder={callbacks.onRetryOrder ?? vi.fn()}
      onRepairSubscription={callbacks.onRepairSubscription ?? vi.fn()}
      onPaymentTerminal={callbacks.onPaymentTerminal}
      onPaid={callbacks.onPaid}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
  getCommercePaymentStatus.mockReset();
  applyTpaySimulatorPaymentResult.mockReset();
});

describe("AccountOrderStatusTerminal", () => {
  it("shows the in-shell poller + staging simulator controls while pending", async () => {
    getCommercePaymentStatus.mockResolvedValue({ status: "processing", payment: { intentStatus: "processing" } });
    renderTerminal();

    expect(await screen.findByTestId("account-payment-status")).toBeInTheDocument();
    expect(screen.getByTestId("account-simulator-controls")).toBeInTheDocument();
  });

  it("applies the simulator result when the buyer approves in place", async () => {
    getCommercePaymentStatus.mockResolvedValue({ status: "processing", payment: { intentStatus: "processing" } });
    applyTpaySimulatorPaymentResult.mockResolvedValue({});
    renderTerminal();

    const approve = await screen.findByText(/zatwierd|approve/i);
    fireEvent.click(approve);

    await waitFor(() =>
      expect(applyTpaySimulatorPaymentResult).toHaveBeenCalledWith(
        expect.objectContaining({ providerPaymentId: params.providerPaymentId, resultStatus: "succeeded" }),
      ),
    );
  });

  it("renders the cream success shell when the order is paid", async () => {
    const onPaid = vi.fn();
    getCommercePaymentStatus.mockResolvedValue({ status: "paid", payment: { intentStatus: "succeeded" } });
    const recap = {
      orderRef: params.orderRef,
      petId: "44444444-4444-4444-8444-444444444444",
      petName: "Burek",
      mode: "one_time" as const,
    };
    renderTerminal({ petId: "stale-pet" }, { onPaid }, recap);

    // Wait for the success shell (its "go to orders" CTA is success-exclusive — the
    // pending screen only has the simulator controls) before asserting the ref, so
    // we don't race the processing→paid transition.
    await screen.findByRole("button", { name: /Przejdź do zamówień|zamówie/i });
    // OrderSuccessShell surfaces the order reference as a friendly OPENLUP-* number,
    // never the raw order_<id> form (CJ01-AD).
    expect(
      screen.getByText(formatCustomerOrderReference(params.orderRef)),
    ).toBeInTheDocument();
    expect(screen.queryByText(params.orderRef)).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-simulator-controls")).not.toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
  });

  it("keeps an already-paid subscription in mandate activation polling without claiming account success", async () => {
    const onPaid = vi.fn();
    getCommercePaymentStatus.mockResolvedValue({
      status: "paid",
      payment: { intentStatus: "succeeded" },
      subscriptionActivation: {
        status: "waiting_for_mandate",
        subscriptionId: "77777777-7777-4777-8777-777777777777",
      },
    });
    renderTerminal({}, { onPaid });

    expect(await screen.findByText("Pierwsze zamówienie jest opłacone.")).toBeInTheDocument();
    expect(screen.getByTestId("account-payment-status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Przejdź do zamówień|zamówie/i })).toBeNull();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it.each(["waiting_for_mandate", "action_required"] as const)(
    "notifies authoritative paid cleanup while subscription activation is %s without claiming success",
    async (activationStatus) => {
      const onPaid = vi.fn();
      const onPaymentTerminal = vi.fn();
      getCommercePaymentStatus.mockResolvedValue({
        status: "paid",
        payment: { intentStatus: "succeeded" },
        subscriptionActivation: {
          status: activationStatus,
          subscriptionId: "77777777-7777-4777-8777-777777777777",
        },
      });
      renderTerminal({}, { onPaid, onPaymentTerminal });

      if (activationStatus === "waiting_for_mandate") {
        expect(await screen.findByText("Pierwsze zamówienie jest opłacone.")).toBeInTheDocument();
      } else {
        expect(await screen.findByRole("button", { name: "Dodaj kartę w koncie" })).toBeInTheDocument();
      }
      expect(onPaymentTerminal).toHaveBeenCalledExactlyOnceWith("paid");
      expect(onPaid).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Przejdź do zamówień|zamówie/i })).toBeNull();
    },
  );

  it("notifies an authoritative failed payment exactly once before retry UI", async () => {
    const onPaymentTerminal = vi.fn();
    getCommercePaymentStatus.mockResolvedValue({ status: "failed", payment: { intentStatus: "failed" } });
    renderTerminal({}, { onPaymentTerminal });

    await screen.findByRole("button", { name: /Dokończ płatność/i });

    expect(onPaymentTerminal).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("keeps mandate activation polling beyond 60 seconds without an account success", async () => {
    vi.useFakeTimers();
    const onPaid = vi.fn();
    getCommercePaymentStatus.mockResolvedValue({
      status: "paid",
      payment: { intentStatus: "succeeded" },
      subscriptionActivation: {
        status: "waiting_for_mandate",
        subscriptionId: "77777777-7777-4777-8777-777777777777",
      },
    });
    renderTerminal({}, { onPaid });

    await vi.advanceTimersByTimeAsync(60_001);

    expect(getCommercePaymentStatus.mock.calls.length).toBeGreaterThan(2);
    expect(screen.getByText("Pierwsze zamówienie jest opłacone.")).toBeInTheDocument();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it.each(["active", "action_required"] as const)(
    "does not timeout when the first mandate activation response arrives at the 60s boundary (%s)",
    async (activationStatus) => {
      vi.useFakeTimers();
      const onPaid = vi.fn();
      const onRepairSubscription = vi.fn();
      let statusReads = 0;
      getCommercePaymentStatus.mockImplementation(() => {
        statusReads += 1;
        if (statusReads <= 40) {
          return Promise.resolve({ status: "processing", payment: { intentStatus: "processing" } });
        }
        if (statusReads === 41) {
          return Promise.resolve({
            status: "paid",
            payment: { intentStatus: "succeeded" },
            subscriptionActivation: {
              status: "waiting_for_mandate",
              subscriptionId: "77777777-7777-4777-8777-777777777777",
            },
          });
        }
        return Promise.resolve({
          status: "paid",
          payment: { intentStatus: "succeeded" },
          subscriptionActivation: {
            status: activationStatus,
            subscriptionId: "77777777-7777-4777-8777-777777777777",
          },
        });
      });
      const recap = {
        orderRef: params.orderRef,
        petId: "44444444-4444-4444-8444-444444444444",
        petName: "Burek",
        mode: "subscription" as const,
      };
      renderTerminal({}, { onPaid, onRepairSubscription }, recap);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(screen.getByText("Pierwsze zamówienie jest opłacone.")).toBeInTheDocument();
      expect(onPaid).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });

      if (activationStatus === "active") {
        expect(screen.getByRole("button", { name: /Przejdź do zamówień|zamówie/i })).toBeInTheDocument();
        expect(onPaid).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
      } else {
        expect(screen.getByRole("button", { name: "Dodaj kartę w koncie" })).toBeInTheDocument();
        expect(onPaid).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for active activation before showing paid account success", async () => {
    vi.useFakeTimers();
    const onPaid = vi.fn();
    let resolveInitialStatus: (value: unknown) => void;
    const initialStatus = new Promise((resolve) => {
      resolveInitialStatus = resolve;
    });
    getCommercePaymentStatus
      .mockReturnValueOnce(initialStatus)
      .mockResolvedValueOnce({
        status: "paid",
        payment: { intentStatus: "succeeded" },
        subscriptionActivation: {
          status: "active",
          subscriptionId: "77777777-7777-4777-8777-777777777777",
        },
      });
    const recap = {
      orderRef: params.orderRef,
      petId: "44444444-4444-4444-8444-444444444444",
      petName: "Burek",
      mode: "subscription" as const,
    };
    renderTerminal({}, { onPaid }, recap);

    await act(async () => {
      resolveInitialStatus!({
        status: "paid",
        payment: { intentStatus: "succeeded" },
        subscriptionActivation: {
          status: "waiting_for_mandate",
          subscriptionId: "77777777-7777-4777-8777-777777777777",
        },
      });
      await Promise.resolve();
    });
    expect(screen.getByText("Pierwsze zamówienie jest opłacone.")).toBeInTheDocument();
    expect(onPaid).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole("button", { name: /Przejdź do zamówień|zamówie/i })).toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
  });

  it("stops at account payment repair when activation changes from waiting to action required", async () => {
    vi.useFakeTimers();
    const onPaid = vi.fn();
    const onRepairSubscription = vi.fn();
    let resolveInitialStatus: (value: unknown) => void;
    const initialStatus = new Promise((resolve) => {
      resolveInitialStatus = resolve;
    });
    getCommercePaymentStatus
      .mockReturnValueOnce(initialStatus)
      .mockResolvedValueOnce({
        status: "paid",
        payment: { intentStatus: "succeeded" },
        subscriptionActivation: {
          status: "action_required",
          subscriptionId: "77777777-7777-4777-8777-777777777777",
        },
    });
    renderTerminal({}, { onPaid, onRepairSubscription });

    await act(async () => {
      resolveInitialStatus!({
        status: "paid",
        payment: { intentStatus: "succeeded" },
        subscriptionActivation: {
          status: "waiting_for_mandate",
          subscriptionId: "77777777-7777-4777-8777-777777777777",
        },
      });
      await Promise.resolve();
    });
    expect(screen.getByText("Pierwsze zamówienie jest opłacone.")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const repair = screen.getByRole("button", { name: "Dodaj kartę w koncie" });
    expect(onPaid).not.toHaveBeenCalled();
    fireEvent.click(repair);
    expect(onRepairSubscription).toHaveBeenCalledWith("77777777-7777-4777-8777-777777777777");
  });

  it("shows the account payment-method repair CTA after mandate activation requires action", async () => {
    const onPaid = vi.fn();
    const onRepairSubscription = vi.fn();
    getCommercePaymentStatus.mockResolvedValue({
      status: "paid",
      payment: { intentStatus: "succeeded" },
      subscriptionActivation: {
        status: "action_required",
        subscriptionId: "77777777-7777-4777-8777-777777777777",
      },
    });
    renderTerminal({}, { onPaid, onRepairSubscription });

    fireEvent.click(await screen.findByRole("button", { name: "Dodaj kartę w koncie" }));
    expect(onRepairSubscription).toHaveBeenCalledWith("77777777-7777-4777-8777-777777777777");
    expect(screen.queryByRole("button", { name: /Przejdź do zamówień|zamówie/i })).toBeNull();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it.each(["failed", "expired"] as const)(
    "routes a provider-attested %s result back to the account order flow",
    async (status) => {
      const onRetryOrder = vi.fn();
      getCommercePaymentStatus.mockResolvedValue({ status, payment: { intentStatus: status } });
      renderTerminal({}, { onRetryOrder });

      fireEvent.click(await screen.findByRole("button", { name: /Dokończ płatność/i }));

      expect(onRetryOrder).toHaveBeenCalledTimes(1);
      expect(getCommercePaymentStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("only checks status again after a polling timeout, and says so", async () => {
    vi.useFakeTimers();
    const onRetryOrder = vi.fn();
    getCommercePaymentStatus.mockResolvedValue({
      status: "processing",
      payment: { intentStatus: "processing" },
    });
    renderTerminal({}, { onRetryOrder });

    await vi.advanceTimersByTimeAsync(60_001);

    // A wait that ran out is not a failure. This surface used to render it as
    // one — assertive alert, coral X, "Płatność nieudana" — over a control
    // labelled "Dokończ płatność" that only re-polled. The label now matches
    // what the handler actually does, which is the whole defect.
    expect(screen.queryByText("checkout:paymentFailed.title")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dokończ płatność/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-wait-delayed")).toBeInTheDocument();

    const callsBeforeRetry = getCommercePaymentStatus.mock.calls.length;
    fireEvent.click(screen.getByTestId("payment-wait-recheck"));
    await vi.advanceTimersByTimeAsync(0);

    // Still a re-read, never a second payment.
    expect(onRetryOrder).not.toHaveBeenCalled();
    expect(getCommercePaymentStatus.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });

  it("hides the simulator controls for a non-simulator provider attempt", async () => {
    getCommercePaymentStatus.mockResolvedValue({ status: "processing", payment: { intentStatus: "processing" } });
    renderTerminal({ providerPaymentId: "tpay_live_abc" });

    expect(await screen.findByTestId("account-payment-status")).toBeInTheDocument();
    expect(screen.queryByTestId("account-simulator-controls")).not.toBeInTheDocument();
  });
});
