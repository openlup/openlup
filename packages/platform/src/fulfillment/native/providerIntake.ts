import type { DispatchRecord, FulfillmentCapabilityDescriptor, FulfillmentObservation, FulfillmentObservationCodecs, FulfillmentObservationPagePort, FulfillmentObservationPort, FulfillmentSelection, FulfillmentRefusal } from '../contracts/index.js';
import type { PlatformJobInvocation, JobLeasePort } from '@openlup/core/platform-runtime';
import { isDeepStrictEqual } from 'node:util';
import { nativeCall, type PgExecutor } from '../postgresDispatchStore.js';
import { readFulfillmentCapabilities } from '../providerCapabilities.js';
import { verifyAndNormalizeFulfillmentObservation, type FulfillmentIngressResult } from '../verifiedIngress.js';
import { runFulfillmentReconciliationPage } from '../providerReconciliationWorker.js';
import { projectObservation } from '../observationProjection.js';
import { createPostgresFulfillmentShipmentCommandPort } from './shipmentCommands.js';

type Ingress = Parameters<typeof verifyAndNormalizeFulfillmentObservation>[0];
type Poll = Parameters<typeof runFulfillmentReconciliationPage>[0];
type Evidence = Parameters<Poll['lifecycle']['findDispatchRef']>[0];
type Ref = NonNullable<Awaited<ReturnType<Poll['lifecycle']['findDispatchRef']>>>;
interface State { status: string | null; latestOccurredAt: string | null; handedOverAt: string | null; carrierRef: string | null; serviceRef: string | null }

export interface NativeFulfillmentProviderIntakeOptions {
  db: PgExecutor | null;
  enabled: boolean;
  selection: FulfillmentSelection;
  capability: FulfillmentCapabilityDescriptor;
  observation: FulfillmentObservationPort | null;
  pages: FulfillmentObservationPagePort | null;
  codecs: FulfillmentObservationCodecs & Poll['lifecycle']['trackingCodecs'];
  keys: Ingress['lifecycle']['keys'] & {
    acceptance(ref: string): { providerAttemptKey: string; labelKey: string };
    exception(ref: string, occurrence: string): string;
  };
  /** Adapter-owned outbound identity translation; SQL resolves recorded associations only. */
  orderIdentity?: {
    merchantOrderRef(orderNumber: string): string | null;
    outboundOrderNumber(order: { orderRef: string; orderNumber: string | null }): string | null;
  };
  accounting?: { issue(ref: string): Promise<void>; classify: Poll['lifecycle']['invoiceFailure'] };
}

export interface NativeFulfillmentReconciliationJob {
  ledger: JobLeasePort & { readLatestTerminalRunMetadata(jobName: string): Promise<Record<string, unknown> | null> };
  jobName: string;
  invocation: PlatformJobInvocation;
  pageSize: number;
}
type IntakeRefusal = { kind: 'refused'; refusal: FulfillmentRefusal };
export type NativeFulfillmentReconciliationResult = IntakeRefusal | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; status: 502; reason: 'reconciliation_checkpoint_read_failed' }
  | ({ kind: 'finished' } & Awaited<ReturnType<typeof runFulfillmentReconciliationPage>>);
export interface NativeFulfillmentProviderIntake {
  commands: ReturnType<typeof createPostgresFulfillmentShipmentCommandPort> | null;
  ingest(verification: Parameters<FulfillmentObservationPort['verifyAndNormalize']>[0]): Promise<FulfillmentIngressResult | IntakeRefusal>;
  reconcile(job: NativeFulfillmentReconciliationJob): Promise<NativeFulfillmentReconciliationResult>;
}

/** Each executor call must commit before resolving. Never pass a transaction spanning this composition's provider or accounting I/O. */
export function createPostgresFulfillmentProviderIntake(input: NativeFulfillmentProviderIntakeOptions): NativeFulfillmentProviderIntake {
  const { db } = input;
  const call = <T>(name: string, values: unknown[]) => nativeCall<T>(db!, name, values);
  const provider = input.capability.providerRef;
  const commands = db ? createPostgresFulfillmentShipmentCommandPort(db) : null;
  const gate = (kind: 'webhook' | 'polling') => {
    if (!input.enabled) return { kind: 'refused' as const, refusal: { reason: 'disabled' as const, phase: 'selection' as const, retryable: false } };
    const selected = readFulfillmentCapabilities([input.capability], input.selection);
    if (selected.kind === 'refused') return selected;
    if (!db || (kind === 'webhook' ? !input.observation : !input.pages)) return { kind: 'refused' as const, refusal: { reason: 'not_ready' as const, phase: 'selection' as const, retryable: false } };
    if (kind === 'webhook' && ((selected.descriptor.intakeMode ?? 'webhook') !== 'webhook' || !selected.descriptor.operations.verifyObservation.supported))
      return { kind: 'refused' as const, refusal: { reason: 'unsupported' as const, phase: 'verify' as const, retryable: false } };
    if (kind === 'polling' && !selected.descriptor.operations.readback.supported) return { kind: 'refused' as const, refusal: { reason: 'unsupported' as const, phase: 'readback' as const, retryable: false } };
    return null;
  };
  const readState = (ref: string) => call<State | null>('fulfillment_intake_read_state', [ref]);
  const read = async (evidence: Evidence) => {
    if ('fact' in evidence && evidence.fact.providerKind !== provider) throw new Error('fulfillment_observation_provider_mismatch');
    const record = await call<(DispatchRecord & { orderNumber: string | null; matchedBy: 'provider' | 'native' | 'merchant'; acceptance?: Parameters<import('../contracts/index.js').FulfillmentStorePort['acknowledge']>[0]['acceptance'] }) | null>(
      'fulfillment_intake_find_dispatch', [provider, { ...evidence.correlation,
        merchantOrderRef: evidence.correlation.orderNumber ? input.orderIdentity?.merchantOrderRef(evidence.correlation.orderNumber) ?? null : null }]);
    if (record && evidence.correlation.orderNumber !== null) {
      const expected = input.orderIdentity ? input.orderIdentity.outboundOrderNumber(record) : record.orderNumber;
      if (expected === null || evidence.correlation.orderNumber !== expected) throw new Error('fulfillment_observation_correlation_conflict');
    }
    return record;
  };
  const findDispatchRef = async (evidence: Evidence): Promise<Ref | null> => {
    const record = await read(evidence);
    return record ? { orderRef: record.orderRef, fulfillmentRef: record.fulfillmentRef, dispatchRef: record.dispatchRef, externalRef: record.externalRef } : null;
  };
  const acknowledgeDispatchAcceptance = async (ref: Ref, evidence: Evidence) => {
    const record = await read(evidence);
    if (!record || record.dispatchRef !== ref.dispatchRef || record.fulfillmentRef !== ref.fulfillmentRef || record.orderRef !== ref.orderRef)
      throw new Error('fulfillment_observation_dispatch_changed');
    const externalRef = evidence.correlation.externalRef ?? record.externalRef;
    if (!externalRef?.trim()) throw new Error('fulfillment_observation_external_ref_required');
    const keys = input.keys.acceptance(ref.fulfillmentRef);
    if (!keys.providerAttemptKey.trim() || !keys.labelKey.trim() || keys.providerAttemptKey === keys.labelKey) throw new Error('fulfillment_observation_acceptance_keys_invalid');
    const acceptance = record.acceptance ?? { kind: 'accepted' as const, externalRef, evidence: record.evidence, ...keys };
    if (acceptance.externalRef !== externalRef || acceptance.providerAttemptKey !== keys.providerAttemptKey || acceptance.labelKey !== keys.labelKey)
      throw new Error('fulfillment_observation_acceptance_conflict');
    const result = await call<{ acknowledged: boolean; record: DispatchRecord }>('fulfillment_dispatch_finish', [record.dispatchRef, acceptance, true,
      input.capability.intakeMode === 'polling' ? 'poll' : 'push']);
    if (!result.acknowledged || result.record.dispatchRef !== ref.dispatchRef || result.record.status !== 'created' || result.record.externalRef !== externalRef)
      throw new Error('fulfillment_observation_acknowledgement_invalid');
  };
  const recordProviderException = (ref: Ref, observation: FulfillmentObservation) => {
    if (!observation.intake) throw new Error('observation_evidence_not_recorded');
    return call<{ replayed: boolean }>('fulfillment_intake_record_exception', [input.keys.exception(ref.fulfillmentRef, observation.intake.occurrenceKey), ref.fulfillmentRef, 'provider_exception', observation]);
  };
  const recordStatusEvidence = (ref: Ref, observation: FulfillmentObservation) => call<{ replayed: boolean }>('fulfillment_intake_record_status', [
    observation.eventKey, ref.dispatchRef, ref.fulfillmentRef, observation.fact.canonicalStatus, neutralObservation(observation),
  ]);
  const effects: Ingress['lifecycle']['effects'] = {
    async markProviderStockConsumed(request) {
      const result = await call<{ replayed: boolean }>('fulfillment_intake_consume_packed', [request.idempotencyKey, request.fulfillmentOrderId]);
      try { await call('fulfillment_intake_close_recovered_picked', [request.fulfillmentOrderId]); } catch { /* Receipt bookkeeping never blocks physical effects. */ }
      return result;
    },
    markHandedOver: request => call('fulfillment_operator_hand_off', [request.idempotencyKey, request.fulfillmentOrderId, null, { suppressShipmentDispatched: request.suppressDispatched }]),
    async recordTrackingReference(request) {
      const reference = await call<{ readBack: boolean }>('fulfillment_intake_record_tracking', [request.idempotencyKey, request.fulfillmentOrderId, {
        providerRef: provider, trackingNumber: request.trackingNumber, carrierKind: request.carrierKind, service: request.service, trackingUrl: request.trackingUrl,
      }]);
      // Preserve the independent reference write/readback before the existing command transaction.
      const tracking = await call<{ replayed: boolean }>('fulfillment_operator_record_tracking', [request.idempotencyKey, request.fulfillmentOrderId, {
        status: request.status, providerTrackingId: request.trackingNumber, rawEvent: { occurredAt: request.observation.intake?.occurredAt ?? null },
      }, null]);
      return { replayed: tracking.replayed, readBack: reference.readBack };
    },
  };
  const stateConflict: Poll['lifecycle']['classifyStateConflict'] = error => {
    const message = (error as { message?: string })?.message;
    return message === 'commerce_fulfillment_not_found' ? 'fulfillment_not_found'
      : message === 'commerce_fulfillment_stock_consumed_requires_label' ? 'stock_consumed_requires_label' : null;
  };
  const supersededCause = (error: unknown) => (error as { message?: string })?.message?.includes('tracking_after_delivered_forbidden')
    ? 'tracking_after_delivered_forbidden' : null;
  const classifyFailure: Ingress['lifecycle']['classifyFailure'] = error => (error as { code?: string })?.code === '55P03' ? 'stock_contention'
    : supersededCause(error) ? 'state_conflict' : 'other';
  const poll: Omit<Poll, 'provider' | 'checkpoint' | 'pageSize'> = {
    localPersistence: {
      readLocalFulfillmentStatus: async ref => (await readState(ref))?.status ?? null,
      latestStatusOccurredAt: async ref => (await readState(ref))?.latestOccurredAt ?? null,
      readHandedOverAt: async ref => (await readState(ref))?.handedOverAt ?? null,
    },
    lifecycle: {
      findDispatchRef, acknowledgeDispatchAcceptance, recordStatusEvidence, effects, keys: input.keys,
      recordProviderException,
      recordQuarantine: (evidence, reason) => call('fulfillment_intake_quarantine', [evidence?.eventKey ?? 'unknown', evidence, reason]),
      readDeliveryCarrier: async ref => { const state = await readState(ref); return state ? { carrierRef: state.carrierRef, serviceRef: state.serviceRef } : null; },
      trackingCodecs: input.codecs,
      ...(input.accounting ? { issueAccountingInvoice: input.accounting.issue } : {}),
      invoiceFailure: input.accounting?.classify ?? (() => ({ permanent: false, identifier: null, sqlstate: null, benign: false })),
      classifyStateConflict: stateConflict,
    },
  };
  return {
    /** Existing operator factories retain their own command transactions and refusals. */
    commands: commands as ReturnType<typeof createPostgresFulfillmentShipmentCommandPort> | null,
    async ingest(verification: Parameters<FulfillmentObservationPort['verifyAndNormalize']>[0]) {
      const refusal = gate('webhook');
      if (refusal) return refusal;
      return verifyAndNormalizeFulfillmentObservation({
        enabled: true, provider: input.observation!, verification, approveTrackingUrl: input.codecs.approveTrackingUrl, observationCodecs: input.codecs,
        localPersistence: {
          async recordObservation(observation) {
            const receipt = await call<{ replayed: boolean; receiptId: string; observation: FulfillmentObservation }>(
              'fulfillment_intake_record_observation', [observation.eventKey, null, neutralObservation(observation), observation.firstReceivedAt]);
            try {
              // Validate a retained version without rewriting its admitted snapshot.
              if (!receipt.observation.intake || !isDeepStrictEqual(receipt.observation,
                projectObservation(receipt.observation, input.codecs.approveTrackingUrl, input.codecs))) throw new Error('unsupported_retained_envelope');
            } catch { throw new Error('observation_evidence_not_recorded'); }
            return receipt;
          },
          markProcessed: (key, outcome) => call('fulfillment_mark_observation_processed', [key, outcome]),
        },
        lifecycle: {
          findDispatchRef, acknowledgeDispatchAcceptance,
          async recordStatusEvidence(ref, observation) {
            const status = await recordStatusEvidence(ref, observation);
            if (observation.fact.canonicalStatus === 'exception') await recordProviderException(ref, observation);
            return status;
          },
          effects, keys: input.keys, classifyFailure, supersededCause,
          annotateStockContention: (key, ref) => call('fulfillment_intake_annotate_stock_contention', [key, ref]),
          ...(input.accounting ? { issueAccountingInvoice: async (ref: string) => { try { await input.accounting!.issue(ref); } catch { /* Webhook accounting is fail-soft after committed physical effects. */ } } } : {}),
        },
      });
    },
    /** No schedule is installed. Lease and checkpoint belong to the existing durable job ledger. */
    async reconcile(job: NativeFulfillmentReconciliationJob) {
      const refusal = gate('polling');
      if (refusal) return refusal;
      if (!Number.isSafeInteger(job.pageSize) || job.pageSize <= 0) throw new Error('reconciliation_page_size_invalid');
      const claim = await job.ledger.claimJobRun(job.jobName, job.invocation);
      if (!claim.acquired || !claim.runId) return { kind: 'skipped' as const, reason: claim.reason };
      let checkpoint: unknown;
      try { checkpoint = await job.ledger.readLatestTerminalRunMetadata(job.jobName); }
      catch {
        await job.ledger.finishJobRun(job.jobName, claim.runId, job.invocation, 'failed', { checked: 0, updated: 0, failures: 1, skipped: false, reason: 'reconciliation_checkpoint_read_failed' });
        return { kind: 'failed' as const, status: 502 as const, reason: 'reconciliation_checkpoint_read_failed' };
      }
      const page = await runFulfillmentReconciliationPage({ ...poll, provider: input.pages!, checkpoint, pageSize: job.pageSize });
      // This host follows the donor's zero-scan reset. The generic page helper retains its own contract.
      if (!page.result.ok && page.result.checked === 0) page.metadata.reconciliationPagination.nextPage = 0;
      const released = await job.ledger.finishJobRun(job.jobName, claim.runId, job.invocation, page.result.ok ? 'success' : 'failed', page.result, { ...page.result, ...page.metadata });
      if (!released) throw new Error('reconciliation_job_lease_lost');
      return { kind: 'finished' as const, ...page };
    },
  };
}

function neutralObservation(observation: FulfillmentObservation): FulfillmentObservation {
  const { providerStatus: _privateStatus, ...neutral } = observation;
  return neutral;
}
