import { describe, expect, it } from "vitest";
import {
  renderCheckoutRecovery,
  renderCheckoutExpired,
  renderOrderConfirmation,
  renderOrderCanceled,
  renderOrderPaidConfirmation,
  renderOrderRefunded,
  renderPaymentFailed,
  renderShipmentDispatched,
  renderShipmentDelivered,
  renderShipmentException,
} from "./transactionalEmailRenderers.js";
import { APP_ORDER_REF_PREFIX } from "../../../src/lib/brand/appBrand.js";
import { emailPresentation as exampleEmailPresentation } from "../../../src/domains/communications/email/exampleEmailPresentation.js";

const signal = new AbortController().signal;
const BASE = "https://preview.example.test";
const ORDER_ID = "order_7a8b1790-7505-42b1-9538-a17d1ac24a73";
const ORDER_REF = `${APP_ORDER_REF_PREFIX}-7A8B1790`;

function expectCustomerOrderReference(out: { subject: string; html: string; text: string }) {
  expect(out.subject).toContain(ORDER_REF);
  expect(out.html).toContain(ORDER_REF);
  expect(out.text).toContain(ORDER_REF);
  expect(out.subject).not.toContain(ORDER_ID);
  expect(out.html).not.toContain(ORDER_ID);
  expect(out.text).not.toContain(ORDER_ID);
}

function expectPreviewAssets(out: { html: string }, locale: "en" = "en", contentImages = 0) {
  expect(locale).toBe("en");
  // The neutral default presentation emits no chrome image (logo or banner), so
  // every <img> is a content illustration the caller counts (a guide cover).
  expect(out.html.match(/<img\b/g) ?? []).toHaveLength(contentImages);
}

describe("transactionalEmailRenderers", () => {
  it("renders through an explicitly injected presentation", () => {
    const presentation = {
      ...exampleEmailPresentation,
      emailTeamSignoff: { pl: "Zespół Example", en: "Example Team" },
    };
    const out = renderOrderConfirmation({
      to: "a@example.com",
      firstName: "Anna",
      petName: null,
      orderId: ORDER_ID,
      outboxEventId: "presentation-injection",
      items: [],
      totals: null,
      signal,
    }, BASE, presentation);

    expect(out.text).toContain("Zespół Example");
    expect(out.text).not.toContain("Zespół openlup");
  });

  it("passes petName through draft and checkout-recovery rendering", () => {
    const draft = renderOrderConfirmation({
      to: "a@example.com",
      firstName: "Anna",
      petName: "Fistaszek",
      orderId: ORDER_ID,
      outboxEventId: "e0",
      items: [],
      totals: null,
      signal,
    }, BASE);
    const recovery = renderCheckoutRecovery({
      to: "a@example.com",
      firstName: "Anna",
      petName: "Fistaszek",
      orderId: ORDER_ID,
      recoveryToken: "rcv_123",
      mode: "one_time",
      reminderHours: 1,
      outboxEventId: "e0-recovery",
      signal,
    }, BASE);

    expect(draft.text).toContain("Fistaszek");
    expect(recovery.text).toContain("Fistaszek");
    expectPreviewAssets(draft);
    expectPreviewAssets(recovery);
  });

  // Added as a SEPARATE pair rather than by widening a case above: the no-source
  // URL is what every cron and operator email has always carried, and the point
  // of these assertions is that the new parameter appears on one producer's link
  // and on no other's.
  it("marks only a buyer-hatch recovery link with src=hatch", () => {
    const base = {
      to: "a@example.com",
      firstName: "Anna",
      petName: null,
      orderId: ORDER_ID,
      recoveryToken: "rcv_123",
      mode: "one_time",
      reminderHours: 1,
      outboxEventId: "e-hatch",
      signal,
    };
    const cron = renderCheckoutRecovery(base, BASE);
    const hatch = renderCheckoutRecovery({ ...base, linkSource: "buyer_hatch" }, BASE);

    expect(cron.html).not.toContain("src=hatch");
    expect(cron.text).not.toContain("src=hatch");
    expect(hatch.html).toContain("src=hatch");
    expect(hatch.text).toContain("src=hatch");
    // The token still rides the link; the parameter is appended, not substituted.
    expect(hatch.text).toContain("token=rcv_123");
  });

  it("renders the paid confirmation: receipt copy, items/totals, account CTA", () => {
    const out = renderOrderPaidConfirmation(
      {
        to: "a@example.com",
        firstName: "Anna",
        petName: "Fistaszek",
        orderId: ORDER_ID,
        mode: "one_time",
        outboxEventId: "e1",
        items: [{ name: "Karma 5kg", quantity: 1, lineTotalLabel: "99,99 zł" }],
        totals: { subtotalLabel: "99,99 zł", discountLabel: null, totalLabel: "99,99 zł" },
        signal,
      },
      BASE,
    );
    expect(out.subject).toContain("Mamy Wasze zamówienie");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Zamówienie potwierdzone");
    expect(out.html).toContain("1× Karma 5kg – 99,99 zł");
    expect(out.text).toContain("Fistaszek");
    // CJ-20: CTA deep-links to the orders tab, not the bare account root.
    expect(out.html).toContain(`href="${BASE}/konto?sekcja=orders"`);
    expect(out.html).not.toContain(`href="${BASE}/konto"`);
    expectPreviewAssets(out);
  });

  it("renders the payment-failed notice as recoverable account CTA", () => {
    const out = renderPaymentFailed(
      { to: "a@example.com", firstName: "Anna", orderId: ORDER_ID, amountLabel: "129,99 zł", recoveryToken: "rcv_123", mode: "subscription_cycle", outboxEventId: "e2", signal },
      BASE,
    );
    expect(out.subject).toContain("nie przeszła");
    expect(out.subject).toContain("nie przeszła");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Płatność nie przeszła");
    expect(out.html).toContain(`href="${BASE}/konto/dokoncz-platnosc?token=rcv_123"`);
    expect(out.html).not.toContain(`href="${BASE}/skomponuj-pakiet"`);
    expect(out.text).toContain("dla tej subskrypcji – bez składania koszyka od nowa");
    expectPreviewAssets(out);
  });

  it("renders checkout-expired with a recovery token as complete-payment CTA", () => {
    const out = renderCheckoutExpired(
      { to: "a@example.com", firstName: "Anna", orderId: ORDER_ID, amountLabel: "129,99 zł", recoveryToken: "rcv_expired_123", outboxEventId: "e2-expired", signal },
      BASE,
    );
    expect(out.subject).toContain("Dokończ płatność");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Dokończ płatność");
    expect(out.html).toContain(`href="${BASE}/konto/dokoncz-platnosc?token=rcv_expired_123"`);
    expect(out.html).not.toContain(`href="${BASE}/skomponuj-pakiet"`);
    expect(out.text).not.toContain("Rezerwacja wygasła");
    expectPreviewAssets(out);
  });

  it("renders checkout-expired without a recovery token as expired-order copy + configurator CTA", () => {
    const out = renderCheckoutExpired(
      { to: "a@example.com", firstName: "Anna", orderId: ORDER_ID, amountLabel: "129,99 zł", outboxEventId: "e2-expired", signal },
      BASE,
    );
    expect(out.subject).toContain("Rezerwacja zamówienia");
    expect(out.subject).toContain("wygasła");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Rezerwacja wygasła");
    expect(out.html).toContain(`href="${BASE}/skomponuj-pakiet"`);
    expect(out.text).toContain("Kwota poprzedniego zamówienia: 129,99 zł");
    expect(out.text).not.toContain("wszystko jest zapisane");
    expectPreviewAssets(out);
  });

  it("renders the cancellation notice: cancel copy + shop CTA, EN locale", () => {
    const out = renderOrderCanceled(
      { to: "a@example.com", firstName: "Anna", orderId: ORDER_ID, amountLabel: "129,99 zł", outboxEventId: "e3", locale: "en", signal },
      BASE,
    );
    expect(out.subject).toContain("has been canceled");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Order canceled");
    expect(out.html).toContain(`href="${BASE}/build-your-box"`);
    expect(out.text).not.toContain("A refund of 129,99 zł is on its way");
    expect(out.text).toContain("we'll confirm any refund separately after review");
    expectPreviewAssets(out, "en");
  });

  it("renders the refund confirmation: refund copy + shop CTA", () => {
    const out = renderOrderRefunded(
      { to: "a@example.com", firstName: "Anna", orderId: ORDER_ID, amountLabel: "129,99 zł", outboxEventId: "e4", signal },
      BASE,
    );
    expect(out.subject).toContain("został zrealizowany");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Zwrot zrealizowany");
    expect(out.html).toContain(`href="${BASE}/skomponuj-pakiet"`);
    expect(out.text).toContain("Kwota zwrotu: 129,99 zł");
    expectPreviewAssets(out);
  });

  it("renders the dispatched notice: tracking number + account guide", () => {
    const out = renderShipmentDispatched({
      to: "a@example.com",
      firstName: "Anna",
      petName: "Fistaszek",
      orderId: ORDER_ID,
      trackingNumber: "JD0123456789",
      trackingUrl: "https://track.example/JD0123456789",
      outboxEventId: "e5",
      signal,
    }, BASE);
    expect(out.subject).toContain("ruszyła w drogę");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Paczka w drodze");
    // Carrier tracking is a text link in the number box; the account guide is the button.
    expect(out.html).toContain(`href="${BASE}/porady/pliki/przewodnik-po-koncie-klienta.pdf"`);
    expect(out.html).not.toContain(`href="${BASE}/konto"`);
    expect(out.html).toContain('href="https://track.example/JD0123456789"');
    expect(out.html).toContain("Śledź przesyłkę");
    expect(out.text).toContain("JD0123456789");
    expect(out.text).toContain("Fistaszek");
    expectPreviewAssets(out);
  });

  it("renders the delivered notice: delivered copy + start guide", () => {
    const out = renderShipmentDelivered(
      { to: "a@example.com", firstName: "Anna", petName: "Fistaszek", orderId: ORDER_ID, outboxEventId: "e6", signal },
      BASE,
    );
    expect(out.subject).toContain("dotarła");
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Paczka dostarczona");
    expect(out.html).toContain(`href="${BASE}/porady/pliki/jak-wprowadzic-nowa-karme.pdf"`);
    expect(out.html).not.toContain(`href="${BASE}/skomponuj-pakiet"`);
    expect(out.html).toContain(`<img src="${BASE}/porady/pliki/okladka-jak-wprowadzic-nowa-karme.jpg"`);
    expectPreviewAssets(out, "en", 1);
    expect(out.text).toContain("Fistaszek");
  });

  it("renders the exception notice: reassurance copy + account CTA, no internal reason", () => {
    const out = renderShipmentException(
      { to: "a@example.com", firstName: "Anna", orderId: ORDER_ID, outboxEventId: "e7", signal },
      BASE,
    );
    expectCustomerOrderReference(out);
    expect(out.html).toContain("Potrzebujemy chwili dłużej");
    expect(out.html).toContain(`href="${BASE}/konto"`);
    expect(out.html).not.toContain("split");
    expect(out.html).not.toContain("fulfillment_exception");
    expectPreviewAssets(out);
  });
});
