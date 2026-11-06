import { createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { createPostgresPurchaseRenewalWriter, createPostgresSandboxRenewalRail,
  createPostgresRenewalStore, createSandboxRenewalPolicy } from '@openlup/platform/subscriptions';
import type { NativeRetryDriverOptions, createNativeSubscriptionBinding } from '@openlup/platform/subscriptions';
import type { RenewalReadback } from '@openlup/platform/subscriptions/contracts';
import type { RenewalConfig } from '../shared/renewal-config.ts';

type Input = Parameters<typeof createNativeSubscriptionBinding>[0];

/** Only the scheduled host selects scenarios. No request body supplies method or money facts. */
export function composeRenewalSandbox(input: {
  executor: Input['executor']; withTransaction: Input['withTransaction']; codec: Input['codec'];
  config: RenewalConfig; now(): string;
  failureTemplate: string; recoveredTemplate: string; recoveryPath: string;
}) {
  const { executor, config, now, codec } = input;
  const writer = createPostgresPurchaseRenewalWriter(executor);
  const store = createPostgresRenewalStore(executor, codec, input.withTransaction);
  const rail = createPostgresSandboxRenewalRail(executor, { scenario: config.sandbox.initial, now });
  const simulator = createPostgresSandboxPaymentSimulator(executor, { dunningTemplateSlug: input.failureTemplate,
    recoveryTemplateSlug: input.recoveredTemplate, recoveryUrlPath: input.recoveryPath });
  const methods = new Map<string, { methodRef: string; evidenceRef: string; authorized: boolean; authorizationRef: string }>();
  const allowed = new Map<string, string>();
  function method(subscriptionId: string) {
    const value = methods.get(subscriptionId);
    if (!value) throw new Error('starter_renewal_method_unavailable');
    return value;
  }
  async function refresh() {
    methods.clear(); allowed.clear();
    const rows = (await executor.query(`SELECT s.id,t.authorization_ref,t.unattended_charge_authorized_at,
      method.method_ref,method.evidence_ref,method.health_state,
      recovery_auth.method_ref AS recovery_method
      FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
      JOIN public.subscription_method_states method ON method.subscription_id=s.id
      LEFT JOIN public.subscription_retry_obligations obligation ON obligation.subscription_id=s.id
      LEFT JOIN public.subscription_retry_recovery_authorizations recovery_auth ON recovery_auth.obligation_id=obligation.id
        AND recovery_auth.retry_attempt=obligation.retry_attempt AND recovery_auth.consumed_at IS NULL
      WHERE t.settlement_channel_key='sandbox' AND s.status='active'`)).rows;
    for (const row of rows) {
      const id = String(row.id);
      methods.set(id, { methodRef: String(row.method_ref), evidenceRef: String(row.evidence_ref),
        authorizationRef: String(row.authorization_ref), authorized: row.health_state === 'healthy' && row.unattended_charge_authorized_at != null });
      allowed.set(id, String(row.recovery_method ?? row.method_ref));
    }
  }
  const policy = { ...createSandboxRenewalPolicy('server-selected'),
    executionInput: (...args: Parameters<ReturnType<typeof createSandboxRenewalPolicy>['executionInput']>) =>
      createSandboxRenewalPolicy(method(args[1].cycleSnapshot.subscriptionId).methodRef).executionInput(...args),
  };
  const retry: Input['retry'] = {
    recoveredTemplate: input.recoveredTemplate,
    async readFrozenMandate(snapshot) {
      const current = await writer.readMethod(snapshot.subscriptionId);
      const saved = method(snapshot.subscriptionId);
      return { authorized: saved.authorized && current?.healthState === 'healthy',
        authorizationRef: saved.authorizationRef, paymentMethodRef: saved.methodRef };
    },
    retryInput(snapshot, row) {
      const methodRef = allowed.get(snapshot.subscriptionId);
      if (!methodRef) throw new Error('starter_renewal_method_unavailable');
      const due = { ...snapshot, cadenceDays: snapshot.templateSnapshot.cadenceDays, currency: snapshot.pricingSnapshot.currency,
        deliveryAdmission: 'allowed' as const, deliveryBlockReason: null };
      const base = createSandboxRenewalPolicy(methodRef).executionInput(due,
        { cycleSnapshot: snapshot, identityKey: row.identityKey, operationFingerprint: row.requestFingerprint } as RenewalReadback,
        { settlementIntentId: row.settlementIntentId, orderId: row.orderId });
      return { ...base, executionIdempotencyKey: `${row.identityKey}:retry:${row.retryAttempt}`,
        externalIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}` };
    },
    payments: {
      async execute(request) {
        const saved = (await executor.query(`SELECT op.cycle_snapshot FROM public.subscription_renewal_operations op
          JOIN public.commerce_settlement_intents intent ON intent.renewal_operation_id=op.id WHERE intent.id=$1::uuid`, [request.paymentIntentId])).rows[0];
        if (!saved) throw new Error('starter_renewal_operation_missing');
        const snapshot = codec.decode(saved.cycle_snapshot as Record<string, unknown>), current = method(snapshot.subscriptionId);
        const attempt = await simulator.beginAttempt({ settlementIntentId: request.paymentIntentId,
          idempotencyKey: request.executionIdempotencyKey, requestFingerprint: request.requestFingerprint,
          methodFacts: { authorizationRef: snapshot.authorizationRef, unattendedChargeAuthorizedAt: snapshot.unattendedChargeAuthorizedAt,
            payerAccountRef: snapshot.payerAccountRef, methodRef: request.paymentMethodRef!, methodEvidenceRef: current.evidenceRef }, at: now() });
        if (!attempt.replayed && config.sandbox.retry !== 'ambiguous') await simulator.recordObservation({ attemptId: attempt.id,
          idempotencyKey: `renewal-observation:${attempt.id}`, outcome: config.sandbox.retry === 'succeeded' ? 'captured' : 'refused', occurredAt: now() });
        return { status: 'pending', externalAttemptRef: attempt.id };
      },
      async readOutcome(prepared, snapshot) {
        const attempt = await simulator.readAttempt({ settlementIntentId: prepared.settlementIntentId });
        if (!attempt || attempt.requestKey !== prepared.request.idempotencyKey
          || attempt.requestFingerprint !== prepared.request.providerRequestFingerprint) throw new Error('starter_renewal_attempt_mismatch');
        const saved = await simulator.readAttempt({ settlementIntentId: prepared.settlementIntentId, attemptId: attempt.id });
        if (!saved) throw new Error('starter_renewal_attempt_missing');
        const event = saved.latestObservation;
        const operation = await store.readRenewal(prepared.identityKey);
        if (!operation) throw new Error('starter_renewal_operation_missing');
        return { status: event?.outcome === 'captured' ? 'succeeded' : event && ['refused', 'expired'].includes(event.outcome) ? 'failed' : 'unknown',
          disposition: !event || event.outcome === 'indeterminate' ? 'ambiguous' : 'observed',
          operationId: operation.operationId, eventKey: event ? `sandbox:${event.id}` : `awaiting:${attempt.id}`,
          requestFingerprint: prepared.operationFingerprint, verifiedEvidenceRef: event ? `sandbox:${event.id}` : '',
          externalAttemptRef: attempt.id, occurredAt: event?.occurredAt ?? null,
          observedAt: event?.recordedAt ?? now(), firstRecordedAt: event?.recordedAt ?? now(),
          amountMinor: snapshot.pricingSnapshot.totalAmountMinor, currency: snapshot.pricingSnapshot.currency,
          reason: event && event.outcome !== 'captured' ? `sandbox_${event.outcome}` : null,
          ...(event ? { sourceEvidence: { sourceKind: 'accepted_event' as const, sourceReference: event.id,
            observedStatus: event.outcome, observedAt: event.occurredAt, payloadFingerprint: event.fingerprint, attemptRef: attempt.id } } : {}),
        } satisfies Awaited<ReturnType<NativeRetryDriverOptions['payments']['readOutcome']>>;
      },
    },
  };
  return { refresh, policy, retry, paymentRails: { resolve: (key: string) => key === 'sandbox' ? rail : null } };
}
