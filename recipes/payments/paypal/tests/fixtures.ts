import { createHash } from "node:crypto";
import type {
  PaymentAdapter,
  PaymentMoney,
  PaymentRefundObservation,
  VerifiedPaymentEvidence,
} from "@openlup/platform/payments/contracts";
import {
  createScriptedPaymentFake,
  type PaymentAdapterSafetyScenarios,
  type PaymentAdapterTestSubject,
  type PaymentWebhookFixture,
  type ScriptedPaymentOutcome,
} from "@openlup/platform/payments/testing";
import {
  createPayPalPaymentAdapter,
  minorToMajorString,
  PayPalTransportError,
  type PayPalClient,
  type PayPalOrderResource,
} from "../server/index.js";

/** Synthetic high-visibility canaries used to prove zero secret/PII leakage (ADR-001). */
export const PAYPAL_TEST_CANARIES = Object.freeze({
  marker: "paypal-canary-marker/alpha+01",
  clientId: "paypal_canary_client_id_0001",
  clientSecret: "paypal_canary_client_secret_0001",
  payerEmail: "paypal-canary-buyer@example.invalid",
  payerName: "PayPal Canary Buyer",
});

export const PAYPAL_TEST_RETURN_URL = "https://store.example.test/checkout/paypal/return";
export const PAYPAL_TEST_CANCEL_URL = "https://store.example.test/checkout/paypal/cancel";
export const PAYPAL_TEST_WEBHOOK_ID = "WH-TEST-0001";
export const PAYPAL_TEST_OCCURRED_AT = "2030-06-15T12:00:00.000Z";

export function buildPayPalWebhookInput(
  input: {
    orderId: string;
    eventType?: string;
    webhookId?: string;
    useSupplementaryOrderId?: boolean;
    signatureHeader?: string;
    certUrl?: string;
    omitSignatureHeaders?: boolean;
  },
  receivedAt = PAYPAL_TEST_OCCURRED_AT,
): {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
  receivedAt: string;
} {
  const payload = input.useSupplementaryOrderId
    ? {
        id: input.webhookId ?? `WH-${input.orderId}`,
        event_type: input.eventType ?? "PAYMENT.CAPTURE.COMPLETED",
        create_time: PAYPAL_TEST_OCCURRED_AT,
        resource: {
          id: `CAP-${input.orderId}`,
          supplementary_data: {
            related_ids: {
              order_id: input.orderId,
            },
          },
        },
      }
    : {
        id: input.webhookId ?? `WH-${input.orderId}`,
        event_type: input.eventType ?? "PAYMENT.CAPTURE.COMPLETED",
        create_time: PAYPAL_TEST_OCCURRED_AT,
        resource: {
          id: input.orderId,
        },
      };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!input.omitSignatureHeaders) {
    headers["paypal-auth-algo"] = "SHA256withRSA";
    headers["paypal-cert-url"] = input.certUrl ?? "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST-001";
    headers["paypal-transmission-id"] = `tx-${input.orderId}`;
    headers["paypal-transmission-sig"] = input.signatureHeader ?? "valid-paypal-sig";
    headers["paypal-transmission-time"] = PAYPAL_TEST_OCCURRED_AT;
  }

  return {
    rawBody: new TextEncoder().encode(JSON.stringify(payload)),
    headers,
    receivedAt,
  };
}

function expectedPayPalEvidence(input: {
  orderId: string;
  intentRef: string | null;
  attemptRef: string | null;
  status: string;
  captureStatus?: string | null;
  eventType?: string;
  outcome: VerifiedPaymentEvidence["outcome"];
  money: PaymentMoney;
  occurredAt?: string | null;
  capturedAmountBasis?: "provider_capture_v1";
  refund?: PaymentRefundObservation;
}): VerifiedPaymentEvidence {
  const providerEventId =
    input.outcome === "disputed"
      ? `paypal:${input.orderId}:disputed:${input.money.amountMinor}`
      : input.outcome === "refunded" && input.refund && "refundedMoney" in input.refund
        ? `paypal:${input.orderId}:refunded:${input.refund.refundedMoney.amountMinor}`
        : `paypal:${input.orderId}:${input.status.toLowerCase()}:${input.outcome}`;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        provider: "paypal",
        kind: "money",
        providerEventId,
        providerPaymentRef: input.orderId,
        intentRef: input.intentRef,
        attemptRef: input.attemptRef,
        outcome: input.outcome,
        money: input.money,
        ...(input.refund ? { refund: input.refund } : {}),
      }),
      "utf8",
    )
    .digest("hex");

  return {
    kind: "money",
    provider: "paypal",
    providerEventId,
    providerOccurredAt: input.occurredAt === undefined ? PAYPAL_TEST_OCCURRED_AT : input.occurredAt,
    fingerprint,
    providerAuditPayload: {
      status: input.status,
      mode: "test",
      captureStatus: input.captureStatus ?? null,
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(input.refund ? { refundOperationId: input.refund.operationId } : {}),
    },
    providerPaymentRef: input.orderId,
    intentRef: input.intentRef,
    attemptRef: input.attemptRef,
    outcome: input.outcome,
    money: input.money,
    ...(input.capturedAmountBasis ? { capturedAmountBasis: input.capturedAmountBasis } : {}),
    ...(input.refund ? { refund: input.refund } : {}),
  };
}

interface SubjectSeed {
  attemptRef: string;
  intentRef: string;
  remote: string;
  suffix: string;
  money: PaymentMoney;
  partialMoney: PaymentMoney;
}

const SEEDS: readonly SubjectSeed[] = [
  {
    attemptRef: "attempt-eu-eur",
    intentRef: "intent-eu-eur",
    remote: "5O190127TN364715E",
    suffix: "EU0001",
    money: { amountMinor: 4999, currency: "EUR" },
    partialMoney: { amountMinor: 1500, currency: "EUR" },
  },
  {
    attemptRef: "attempt-us-usd",
    intentRef: "intent-us-usd",
    remote: "5O190127TN364715U",
    suffix: "US0002",
    money: { amountMinor: 4999, currency: "USD" },
    partialMoney: { amountMinor: 1500, currency: "USD" },
  },
];

export function createPayPalSafetyFixture(): {
  subjects: PaymentAdapterTestSubject[];
  adapter: PaymentAdapter;
  fake: ReturnType<typeof createScriptedPaymentFake>;
  providerRequests: () => number;
} {
  let providerRequestCount = 0;
  let injectedFailure: ScriptedPaymentOutcome<unknown> | null = null;

  const remoteByIntent = new Map(SEEDS.map((seed) => [seed.intentRef, seed.remote]));
  const seedByRemote = new Map(SEEDS.map((seed) => [seed.remote, seed]));
  const seedByPartialId = new Map(SEEDS.map((seed) => [`PP_PART_${seed.suffix}`, seed]));
  const seedByRefundId = new Map(SEEDS.map((seed) => [`PP_REF_${seed.suffix}`, seed]));
  const missingIds = new Set(SEEDS.map((seed) => `PP_MISSING_${seed.suffix}`));
  const zeroById = new Map(SEEDS.map((seed) => [`PP_ZERO_${seed.suffix}`, seed]));
  const noAmtIds = new Set(SEEDS.map((seed) => `PP_NOAMT_${seed.suffix}`));
  const noCurById = new Map(SEEDS.map((seed) => [`PP_NOCUR_${seed.suffix}`, seed]));

  const fake = createScriptedPaymentFake<{
    createOrder: PayPalOrderResource;
  }>();

  const client: PayPalClient = {
    async createOrder(request) {
      providerRequestCount += 1;
      const unit = request.purchase_units[0]!;
      const intentRef = unit.custom_id ?? "";
      const remote = remoteByIntent.get(intentRef) ?? "PP_DEFAULT_001";
      const step: ScriptedPaymentOutcome<PayPalOrderResource> =
        (injectedFailure as ScriptedPaymentOutcome<PayPalOrderResource> | null)
        ?? {
          kind: "success",
          value: {
            id: remote,
            status: "CREATED",
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: unit.reference_id,
                custom_id: unit.custom_id,
                amount: unit.amount,
              },
            ],
            links: [
              {
                rel: "approve",
                href: `https://www.sandbox.paypal.com/checkoutnow?token=${remote}`,
                method: "GET",
              },
            ],
            create_time: PAYPAL_TEST_OCCURRED_AT,
          },
        };
      injectedFailure = null;
      fake.enqueue("createOrder", step);
      return await fake.invoke("createOrder");
    },

    async getOrder(orderId) {
      providerRequestCount += 1;
      if (missingIds.has(orderId)) {
        throw new PayPalTransportError({
          diagnosticCode: "PAYPAL_HTTP_404",
          httpStatus: 404,
          phase: "unknown",
        });
      }

      const zeroSeed = zeroById.get(orderId);
      if (zeroSeed) {
        return {
          id: orderId,
          status: "COMPLETED",
          purchase_units: [
            {
              amount: {
                currency_code: zeroSeed.money.currency,
                value: minorToMajorString(0, zeroSeed.money.currency),
              },
            },
          ],
          update_time: PAYPAL_TEST_OCCURRED_AT,
        };
      }

      if (noAmtIds.has(orderId)) {
        return {
          id: orderId,
          status: "COMPLETED",
          purchase_units: [{}],
          update_time: PAYPAL_TEST_OCCURRED_AT,
        };
      }

      const noCurSeed = noCurById.get(orderId);
      if (noCurSeed) {
        return {
          id: orderId,
          status: "COMPLETED",
          purchase_units: [
            {
              amount: {
                value: minorToMajorString(noCurSeed.money.amountMinor, noCurSeed.money.currency),
              } as PayPalOrderResource["purchase_units"] extends readonly (infer U)[] | undefined
                ? U extends { amount?: infer A }
                  ? NonNullable<A>
                  : never
                : never,
            },
          ],
          update_time: PAYPAL_TEST_OCCURRED_AT,
        };
      }

      const partSeed = seedByPartialId.get(orderId) ?? seedByRefundId.get(orderId);
      if (partSeed) {
        const majorFull = minorToMajorString(partSeed.money.amountMinor, partSeed.money.currency);
        const majorPart = minorToMajorString(partSeed.partialMoney.amountMinor, partSeed.partialMoney.currency);
        return {
          id: orderId,
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: partSeed.attemptRef,
              custom_id: partSeed.intentRef,
              amount: { currency_code: partSeed.money.currency, value: majorFull },
              payments: {
                captures: [
                  {
                    id: `CAP-${orderId}`,
                    status: "COMPLETED",
                    amount: { currency_code: partSeed.money.currency, value: majorFull },
                    update_time: PAYPAL_TEST_OCCURRED_AT,
                  },
                ],
                refunds: [
                  {
                    id: `REF-${orderId}`,
                    status: "COMPLETED",
                    amount: { currency_code: partSeed.partialMoney.currency, value: majorPart },
                    update_time: PAYPAL_TEST_OCCURRED_AT,
                  },
                ],
              },
            },
          ],
          update_time: PAYPAL_TEST_OCCURRED_AT,
        };
      }

      const seed = seedByRemote.get(orderId);
      if (!seed) {
        throw new PayPalTransportError({
          diagnosticCode: "PAYPAL_HTTP_404",
          httpStatus: 404,
          phase: "unknown",
        });
      }

      const majorFull = minorToMajorString(seed.money.amountMinor, seed.money.currency);
      return {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: seed.attemptRef,
            custom_id: seed.intentRef,
            amount: { currency_code: seed.money.currency, value: majorFull },
            payments: {
              captures: [
                {
                  id: `CAP-${orderId}`,
                  status: "COMPLETED",
                  amount: { currency_code: seed.money.currency, value: majorFull },
                  update_time: PAYPAL_TEST_OCCURRED_AT,
                },
              ],
            },
          },
        ],
        update_time: PAYPAL_TEST_OCCURRED_AT,
      };
    },

    async verifyWebhookSignature(request) {
      providerRequestCount += 1;
      if (request.webhook_id !== PAYPAL_TEST_WEBHOOK_ID || request.transmission_sig !== "valid-paypal-sig") {
        return { verification_status: "FAILURE" };
      }
      return { verification_status: "SUCCESS" };
    },
  };

  const adapter = createPayPalPaymentAdapter({
    client,
    webhookId: PAYPAL_TEST_WEBHOOK_ID,
    returnUrl: PAYPAL_TEST_RETURN_URL,
    cancelUrl: PAYPAL_TEST_CANCEL_URL,
    mode: "test",
    supportedCurrencies: ["EUR", "USD"],
  });

  const baseInputs = SEEDS.map((seed) => ({
    attemptRef: seed.attemptRef,
    intentRef: seed.intentRef,
    fingerprint: `fp_${seed.attemptRef}`,
    providerIdempotencyKey: `idem_${seed.attemptRef}`,
    money: seed.money,
    mode: "test" as const,
    purpose: "initial" as const,
    customerRef: `payer_${seed.suffix}`,
  }));

  const subjects: PaymentAdapterTestSubject[] = SEEDS.map((seed, index) => {
    const executionInput = baseInputs[index]!;
    const identity = {
      provider: "paypal",
      providerPaymentRef: seed.remote,
      intentRef: seed.intentRef,
      attemptRef: seed.attemptRef,
    };

    const validWebhook: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({
        orderId: seed.remote,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        useSupplementaryOrderId: true,
      }),
      expected: expectedPayPalEvidence({
        orderId: seed.remote,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "COMPLETED",
        captureStatus: "COMPLETED",
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        outcome: "succeeded",
        money: seed.money,
        capturedAmountBasis: "provider_capture_v1",
      }),
    };

    const duplicateWebhook: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput(
        {
          orderId: seed.remote,
          eventType: "PAYMENT.CAPTURE.COMPLETED",
          useSupplementaryOrderId: true,
        },
        "2030-06-15T12:05:00.000Z",
      ),
      expected: validWebhook.expected,
    };

    const signatureMismatch: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({ orderId: seed.remote, signatureHeader: "forged-paypal-sig" }),
      expected: { kind: "refusal", reason: "signature" },
    };

    const partialId = `PP_PART_${seed.suffix}`;
    const partialAmount: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({
        orderId: partialId,
        eventType: "PAYMENT.CAPTURE.REFUNDED",
        useSupplementaryOrderId: true,
      }),
      expected: expectedPayPalEvidence({
        orderId: partialId,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "COMPLETED",
        captureStatus: "COMPLETED",
        eventType: "PAYMENT.CAPTURE.REFUNDED",
        outcome: "refunded",
        money: seed.money,
        refund: {
          kind: "cumulative-snapshot",
          operationId: `paypal:refund:${partialId}:${seed.partialMoney.amountMinor}`,
          originalPaymentMoney: seed.money,
          refundedMoney: seed.partialMoney,
        },
      }),
    };

    const refundId = `PP_REF_${seed.suffix}`;
    const refundWebhook: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({
        orderId: refundId,
        eventType: "PAYMENT.CAPTURE.REFUNDED",
        useSupplementaryOrderId: true,
      }),
      expected: expectedPayPalEvidence({
        orderId: refundId,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "COMPLETED",
        captureStatus: "COMPLETED",
        eventType: "PAYMENT.CAPTURE.REFUNDED",
        outcome: "refunded",
        money: seed.money,
        refund: {
          kind: "cumulative-snapshot",
          operationId: `paypal:refund:${refundId}:${seed.partialMoney.amountMinor}`,
          originalPaymentMoney: seed.money,
          refundedMoney: seed.partialMoney,
        },
      }),
    };

    const zeroAmount: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({ orderId: `PP_ZERO_${seed.suffix}` }),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const missingAmount: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({ orderId: `PP_NOAMT_${seed.suffix}` }),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const missingCurrency: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({ orderId: `PP_NOCUR_${seed.suffix}` }),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const chargeback: PaymentWebhookFixture = {
      input: buildPayPalWebhookInput({
        orderId: seed.remote,
        eventType: "CUSTOMER.DISPUTE.CREATED",
        useSupplementaryOrderId: true,
      }),
      expected: expectedPayPalEvidence({
        orderId: seed.remote,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "COMPLETED",
        captureStatus: "COMPLETED",
        eventType: "CUSTOMER.DISPUTE.CREATED",
        outcome: "disputed",
        money: seed.money,
        refund: {
          kind: "full-reversal",
          reason: "chargeback",
          operationId: `paypal:chargeback:${seed.remote}:${seed.money.amountMinor}`,
          originalPaymentMoney: seed.money,
        },
      }),
    };

    const capabilityInputs: PaymentAdapterSafetyScenarios["capabilityInputs"] = [
      ...baseInputs.flatMap((row) =>
        (["wallet", "card"] as const).map((family) => ({
          ...row,
          methodSelection: { family },
        })),
      ),
      {
        ...executionInput,
        purpose: "renewal-unattended" as const,
        orderMode: "subscription_cycle" as const,
        storedMethod: { reference: `ba_${seed.suffix}`, mandate: {} },
      },
    ];

    function triggerFault(
      kind: "timeout-before-dispatch" | "provider-5xx" | "timeout-after-dispatch" | "redelivery-409",
    ) {
      injectedFailure = { kind };
      return adapter.attemptPort.execute(executionInput);
    }

    const transport: PaymentAdapterSafetyScenarios["transport"] = {
      "timeout-before-dispatch": { calls: fake.calls, execute: () => triggerFault("timeout-before-dispatch") },
      "provider-5xx-before-dispatch": { calls: fake.calls, execute: () => triggerFault("provider-5xx") },
      "timeout-after-dispatch": { calls: fake.calls, execute: () => triggerFault("timeout-after-dispatch") },
      "redelivery-409": { calls: fake.calls, execute: () => triggerFault("redelivery-409") },
    };

    return {
      subjectId: seed.attemptRef,
      adapter,
      executionInput,
      readbackInput: {
        identity,
        expectedMoney: seed.money,
        purpose: "active_checkout",
      },
      verification: [validWebhook, duplicateWebhook, refundWebhook, chargeback, signatureMismatch],
      safety: {
        providerRequests: () => providerRequestCount,
        transport,
        capabilityInputs,
        unsupportedCurrencyInput: {
          ...executionInput,
          money: { amountMinor: seed.money.amountMinor, currency: "JPY" },
        },
        partialMoney: seed.partialMoney,
        webhooks: {
          valid: validWebhook,
          duplicate: duplicateWebhook,
          signatureMismatch,
          partialAmount,
          zeroAmount,
          missingAmount,
          missingCurrency,
          chargeback,
        },
      },
    };
  });

  return {
    subjects,
    adapter,
    fake,
    providerRequests: () => providerRequestCount,
  };
}
