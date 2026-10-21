import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listReferenceStoreItems: vi.fn(),
  listCatalogProducts: vi.fn(),
  getCatalogProduct: vi.fn(),
  submitReferenceCheckout: vi.fn(),
}));
vi.mock("@/domains/catalog/catalogClient", () => ({
  listReferenceStoreItems: mocks.listReferenceStoreItems,
  listCatalogProducts: mocks.listCatalogProducts,
  getCatalogProduct: mocks.getCatalogProduct,
}));
vi.mock("@/domains/commerce/referenceCommerceClient", () => ({ submitReferenceCheckout: mocks.submitReferenceCheckout }));

import ReferenceStorePage from "./ReferenceStorePage";

describe("ReferenceStorePage", () => {
  it("uses only typed BFF clients for a neutral local checkout", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue({
      contractVersion: "catalog.sellable.v1",
      profile: {
        id: "test-local-profile",
        brand: "Northstar Supply",
        country: "DE",
        currency: "EUR",
        locale: "en",
        timezone: "UTC",
      },
      items: [{
        sku: "NORTHSTAR-REFILL-001",
        title: "Northstar Supply Refill",
        unitPrice: { amountMinor: 1490, currency: "EUR" },
        permittedPurchaseModes: ["one_time"],
      }],
    });
    mocks.submitReferenceCheckout.mockResolvedValue({
      version: "commerce.reference_checkout.v1",
      orderId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      paymentIntentId: "33333333-3333-4333-8333-333333333333",
      paymentAttemptId: "44444444-4444-4444-8444-444444444444",
      paymentStatus: "created",
      paymentAttemptStatus: "processing",
      replayed: false,
      total: { amountMinor: 1490, currency: "EUR" },
    });

    mocks.listCatalogProducts.mockRejectedValue(new Error("refused"));

    render(<ReferenceStorePage />);
    expect(await screen.findByRole("heading", { name: "Northstar Supply" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create local checkout" }));

    await waitFor(() => expect(mocks.submitReferenceCheckout).toHaveBeenCalledTimes(1));
    expect(mocks.submitReferenceCheckout).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({
        currency: "EUR",
        shippingAddress: expect.objectContaining({ country: "DE" }),
        lines: [{ sku: "NORTHSTAR-REFILL-001", quantity: 1 }],
      }),
    }));
    expect(await screen.findByText(/Checkout created/)).toBeInTheDocument();
  });

  it("does not present a refused payment as a created checkout", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue({
      contractVersion: "catalog.sellable.v1",
      profile: {
        id: "test-local-profile",
        brand: "Northstar Supply",
        country: "DE",
        currency: "EUR",
        locale: "en",
        timezone: "UTC",
      },
      items: [{
        sku: "NORTHSTAR-REFILL-001",
        title: "Northstar Supply Refill",
        unitPrice: { amountMinor: 1490, currency: "EUR" },
        permittedPurchaseModes: ["one_time"],
      }],
    });
    mocks.submitReferenceCheckout.mockResolvedValue({
      version: "commerce.reference_checkout.v1",
      orderId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      paymentIntentId: "33333333-3333-4333-8333-333333333333",
      paymentAttemptId: "44444444-4444-4444-8444-444444444444",
      paymentStatus: "failed",
      paymentAttemptStatus: "failed",
      replayed: false,
      total: { amountMinor: 1490, currency: "EUR" },
    });

    render(<ReferenceStorePage />);
    await screen.findByRole("heading", { name: "Northstar Supply" });
    fireEvent.click(screen.getByRole("button", { name: "Create local checkout" }));

    expect(await screen.findByText(/Checkout refused/)).toBeInTheDocument();
    expect(screen.queryByText(/Checkout created/)).not.toBeInTheDocument();
  });

  it("reads the operator catalogue through the typed database-backed client", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue({
      contractVersion: "catalog.sellable.v1",
      profile: { id: "p", brand: "Northstar Supply", country: "DE", currency: "EUR", locale: "en", timezone: "UTC" },
      items: [{ sku: "S", title: "T", unitPrice: { amountMinor: 1, currency: "EUR" }, permittedPurchaseModes: ["one_time"] }],
    });
    const unit = {
      sku: "REFERENCE-ALPHA-S",
      pricing: { status: "configured", listPrice: { amountMinor: 1990, currency: "EUR" } },
    };
    mocks.listCatalogProducts.mockResolvedValue({
      contractVersion: "v", products: [{ slug: "reference-alpha", displayName: "Reference Alpha", variants: [unit] }],
    });
    mocks.getCatalogProduct.mockResolvedValue({
      contractVersion: "v", product: { slug: "reference-alpha", displayName: "Reference Alpha", variants: [unit] },
    });

    render(<ReferenceStorePage />);

    const entry = await screen.findByRole("button", { name: /Reference Alpha/ });
    fireEvent.click(entry);
    await waitFor(() => expect(mocks.getCatalogProduct).toHaveBeenCalledWith("reference-alpha"));
    expect(await screen.findByText(/REFERENCE-ALPHA-S/)).toBeInTheDocument();
  });

  it("names the refusal instead of rendering an empty shop", async () => {
    mocks.listReferenceStoreItems.mockResolvedValue({
      contractVersion: "catalog.sellable.v1",
      profile: { id: "p", brand: "Northstar Supply", country: "DE", currency: "EUR", locale: "en", timezone: "UTC" },
      items: [{ sku: "S", title: "T", unitPrice: { amountMinor: 1, currency: "EUR" }, permittedPurchaseModes: ["one_time"] }],
    });
    mocks.listCatalogProducts.mockRejectedValue(new Error("refused"));

    render(<ReferenceStorePage />);

    expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
  });
});
