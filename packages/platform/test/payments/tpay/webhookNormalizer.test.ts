import { describe, expect, it } from "vitest";

import {
  normalizeTpayWebhook,
  toNormalizedProviderTpayWebhook,
} from "../../../src/payments/tpay/webhookNormalizer.js";

describe("Tpay webhook normalizer", () => {
  it.each([
    ["TRUE", "TR-123"], ["true", "TR-123"],
    ["CHARGEBACK", "TR-123:chargeback"], ["chargeback", "TR-123:chargeback"],
    ["FALSE", "TR-123"], ["false", "TR-123"],
    ["ERROR", "TR-123"], ["DECLINED", "TR-123"],
    ["ERROR:DECLINED", "TR-123"],
  ])("characterizes byte-exact transaction identity for %s", (status, id) => {
    const { event } = normalizeTpayWebhook(new URLSearchParams({ tr_id: "TR-123", tr_status: status }).toString());
    expect(event.provider_event_id).toBe(id);
    expect(event.payment_provider_id).toBe("TR-123");
  });

  it.each(["2026-10-21", "2026-10-21T01:00:00Z", "invalid", ""])(
    "keeps operational receipt time regardless of tr_date=%s", tr_date => {
      const normalized = normalizeTpayWebhook(new URLSearchParams({ tr_id: "TR-date", tr_status: "TRUE", tr_date }).toString());
      expect(toNormalizedProviderTpayWebhook(normalized, "2026-10-21T16:00:00.000Z").occurredAt)
        .toBe("2026-10-21T16:00:00.000Z");
    },
  );

  it("normalizes transaction settlement payloads and removes payer/token fields", () => {
    const normalized = normalizeTpayWebhook(
      new URLSearchParams({
        id: "1010",
        tr_id: "TR-123",
        tr_date: "2026-06-09",
        tr_crc: "11111111-1111-4111-8111-111111111111",
        tr_amount: "49.90",
        tr_paid: "49.90",
        tr_desc: "order_123",
        tr_status: "true",
        tr_email: "anna@example.com",
        card_token: "must_not_be_copied",
        test_mode: "1",
      }).toString(),
    );

    expect(normalized.event).toEqual({
      provider_event_id: "TR-123",
      event_type: "payment.succeeded",
      payment_provider_id: "TR-123",
      payment_intent_id: "11111111-1111-4111-8111-111111111111",
      amount_minor: 4990,
      raw_payload: {
        provider: "tpay",
        eventKind: "transaction",
        transactionTitle: "TR-123",
        hiddenDescription: "11111111-1111-4111-8111-111111111111",
        transactionAmount: "49.90",
        paidAmount: "49.90",
        // This payload carries no `tr_currency`, and the record says so. It used to say
        // "PLN" - a value the provider never sent, invented by a `??` default.
        currency: null,
        status: "true",
        testMode: "1",
      },
    });
    expect(toNormalizedProviderTpayWebhook(normalized, "2026-06-10T10:00:00.000Z").currency).toBeNull();
    expect(JSON.stringify(normalized)).not.toContain("anna@example.com");
    expect(JSON.stringify(normalized)).not.toContain("must_not_be_copied");
  });

  it("classifies UPPERCASE tr_status (the real production value) case-insensitively", () => {
    // Production Tpay sends tr_status="TRUE"/"CHARGEBACK" uppercase; a
    // case-sensitive compare mislabeled every real success as payment.failed
    // (caught live 2026-07-13). The raw value is preserved in raw_payload.status.
    const paid = normalizeTpayWebhook(
      new URLSearchParams({
        tr_id: "TR-UP",
        tr_crc: "22222222-2222-4222-8222-222222222222",
        tr_amount: "1.00",
        tr_paid: "1.00",
        tr_status: "TRUE",
        test_mode: "0",
      }).toString(),
    );
    expect(paid.event.event_type).toBe("payment.succeeded");
    expect((paid.event.raw_payload as Record<string, unknown>).status).toBe("TRUE");

    const chargeback = normalizeTpayWebhook(
      new URLSearchParams({ tr_id: "TR-CB", tr_amount: "1.00", tr_paid: "1.00", tr_status: "CHARGEBACK" }).toString(),
    );
    expect(chargeback.event.event_type).toBe("payment.refunded");

    const failed = normalizeTpayWebhook(
      new URLSearchParams({ tr_id: "TR-F", tr_amount: "1.00", tr_paid: "0.00", tr_status: "FALSE" }).toString(),
    );
    expect(failed.event.event_type).toBe("payment.failed");
  });

  it("classifies lowercase refund and failure statuses the same way", () => {
    // Both casings of every status this rail classifies are pinned here, so the
    // pin does not depend on which casing the provider happens to send. The
    // lowercase refund/failure halves previously lived only in the cross-rail
    // test that PR 2457 added to the JSON-shaped adapter; that adapter had no
    // production consumer and was deleted, so the live-rail cases move here
    // rather than disappearing with it.
    const chargeback = normalizeTpayWebhook(
      new URLSearchParams({ tr_id: "TR-CB-LOW", tr_amount: "1.00", tr_paid: "1.00", tr_status: "chargeback" }).toString(),
    );
    expect(chargeback.event.event_type).toBe("payment.refunded");

    const failed = normalizeTpayWebhook(
      new URLSearchParams({ tr_id: "TR-F-LOW", tr_amount: "1.00", tr_paid: "0.00", tr_status: "false" }).toString(),
    );
    expect(failed.event.event_type).toBe("payment.failed");
  });

  it("preserves explicit transaction currency so payment-control can reject mismatches", () => {
    const normalized = normalizeTpayWebhook(
      new URLSearchParams({
        tr_id: "TR-123",
        tr_crc: "11111111-1111-4111-8111-111111111111",
        tr_amount: "49.90",
        tr_paid: "49.90",
        tr_status: "true",
        tr_currency: "EUR",
      }).toString(),
    );

    expect(toNormalizedProviderTpayWebhook(normalized, "2026-06-10T10:00:00.000Z").currency).toBe("EUR");
  });

  it("normalizes BLIK alias notifications into sanitized method-ref evidence", () => {
    const normalized = normalizeTpayWebhook(
      "id=1010&event=ALIAS_REGISTER&client_id=11111111-1111-4111-8111-111111111111&subscription_id=22222222-2222-4222-8222-222222222222&msg_value%5Bvalue%5D=user_alias&msg_value%5Btype%5D=UID&msg_value%5BexpirationDate%5D=2026-12-31",
    );

    expect(normalized.event.raw_payload).toEqual({
      provider: "tpay",
      eventKind: "blik_alias",
      event: "ALIAS_REGISTER",
      paymentIntentId: null,
      aliasValuePresent: true,
      aliasType: "UID",
      aliasExpirationDatePresent: true,
    });
    expect(normalized.methodRef).toMatchObject({
      clientId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      providerMethodRef: "user_alias",
      methodKind: "blik_payid",
      status: "active",
    });

    expect(toNormalizedProviderTpayWebhook(normalized, "2026-06-10T10:00:00.000Z")).toMatchObject({
      provider: "tpay",
      providerEventId: "ALIAS_REGISTER:user_alias",
      eventType: "setup.succeeded",
      providerPaymentId: "user_alias",
      paymentIntentId: null,
      occurredAt: "2026-06-10T10:00:00.000Z",
      reusableMethod: {
        clientId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
        providerMethodRef: "user_alias",
        methodKind: "blik_payid",
        status: "active",
      },
    });
  });

  it("does not expose reusable method data without client ownership evidence", () => {
    const normalized = normalizeTpayWebhook(
      "id=1010&event=ALIAS_REGISTER&msg_value%5Bvalue%5D=openlup_22222222-2222-4222-8222-222222222222&msg_value%5Btype%5D=UID",
    );

    const provider = toNormalizedProviderTpayWebhook(normalized, "2026-06-10T10:00:00.000Z");
    expect(provider.reusableMethod).toBeNull();
    expect(provider.paymentIntentId).toBe("22222222-2222-4222-8222-222222222222");
    expect(provider.eventType).toBe("setup.succeeded");
  });

  it("maps rejected BLIK alias notifications to inactive reusable methods", () => {
    const normalized = normalizeTpayWebhook(
      "id=1010&event=ALIAS_DELETE&client_id=11111111-1111-4111-8111-111111111111&msg_value%5Bvalue%5D=user_alias&msg_value%5Btype%5D=UID",
    );

    const provider = toNormalizedProviderTpayWebhook(normalized, "2026-06-10T10:00:00.000Z");
    expect(provider.eventType).toBe("setup.failed");
    expect(provider.reusableMethod).toMatchObject({
      clientId: "11111111-1111-4111-8111-111111111111",
      providerMethodRef: "user_alias",
      methodKind: "blik_payid",
      status: "inactive",
    });
  });
});

const railDelivery = (body: string) =>
  toNormalizedProviderTpayWebhook(normalizeTpayWebhook(body), "2026-06-10T10:00:00.000Z");

const aliasEvent = (name: string) => railDelivery(
  `id=1010&event=${name}&client_id=11111111-1111-4111-8111-111111111111&msg_value%5Bvalue%5D=user_alias&msg_value%5Btype%5D=UID`,
);

describe("alias lifecycle mapping", () => {
  // One rail name per row. A class-level assertion here would let a rotation
  // drift into the terminal set without a single test turning red.
  it.each([
    ["ALIAS_REGISTER", "method_registered", "setup.succeeded", "active"],
    ["ALIAS_UPDATE", "method_updated", "setup.succeeded", "active"],
    ["ALIAS_UNREGISTER", "method_revoked", "setup.failed", "inactive"],
    ["ALIAS_EXPIRED", "method_expired", "setup.failed", "inactive"],
  ])("maps %s to %s", (name, kind, canonical, status) => {
    const provider = aliasEvent(name);
    expect(provider.eventType).toBe(canonical);
    expect(provider.reusableMethod?.status).toBe(status);
    expect(provider.methodLifecycle).toEqual({
      kind,
      // The transition must name the same rail as the delivery that carried it.
      providerKind: provider.provider,
      providerMethodRef: "user_alias",
      providerEventId: `${name}:user_alias`,
      occurredAt: "2026-06-10T10:00:00.000Z",
      replacement: null,
    });
  });

  // ⛔ The rotation pin. An update means the SAME standing consent behind a new
  // alias; leaving the method active is the whole point, and a regression here
  // would silently disarm every mandate the rail rotates.
  it("keeps the stored mandate active across an update", () => {
    const provider = aliasEvent("ALIAS_UPDATE");
    expect(provider.methodLifecycle?.kind).toBe("method_updated");
    expect(provider.reusableMethod?.status).toBe("active");
  });

  it("gives each transition its own delivery identity, so a death never replays a birth", () => {
    expect(aliasEvent("ALIAS_REGISTER").providerEventId)
      .not.toBe(aliasEvent("ALIAS_UNREGISTER").providerEventId);
  });

  it("classifies alias names case-insensitively", () => {
    expect(aliasEvent("alias_unregister").methodLifecycle?.kind).toBe("method_revoked");
  });

  it("reports no transition for an unrecognised alias name or a money delivery", () => {
    expect(aliasEvent("ALIAS_DELETE").methodLifecycle).toBeNull();
    expect(railDelivery("tr_id=TR-1&tr_status=TRUE&tr_amount=49.90&tr_paid=49.90").methodLifecycle).toBeNull();
  });
});
