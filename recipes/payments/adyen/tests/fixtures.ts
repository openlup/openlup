import { createHash } from "node:crypto";
import type {
  PaymentAdapter,
  PaymentMoney,
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
  computeAdyenNotificationHmac,
  createAdyenPaymentAdapter,
  type AdyenCheckoutClient,
} from "../server/index.js";

/** Synthetic high-visibility canaries used to prove zero secret/PII leakage (ADR-001). */
export const ADYEN_TEST_CANARIES = Object.freeze({
  apiKey: ["fixture", "canary", "adyen", "credential", "0001"].join("_"),
  hmacKeyHex: "00112233".repeat(8),
  sessionData: ["fixture", "canary", "session", "data", "do-not-persist"].join("_"),
  payerEmail: "canary-buyer@example.invalid",
  payerName: "Canary Buyer Name",
});

export const ADYEN_TEST_MERCHANT_ACCOUNT = "OpenLupUSMerchantTEST";
export const ADYEN_TEST_RETURN_URL = "https://store.example.test/checkout/return";
export const ADYEN_TEST_OCCURRED_AT = "2030-06-15T12:00:00.000Z";

export interface BuildSignedAdyenWebhookInput {
  pspReference: string;
  originalReference?: string;
  merchantAccountCode?: string;
  merchantReference: string;
  intentRef?: string;
  attemptRef?: string;
  amount?: { value?: number | null; currency?: string | null } | null;
  eventCode: string;
  success: "true" | "false";
  eventDate?: string | null;
  live?: "true" | "false";
  reason?: string;
  paymentMethod?: string;
  recurringDetailReference?: string;
  shopperReference?: string;
  hmacKeyHex?: string;
  tamperSignature?: boolean;
  receivedAt?: string;
}

export function buildSignedAdyenWebhook(input: BuildSignedAdyenWebhookInput): {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
  receivedAt: string;
} {
  const merchantAccountCode = input.merchantAccountCode ?? ADYEN_TEST_MERCHANT_ACCOUNT;
  const originalReference = input.originalReference ?? "";
  const hmacKeyHex = input.hmacKeyHex ?? ADYEN_TEST_CANARIES.hmacKeyHex;

  const amountObj: Record<string, unknown> | undefined =
    input.amount === null
      ? undefined
      : {
          ...(input.amount?.currency !== undefined && input.amount.currency !== null
            ? { currency: input.amount.currency }
            : {}),
          ...(input.amount?.value !== undefined && input.amount.value !== null
            ? { value: input.amount.value }
            : {}),
        };

  const valueStr =
    amountObj && typeof amountObj.value === "number" ? String(amountObj.value) : "";
  const currencyStr =
    amountObj && typeof amountObj.currency === "string" ? amountObj.currency : "";

  const computedHmac = computeAdyenNotificationHmac(
    {
      pspReference: input.pspReference,
      originalReference,
      merchantAccountCode,
      merchantReference: input.merchantReference,
      value: valueStr,
      currency: currencyStr,
      eventCode: input.eventCode,
      success: input.success,
    },
    hmacKeyHex,
  );

  const additionalData: Record<string, string> = {
    hmacSignature: input.tamperSignature ? "invalidBase64Signature==" : computedHmac,
    ...(input.intentRef ? { "metadata.intentRef": input.intentRef } : {}),
    ...(input.attemptRef ? { "metadata.attemptRef": input.attemptRef } : {}),
    ...(input.recurringDetailReference
      ? { "recurring.recurringDetailReference": input.recurringDetailReference }
      : {}),
    ...(input.shopperReference ? { "recurring.shopperReference": input.shopperReference } : {}),
  };

  const payload = {
    live: input.live ?? "false",
    notificationItems: [
      {
        NotificationRequestItem: {
          additionalData,
          ...(amountObj !== undefined ? { amount: amountObj } : {}),
          eventCode: input.eventCode,
          ...(input.eventDate !== null ? { eventDate: input.eventDate ?? ADYEN_TEST_OCCURRED_AT } : {}),
          merchantAccountCode,
          merchantReference: input.merchantReference,
          ...(originalReference ? { originalReference } : {}),
          ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
          pspReference: input.pspReference,
          ...(input.reason ? { reason: input.reason } : {}),
          success: input.success,
        },
      },
    ],
  };

  return {
    rawBody: new TextEncoder().encode(JSON.stringify(payload)),
    headers: { "content-type": "application/json" },
    receivedAt: input.receivedAt ?? ADYEN_TEST_OCCURRED_AT,
  };
}

function expectedAdyenEvidence(input: {
  pspReference: string;
  originalReference?: string;
  merchantReference: string;
  intentRef: string;
  attemptRef: string | null;
  eventCode: string;
  outcome: VerifiedPaymentEvidence["outcome"];
  money: PaymentMoney;
  paymentMethod?: string | null;
  occurredAt?: string | null;
  capturedAmountBasis?: "provider_capture_v1";
  refusal?: VerifiedPaymentEvidence["refusal"];
  reusableMethod?: VerifiedPaymentEvidence["reusableMethod"];
}): VerifiedPaymentEvidence {
  const providerPaymentRef = input.originalReference || input.pspReference;
  const providerEventId = `adyen:${input.pspReference}:${input.eventCode}:${input.outcome}`;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        provider: "adyen",
        kind: "money",
        providerEventId,
        providerPaymentRef,
        intentRef: input.intentRef,
        attemptRef: input.attemptRef,
        outcome: input.outcome,
        money: input.money,
      }),
      "utf8",
    )
    .digest("hex");

  return {
    kind: "money",
    provider: "adyen",
    providerEventId,
    providerOccurredAt: input.occurredAt === undefined ? ADYEN_TEST_OCCURRED_AT : input.occurredAt,
    fingerprint,
    providerAuditPayload: {
      eventCode: input.eventCode,
      paymentMethod: input.paymentMethod ?? null,
      merchantReference: input.merchantReference,
    },
    providerPaymentRef,
    intentRef: input.intentRef,
    attemptRef: input.attemptRef,
    outcome: input.outcome,
    money: input.money,
    ...(input.capturedAmountBasis ? { capturedAmountBasis: input.capturedAmountBasis } : {}),
    ...(input.refusal ? { refusal: input.refusal } : {}),
    ...(input.reusableMethod ? { reusableMethod: input.reusableMethod } : {}),
  };
}

interface SubjectSeed {
  attemptRef: string;
  intentRef: string;
  remote: string;
  money: PaymentMoney;
  partialMoney: PaymentMoney;
}

const SEEDS: readonly SubjectSeed[] = [
  {
    attemptRef: "attempt-us-usd",
    intentRef: "intent-us-usd",
    remote: "8836000000000001",
    money: { amountMinor: 4999, currency: "USD" },
    partialMoney: { amountMinor: 1500, currency: "USD" },
  },
  {
    attemptRef: "attempt-eu-eur",
    intentRef: "intent-eu-eur",
    remote: "8836000000000002",
    money: { amountMinor: 4999, currency: "EUR" },
    partialMoney: { amountMinor: 1500, currency: "EUR" },
  },
];

export function createAdyenSafetyFixture(): {
  subjects: PaymentAdapterTestSubject[];
  adapter: PaymentAdapter;
  fake: ReturnType<typeof createScriptedPaymentFake>;
  unattendedRequests: unknown[];
  cancelRequests: Array<{ pspReference: string; reference: string }>;
  providerRequests: () => number;
} {
  let providerRequestCount = 0;
  let injectedFailure: ScriptedPaymentOutcome<unknown> | null = null;
  const unattendedRequests: unknown[] = [];
  const cancelRequests: Array<{ pspReference: string; reference: string }> = [];
  const remoteByIntent = new Map(SEEDS.map((seed) => [seed.intentRef, seed.remote]));

  const fake = createScriptedPaymentFake<{
    createSession: Awaited<ReturnType<AdyenCheckoutClient["createSession"]>>;
    createPayment: Awaited<ReturnType<AdyenCheckoutClient["createPayment"]>>;
  }>();

  const client: AdyenCheckoutClient = {
    async createSession(request) {
      providerRequestCount += 1;
      const remote = remoteByIntent.get(request.reference) ?? "8836000000000099";
      const step: ScriptedPaymentOutcome<Awaited<ReturnType<AdyenCheckoutClient["createSession"]>>> =
        (injectedFailure as ScriptedPaymentOutcome<Awaited<ReturnType<AdyenCheckoutClient["createSession"]>>> | null)
        ?? {
          kind: "success",
          value: {
            id: remote,
            sessionData: ADYEN_TEST_CANARIES.sessionData,
            amount: request.amount,
            reference: request.reference,
            expiresAt: "2030-06-15T13:00:00.000Z",
          },
        };
      injectedFailure = null;
      fake.enqueue("createSession", step);
      return await fake.invoke("createSession");
    },
    async createPayment(request) {
      providerRequestCount += 1;
      if (request.shopperInteraction === "ContAuth") {
        unattendedRequests.push(request);
      }
      const remote = remoteByIntent.get(request.reference) ?? "8836000000000099";
      const isRedirect = request.shopperInteraction === "Ecommerce";
      const step: ScriptedPaymentOutcome<Awaited<ReturnType<AdyenCheckoutClient["createPayment"]>>> =
        (injectedFailure as ScriptedPaymentOutcome<Awaited<ReturnType<AdyenCheckoutClient["createPayment"]>>> | null)
        ?? {
          kind: "success",
          value: isRedirect
            ? {
                pspReference: remote,
                resultCode: "RedirectShopper",
                action: {
                  type: "redirect",
                  url: `https://checkout-test.adyen.com/redirect/${remote}`,
                  method: "GET",
                },
                amount: request.amount,
              }
            : {
                pspReference: remote,
                resultCode: "Authorised",
                amount: request.amount,
              },
        };
      injectedFailure = null;
      fake.enqueue("createPayment", step);
      return await fake.invoke("createPayment");
    },
    async cancelPayment(pspReference, request) {
      providerRequestCount += 1;
      cancelRequests.push({ pspReference, reference: request.reference });
      return {
        pspReference: `cancel_${pspReference}`,
        paymentPspReference: pspReference,
        status: "received",
        reference: request.reference,
      };
    },
  };

  const adapter = createAdyenPaymentAdapter({
    client,
    merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
    returnUrl: ADYEN_TEST_RETURN_URL,
    hmacKeysHex: [ADYEN_TEST_CANARIES.hmacKeyHex],
    mode: "test",
    supportedCurrencies: ["USD", "EUR"],
    captureMode: "immediate",
  });

  const baseInputs = SEEDS.map((seed) => ({
    attemptRef: seed.attemptRef,
    intentRef: seed.intentRef,
    fingerprint: `fp_${seed.attemptRef}`,
    providerIdempotencyKey: `idem_${seed.attemptRef}`,
    money: seed.money,
    mode: "test" as const,
    purpose: "initial" as const,
    customerRef: `shopper_${seed.attemptRef}`,
  }));

  const subjects: PaymentAdapterTestSubject[] = SEEDS.map((seed, index) => {
    const executionInput = baseInputs[index]!;
    const identity = {
      provider: "adyen",
      providerPaymentRef: seed.remote,
      intentRef: seed.intentRef,
      attemptRef: seed.attemptRef,
    };

    const validWebhook: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: seed.money.amountMinor, currency: seed.money.currency },
        eventCode: "AUTHORISATION",
        success: "true",
        paymentMethod: "visa",
      }),
      expected: expectedAdyenEvidence({
        pspReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        eventCode: "AUTHORISATION",
        outcome: "succeeded",
        money: seed.money,
        paymentMethod: "visa",
        capturedAmountBasis: "provider_capture_v1",
      }),
    };

    const duplicateWebhook: PaymentWebhookFixture = {
      input: {
        ...validWebhook.input,
        receivedAt: "2030-06-15T12:05:00.000Z",
      },
      expected: validWebhook.expected,
    };

    const signatureMismatch: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: seed.money.amountMinor, currency: seed.money.currency },
        eventCode: "AUTHORISATION",
        success: "true",
        tamperSignature: true,
      }),
      expected: { kind: "refusal", reason: "signature" },
    };

    // Partial CAPTURE webhook proves partial money never settles a full order amount.
    const partialAmount: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: `cap_${seed.remote}`,
        originalReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: seed.partialMoney.amountMinor, currency: seed.partialMoney.currency },
        eventCode: "CAPTURE",
        success: "true",
        paymentMethod: "visa",
      }),
      expected: expectedAdyenEvidence({
        pspReference: `cap_${seed.remote}`,
        originalReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        eventCode: "CAPTURE",
        outcome: "succeeded",
        money: seed.partialMoney,
        paymentMethod: "visa",
        capturedAmountBasis: "provider_capture_v1",
      }),
    };

    const zeroAmount: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: `zero_${seed.remote}`,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: 0, currency: seed.money.currency },
        eventCode: "AUTHORISATION",
        success: "true",
      }),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const missingAmount: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: `noamt_${seed.remote}`,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { currency: seed.money.currency },
        eventCode: "AUTHORISATION",
        success: "true",
      }),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const missingCurrency: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: `nocur_${seed.remote}`,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: seed.money.amountMinor },
        eventCode: "AUTHORISATION",
        success: "true",
      }),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const chargeback: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: `cb_${seed.remote}`,
        originalReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: seed.money.amountMinor, currency: seed.money.currency },
        eventCode: "CHARGEBACK",
        success: "true",
        paymentMethod: "visa",
      }),
      expected: expectedAdyenEvidence({
        pspReference: `cb_${seed.remote}`,
        originalReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        eventCode: "CHARGEBACK",
        outcome: "disputed",
        money: seed.money,
        paymentMethod: "visa",
      }),
    };

    const refundWebhook: PaymentWebhookFixture = {
      input: buildSignedAdyenWebhook({
        pspReference: `ref_${seed.remote}`,
        originalReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        amount: { value: seed.partialMoney.amountMinor, currency: seed.partialMoney.currency },
        eventCode: "REFUND",
        success: "true",
        paymentMethod: "visa",
      }),
      expected: expectedAdyenEvidence({
        pspReference: `ref_${seed.remote}`,
        originalReference: seed.remote,
        merchantReference: seed.intentRef,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        eventCode: "REFUND",
        outcome: "refunded",
        money: seed.partialMoney,
        paymentMethod: "visa",
      }),
    };

    const capabilityInputs: PaymentAdapterSafetyScenarios["capabilityInputs"] = [
      ...baseInputs.flatMap((row) =>
        (["card", "wallet", "bank-redirect"] as const).map((family) => ({
          ...row,
          methodSelection: { family },
        })),
      ),
      {
        ...executionInput,
        purpose: "renewal-unattended" as const,
        orderMode: "subscription_cycle" as const,
        storedMethod: { reference: `adyen_token_${seed.attemptRef}`, mandate: {} },
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
    unattendedRequests,
    cancelRequests,
    providerRequests: () => providerRequestCount,
  };
}
