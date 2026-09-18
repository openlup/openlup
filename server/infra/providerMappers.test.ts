import { describe, expect, it } from "vitest";
import {
  buildFakturowniaCorrectionRequest,
  buildFakturowniaCreateInvoiceRequest,
  buildFakturowniaInvoiceDraft,
  mapFakturowniaProviderSync,
} from "./fakturownia/invoiceMapper.js";
import {
  OMNIPACK_PRODUCTION_BASE_URL,
  OMNIPACK_REQUIRED_ENV,
  OMNIPACK_STAGE_BASE_URL,
  readOmnipackCredentialGate,
  readOmnipackReadinessConfig,
} from "./omnipack/outboundOrderMapper.js";
import { buildStripePaymentIntentDraft, readStripeReadinessConfig } from "./stripe/paymentIntentMapper.js";
import {
  buildTpayBlikAliasChargeDraft,
  buildTpayBlikAliasRegistrationDraft,
  readTpayReadinessConfig,
} from "./tpay/blikRecurringMapper.js";

describe("hidden provider mappers", () => {
  it("maps Stripe card setup facts without calling Stripe", () => {
    expect(readStripeReadinessConfig({}).enabled).toBe(false);
    expect(
      buildStripePaymentIntentDraft({
        amountMinor: 1490,
        currency: "PLN",
        customerRef: "cus_local",
        orderRef: "order_123",
        reusableMethodRef: "pm_card",
      }),
    ).toMatchObject({
      provider: "stripe",
      requestKind: "payment_intent",
      amount: 1490,
      currency: "pln",
      setup_future_usage: "off_session",
      payment_method: "pm_card",
    });
  });

  it("maps Tpay BLIK PAYID registration and alias charge drafts", () => {
    expect(readTpayReadinessConfig({ TPAY_CLIENT_ID: "id" }).enabled).toBe(false);
    expect(
      buildTpayBlikAliasRegistrationDraft({
        orderRef: "order_123",
        amountMinor: 1490,
        currency: "PLN",
        customerEmail: "client@example.test",
        staticWebhookUrl: "https://example.test/api/bff/payment/webhooks/tpay",
        consentRef: "consent_123",
      }),
    ).toMatchObject({
      provider: "tpay",
      requestKind: "blik_alias_registration",
      fallbackRequiredWhenAliasUnavailable: true,
    });
    expect(
      buildTpayBlikAliasChargeDraft({
        orderRef: "order_124",
        payId: "payid_123",
        amountMinor: 2490,
        currency: "PLN",
        staticWebhookUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      }),
    ).toMatchObject({ requestKind: "blik_alias_charge", payId: "payid_123" });
  });

  it("maps immutable invoice snapshots and preserves Omnipack lot metadata", () => {
    const b2bDraft = buildFakturowniaInvoiceDraft({
        orderRef: "order_123",
        issueDate: "2026-06-06",
        sellDate: "2026-06-05",
        currency: "PLN",
        documentKind: "b2b_vat",
        ksefRequired: true,
        seller: {
          name: "Example Company Sp. z o.o.",
          street: "Ul. Example Street 11",
          postalCode: "32-091",
          city: "ExampleCity",
          taxId: "1234563218",
          krs: "0000000000",
          bankAccount: "21 1600 1462 1711 3485 9000 0008",
          departmentId: null,
        },
        buyer: { name: "Client", email: null, taxId: "1234563218" },
        payment: { provider: "stripe", providerPaymentId: "pi_123", paymentCompletedAt: "2026-06-05T10:00:00Z" },
        lines: [{ name: "Food", quantity: 2, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" }],
      });
    expect(b2bDraft).toMatchObject({
      external_id: "order_123",
      oid: "order_123",
      oid_unique: "yes",
      buyer_tax_no_kind: "",
      sell_date: "2026-06-05",
      // `descriptions` is an array of {kind, content} records (KSeF
      // DodatkowyOpis). A bare string is not that shape: the note was never
      // created and the order number reached the vendor only through
      // oid/external_id, neither of which is printed on the document.
      descriptions: [{ kind: "Numer zamówienia", content: "order_123" }],
      // A document is only ever issued for an already-settled order, so it
      // states the settlement instead of printing as awaiting payment: paid in
      // full, on the day of the charge, with no deadline.
      status: "paid",
      paid: 21.6,
      paid_date: "2026-06-05",
      payment_to_kind: "off",
      positions: [{ total_price_net: 20, total_price_gross: 21.6, tax: "8", quantity_unit: "szt." }],
    });
    // The notes are printed and submitted to KSeF, where they become a permanent
    // government record; settlement identifiers never belong there. The private
    // note keeps the same evidence for support.
    expect(JSON.stringify(b2bDraft.descriptions)).not.toContain("pi_123");
    expect(b2bDraft.internal_note).toContain("order_123");
    expect(b2bDraft.internal_note).toContain("payment id: pi_123");
    expect(buildFakturowniaInvoiceDraft({
      orderRef: "order_123",
      issueDate: "2026-06-06",
      currency: "PLN",
      buyer: { name: "Client", email: null, taxId: null },
      lines: [{ name: "Food", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" }],
    })).not.toHaveProperty("provider");
    const b2cDraft = buildFakturowniaInvoiceDraft({
        orderRef: "order_124",
        issueDate: "2026-06-06",
        currency: "PLN",
        documentKind: "b2c_named",
        ksefRequired: false,
        buyer: { name: "Client", email: "client@example.test", taxId: null },
        // The shape the snapshot mapper actually builds when the claim has no
        // settlement instant: the payment block is present and the timestamp is
        // an empty string, not null. `??` does not fall back on "".
        payment: { provider: null, providerPaymentId: null, paymentCompletedAt: "" },
        lines: [
          { name: "Food", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" },
          { name: "Karma luzem", quantity: 3, quantityUnit: "kg", unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" },
          { name: "Dostawa", quantity: 1, unitNetMinor: 1220, unitGrossMinor: 1500, vatRate: "23" },
        ],
      });
    expect(b2cDraft).toMatchObject({
      buyer_company: false,
      buyer_tax_no: null,
    });
    expect(b2cDraft).not.toHaveProperty("gov_save_and_send");
    // A position without quantity_unit prints "(brak)" in the j.m. column, so no
    // emitted line may be missing one. A line that names its own unit keeps it;
    // goods and the delivery line take the default.
    expect(b2cDraft.positions.map((position) => position.quantity_unit))
      .toEqual(["szt.", "kg", "szt."]);
    // With no settlement instant the document falls back to the sell date, which
    // upstream derives from the payment. It never reaches for the current clock,
    // and it never emits an empty date beside a paid status. The amount is the
    // sum of all three positions.
    expect(b2cDraft).toMatchObject({ status: "paid", paid: 58.2, paid_date: "2026-06-06" });

  });

  it("preserves B2B KSeF evidence without adding a submission directive", () => {
    const request = buildFakturowniaCreateInvoiceRequest({
      orderRef: "order_123",
      issueDate: "2026-06-06",
      currency: "PLN",
      documentKind: "b2b_vat",
      ksefRequired: true,
      buyer: { name: "Client", email: null, taxId: "123-456-32-18" },
      lines: [{ name: "Food", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" }],
    });

    expect(request.invoice).toMatchObject({ buyer_tax_no: "1234563218" });
    expect(request.invoice).not.toHaveProperty("ksef");
    expect(Object.keys(request)).toEqual(["invoice"]);
  });

  it("blocks B2B Fakturownia invoices before KSeF when buyer NIP is missing or invalid", () => {
    const base = {
      orderRef: "order_123",
      issueDate: "2026-06-06",
      currency: "PLN",
      documentKind: "b2b_vat" as const,
      ksefRequired: true,
      buyer: { name: "Client", email: null, taxId: "123" },
      lines: [{ name: "Food", quantity: 1, unitNetMinor: 1000, unitGrossMinor: 1080, vatRate: "8" }],
    };

    expect(() => buildFakturowniaCreateInvoiceRequest(base))
      .toThrow("fakturownia_b2b_invoice_invalid_tax_id");
    expect(() => buildFakturowniaCreateInvoiceRequest({
      ...base,
      buyer: { name: "Client", email: null, taxId: null },
    })).toThrow("fakturownia_b2b_invoice_invalid_tax_id");
    expect(() => buildFakturowniaInvoiceDraft(base))
      .toThrow("fakturownia_b2b_invoice_invalid_tax_id");
  });

  it("builds Fakturownia positions from exact discounted line totals", () => {
    const draft = buildFakturowniaInvoiceDraft({
      orderRef: "order_125",
      issueDate: "2026-07-12",
      currency: "PLN",
      documentKind: "b2c_named",
      buyer: { name: "Client", email: "client@example.test", taxId: null },
      // Discounted line: 2 units, reconciled total 10.05 — not derivable from
      // any integer-grosze unit price times quantity.
      lines: [{
        name: "Food",
        quantity: 2,
        unitNetMinor: 465,
        unitGrossMinor: 503,
        totalNetMinor: 931,
        totalGrossMinor: 1005,
        vatRate: "8",
      }],
      chargedTotalGrossMinor: 1005,
    });

    expect(draft.positions).toEqual([
      { name: "Food", quantity: 2, quantity_unit: "szt.", total_price_net: 9.31, total_price_gross: 10.05, tax: "8" },
    ]);
  });

  const b2cInvoiceBase = () => ({
    orderRef: "order_127",
    issueDate: "2026-07-12",
    currency: "PLN",
    documentKind: "b2c_named" as const,
    buyer: { name: "Client", email: "client@example.test", taxId: null },
  });

  it("refuses to build a Fakturownia document whose positions disagree with the charged total", () => {
    const base = {
      ...b2cInvoiceBase(),
      orderRef: "order_126",
      lines: [{ name: "Food", quantity: 1, unitNetMinor: 1380, unitGrossMinor: 1490, vatRate: "8" }],
    };

    expect(() => buildFakturowniaInvoiceDraft({ ...base, chargedTotalGrossMinor: 2480 }))
      .toThrow("fakturownia_invoice_positions_total_mismatch positions=1490 charged=2480");
    expect(() => buildFakturowniaCreateInvoiceRequest({ ...base, chargedTotalGrossMinor: 2480 }))
      .toThrow("fakturownia_invoice_positions_total_mismatch");
    expect(buildFakturowniaInvoiceDraft({ ...base, chargedTotalGrossMinor: 1490 }).positions)
      .toEqual([{
        name: "Food",
        quantity: 1,
        quantity_unit: "szt.",
        total_price_net: 13.8,
        total_price_gross: 14.9,
        tax: "8",
      }]);
  });

  it("gates Omnipack readiness on documented Basic Auth env and provider flags", () => {
    const disabled = readOmnipackReadinessConfig({});

    expect(disabled.enabled).toBe(false);
    expect(disabled.requiredEnv).toEqual([...OMNIPACK_REQUIRED_ENV]);
    expect(disabled.requiredEnv).not.toContain("OMNIPACK_API_TOKEN");
    expect(disabled.requiredEnv).not.toContain("OMNIPACK_WAREHOUSE_ID");

    const stockOnly = readOmnipackCredentialGate({
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED: "true",
      COMMERCE_INVENTORY_SALES_LIMIT_MODE: "warn",
      OMNIPACK_ENV: "stage",
      OMNIPACK_BASE_URL: OMNIPACK_STAGE_BASE_URL,
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable-token",
    });

    expect(stockOnly.readiness.enabled).toBe(true);
    expect(stockOnly.stockSyncEnabled).toBe(true);
    expect(stockOnly.dispatchEnabled).toBe(false);
    expect(stockOnly.salesLimitMode).toBe("warn");
    expect(stockOnly.stageSmokeBlocked).toBe(false);
    expect(stockOnly.liveDispatchBlocked).toBe(true);

    const liveDispatch = readOmnipackCredentialGate({
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      OMNIPACK_ENV: "production",
      OMNIPACK_BASE_URL: OMNIPACK_PRODUCTION_BASE_URL,
      OMNIPACK_USERNAME: "live-user",
      OMNIPACK_PASSWORD: "live-pass",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable-token",
    });

    expect(liveDispatch.readiness.enabled).toBe(true);
    expect(liveDispatch.dispatchEnabled).toBe(true);
    expect(liveDispatch.baseUrl).toBe(OMNIPACK_PRODUCTION_BASE_URL);
    expect(liveDispatch.stageSmokeBlocked).toBe(true);
    expect(liveDispatch.liveDispatchBlocked).toBe(false);
  });

  it("maps Fakturownia correction scaffolds without B2C KSeF submission", () => {
    expect(
      buildFakturowniaCorrectionRequest({
        providerInvoiceId: "123",
        orderRef: "order_correction",
        reason: "Zwrot produktu",
        documentKind: "b2c_named",
        ksefRequired: false,
        buyer: correctionBuyer(),
        lines: [{
          name: "Food",
          quantityBefore: 1,
          quantityAfter: 0,
          totalGrossBeforeMinor: 1080,
          totalGrossAfterMinor: 0,
          vatRate: "8",
        }],
      }),
    ).toMatchObject({
      invoice: {
        kind: "correction",
        invoice_id: "123",
        from_invoice_id: "123",
        // A credit note is a customer-facing document too: it names the order it
        // corrects, and a correction prints the line twice, before and after, so
        // all three position shapes need the unit or the j.m. column reads
        // "(brak)" there as well.
        descriptions: [{ kind: "Numer zamówienia", content: "order_correction" }],
        positions: [{
          quantity: -1,
          total_price_gross: -10.8,
          kind: "correction",
          quantity_unit: "szt.",
          correction_before_attributes: { quantity_unit: "szt." },
          correction_after_attributes: { quantity_unit: "szt." },
        }],
      },
    });
    expect(Object.keys(buildFakturowniaCorrectionRequest({
      providerInvoiceId: "123",
      orderRef: "order_correction",
      reason: "Zwrot produktu",
      documentKind: "b2c_named",
      ksefRequired: false,
      buyer: correctionBuyer(),
      lines: [],
    }))).toEqual(["invoice"]);
  });

  it("carries buyer fields on Fakturownia correction requests", () => {
    // Live Fakturownia rejects a correction without buyer data with 422
    // {"buyer_name":["- nie może być puste"]} (production, 2026-07-13).
    const request = buildFakturowniaCorrectionRequest({
      providerInvoiceId: "123",
      orderRef: "order_correction",
      reason: "Zwrot produktu",
      documentKind: "b2c_named",
      ksefRequired: false,
      buyer: correctionBuyer(),
      lines: [],
    });

    expect(request.invoice).toMatchObject({
      buyer_company: false,
      buyer_name: "Jan Kowalski",
      buyer_email: "buyer@example.test",
      buyer_tax_no: null,
      buyer_street: "ul. Prosta 1 m. 2",
      buyer_post_code: "00-001",
      buyer_city: "Warszawa",
      buyer_country: "PL",
    });
  });

  it("normalizes Fakturownia KSeF provider status into local sync events", () => {
    expect(
      mapFakturowniaProviderSync({
        providerEventId: "fv-1:ksef",
        providerInvoiceId: "fv-1",
        providerInvoiceNumber: "1/06/2026",
        ksefNumber: "KSeF-1",
        ksefStatus: "accepted",
        pdfRef: "pdf:fv-1",
        xmlRef: "xml:fv-1",
        upoRef: "upo:fv-1",
        observedAt: "2026-06-06T10:00:00+02:00",
      }),
    ).toMatchObject({
      providerKind: "fakturownia",
      eventType: "ksef.accepted",
      ksefStatus: "accepted",
      providerPdfRef: "pdf:fv-1",
      providerXmlRef: "xml:fv-1",
      providerUpoRef: "upo:fv-1",
    });

    expect(
      mapFakturowniaProviderSync({
        providerEventId: "fv-2:ksef",
        providerInvoiceId: "fv-2",
        providerInvoiceNumber: null,
        ksefNumber: null,
        ksefStatus: "unexpected-provider-state",
        observedAt: "2026-06-06T10:00:00+02:00",
      }),
    ).toMatchObject({ eventType: "provider.mismatch", ksefStatus: null });
  });
});

function correctionBuyer() {
  return {
    name: "Jan Kowalski",
    email: "buyer@example.test",
    taxId: null,
    address: { line1: "ul. Prosta 1 m. 2", postalCode: "00-001", city: "Warszawa", country: "PL" },
  };
}
