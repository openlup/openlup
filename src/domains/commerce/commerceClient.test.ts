import { describe, expect, it, vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION, COMMERCE_CURRENCIES } from "./types";
import {
  createCommerceOrderDraft,
  createCommerceQuote,
  createCommerceQuoteBatch,
  getCommerceOrderRecap,
  getCommercePaymentStatus,
  getConfiguratorOfferLayout,
  getTpayPaymentChannels,
} from "./commerceClient";
import { COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION } from "./offerLayoutContracts";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "./paymentFailureDisplayContracts";
import { CHECKOUT_CONTRACT_VERSION } from "./checkoutContracts";
import type {
  CreateOrderDraftRequest,
  CreateOrderDraftResponse,
  CreateQuoteResponse,
} from "./contracts";

describe("commerce BFF client", () => {
  it.each([undefined, null, "provider_declined"])("negotiates display while preserving old-server value %s", async (failureDisplay) => {
    const request = {
      orderId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
    };
    const fetcher = createFetcher({
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      orderId: request.orderId, paymentIntentId: request.paymentIntentId,
      status: "failed", orderStatus: "pending_payment",
      payment: {
        intentStatus: "failed", attemptStatus: "failed", paymentAttemptId: null,
        provider: null, providerPaymentId: null, updatedAt: "2026-09-06T18:00:00.000Z",
      },
      failureReason: "provider_declined",
      ...(failureDisplay === undefined ? {} : { failureDisplay }),
      subscriptionActivation: { status: "not_applicable", subscriptionId: null }, nextAction: null,
    });
    const headers = new Headers({ "X-Existing": "preserve", [PAYMENT_FAILURE_DISPLAY_HEADER]: "0" });
    const response = await getCommercePaymentStatus(request, { fetcher, headers, credentials: "include" });
    expect(response.failureDisplay).toBe(failureDisplay);
    if (failureDisplay === undefined) expect(response).not.toHaveProperty("failureDisplay");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/bff/commerce/payment-status?${new URLSearchParams(request)}`);
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
    expect(new Headers(init.headers).get("X-Existing")).toBe("preserve");
    expect(new Headers(init.headers).get(PAYMENT_FAILURE_DISPLAY_HEADER)).toBe("1");
    expect(headers.get(PAYMENT_FAILURE_DISPLAY_HEADER)).toBe("0");
  });
  it("creates a hidden commerce quote through the typed BFF client", async () => {
    const fetcher = createFetcher({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      quote: quote(),
    });

    await expect(
      createCommerceQuote(
        { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] },
        { fetcher },
      ),
    ).resolves.toMatchObject({
      quote: {
        totalGross: { amountMinor: 1490, currency: "PLN" },
        taxIncluded: true,
      },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/quote",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }],
        }),
      }),
    );
  });

  it("throws on BFF errors and malformed quote envelopes", async () => {
    const failed = createRawFetcher({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Unknown commerce SKU" },
    });
    const malformed = createRawFetcher({ ok: true, data: { quote: {} } });

    await expect(
      createCommerceQuote(
        { lines: [{ sku: "OPENLUP-DOG-DUCK-CAN-400G", quantity: 1 }] },
        { fetcher: failed },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      createCommerceQuote(
        { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] },
        { fetcher: malformed },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects private catalog facts in a batch response", async () => {
    const enriched = quote();
    enriched.lines[0]!.catalogFacts = catalogFacts(enriched.currency);

    await expect(createCommerceQuoteBatch(
      { quotes: [{ lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }] },
      { fetcher: createFetcher({ contractVersion: COMMERCE_CONTRACT_VERSION, quotes: [enriched] }) },
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reads the configurator offer layout through the typed BFF client", async () => {
    const fetcher = createFetcher({
      contractVersion: COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION,
      layout: "one_time_first",
    });

    await expect(getConfiguratorOfferLayout({ fetcher })).resolves.toEqual({
      contractVersion: COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION,
      layout: "one_time_first",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/offer-layout",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("bounds the offer-layout read so the package step cannot wait forever", async () => {
    // The step that renders the offer WAITS on this call, so an unanswered request
    // would hold the offer behind a spinner. It is also the most droppable call in
    // the flow: timing out lands on the fail-safe default.
    const hung = vi.fn((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );

    vi.useFakeTimers();
    try {
      const pending = getConfiguratorOfferLayout({
        fetcher: hung as unknown as typeof fetch,
      });
      const settled = expect(pending).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(4_000);
      await settled;
      expect(hung.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an offer layout outside the contract vocabulary", async () => {
    // The caller turns every rejection into the fail-safe default, so a layout the
    // browser does not understand must REJECT rather than arrive as a string.
    const unknownLayout = createFetcher({
      contractVersion: COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION,
      layout: "flavour_first",
    });
    const unavailable = createRawFetcher({
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", message: "Commerce settings unavailable" },
    });

    await expect(getConfiguratorOfferLayout({ fetcher: unknownLayout }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(getConfiguratorOfferLayout({ fetcher: unavailable }))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("creates a hidden order draft through the typed BFF client", async () => {
    const fetcher = createFetcher(orderDraftResponse());
    const request: CreateOrderDraftRequest = {
      idempotencyKey: "quote-2026-06-01-lamb",
      quoteSnapshot: {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quote: quote(),
      },
    };

    await expect(createCommerceOrderDraft(request, { fetcher })).resolves.toMatchObject({
      orderDraft: {
        orderId: "order_wave-3",
        status: "draft",
        paymentStatus: "not_started",
        quoteSnapshot: request.quoteSnapshot,
      },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/order-draft",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("throws on BFF errors and malformed order draft envelopes", async () => {
    const failed = createRawFetcher({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Commerce order draft persistence is not configured",
      },
    });
    const malformed = createRawFetcher({ ok: true, data: { orderDraft: {} } });
    const request: CreateOrderDraftRequest = {
      idempotencyKey: "quote-2026-06-01-lamb",
      quoteSnapshot: {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quote: quote(),
      },
    };

    await expect(createCommerceOrderDraft(request, { fetcher: failed })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    await expect(createCommerceOrderDraft(request, { fetcher: malformed })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("reads sanitized Tpay payment channels through the typed BFF client", async () => {
    const fetcher = createFetcher({
      contractVersion: "commerce.tpay.channels.v1",
      channels: [{
        id: "21",
        name: "PKO",
        fullName: "PKO Bank Polski",
        available: true,
        onlinePayment: true,
        instantRedirection: true,
        groups: [{ id: 108, name: "PKO Bank Polski" }],
      }],
    });

    await expect(getTpayPaymentChannels({ fetcher })).resolves.toMatchObject({
      channels: [{ id: "21", available: true }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/tpay-channels",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps order recap default-v2, analytics-v3, and receipt presentation-v4 negotiated", async () => {
    const base = orderRecapBase();
    const v2Fetcher = createFetcher({
      contractVersion: "commerce.order.recap.v2",
      ...base,
      items: [orderRecapDisplayLine()],
    });
    const v3Fetcher = createFetcher({
      contractVersion: "commerce.order.recap.v3",
      ...base,
      checkoutKind: "one_time",
      moneyReconciled: true,
      items: [{
        ...orderRecapDisplayLine(),
        sku: "SKU-LAMB-400",
        variantCode: "can_400g",
        catalogUnitGross: 1_000,
        catalogTotalGross: 1_000,
        effectiveGross: 1_000,
        effectiveNet: 926,
        discountAllocated: 0,
        vatRateBps: 800,
      }],
    });
    const v4Fetcher = createFetcher({
      contractVersion: "commerce.order.recap.v4",
      ...base,
      checkoutKind: "subscription_initial",
      moneyReconciled: true,
      items: [{
        ...orderRecapDisplayLine(),
        sku: "SKU-LAMB-400",
        variantCode: "can_400g",
        catalogUnitGross: 1_000,
        catalogTotalGross: 1_000,
        effectiveGross: 500,
        effectiveNet: 463,
        discountAllocated: 500,
        vatRateBps: 800,
      }],
      firstSubscriptionPricePresentation: {
        catalogProductsMinor: 1_000,
        productDiscountMinor: 500,
        productPayableMinor: 500,
        shippingGrossMinor: 0,
        shippingDiscountMinor: 0,
        shippingEffectiveMinor: 0,
        totalMinor: 500,
        discountPercent: 50,
      },
    });
    const request = {
      orderId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
    };

    await expect(getCommerceOrderRecap(request, { fetcher: v2Fetcher }))
      .resolves.toMatchObject({ contractVersion: "commerce.order.recap.v2" });
    await expect(getCommerceOrderRecap({
      ...request,
      contractVersion: "commerce.order.recap.v3",
    }, { fetcher: v3Fetcher })).resolves.toMatchObject({
      contractVersion: "commerce.order.recap.v3",
      checkoutKind: "one_time",
      items: [{ sku: "SKU-LAMB-400" }],
    });
    await expect(getCommerceOrderRecap({
      ...request,
      contractVersion: "commerce.order.recap.v4",
    }, { fetcher: v4Fetcher })).resolves.toMatchObject({
      contractVersion: "commerce.order.recap.v4",
      firstSubscriptionPricePresentation: { discountPercent: 50 },
    });

    expect(v2Fetcher).toHaveBeenCalledWith(
      expect.not.stringContaining("contractVersion"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(v3Fetcher).toHaveBeenCalledWith(
      expect.stringContaining("contractVersion=commerce.order.recap.v3"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(v4Fetcher).toHaveBeenCalledWith(
      expect.stringContaining("contractVersion=commerce.order.recap.v4"),
      expect.objectContaining({ method: "GET" }),
    );
  });

});

function orderRecapBase() {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    orderNumber: "VP-1",
    status: "paid",
    paymentStatus: "succeeded",
    mode: "one_time",
    petName: null,
    customerFirstName: null,
    maskedEmail: null,
    cadenceDays: null,
    nextDeliveryAt: null,
    totals: {
      subtotal: recapMoney(1_000),
      discount: recapMoney(0),
      shipping: recapMoney(0),
      shippingDiscount: recapMoney(0),
      tax: recapMoney(74),
      total: recapMoney(1_000),
    },
    shippingAddress: null,
    createdAt: "2026-07-28T10:00:00.000+00:00",
  };
}

function orderRecapDisplayLine() {
  return {
    title: "Jagnięcina 400g",
    quantity: 1,
    recipeName: "Jagnięcina",
    variantName: "400g",
    total: recapMoney(1_000),
    listTotal: null,
    discount: null,
  };
}

function recapMoney(amountMinor: number) {
  return { amountMinor, currency: COMMERCE_CURRENCIES[0] };
}

function orderDraftResponse(): CreateOrderDraftResponse {
  const quoteSnapshot: CreateQuoteResponse = {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: quote(),
  };

  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orderDraft: {
      orderId: "order_wave-3",
      status: "draft",
      paymentStatus: "not_started",
      idempotencyKey: "quote-2026-06-01-lamb",
      quoteSnapshot,
      replayed: false,
    },
  };
}


function quote(): CreateQuoteResponse["quote"] {
  return {
    currency: "PLN",
    taxIncluded: true,
    lines: [
      {
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        productSlug: "lamb",
        quantity: 1,
        unitPriceGross: { amountMinor: 1490, currency: "PLN" },
        lineSubtotalGross: { amountMinor: 1490, currency: "PLN" },
        tax: {
          included: true,
          country: "PL",
          category: "standard",
          vatRateBps: 800,
          legalBasis: "PL VAT Annex 3 item 10c",
          netAmount: { amountMinor: 1380, currency: "PLN" },
          vatAmount: { amountMinor: 110, currency: "PLN" },
          grossAmount: { amountMinor: 1490, currency: "PLN" },
        },
      },
    ],
    discounts: [],
    subtotalGross: { amountMinor: 1490, currency: "PLN" },
    discountTotalGross: { amountMinor: 0, currency: "PLN" },
    totalGross: { amountMinor: 1490, currency: "PLN" },
    netTotal: { amountMinor: 1380, currency: "PLN" },
    taxTotal: { amountMinor: 110, currency: "PLN" },
  };
}

function catalogFacts(currency: CreateQuoteResponse["quote"]["currency"]) {
  return {
    version: "catalog_facts_v1" as const,
    skuId: "11111111-1111-4111-8111-111111111111",
    documentRevisionId: "22222222-2222-4222-8222-222222222222",
    documentDigest: "a".repeat(64), resolvedPriceEntryId: "resolved-entry",
    basePriceEntryId: "base-entry", mode: "one_time" as const,
    atTime: "2026-06-05T10:00:00.000Z", currency,
    resolvedUnitAmountMinor: 1490, resolvedLineAmountMinor: 1490,
    baseUnitAmountMinor: 1490,
  };
}

function createFetcher(data: unknown) {
  return createRawFetcher({ ok: true, data });
}

function createRawFetcher(envelope: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve(envelope),
  });
}
