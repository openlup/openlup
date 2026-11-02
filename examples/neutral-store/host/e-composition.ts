import { createHash } from 'node:crypto';
import { createOrderReviewHandlers, createPostgresOrderReviewLifecyclePort } from '@openlup/platform/commerce/server';
import { createPostgresPartnerAcquisitionPort, createPostgresAcquisitionEvidencePort } from '@openlup/platform/marketing/server/postgres';
import type { PartnersB2BInquirySubmitRequest } from '@openlup/platform/marketing/contracts';
import { isRecord } from '../shared/offer.ts';
import type { ActionBinding, ApplicationBindings } from './bindings.ts';

interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Call only after the selected installed catalogue and restricted roles are ready. */
export function composeExistingCapabilities(input: {
  executor: QueryExecutor;
  connectionString: string;
  authorizeResearchCase?: (customerRef: string, caseReference: string) => Promise<boolean>;
}): Pick<ApplicationBindings, 'actions' | 'close'> {
  const reviews = createOrderReviewHandlers(createPostgresOrderReviewLifecyclePort(input.executor));
  const partners = createPostgresPartnerAcquisitionPort({ connectionString: input.connectionString });
  const evidence = createPostgresAcquisitionEvidencePort({ connectionString: input.connectionString });
  const actions: ApplicationBindings['actions'] = {};

  actions['review.read'] = async payload => {
    if (typeof payload.grant !== 'string' || !payload.grant) return refused('access_grant_unavailable');
    const result = await reviews.read(payload.grant);
    return result.ok ? { ok: true, value: result.value } : refused(`order_review_${result.error.kind}`);
  };
  actions['review.submit'] = async payload => {
    if (typeof payload.grant !== 'string' || !payload.grant) return refused('access_grant_unavailable');
    const command = { grant: payload.grant, rating: payload.rating,
      ...(typeof payload.comment === 'string' && payload.comment ? { comment: payload.comment } : {}),
      fingerprint: createHash('sha256').update(JSON.stringify([payload.rating, payload.comment ?? null])).digest('hex') };
    const result = await reviews.submit(command);
    return result.ok ? { ok: true, value: result.value, ...(result.replayed ? { replayed: true } : {}) }
      : refused(`order_review_${result.error.kind}`);
  };
  actions['partners.submit'] = async (payload, context) => {
    const request = partnerRequest(payload);
    if (!request) return refused('starter_input_invalid');
    const result = await partners.submit({
      idempotencyKey: context.commandKey,
      requesterKey: createHash('sha256').update(request.email.toLowerCase()).digest('hex'),
      policyVersion: context.config.legal.revision, sourcePath: '/partners/b2b-inquiries',
      acceptedAt: new Date().toISOString(), request,
    });
    return result.ok ? { ok: true, value: result.value, ...(result.replayed ? { replayed: true } : {}) }
      : refused(`partner_acquisition_${result.error.kind}`);
  };
  actions['operator.partners'] = async (_payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    const result = await partners.list({ actorRef: context.actor.operatorRef, view: 'partner_acquisition_v1', limit: 30 });
    return result.ok ? { ok: true, value: result.value } : refused(`partner_acquisition_${result.error.kind}`);
  };
  actions['operator.partnerTransition'] = async (payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    if (typeof payload.id !== 'string' || typeof payload.expectedVersion !== 'number'
      || !Number.isSafeInteger(payload.expectedVersion) || !isPartnerStatus(payload.status)) return refused('starter_input_invalid');
    const result = await partners.transition({ actorRef: context.actor.operatorRef,
      idempotencyKey: context.commandKey,
      request: { id: payload.id, expectedVersion: payload.expectedVersion, status: payload.status } });
    return result.ok ? { ok: true, value: result.value } : refused(`partner_acquisition_${result.error.kind}`);
  };
  actions['research.submit'] = async (payload, context) => {
    // A case reference alone is not authority to attach evidence to another participant.
    if (!context.actor.customerRef) return refused('customer_session_required');
    if (typeof payload.caseReference !== 'string' || !isRecord(payload.responseData)
      || (payload.surveyType !== 'producer' && payload.surveyType !== 'consumer')) return refused('starter_input_invalid');
    // Ownership lookup is a separate required host binding, not inferred from a customer session.
    if (!input.authorizeResearchCase || !await input.authorizeResearchCase(context.actor.customerRef, payload.caseReference)) {
      return refused('starter_research_case_authority_unavailable');
    }
    const result = await evidence.submitSurvey({ view: 'acquisition_survey_v1',
      caseReference: payload.caseReference, surveyType: payload.surveyType,
      responseData: payload.responseData, idempotencyKey: context.commandKey });
    return result.ok ? { ok: true, value: result.value } : refused(`acquisition_evidence_${result.error.kind}`);
  };

  return { actions, close: async () => { await Promise.all([partners.close(), evidence.close()]); } };
}

function partnerRequest(payload: Record<string, unknown>): PartnersB2BInquirySubmitRequest | null {
  if (typeof payload.company !== 'string' || typeof payload.country !== 'string'
    || typeof payload.firstName !== 'string' || typeof payload.lastName !== 'string'
    || typeof payload.email !== 'string') return null;
  return { company: payload.company, country: payload.country,
    firstName: payload.firstName, lastName: payload.lastName, email: payload.email,
    phone: typeof payload.phone === 'string' ? payload.phone : null,
    notes: typeof payload.notes === 'string' ? payload.notes : null };
}

type PartnerStatus = Parameters<ReturnType<typeof createPostgresPartnerAcquisitionPort>['transition']>[0]['request']['status'];
function isPartnerStatus(value: unknown): value is PartnerStatus {
  return typeof value === 'string' && ['contacted', 'qualified', 'disqualified', 'closed_won', 'closed_lost'].includes(value);
}

function refused(code: string): Awaited<ReturnType<ActionBinding>> {
  return { ok: false, code };
}
