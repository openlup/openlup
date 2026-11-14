import { z } from "zod";
import type { PaymentAdapter, PaymentAttemptPort, PaymentExecutionEnvelope } from "./contracts/adapter.js";
import type { PaymentIngressPort } from "./contracts/evidence.js";
import type { PreparedAttemptPersistenceResult } from "./contracts/preparedAttempt.js";
import type { PostgresPaymentTruthOptions } from "./contracts/truth.js";
import { createPostgresProviderPaymentControlPort } from "./postgresProviderControl.js";
import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";
import { createPostgresPaymentProviderReconciliationPort } from "./postgresPaymentProviderReconciliation.js";
import { createPostgresPaymentWebhookControlPort } from "./postgresProviderWebhook.js";
import { consumePostgresPaymentMethodDelivery, createPostgresPaymentWebhookMethodRefPort } from "./postgresPaymentMethods.js";
import { createVerifiedPaymentIngress, type PaymentWebhookControlPort, type NormalizedProviderPaymentWebhook } from "./verifiedIngress.js";

export interface PostgresProviderAttemptSnapshot {
  orderId: string; intentStatus: string; settlementStatus: string; amountMinor: number; currency: string;
  requestPayload: Record<string, unknown>; responsePayload: Record<string, unknown>;
  paymentAttempt: { id: string; paymentIntentId: string; paymentId: string; provider: string; status: string;
    providerAttemptId: string | null; providerSessionId: string | null; idempotencyKey: string };
}
export interface PostgresProviderPaymentRail {
  provider: string; mode: "live" | "test"; adapter: PaymentAdapter;
  control: ReturnType<typeof createPostgresProviderPaymentControlPort>;
  controlFor(executor: PaymentProviderExecutor): ReturnType<typeof createPostgresProviderPaymentControlPort>;
  reconciliation: ReturnType<typeof createPostgresPaymentProviderReconciliationPort>;
  readAttempt(intentId: string, attemptId?: string | null): Promise<PostgresProviderAttemptSnapshot | null>;
  execute(request: Parameters<PaymentAttemptPort["execute"]>[0]): Promise<{ execution: PaymentExecutionEnvelope; attempt: PreparedAttemptPersistenceResult }>;
  ingress: PaymentIngressPort;
}
const snapshot: z.ZodType<PostgresProviderAttemptSnapshot> = z.object({ orderId: z.guid(), intentStatus: z.string(), settlementStatus: z.string(),
  amountMinor: z.number().int().positive(), currency: z.string(),
  requestPayload: z.record(z.string(), z.unknown()), responsePayload: z.record(z.string(), z.unknown()),
  paymentAttempt: z.object({ id: z.guid(), paymentIntentId: z.guid(), paymentId: z.guid(), provider: z.string(),
    status: z.string(), providerAttemptId: z.string().nullable(), providerSessionId: z.string().nullable(), idempotencyKey: z.string() }) });

/** Explicit host selection; no SDK construction, provider call or automatic reopen. */
export function createPostgresProviderPaymentRail(input: {
  /** Independently committed calls; never execute a provider inside a host transaction. */
  executor: PaymentProviderExecutor;
  adapter: PaymentAdapter;
  mode: "live" | "test";
  truth: PostgresPaymentTruthOptions;
  resolveMethodOwner: NonNullable<Parameters<typeof createVerifiedPaymentIngress>[0]["resolveMethodOwner"]>;
  resolveSavedMethodOwner: NonNullable<Parameters<typeof createVerifiedPaymentIngress>[0]["resolveSavedMethodOwner"]>;
  /** Select the native renewal result owner for this host's subscription population. */
  composeWebhook?: (event: NormalizedProviderPaymentWebhook, control: PaymentWebhookControlPort) => PaymentWebhookControlPort;
}): PostgresProviderPaymentRail {
  const provider = input.adapter.capabilities.providerKind;
  const control = createPostgresProviderPaymentControlPort(input.executor, input.truth);
  const webhook = createPostgresPaymentWebhookControlPort(input.executor, input.truth);
  const methods = createPostgresPaymentWebhookMethodRefPort(input.executor);
  const reconciliation = createPostgresPaymentProviderReconciliationPort(input.executor, input.truth);
  return {
    provider, mode: input.mode, adapter: input.adapter, control, reconciliation,
    controlFor: executor => createPostgresProviderPaymentControlPort(executor, input.truth),
    async readAttempt(intentId: string, attemptId: string | null = null) {
      const value = (await input.executor.query("SELECT public.payment_provider_attempt_read($1::uuid,$2::uuid) AS response", [intentId, attemptId])).rows[0]?.response;
      if (value == null) return null;
      return snapshot.parse(value);
    },
    async execute(request: Parameters<PaymentAttemptPort["execute"]>[0]) {
      input.adapter.attemptPort.validateInput(request);
      if (request.mode !== input.mode) throw new Error("payment_provider_mode_mismatch");
      const flow = request.purpose === "renewal-unattended" ? "off_session_payment" : "one_time_payment";
      // Explicit allowlist: payer, customer authorization and returned handoffs
      // never become request identity, persisted payloads or diagnostics.
      const requestPayload = { orderRef: request.orderRef ?? request.intentRef, clientId: request.clientId ?? null,
        customerRef: request.customerRef ?? null, saveForFutureUse: request.saveForFutureUse ?? false,
        purpose: request.purpose, mode: request.mode, amountMinor: request.money.amountMinor, currency: request.money.currency,
        orderMode: request.purpose === "renewal-unattended" ? "subscription_cycle" : request.orderMode ?? "one_time",
        methodSelection: request.methodSelection ?? null, storedMethod: request.storedMethod ?? null };
      const prepared = await control.prepareProviderAttempt({ idempotencyKey: request.attemptRef, paymentIntentId: request.intentRef,
        provider, providerIdempotencyKey: request.providerIdempotencyKey, providerRequestFingerprint: request.fingerprint,
        providerFlow: flow, paymentMethodRef: request.storedMethod?.reference ?? null, requestPayload });
      if (prepared.replayed) throw new Error("provider_attempt_in_flight");
      // Each persistence call commits before dispatch; transport/finalize failures
      // retain the prepared row. A restart can only read/reconcile that attempt.
      const execution = await input.adapter.attemptPort.execute(request);
      const facts = execution.persistence;
      if (!facts) throw new Error("payment_adapter_persistence_unavailable");
      const attempt = await control.finalizeProviderAttempt({ idempotencyKey: `${request.attemptRef}:finalize`,
        paymentIntentId: request.intentRef, paymentAttemptId: prepared.paymentAttemptId,
        providerIdempotencyKey: request.providerIdempotencyKey, providerRequestFingerprint: request.fingerprint,
        providerAttemptId: execution.dispatch.kind === "dispatched" ? execution.dispatch.providerPaymentRef : null,
        providerSessionId: facts.providerSessionId,
        attemptStatus: execution.outcome.kind === "attempt" ? execution.outcome.status : "processing",
        nextActionKind: facts.nextActionKind, requestPayload: { ...facts.requestPayload, ...requestPayload }, responsePayload: facts.responsePayload });
      return { execution, attempt };
    },
    ingress: createVerifiedPaymentIngress({ provider, verifyPort: input.adapter.verifyPort, paymentControlPort: webhook,
      resolveMethodOwner: input.resolveMethodOwner, resolveSavedMethodOwner: input.resolveSavedMethodOwner,
      createPorts(event) {
        const evidence = event.rawPayload.openlupEvidence as { providerOccurredAt?: string | null } | undefined;
        const at = evidence?.providerOccurredAt;
        // Receipt time still records receipt. Missing provider time cannot become
        // a financial/lifecycle assertion; retain the evidence for manual repair.
        if (!at) return { paymentControlPort: { ingestPaymentEvent: webhook.ingestPaymentEvent } };
        event.rawPayload.openlupReceipt = { receivedAt: event.occurredAt };
        const selected = input.composeWebhook?.(event, webhook) ?? webhook;
        return { paymentControlPort: { ...selected, ingestPaymentEvent: delivery => selected.ingestPaymentEvent({ ...delivery, occurredAt: at }) },
          methodRefPort: methods, afterProcessed: ({ event: delivery }) => consumePostgresPaymentMethodDelivery(input.executor, delivery) };
      },
    }),
  };
}
