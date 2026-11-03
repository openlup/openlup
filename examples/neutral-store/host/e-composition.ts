import { createHash } from 'node:crypto';
import { createOrderReviewHandlers, createPostgresOrderReviewLifecyclePort,
  createOrderReviewAdminHandlers, createPostgresOrderReviewAdminReadPort } from '@openlup/platform/commerce/server';
import { createPostgresPartnerAcquisitionPort } from '@openlup/platform/marketing/server/postgres';
import type { PartnersB2BInquirySubmitRequest } from '@openlup/platform/marketing/contracts';
import type { ActionBinding, ApplicationBindings } from './bindings.ts';

interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Call only after the selected installed catalogue and restricted roles are ready. */
export function composeExistingCapabilities(input: {
  executor: QueryExecutor;
  connectionString: string;
}): Pick<ApplicationBindings, 'actions' | 'close'> {
  const lifecycle = createPostgresOrderReviewLifecyclePort(input.executor);
  const reviews = createOrderReviewHandlers(lifecycle);
  const admin = createOrderReviewAdminHandlers(lifecycle, createPostgresOrderReviewAdminReadPort(input.executor));
  const partners = createPostgresPartnerAcquisitionPort({ connectionString: input.connectionString });
  const actions: ApplicationBindings['actions'] = {};

  actions['review.read'] = async payload => {
    if (typeof payload.grant !== 'string' || !payload.grant) return refused('access_grant_unavailable');
    const result = await reviews.read(payload.grant);
    return result.ok ? { ok: true, value: result.value } : refused(`order_review_${result.error.kind}`);
  };
  actions['review.submit'] = async payload => {
    if (typeof payload.grant !== 'string' || !payload.grant) return refused('access_grant_unavailable');
    if (typeof payload.rating !== 'number' || !Number.isInteger(payload.rating)
      || payload.rating < 1 || payload.rating > 5
      || (payload.comment !== undefined && typeof payload.comment !== 'string')) return refused('starter_input_invalid');
    const comment = typeof payload.comment === 'string' ? payload.comment.trim() : '';
    const command = { grant: payload.grant, rating: payload.rating,
      ...(comment ? { comment } : {}),
      fingerprint: createHash('sha256').update(`${payload.rating}\n${comment}`).digest('hex') };
    const result = await reviews.submit(command);
    return result.ok ? { ok: true, value: result.value, ...(result.replayed ? { replayed: true } : {}) }
      : refused(`order_review_${result.error.kind}`);
  };
  actions['partners.submit'] = async (payload, context) => {
    const request = partnerRequest(payload);
    if (!request) return refused('starter_input_invalid');
    if (!context.actor.requesterKey) return refused('starter_requester_unavailable');
    const result = await partners.submit({
      idempotencyKey: context.commandKey,
      requesterKey: context.actor.requesterKey,
      policyVersion: context.config.legal.revision, sourcePath: '/partners/b2b-inquiries',
      acceptedAt: new Date().toISOString(), request,
    });
    return result.ok ? { ok: true, value: { caseRef: result.value.caseRef },
      ...(result.replayed ? { replayed: true } : {}) } : refused(`partner_acquisition_${result.error.kind}`);
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
  actions['operator.reviews'] = async (_payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    const result = await admin.list(context.actor.operatorRef, { limit: 30 });
    return result.ok ? { ok: true, value: result.value } : refused(`order_review_${result.error.kind}`);
  };
  actions['operator.reviewModerate'] = async (payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    const result = await admin.moderate(context.actor.operatorRef, {
      reviewRef: payload.reviewRef, action: payload.action, idempotencyKey: context.commandKey,
    });
    return result.ok ? { ok: true, value: result.value, ...(result.replayed ? { replayed: true } : {}) }
      : refused(`order_review_${result.error.kind}`);
  };
  // Acquisition requires a verified native address reference; research additionally
  // requires case ownership. Neither is inferred from a browser-supplied reference.
  return { actions, close: () => partners.close() };
}

function partnerRequest(payload: Record<string, unknown>): PartnersB2BInquirySubmitRequest | null {
  if (typeof payload.company !== 'string' || typeof payload.country !== 'string'
    || typeof payload.firstName !== 'string' || typeof payload.lastName !== 'string'
    || typeof payload.email !== 'string'
    || (payload.phone !== undefined && payload.phone !== null && typeof payload.phone !== 'string')
    || (payload.notes !== undefined && payload.notes !== null && typeof payload.notes !== 'string')) return null;
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
