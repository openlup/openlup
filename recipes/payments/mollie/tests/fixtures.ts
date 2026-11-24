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
  createMolliePaymentAdapter,
  minorToMajorString,
  MollieTransportError,
  type MollieClient,
  type MolliePaymentResource,
} from "../server/index.js";

/** Synthetic high-visibility canaries used to prove zero secret/PII leakage (provider recipe contract). */
export const MOLLIE_TEST_CANARIES = Object.freeze({
  apiKeyTest: ["test", "canary", "mollie", "credential", "0001"].join("_"),
  apiKeyLive: ["live", "canary", "mollie", "credential", "0001"].join("_"),
  payerEmail: "canary-buyer@example.invalid",
  payerName: "Canary Buyer Name",
});

export const MOLLIE_TEST_REDIRECT_URL = "https://store.example.test/checkout/return";
export const MOLLIE_TEST_WEBHOOK_URL = "https://store.example.test/api/bff/payment/webhooks/mollie";
export const MOLLIE_TEST_OCCURRED_AT = "2030-06-15T12:00:00.000Z";
export const MOLLIE_TEST_EXPIRES_AT = "2030-06-15T13:00:00.000Z";

export function buildMollieWebhookInput(
  paymentId: string,
  receivedAt = MOLLIE_TEST_OCCURRED_AT,
): {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
  receivedAt: string;
} {
  return {
    rawBody: new TextEncoder().encode(`id=${paymentId}`),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    receivedAt,
  };
}

function expectedMollieEvidence(input: {
  paymentId: string;
  intentRef: string | null;
  attemptRef: string | null;
  status: string;
  method?: string | null;
  sequenceType?: string | null;
  outcome: VerifiedPaymentEvidence["outcome"];
  money: PaymentMoney;
  occurredAt?: string | null;
  capturedAmountBasis?: "provider_capture_v1";
  refund?: PaymentRefundObservation;
  reusableMethod?: VerifiedPaymentEvidence["reusableMethod"];
}): VerifiedPaymentEvidence {
  const providerEventId =
    input.outcome === "disputed"
      ? `mollie:${input.paymentId}:disputed:${input.money.amountMinor}`
      : input.outcome === "refunded" && input.refund && "refundedMoney" in input.refund
        ? `mollie:${input.paymentId}:refunded:${input.refund.refundedMoney.amountMinor}`
        : `mollie:${input.paymentId}:${input.status}:${input.outcome}`;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        provider: "mollie",
        kind: "money",
        providerEventId,
        providerPaymentRef: input.paymentId,
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
    provider: "mollie",
    providerEventId,
    providerOccurredAt: input.occurredAt === undefined ? MOLLIE_TEST_OCCURRED_AT : input.occurredAt,
    fingerprint,
    providerAuditPayload: {
      status: input.status,
      mode: "test",
      method: input.method ?? null,
      sequenceType: input.sequenceType ?? null,
      ...(input.refund ? { refundOperationId: input.refund.operationId } : {}),
    },
    providerPaymentRef: input.paymentId,
    intentRef: input.intentRef,
    attemptRef: input.attemptRef,
    outcome: input.outcome,
    money: input.money,
    ...(input.capturedAmountBasis ? { capturedAmountBasis: input.capturedAmountBasis } : {}),
    ...(input.refund ? { refund: input.refund } : {}),
    ...(input.reusableMethod ? { reusableMethod: input.reusableMethod } : {}),
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
    remote: "tr_eu00000001",
    suffix: "eu00000001",
    money: { amountMinor: 4999, currency: "EUR" },
    partialMoney: { amountMinor: 1500, currency: "EUR" },
  },
  {
    attemptRef: "attempt-us-usd",
    intentRef: "intent-us-usd",
    remote: "tr_us00000002",
    suffix: "us00000002",
    money: { amountMinor: 4999, currency: "USD" },
    partialMoney: { amountMinor: 1500, currency: "USD" },
  },
];

export function createMollieSafetyFixture(): {
  subjects: PaymentAdapterTestSubject[];
  adapter: PaymentAdapter;
  fake: ReturnType<typeof createScriptedPaymentFake>;
  unattendedRequests: unknown[];
  cancelRequests: string[];
  providerRequests: () => number;
} {
  let providerRequestCount = 0;
  let injectedFailure: ScriptedPaymentOutcome<unknown> | null = null;
  const unattendedRequests: unknown[] = [];
  const cancelRequests: string[] = [];

  const remoteByIntent = new Map(SEEDS.map((seed) => [seed.intentRef, seed.remote]));
  const seedByRemote = new Map(SEEDS.map((seed) => [seed.remote, seed]));
  const seedByPartialId = new Map(SEEDS.map((seed) => [`tr_part${seed.suffix}`, seed]));
  const seedByRefundId = new Map(SEEDS.map((seed) => [`tr_ref${seed.suffix}`, seed]));
  const missingIds = new Set(SEEDS.map((seed) => `tr_missing${seed.suffix}`));
  const zeroById = new Map(SEEDS.map((seed) => [`tr_zero${seed.suffix}`, seed]));
  const noAmtIds = new Set(SEEDS.map((seed) => `tr_noamt${seed.suffix}`));
  const noCurById = new Map(SEEDS.map((seed) => [`tr_nocur${seed.suffix}`, seed]));

  // Exact readback sequence per seed.remote across runPaymentAdapterConformance:
  // 1) readbackPort.readPayment -> paid
  // 2) verification[0..1] (valid, duplicate) -> paid, paid
  // 3) verification[3] (chargeback) -> disputed
  // 4) safety providerKind (valid) -> paid
  // 5) safety refundObservation (chargeback) -> disputed
  // 6) safety valid + duplicate + 409 probes (x6) -> paid
  // 7) safety chargeback -> disputed
  const remoteOutcomeQueue = new Map<string, Array<"paid" | "disputed">>(
    SEEDS.map((seed) => [
      seed.remote,
      [
        "paid",
        "paid",
        "paid",
        "disputed",
        "paid",
        "disputed",
        "paid",
        "paid",
        "paid",
        "paid",
        "paid",
        "paid",
        "disputed",
      ],
    ]),
  );

  const fake = createScriptedPaymentFake<{
    createPayment: MolliePaymentResource;
  }>();

  const client: MollieClient = {
    async createPayment(request) {
      providerRequestCount += 1;
      if (request.sequenceType === "recurring") {
        unattendedRequests.push(request);
      }
      const intentRef = request.metadata?.intentRef ?? "";
      const remote = remoteByIntent.get(intentRef) ?? "tr_default0001";
      const isRecurring = request.sequenceType === "recurring";
      const step: ScriptedPaymentOutcome<MolliePaymentResource> =
        (injectedFailure as ScriptedPaymentOutcome<MolliePaymentResource> | null)
        ?? {
          kind: "success",
          value: {
            resource: "payment",
            id: remote,
            mode: "test",
            status: "open",
            amount: request.amount,
            sequenceType: request.sequenceType ?? "oneoff",
            createdAt: MOLLIE_TEST_OCCURRED_AT,
            expiresAt: MOLLIE_TEST_EXPIRES_AT,
            ...(isRecurring
              ? { customerId: request.customerId, mandateId: request.mandateId }
              : {
                  _links: {
                    checkout: {
                      href: `https://www.mollie.com/checkout/select-method/${remote}`,
                    },
                  },
                }),
          },
        };
      injectedFailure = null;
      fake.enqueue("createPayment", step);
      return await fake.invoke("createPayment");
    },

    async getPayment(paymentId) {
      providerRequestCount += 1;
      if (missingIds.has(paymentId)) {
        throw new MollieTransportError({
          diagnosticCode: "MOLLIE_HTTP_404",
          httpStatus: 404,
          phase: "unknown",
        });
      }

      const zeroSeed = zeroById.get(paymentId);
      if (zeroSeed) {
        return {
          resource: "payment",
          id: paymentId,
          mode: "test",
          status: "paid",
          amount: { value: minorToMajorString(0, zeroSeed.money.currency), currency: zeroSeed.money.currency },
          paidAt: MOLLIE_TEST_OCCURRED_AT,
        };
      }

      if (noAmtIds.has(paymentId)) {
        return {
          resource: "payment",
          id: paymentId,
          mode: "test",
          status: "paid",
          amount: undefined as unknown as MolliePaymentResource["amount"],
          paidAt: MOLLIE_TEST_OCCURRED_AT,
        };
      }

      const noCurSeed = noCurById.get(paymentId);
      if (noCurSeed) {
        return {
          resource: "payment",
          id: paymentId,
          mode: "test",
          status: "paid",
          amount: {
            value: minorToMajorString(noCurSeed.money.amountMinor, noCurSeed.money.currency),
          } as unknown as MolliePaymentResource["amount"],
          paidAt: MOLLIE_TEST_OCCURRED_AT,
        };
      }

      const partSeed = seedByPartialId.get(paymentId) ?? seedByRefundId.get(paymentId);
      if (partSeed) {
        const majorFull = minorToMajorString(partSeed.money.amountMinor, partSeed.money.currency);
        const majorPart = minorToMajorString(partSeed.partialMoney.amountMinor, partSeed.partialMoney.currency);
        return {
          resource: "payment",
          id: paymentId,
          mode: "test",
          status: "paid",
          amount: { value: majorFull, currency: partSeed.money.currency },
          amountRefunded: { value: majorPart, currency: partSeed.partialMoney.currency },
          method: "creditcard",
          sequenceType: "oneoff",
          paidAt: MOLLIE_TEST_OCCURRED_AT,
          metadata: {
            intentRef: partSeed.intentRef,
            attemptRef: partSeed.attemptRef,
          },
        };
      }

      const seed = seedByRemote.get(paymentId);
      if (!seed) {
        throw new MollieTransportError({
          diagnosticCode: "MOLLIE_HTTP_404",
          httpStatus: 404,
          phase: "unknown",
        });
      }

      const queue = remoteOutcomeQueue.get(paymentId);
      const nextKind = queue?.shift() ?? "paid";
      const majorFull = minorToMajorString(seed.money.amountMinor, seed.money.currency);

      if (nextKind === "disputed") {
        return {
          resource: "payment",
          id: paymentId,
          mode: "test",
          status: "paid",
          amount: { value: majorFull, currency: seed.money.currency },
          amountChargedBack: { value: majorFull, currency: seed.money.currency },
          method: "creditcard",
          sequenceType: "oneoff",
          paidAt: MOLLIE_TEST_OCCURRED_AT,
          metadata: {
            intentRef: seed.intentRef,
            attemptRef: seed.attemptRef,
          },
        };
      }

      return {
        resource: "payment",
        id: paymentId,
        mode: "test",
        status: "paid",
        amount: { value: majorFull, currency: seed.money.currency },
        method: "creditcard",
        sequenceType: "oneoff",
        paidAt: MOLLIE_TEST_OCCURRED_AT,
        metadata: {
          intentRef: seed.intentRef,
          attemptRef: seed.attemptRef,
        },
      };
    },

    async cancelPayment(paymentId) {
      providerRequestCount += 1;
      cancelRequests.push(paymentId);
      const seed = seedByRemote.get(paymentId) ?? SEEDS[0]!;
      return {
        resource: "payment",
        id: paymentId,
        mode: "test",
        status: "canceled",
        amount: {
          value: minorToMajorString(seed.money.amountMinor, seed.money.currency),
          currency: seed.money.currency,
        },
        canceledAt: MOLLIE_TEST_OCCURRED_AT,
      };
    },
  };

  const adapter = createMolliePaymentAdapter({
    client,
    redirectUrl: MOLLIE_TEST_REDIRECT_URL,
    webhookUrl: MOLLIE_TEST_WEBHOOK_URL,
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
    customerRef: `cst_${seed.suffix}`,
  }));

  const subjects: PaymentAdapterTestSubject[] = SEEDS.map((seed, index) => {
    const executionInput = baseInputs[index]!;
    const identity = {
      provider: "mollie",
      providerPaymentRef: seed.remote,
      intentRef: seed.intentRef,
      attemptRef: seed.attemptRef,
    };

    const validWebhook: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(seed.remote),
      expected: expectedMollieEvidence({
        paymentId: seed.remote,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "paid",
        method: "creditcard",
        sequenceType: "oneoff",
        outcome: "succeeded",
        money: seed.money,
        capturedAmountBasis: "provider_capture_v1",
      }),
    };

    const duplicateWebhook: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(seed.remote, "2030-06-15T12:05:00.000Z"),
      expected: validWebhook.expected,
    };

    const signatureMismatch: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(`tr_missing${seed.suffix}`),
      expected: { kind: "refusal", reason: "signature" },
    };

    const partialId = `tr_part${seed.suffix}`;
    const partialAmount: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(partialId),
      expected: expectedMollieEvidence({
        paymentId: partialId,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "paid",
        method: "creditcard",
        sequenceType: "oneoff",
        outcome: "refunded",
        money: seed.money,
        refund: {
          kind: "cumulative-snapshot",
          operationId: `mollie:refund:${partialId}:${seed.partialMoney.amountMinor}`,
          originalPaymentMoney: seed.money,
          refundedMoney: seed.partialMoney,
        },
      }),
    };

    const refundId = `tr_ref${seed.suffix}`;
    const refundWebhook: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(refundId),
      expected: expectedMollieEvidence({
        paymentId: refundId,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "paid",
        method: "creditcard",
        sequenceType: "oneoff",
        outcome: "refunded",
        money: seed.money,
        refund: {
          kind: "cumulative-snapshot",
          operationId: `mollie:refund:${refundId}:${seed.partialMoney.amountMinor}`,
          originalPaymentMoney: seed.money,
          refundedMoney: seed.partialMoney,
        },
      }),
    };

    const zeroAmount: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(`tr_zero${seed.suffix}`),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const missingAmount: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(`tr_noamt${seed.suffix}`),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const missingCurrency: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(`tr_nocur${seed.suffix}`),
      expected: { kind: "refusal", reason: "malformed" },
    };

    const chargeback: PaymentWebhookFixture = {
      input: buildMollieWebhookInput(seed.remote),
      expected: expectedMollieEvidence({
        paymentId: seed.remote,
        intentRef: seed.intentRef,
        attemptRef: seed.attemptRef,
        status: "paid",
        method: "creditcard",
        sequenceType: "oneoff",
        outcome: "disputed",
        money: seed.money,
        refund: {
          kind: "full-reversal",
          reason: "chargeback",
          operationId: `mollie:chargeback:${seed.remote}:${seed.money.amountMinor}`,
          originalPaymentMoney: seed.money,
        },
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
        storedMethod: { reference: `mdt_${seed.suffix}`, mandate: {} },
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
