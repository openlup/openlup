import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/**
 * The UI half of the subscription journey, seeded.
 *
 * `docs/plan/oss-subscription-axis-audit.md` §1.5 records that the axis has a port-level
 * journey (reference skeleton B) and **no** journey at any level that drives a page. This
 * spec is that seed, scoped to the entry: it drives the neutral entry the way a customer
 * does — pick an offer, pick a recurrence, fill the details, subscribe — and asserts the
 * two things a1 is about: that a SUBSCRIPTION command leaves the entry, and that the
 * customer is handed to the PUBLISHED checkout machine's payment page with the query
 * contract that page reads.
 *
 * ⛔ It deliberately does not assert renewal, dunning or recovery. Those are the
 * lifecycle's, and skeleton B already owns them at the port level.
 */

const mocks = vi.hoisted(() => ({
  listReferenceStoreItems: vi.fn(),
  submitReferenceCheckout: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/domains/catalog/catalogClient", () => ({
  listReferenceStoreItems: mocks.listReferenceStoreItems,
}));
vi.mock("@/domains/commerce/referenceCommerceClient", () => ({
  submitReferenceCheckout: mocks.submitReferenceCheckout,
}));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => mocks.navigate,
}));

import SubscribeEntryPage from "./SubscribeEntryPage";

const CATALOG = {
  contractVersion: "catalog.sellable.v1",
  profile: {
    id: "example-store",
    brand: "Northstar Supply",
    country: "DE",
    currency: "EUR",
    locale: "en",
    timezone: "UTC",
  },
  items: [
    {
      sku: "NORTHSTAR-REFILL-001",
      title: "Northstar Supply Refill",
      unitPrice: { amountMinor: 1490, currency: "EUR" },
      permittedPurchaseModes: ["one_time", "subscription"],
    },
    {
      sku: "NORTHSTAR-GIFT-001",
      title: "Northstar Supply Gift Box",
      unitPrice: { amountMinor: 4900, currency: "EUR" },
      permittedPurchaseModes: ["one_time"],
    },
  ],
};

const CHECKOUT_CREATED = {
  version: "commerce.reference_checkout.v1",
  orderId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  paymentIntentId: "33333333-3333-4333-8333-333333333333",
  paymentAttemptId: "44444444-4444-4444-8444-444444444444",
  paymentStatus: "created",
  paymentAttemptStatus: "processing",
  replayed: false,
  total: { amountMinor: 2980, currency: "EUR" },
};

const DETAILS: ReadonlyArray<[string, string]> = [
  ["First name", "Ada"],
  ["Last name", "Lovelace"],
  ["Email", "ada@example.test"],
  ["Phone", "600100200"],
  ["Street and number", "Analytical 1"],
  ["Postal code", "10115"],
  ["City", "Berlin"],
];

function renderEntry() {
  return render(
    <MemoryRouter>
      <SubscribeEntryPage />
    </MemoryRouter>,
  );
}

function fillDetails(): void {
  for (const [label, value] of DETAILS) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

describe("subscribe entry journey", () => {
  it("carries a chosen offer and recurrence into the published checkout machine", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue(CATALOG);
    mocks.submitReferenceCheckout.mockResolvedValue(CHECKOUT_CREATED);

    renderEntry();

    expect(await screen.findByRole("heading", { name: "Northstar Supply" })).toBeInTheDocument();
    // Only the subscribable offer is presented; the gift box is one-time only.
    expect(screen.getByLabelText(/Northstar Supply Refill/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Gift Box/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Quantity per delivery"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Every 14 days"));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() => expect(mocks.submitReferenceCheckout).toHaveBeenCalledTimes(1));

    const { command } = mocks.submitReferenceCheckout.mock.calls[0][0];
    expect(command.mode).toBe("subscription");
    expect(command.cadenceDays).toBe(14);
    expect(command.currency).toBe("EUR");
    expect(command.lines).toEqual([{ sku: "NORTHSTAR-REFILL-001", quantity: 2 }]);
    expect(command.shippingAddress).toMatchObject({ country: "DE", city: "Berlin" });
    expect(command.customer).toMatchObject({ email: "ada@example.test" });

    // The handoff: the published payment page's own query contract.
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    const target = new URL(mocks.navigate.mock.calls[0][0], "https://example.test");
    expect(target.pathname).toBe("/subscribe/payment");
    expect(target.searchParams.get("orderId")).toBe(CHECKOUT_CREATED.orderId);
    expect(target.searchParams.get("paymentIntentId")).toBe(CHECKOUT_CREATED.paymentIntentId);
    expect(target.searchParams.get("clientId")).toBe(CHECKOUT_CREATED.clientId);
  });

  it("routes a refused settlement to the published failure page instead of the payment page", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue(CATALOG);
    mocks.submitReferenceCheckout.mockResolvedValue({
      ...CHECKOUT_CREATED,
      paymentStatus: "failed",
      paymentAttemptStatus: "failed",
    });
    mocks.navigate.mockClear();

    renderEntry();
    await screen.findByRole("heading", { name: "Northstar Supply" });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    expect(String(mocks.navigate.mock.calls[0][0])).toContain("/subscribe/payment-failed");
  });

  it("stays inert on a deployment whose catalog declares nothing subscribable", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue({
      ...CATALOG,
      items: [CATALOG.items[1]],
    });
    mocks.submitReferenceCheckout.mockClear();

    renderEntry();

    expect(
      await screen.findByText(/publishes no offers on a recurring basis/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe" })).not.toBeInTheDocument();
    expect(mocks.submitReferenceCheckout).not.toHaveBeenCalled();
  });
});
