import { describe, expect, it } from "vitest";
import {
  renderReturnApproved,
  renderReturnRejected,
  renderShipmentDelivered,
  renderShipmentDispatched,
  renderShipmentException,
} from "./transactionalFulfillmentEmailRenderers.js";
import { APP_ORDER_REF_PREFIX } from "../../../src/lib/brand/appBrand.js";

const signal = new AbortController().signal;
const BASE = "https://staging.example.test";
const ORDER_ID = "order_7a8b1790-7505-42b1-9538-a17d1ac24a73";
const ORDER_REF = `${APP_ORDER_REF_PREFIX}-7A8B1790`;

function expectCustomerOrderReference(out: {
  subject: string;
  html: string;
  text: string;
}): void {
  expect(out.subject).toContain(ORDER_REF);
  expect(out.html).toContain(ORDER_REF);
  expect(out.text).toContain(ORDER_REF);
  expect(out.subject).not.toContain(ORDER_ID);
  expect(out.html).not.toContain(ORDER_ID);
  expect(out.text).not.toContain(ORDER_ID);
}

function expectStagingAssets(out: { html: string }, contentImages = 0): void {
  // The neutral default presentation emits no chrome image (logo or banner), so
  // every <img> is a content illustration the caller counts (a guide cover).
  expect(out.html.match(/<img\b/g) ?? []).toHaveLength(contentImages);
}

describe("transactionalFulfillmentEmailRenderers", () => {
  it("renders shipment dispatched with the tracking box and account guide", () => {
    const out = renderShipmentDispatched(
      {
        to: "a@example.com",
        firstName: "Anna",
        orderId: ORDER_ID,
        trackingNumber: "JD0123456789",
        trackingUrl: "https://track.example/JD0123456789",
        outboxEventId: "e5",
        signal,
      },
      BASE,
    );

    expect(out.html).toContain("Paczka w drodze");
    expect(out.html).toContain(`href="${BASE}/porady/pliki/przewodnik-po-koncie-klienta.pdf"`);
    expect(out.html).not.toContain(`href="${BASE}/konto"`);
    expect(out.html).toContain('href="https://track.example/JD0123456789"');
    expect(out.html).toContain("Śledź przesyłkę");
    expect(out.text).toContain("JD0123456789");
    expectCustomerOrderReference(out);
    expectStagingAssets(out);
  });

  it("renders shipment delivered with the start-guide card", () => {
    const out = renderShipmentDelivered(
      {
        to: "a@example.com",
        firstName: "Anna",
        orderId: ORDER_ID,
        outboxEventId: "e6",
        signal,
      },
      BASE,
    );

    expect(out.subject).toContain("dotarła");
    expect(out.html).toContain("Paczka dostarczona");
    expect(out.html).toContain(`href="${BASE}/porady/pliki/jak-wprowadzic-nowa-karme.pdf"`);
    expect(out.html).not.toContain(`href="${BASE}/skomponuj-pakiet"`);
    expect(out.html).toContain(`<img src="${BASE}/porady/pliki/okladka-jak-wprowadzic-nowa-karme.jpg"`);
    expectCustomerOrderReference(out);
    expectStagingAssets(out, 1);
  });

  it("renders shipment exception with reassurance copy only", () => {
    const out = renderShipmentException(
      {
        to: "a@example.com",
        firstName: "Anna",
        orderId: ORDER_ID,
        outboxEventId: "e7",
        signal,
      },
      BASE,
    );

    expect(out.html).toContain("Potrzebujemy chwili dłużej");
    expect(out.html).toContain(`href="${BASE}/konto"`);
    expect(out.html).not.toContain("fulfillment_exception");
    expectCustomerOrderReference(out);
    expectStagingAssets(out);
  });

  it("renders an approved return with the guide CTA and a rejected return with account CTA", () => {
    const approved = renderReturnApproved(
      {
        to: "a@example.com",
        firstName: "Anna",
        orderId: ORDER_ID,
        outboxEventId: "e8",
        signal,
      },
      BASE,
    );
    const rejected = renderReturnRejected(
      {
        to: "a@example.com",
        firstName: "Anna",
        orderId: ORDER_ID,
        outboxEventId: "e9",
        signal,
      },
      BASE,
    );

    expect(approved.html).toContain("Zwrot zaakceptowany");
    expect(rejected.html).toContain("W sprawie Twojego zwrotu");
    expect(approved.html).toContain(`href="${BASE}/zwroty"`);
    expect(rejected.html).toContain(`href="${BASE}/konto"`);
    expect(approved.html).toContain("Zobacz instrukcję zwrotu");
    expectCustomerOrderReference(approved);
    expectCustomerOrderReference(rejected);
    expectStagingAssets(approved);
    expectStagingAssets(rejected);
  });
});
