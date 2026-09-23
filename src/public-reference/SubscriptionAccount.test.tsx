// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(), checkout: vi.fn(), signIn: vi.fn(), readSession: vi.fn(), clearSession: vi.fn(),
  getAccount: vi.fn(), applyAction: vi.fn(), reconcile: vi.fn(),
}));
vi.mock("./subscriptionApi", () => ({
  loadReferenceItems: mocks.catalog,
  createReferenceSubscription: mocks.checkout,
  requestReferenceSignIn: mocks.signIn,
  readReferenceSession: mocks.readSession,
  clearReferenceSession: mocks.clearSession,
}));
vi.mock("@/domains/customers/customerSelfServiceClient", () => ({
  getCustomerAccount: mocks.getAccount,
  applyCustomerSubscriptionAction: mocks.applyAction,
}));
vi.mock("@/domains/customers/customerReconcileClient", () => ({ reconcileCustomerAccount: mocks.reconcile }));
vi.mock("@/pages/account/v2/subscriptions/modals/RescheduleModal", () => ({
  RescheduleModal: ({ open, onAction, subscription }: { open: boolean; onAction: (body: unknown) => void; subscription: { subscriptionId: string } }) =>
    open ? <button type="button" onClick={() => onAction({ action: "slide_next_cycle", subscriptionId: subscription.subscriptionId, newNextCycleAt: "2026-10-17T12:00:00.000Z", idempotencyKey: "reference-date-1" })}>Confirm date</button> : null,
}));

import { ReferenceAccount, ReferenceSubscribe } from "./SubscriptionAccount";

const catalog = {
  contractVersion: "catalog.sellable.v1",
  profile: { id: "local", brand: "Reference", country: "PL", currency: "USD", locale: "en", timezone: "UTC" },
  items: [{ sku: "NORTHSTAR-REFILL-001", title: "Refill", unitPrice: { amountMinor: 1490, currency: "USD" }, permittedPurchaseModes: ["subscription"] }],
};
const oldAccount = {
  recentOrders: [{ orderId: "order-1", orderNumber: "REF-1", status: "paid", paymentStatus: "succeeded" }],
  actionRequired: [],
  subscriptions: [{ subscriptionId: "subscription-1", status: "active", nextCycleAt: "2026-10-10T12:00:00.000Z", editCutoffAt: null, cadenceDays: 28, canEditUpcomingPackage: true, editBlockedReason: null }],
};
const newAccount = { ...oldAccount, subscriptions: [{ ...oldAccount.subscriptions[0], nextCycleAt: "2026-10-17T12:00:00.000Z" }] };

function withQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.catalog.mockResolvedValue(catalog);
  mocks.checkout.mockResolvedValue({ orderId: "order-1", paymentStatus: "succeeded" });
  mocks.signIn.mockResolvedValue({ accepted: true });
  mocks.readSession.mockReturnValue({ accessToken: "private-token", accountId: "buyer-1" });
  mocks.getAccount.mockResolvedValue(oldAccount);
  mocks.applyAction.mockResolvedValue({});
});

describe("subscription reference account", () => {
  it("buys the server-listed recurring SKU and presents captured status without claiming delivery", async () => {
    withQuery(<ReferenceSubscribe />);
    expect(await screen.findByText("Refill")).toBeInTheDocument();
    expect(screen.getByText("14.90 USD every 28 days, one item per order.")).toBeInTheDocument();
    for (const [label, value] of [
      ["First name", "Ada"], ["Last name", "Buyer"], ["Email", "ada@example.com"],
      ["Phone", "123456789"], ["Street address", "Example 1"], ["Postal code", "00-001"], ["City", "Warsaw"],
    ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Place recurring order" }));
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledOnce());
    expect(mocks.checkout.mock.calls[0]?.[0]).toMatchObject({ command: {
      mode: "subscription", cadenceDays: 28, currency: "USD", lines: [{ sku: "NORTHSTAR-REFILL-001", quantity: 1 }],
      customer: { email: "ada@example.com" },
    } });
    expect(await screen.findByText(/Captured in the local reference/)).toBeInTheDocument();
    expect(screen.getByText(/durable account state/)).toBeInTheDocument();
  });

  it("applies a selected renewal change with the signed-in token and shows refreshed readback", async () => {
    mocks.getAccount.mockResolvedValueOnce(oldAccount).mockResolvedValueOnce(newAccount);
    withQuery(<ReferenceAccount />);
    expect(await screen.findByText(/Oct 10, 2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change next renewal date" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm date" }));
    await waitFor(() => expect(mocks.applyAction).toHaveBeenCalledWith("private-token", expect.objectContaining({
      action: "slide_next_cycle", subscriptionId: "subscription-1",
    })));
    expect(await screen.findByText(/Oct 17, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/saved and account refreshed/)).toBeInTheDocument();
  });

  it("clears the tab session and principal cache on sign-out", async () => {
    const { client } = withQuery(<ReferenceAccount />);
    await screen.findByText(/Oct 10, 2026/);
    expect(client.getQueryData(["reference-account", "buyer-1"])).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.clearSession).toHaveBeenCalledOnce();
    expect(client.getQueryData(["reference-account", "buyer-1"])).toBeUndefined();
    expect(screen.getByRole("heading", { name: "Sign in to your account" })).toBeInTheDocument();
  });
});
