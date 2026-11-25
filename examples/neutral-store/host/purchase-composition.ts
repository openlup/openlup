import { isConfiguredLocale } from '../shared/locales.ts';
import { mintSandboxContinuation } from './checkout-recovery.ts';
import { isInitialCheckoutOrder, sameUuid } from './recurring-fence.ts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { setTimeout } from 'node:timers/promises';
import type { PostgresContactClientRegistrar } from '@openlup/platform/identity';
import { createPostgresCheckoutRateLimit, createCheckoutAttemptBindings, admitCheckoutAttempt, admitCheckoutReplay, type CheckoutRateLimit } from './checkout-attempts.ts';
import { installedAcquisitionPredecessors, createInitialPurchaseActivation, createAcquisitionRenewalBinding, type AcquisitionPredecessors, type AcquisitionRenewalBinding } from './acquisition-predecessors.ts';
import { createNativeQuoteService, governedCheckoutRefusal, quoteFailure } from './quote-composition.ts';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createPostgresNativeCheckoutHostPort } from '@openlup/platform/commerce/server/native-checkout';
import { createPostgresNativeCheckoutSubscriptionPort } from '@openlup/platform/subscriptions';
import { createPostgresPurchaseReservationPort, createPostgresAbandonedCheckoutCompensationPort } from '@openlup/platform/inventory';
import { createPostgresFulfillmentStockSyncPort, FulfillmentStockReplayConflictError } from '@openlup/platform/fulfillment';
import { createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { ACQUISITION_TERMS_CAPABILITY, type CreateQuoteResponse } from '@openlup/platform/pricing';
import type { ApplicationBindings, ActionContext } from './bindings.ts';
import { checkoutOfferContext, parseCart, isRecord } from '../shared/offer.ts';
import { catalogAdmissionRefusal, generateCheckoutRecoveryToken } from '@openlup/platform/commerce/server';
import { readCheckoutGuidance } from './checkout-recovery.ts';
import type { PurchaseRecovery } from './checkout-recovery.ts';
import { canonicalCatalogDraftJson } from '@openlup/platform/catalog';
import { checkoutLateCreateMs } from '../shared/api.ts';

const refused = (code: string) => code === governedCheckoutRefusal.code ? governedCheckoutRefusal : { ok: false as const, code };
const success = (value: unknown) => ({ ok: true as const, value });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
/** Only a version 4 UUID key has a continuation; other released key formats keep their earlier answers. */
const continuable = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const only = (payload: Record<string, unknown>, fields: string[]) => Object.keys(payload).every(key => key === 'locale' || fields.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;
const command = (context: ActionContext, operation: string) => `${operation}:${hash([context.actor.principalRef, context.commandKey])}`;
const source = (context: ActionContext) => `starter-demo:${context.config.id}`;
const present = (order: { id: string; status: string; total_amount_minor: number | string; currency_code: string }) => ({ orderRef: order.id, status: order.status,
  total: { amountMinor: Number(order.total_amount_minor), currency: order.currency_code } });

const checkoutLane = 'starter-checkout';
/** Creation tails run after the key lock is released. An incomplete order younger than
 * this may still be creating, so abandon waits for it to stall. A code constant. */
export const checkoutIncompleteAbandonMs = 60_000;
const checkoutDigest = (document: unknown) => createHash('sha256').update(canonicalCatalogDraftJson(document), 'utf8').digest('hex');
/** A repeat passes the acceptance digest stored with the first order; a fresh create hashes the presented one. */
function originalSubmit(payload: Record<string, unknown>, context: ActionContext, clientId: string, key: string, email: string,
  acceptanceTokenDigest?: string | null) {
  const { quoteAcceptance, ...selection } = payload;
  const scope = {
    schemaVersion: 1, ownerNamespace: source(context), clientId, lane: checkoutLane, requestKey: key,
    ...(context.actor.principalRef ? { actorRef: context.actor.principalRef } : {}),
    acceptanceTokenDigest: acceptanceTokenDigest !== undefined ? acceptanceTokenDigest
      : typeof quoteAcceptance === 'string' ? checkoutDigest(quoteAcceptance) : null,
  };
  return { ...scope, submitDigest: checkoutDigest(['catalog.checkout-submit.v1', scope, { ...selection, email }]) };
}

async function readOwnedDraft(db: PoolClient, key: string, clientId: string | null, email: string) {
  return (await db.query<{
    id: string; client_id: string; status: string; total_amount_minor: number; currency_code: string;
    owned: boolean; snapshot: CreateQuoteResponse; completed: boolean; submit: unknown; fingerprint: string;
  }>(`SELECT o.id,o.client_id,o.status,o.total_amount_minor,o.currency_code,
    ($2::uuid IS NOT NULL AND c.id=$2 OR $2::uuid IS NULL AND lower(btrim(c.email))=$3) AS owned,
    o.metadata->'quoteSnapshot' AS snapshot,o.metadata->'catalogAdmissionSubmit' AS submit,r.request_fingerprint AS fingerprint,
    EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id AND i.channel_key='sandbox') AS completed
    FROM public.commerce_order_draft_receipts r JOIN public.commerce_orders o ON o.id=r.order_id
    LEFT JOIN public.clients c ON c.id=o.client_id WHERE r.idempotency_key=$1`, [key, clientId, email])).rows[0];
}

function legacyReviewEvidence(snapshot: CreateQuoteResponse) {
  const context = snapshot.quote.context as Record<string, unknown> | undefined;
  const priceFacts = snapshot.quote.lines.map(line => {
    if (!line.catalogFacts) return { sku: line.sku };
    const { atTime: _time, ...facts } = line.catalogFacts;
    return facts;
  });
  return { identityComparison: 'unavailable',
    priceEvidenceRef: `price.v1:${checkoutDigest(['price.v1', priceFacts])}`,
    policyEvidenceRef: `policy.v1:${checkoutDigest(['policy.v1', context?.pricingPolicy ?? { applicability: 'not_applicable' }])}` };
}

/** Existing request admission precedes each action; ownership is derived here. */
export function composePurchaseCapabilities(db: Pool, contacts: PostgresContactClientRegistrar, checkRateLimit: CheckoutRateLimit | undefined, recovery: PurchaseRecovery, quoteOptions: { predecessors?: AcquisitionPredecessors; keyring?: PromotionAcceptanceKeyring; renewal?: AcquisitionRenewalBinding; bindContact?(session: PoolClient): PostgresContactClientRegistrar } = {}): ApplicationBindings['actions'] {
  let attemptBindings: ReturnType<typeof createCheckoutAttemptBindings> | undefined;
  const predecessors = quoteOptions.predecessors ?? installedAcquisitionPredecessors();
  const renewal = quoteOptions.renewal ?? createAcquisitionRenewalBinding(db);
  const activation = createInitialPurchaseActivation(db, renewal);
  const quotes = createNativeQuoteService(db, predecessors, quoteOptions.keyring);
  const destinations = createPostgresDestinationPort(db);
  const checkoutHost = createPostgresNativeCheckoutHostPort(db);
  const subscriptionHost = createPostgresNativeCheckoutSubscriptionPort(db);
  const reservations = createPostgresPurchaseReservationPort(db);
  const compensation = createPostgresAbandonedCheckoutCompensationPort(db);
  const readOrder = async (id: unknown) => {
    if (!uuid(id)) return null;
    return checkoutHost.readOrder(id);
  };
  const token = (value: unknown): value is string => typeof value === 'string' && /^rcv_(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/.test(value);
  const requester = (context: ActionContext) => ({ headers: {}, ...(context.actor.requesterKey ? { requesterKey: context.actor.requesterKey } : {}) });
  /** Every repeat under an existing key is metered in the repeat bucket before it has any effect. */
  const admitRepeat = (session: PoolClient, context: ActionContext, key: string) => admitCheckoutReplay(
    checkRateLimit ?? createPostgresCheckoutRateLimit(session, context.config.purchase.attemptLimits), requester(context), key);
  /** A further continuation link for an unpaid order. Earlier links stay valid; no mail is sent. */
  async function continuationToken(executor: Pick<PoolClient, 'query'>, orderId: string):
    Promise<{ token: string; refusal?: undefined } | { token?: undefined; refusal: ReturnType<typeof refused> }> {
    try {
      const rawToken = generateCheckoutRecoveryToken();
      await recovery.tokens.issue({ orderId, rawToken, expiresAt: '' });
      return { token: rawToken };
    } catch {
      const { rows: [order] } = await executor.query<{ status: string; elapsed: boolean }>(`SELECT status,
        created_at + interval '24 hours' <= clock_timestamp() AS elapsed FROM public.commerce_orders WHERE id=$1`, [orderId]);
      return { refusal: refused(order?.status !== 'pending_payment' ? 'starter_checkout_not_payable'
        : order.elapsed ? 'starter_checkout_expired' : 'starter_purchase_unavailable') };
    }
  }
  const authorizedOrder = async (payload: Record<string, unknown>, context: ActionContext) => {
    if (context.actor.customerRef) {
      let orderId = payload.orderRef;
      if (payload.token !== undefined) {
        if (!token(payload.token)) return null;
        const verified = await recovery.tokens.validate(payload.token);
        if (!verified || (payload.orderRef !== undefined && !sameUuid(payload.orderRef, verified.orderId))
          || !await isInitialCheckoutOrder(db, verified.orderId)) return null;
        orderId = verified.orderId;
      }
      const order = await readOrder(orderId);
      return order && sameUuid(order.client_id, context.actor.customerRef)
        && await isInitialCheckoutOrder(db, order.id) ? order : null;
    }
    if (!token(payload.token)) return null;
    const verified = await recovery.tokens.validate(payload.token);
    if (!verified || (payload.orderRef !== undefined
      && (!uuid(payload.orderRef) || !sameUuid(payload.orderRef, verified.orderId)))) return null;
    const order = await readOrder(verified.orderId);
    return order?.status === 'pending_payment' && sameUuid(order.client_id, verified.clientId)
      && await isInitialCheckoutOrder(db, order.id) ? order : null;
  };
  const address = (payload: Record<string, unknown>, country: string) => ({
    recipientName: `${payload.firstName} ${payload.lastName}`, line1: String(payload.line1),
    ...(payload.line2 ? { line2: String(payload.line2) } : {}), city: String(payload.city),
    postalCode: String(payload.postalCode), country, contactPhone: String(payload.phone),
  });
  const actions: ApplicationBindings['actions'] = {};
  actions['offer.validate'] = async (payload, context) => {
    try { return success(quotes.public(await quotes.quote(payload, context))); }
    catch (error) { return refused(quoteFailure(error)); }
  };
  actions['checkout.create'] = async (payload, context) => {
    const started = performance.now();
    const received = context.receivedAt ?? started;
    let draftSession: PoolClient | undefined;
    let key: string | undefined;
    let draftTransaction = false;
    async function releaseDraftSession() {
      const session = draftSession;
      draftSession = undefined;
      if (!session) return;
      try {
        if (draftTransaction) await session.query('ROLLBACK');
        if (key) await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
        session.release();
      } catch { session.release(true); }
    }
    try {
    if (!only(payload, ['email', 'cart', 'configuration', 'country', 'termsRevision', 'termsAccepted', 'firstName', 'lastName', 'phone', 'line1', 'line2', 'city', 'postalCode', 'acquisitionCapability', 'quoteAcceptance', 'expectedTotal', 'promoCodes'])
      || !['firstName', 'lastName', 'phone', 'line1', 'city', 'postalCode'].every(key => text(payload[key], key === 'postalCode' ? context.config.purchase.inputLimits.postalCode
        : key === 'phone' ? context.config.purchase.inputLimits.phone
          : ['firstName', 'lastName'].includes(key) ? context.config.purchase.inputLimits.name : context.config.purchase.inputLimits.text))
      || (payload.line2 !== undefined && (typeof payload.line2 !== 'string' || payload.line2.length > context.config.purchase.inputLimits.text))
      || payload.configuration !== context.config.id || typeof payload.country !== 'string' || !/^[A-Z]{2}$/.test(payload.country)) return refused('starter_input_invalid');
    const offer = parseCart(context.config.id, payload.cart);
    if (!offer.ok) return refused(offer.issues[0]!.code);
    if (!isConfiguredLocale(payload.locale, context.config.market)) return refused('starter_input_invalid');
    const email = context.actor.customerRef
      ? await checkoutHost.readClientEmail({ clientId: context.actor.customerRef, principalId: context.actor.principalRef! })
      : typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!text(email, context.config.purchase.inputLimits.email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return refused('starter_email_invalid');
    key = command(context, 'checkout');
    draftSession = await db.connect();
    await draftSession.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    const boundQuotes = createNativeQuoteService(draftSession, predecessors, quoteOptions.keyring);
    const priorOrder = await readOwnedDraft(draftSession, key, context.actor.customerRef, email);
    // A late fresh create could otherwise follow a caller that has already moved on.
    if (!priorOrder && performance.now() - received > checkoutLateCreateMs) return refused('starter_checkout_request_stale');
    const heldSession = draftSession, heldKey = key;
    // A changed payload under a continuable key is metered, never applied, and named by the order's state.
    const changed = async (order: { status: string }) => !await admitRepeat(heldSession, context, heldKey)
      ? refused('starter_attempt_limited') : refused(order.status === 'pending_payment' ? 'starter_checkout_changed'
        : order.status === 'paid' ? 'starter_checkout_paid' : 'starter_checkout_not_payable');
    if (priorOrder && !priorOrder.owned) {
      if (continuable(context.commandKey)) return await changed(priorOrder);
      return refused(attemptBindings?.conflicts(context.commandKey, email, context.actor.requesterKey)
        ? 'starter_attempt_limited' : 'starter_command_conflict');
    }
    const prior = priorOrder?.snapshot;
    const offerContext = checkoutOfferContext(offer.cart.mode);
    let observed;
    try {
      if (priorOrder) {
        // Historical drafts carry the original starter request binding and the
        // native fingerprint. A stamped draft requires its exact submit digest.
        if (!prior) return refused('starter_command_conflict');
        if (priorOrder.submit === null) {
          if (payload.termsAccepted !== true || (offer.cart.mode === 'subscription'
            && payload.acquisitionCapability !== undefined && payload.acquisitionCapability !== ACQUISITION_TERMS_CAPABILITY)) {
            return refused('starter_command_conflict');
          }
          observed = await boundQuotes.quote(payload, context, prior);
        }
        // A repeat admits nothing and never re-prices, so the stored acceptance stands for the same terms.
        // A different acceptance counts as the same intent only if it verifies against the stored snapshot.
        let acceptanceDigest: string | null | undefined;
        const stored = isRecord(priorOrder.submit) ? priorOrder.submit : undefined;
        if (stored && (typeof stored.acceptanceTokenDigest === 'string' || stored.acceptanceTokenDigest === null)) {
          acceptanceDigest = stored.acceptanceTokenDigest;
          const presented = typeof payload.quoteAcceptance === 'string' ? checkoutDigest(payload.quoteAcceptance) : null;
          if (presented !== acceptanceDigest) {
            try { boundQuotes.verify(await boundQuotes.quote(payload, context, prior), payload); }
            catch { acceptanceDigest = presented; }
          }
        }
        const { submitDigest } = originalSubmit(payload, context, priorOrder.client_id, key, email, acceptanceDigest);
        if (stored && continuable(context.commandKey) && submitDigest !== stored.submitDigest) return await changed(priorOrder);
        await draftSession.query('SELECT public.catalog_admission_replay_order_draft($1,$2,$3,$4)',
          [key, priorOrder.client_id, checkoutLane, priorOrder.submit === null ? priorOrder.fingerprint : submitDigest]);
      } else {
        const { rows } = await draftSession.query(`SELECT public.catalog_admission_requires_quote_authority($1::text[],
          coalesce($2::jsonb#>>'{offerVersion,version}',$2::jsonb->>'offerVersion')) AS governed`,
          [offer.cart.lines.map(line => line.sku), JSON.stringify(offerContext)]);
        if (rows[0]?.governed) return governedCheckoutRefusal;
        if (offer.cart.mode === 'subscription' && payload.acquisitionCapability !== ACQUISITION_TERMS_CAPABILITY) return refused('acquisition_terms_capability_required');
        if (payload.termsAccepted !== true) return refused('starter_terms_required');
      }
      // The intent is opened after destination, stock hold and provisional activation.
      // Only a completed checkout can bypass resuming those installation-bound steps.
      if (prior && priorOrder?.completed === true) {
        const admitted = await admitRepeat(draftSession, context, key);
        if (!['pending_payment','paid'].includes(priorOrder.status) || !await isInitialCheckoutOrder(draftSession,priorOrder.id)) return refused('starter_checkout_not_payable');
        // A limited repeat still learns that its order exists, without a new link.
        if (!admitted || priorOrder.status !== 'pending_payment') return { ...success(present(priorOrder)),replayed: true };
        const issued = await continuationToken(draftSession, priorOrder.id);
        return issued.refusal ?? { ...success({ ...present(priorOrder), token: issued.token }), replayed: true };
      }
      observed ??= await boundQuotes.quote(payload, context, prior, undefined, offerContext);
      if (!prior && payload.termsRevision !== context.config.legal.revision) return refused('starter_terms_required');
      if (!prior && payload.country !== context.config.market.country) return refused('starter_input_invalid');
      if (!prior) boundQuotes.verify(observed, payload);
      if (observed.terms) renewal.assertAvailable(observed.snapshot);
    } catch (error) {
      const reason = catalogAdmissionRefusal(error);
      if (reason) return refused(reason);
      // Under a continuable key an invalidated draft is a closed order, as for checkout.continuation.
      if (error instanceof Error && error.message === 'commerce_order_draft_expired') {
        return refused(continuable(context.commandKey) ? 'starter_checkout_not_payable' : error.message);
      }
      if (isRecord(error) && (error.code === '23505' || error.message === 'starter_command_conflict')) return refused('starter_command_conflict');
      return refused(quoteFailure(error));
    }
    const attemptLimit = checkRateLimit ?? createPostgresCheckoutRateLimit(draftSession, context.config.purchase.attemptLimits);
    if (!await admitCheckoutAttempt(attemptLimit,
      { headers: {}, ...(context.actor.requesterKey ? { requesterKey: context.actor.requesterKey } : {}) },
      // The derived key: a replaced quota callback never receives the header value.
      { idempotencyKey: key, contact: { email } }, 0)) return refused('starter_attempt_limited');
    attemptBindings ??= createCheckoutAttemptBindings(context.config.purchase.attemptLimits);
    const attempt = attemptBindings.bind(context.commandKey, email, context.actor.requesterKey);
    if (!attempt) return refused('starter_attempt_limited');
    const session = draftSession;
    const authorizedClient = priorOrder?.client_id ?? context.actor.customerRef;
    if (!priorOrder && quoteOptions.bindContact) {
      await session.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      draftTransaction = true;
    }
    const registrar = quoteOptions.bindContact?.(session) ?? contacts;
    const contact = await (authorizedClient
      ? Promise.resolve({ ok: true as const, clientId: authorizedClient })
      : registrar.ensureContactClient({ email, ...context.config.purchase.contact,
        profileDefaults: { firstName: String(payload.firstName), lastName: String(payload.lastName),
          phone: String(payload.phone), country: context.config.market.country },
        // The derived key: the header value can address an unpaid order and is never stored.
        journey: { idempotencyKey: key, locale: payload.locale, mode: offer.cart.mode } }));
    if (!contact.ok) return refused('starter_purchase_unavailable');
    const quoteSnapshot = observed.snapshot;
    const quote = observed.projection;
    const shipping = address(payload, context.config.market.country);
    const submit = originalSubmit(payload, context, contact.clientId, key, email);
    // Keep the original purchase writer and attach private submit evidence
    // before its COMMIT on the session holding the request key.
    const drafts = predecessors.checkout({ async connect() {
      return { async query(statement, values) {
        if (statement === 'BEGIN ISOLATION LEVEL READ COMMITTED' && draftTransaction) return { rows: [] };
        if (statement === 'COMMIT') {
          await session.query('SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)',
            [key, contact.clientId, { ...submit, legacyReviewEvidence: legacyReviewEvidence(quoteSnapshot) }]);
        }
        return session.query(statement, values);
      }, release() {} };
    } }, { regionCode: context.config.market.country,
      financialPolicy: createAcquisitionFinancialPolicy(), isAcquisitionDiscount: discount => discount.promotionId === `demo-acquisition:${context.config.id}` });
    let created: { id: string; fresh: boolean } | null = null;
    let writingStock = false;
    try {
      const orderId = priorOrder?.id ?? (await drafts.createOrderDraft({ idempotencyKey: key, quoteSnapshot }, { clientId: contact.clientId })).orderDraft.orderId.slice(6);
      created = { id: orderId, fresh: !priorOrder };
      draftTransaction = false;
      await releaseDraftSession();
      const current = await readOrder(orderId);
      if (!current || !await isInitialCheckoutOrder(db, current.id) || !['pending_payment', 'paid'].includes(current.status)) return refused('starter_checkout_not_payable');
      // Replayed registration compares the original immutable address before returning it.
      await destinations.registerOrder({ idempotencyKey: `${key}:destination`, orderId, address: shipping, now: new Date().toISOString() });
      const stock = createPostgresFulfillmentStockSyncPort(db, { sourceKey: source(context), readLocalInventoryStock: async () => [] });
      writingStock = true;
      for (const line of quote.lines) await stock.recordProviderStockCurrent({ requestKey: `starter-stock:${line.sku}`, snapshot: {
        providerRef: context.config.purchase.stock.providerRef, collectedAt: context.config.purchase.stock.collectedAt, sourceRevision: null,
        revisionSource: 'collection', quantityKind: 'snapshot', skuRef: line.sku,
        totalQuantity: context.config.purchase.stock.quantities[line.sku]!, forSaleQuantity: context.config.purchase.stock.quantities[line.sku]!, reservedOrUnavailableQuantity: 0, syncRunId: context.config.purchase.stock.syncRunId,
      }, inventoryClass: 'sellable', lastSyncedAt: context.config.purchase.stock.collectedAt, staleAfter: context.config.purchase.stock.staleAfter });
      writingStock = false;
      const items = await checkoutHost.readOrderItems(orderId);
      await reservations.reserveOrderItems({ idempotencyKey: `${key}:hold`, orderId, stockSourceKey: source(context),
        items: items.map(item => ({ orderItemId: item.id, skuId: item.sku_id, quantity: item.quantity })),
        paymentStatus: 'created', expiresAt: new Date(new Date(current.created_at).getTime() + context.config.purchase.reservationMinutes * 60 * 1000).toISOString(), now: new Date().toISOString() });
      if (quote.mode === 'subscription') await subscriptionHost.declareProvisionalActivation({
        idempotencyKey: `${key}:declare`, orderId, cadenceDays: quote.cadenceDays!, now: new Date().toISOString() });
      await checkoutHost.openSettlementIntent({
        idempotencyKey: `${key}:intent`, orderId, channelKey: 'sandbox', amountMinor: quote.totalMinor, currency: quote.currency, now: new Date().toISOString() });
      let recoveryToken: string | undefined;
      if (created.fresh && current.status === 'pending_payment') {
        recoveryToken = generateCheckoutRecoveryToken();
        const tokenId = await recovery.tokens.issue({ orderId, rawToken: recoveryToken, expiresAt: '' });
        const expiresAt = recovery.tokens.readExpiry ? await recovery.tokens.readExpiry(tokenId) : null;
        if (!expiresAt) throw new Error('checkout_recovery_storage_failed');
        await recovery.deliver({ email, rawToken: recoveryToken, orderRef: orderId,
          expiresAt, context, locale: payload.locale });
      } else if (current.status === 'pending_payment') {
        // A repeat that completed an interrupted creation also gets a way to pay, never a mail.
        const issued = await continuationToken(db, orderId);
        if (issued.refusal) return issued.refusal;
        recoveryToken = issued.token;
      }
      return { ...success({ ...present(current), ...(recoveryToken ? { token: recoveryToken } : {}) }),
        replayed: !created.fresh };
    } catch (error) {
      // Creation has no payment dispatch. Never cancel the canonical order on a
      // changed-input replay, or any error carrying uncertain/in-flight dispatch.
      const reason = !writingStock && isRecord(error) ? error.reason ?? (isRecord(error.details) ? error.details.reason : undefined) : undefined;
      if (created?.fresh && reason !== 'provider_attempt_in_flight' && reason !== 'provider_dispatch_uncertain') {
        await compensation.cancelAbandonedOrder({ idempotencyKey: `${key}:compensate`, orderId: created.id,
          reason: ['journey_consumed', 'checkout_journey_consumed'].includes(String(reason)) ? 'checkout_journey_consumed' : 'checkout_failed_before_dispatch' });
      }
      if (writingStock) return refused(error instanceof FulfillmentStockReplayConflictError ? 'starter_command_conflict' : 'starter_purchase_unavailable');
      return failure(error);
    }
    } catch (error) { return refused(quoteFailure(error)); }
    finally {
      await releaseDraftSession();
      await setTimeout(Math.max(0, context.config.purchase.responseFloorMs - (performance.now() - started)));
    }
  };
  /** Continue or abandon the order under a checkout key without re-sending its details.
   * A guest is authorised by the key value alone; a signed-in key is derived from the principal. */
  actions['checkout.continuation'] = async (payload, context) => {
    const started = performance.now();
    let session: PoolClient | undefined;
    let locked = false;
    const key = command(context, 'checkout');
    try {
      if (!only(payload, ['action']) || (payload.action !== 'resume' && payload.action !== 'abandon')
        || !isConfiguredLocale(payload.locale, context.config.market) || !continuable(context.commandKey)) return refused('starter_input_invalid');
      // Every step runs on the session holding the key lock, so the answer agrees with a create holding it.
      session = await db.connect();
      await session.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      locked = true;
      return await continueCheckout(session, payload.action, key, context);
    } catch (error) { return failure(error); }
    finally {
      if (session) {
        try { if (locked) await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); session.release(); }
        catch { session.release(true); }
      }
      await setTimeout(Math.max(0, context.config.purchase.responseFloorMs - (performance.now() - started)));
    }
  };
  async function continueCheckout(session: PoolClient, action: 'resume' | 'abandon', key: string, context: ActionContext) {
    const order = await readOwnedDraft(session, key, context.actor.customerRef, '');
    // An unknown key is answered before metering: guessing a key needs no meter, fresh creates need the budget.
    if (!order || (context.actor.customerRef && !order.owned)) return action === 'resume' ? refused('starter_checkout_not_found') : success({ abandoned: false });
    const admitted = await admitRepeat(session, context, key);
    if (!admitted && action === 'abandon') return refused('starter_attempt_limited');
    try {
      await session.query('SELECT public.catalog_admission_replay_order_draft($1,$2,$3,$4)', [key, order.client_id, checkoutLane,
        isRecord(order.submit) && typeof order.submit.submitDigest === 'string' ? order.submit.submitDigest : order.fingerprint]);
    } catch (error) {
      // An invalidated draft receipt is a closed order for this operation.
      if (error instanceof Error && error.message === 'commerce_order_draft_expired') return refused('starter_checkout_not_payable');
      if (isRecord(error) && error.code === '23505') return refused('starter_command_conflict');
      throw error;
    }
    const initial = await isInitialCheckoutOrder(session, order.id);
    if (initial && order.status === 'paid') return action === 'resume' ? { ...success(present(order)), replayed: true } : refused('starter_checkout_paid');
    const payable = initial && order.status === 'pending_payment';
    if (action === 'resume') {
      if (!payable) return refused('starter_checkout_not_payable');
      if (!order.completed) return refused('starter_checkout_in_progress');
      if (!admitted) return { ...success(present(order)), replayed: true };
      const issued = await continuationToken(session, order.id);
      return issued.refusal ?? { ...success({ ...present(order), token: issued.token }), replayed: true };
    }
    if (!payable) return success({ abandoned: false, orderRef: order.id, status: order.status });
    if (!order.completed) {
      const { rows: [age] } = await session.query<{ young: boolean }>(`SELECT created_at + $2 * interval '1 millisecond' > clock_timestamp()
        AS young FROM public.commerce_orders WHERE id=$1`, [order.id, checkoutIncompleteAbandonMs]);
      if (age?.young !== false) return refused('starter_checkout_in_progress');
    }
    // The expiry sweep's predicate, through its runtime entry: no provider attempt ever and no external reference.
    const { rows: [safety] } = await session.query<{ safe: boolean }>('SELECT public.commerce_checkout_abandonment_safe_runtime($1::uuid) AS safe', [order.id]);
    // A refused predicate and a port that cancels nothing share one answer, read from the order's current state.
    let cancelled = false;
    if (safety?.safe === true) {
      try {
        // A stalled incomplete creation is cancelled too: a later tail cannot hold stock on a cancelled order.
        cancelled = (await createPostgresAbandonedCheckoutCompensationPort(session).cancelAbandonedOrder({
          idempotencyKey: `${key}:start-over`, orderId: order.id, reason: 'checkout_started_over' })).cancelled;
      } catch (error) {
        // The order's subscription link changed while it was being cancelled: nothing moved, so repeating is safe.
        if (isRecord(error) && error.code === '55000') return refused('starter_purchase_unavailable');
        if (!isRecord(error) || !['22023', '23505'].includes(String(error.code))) throw error;
      }
    }
    if (cancelled) return success({ abandoned: true, orderRef: order.id });
    const { rows: [current] } = await session.query<{ status: string }>('SELECT status FROM public.commerce_orders WHERE id=$1', [order.id]);
    return refused(current?.status === 'paid' ? 'starter_checkout_paid'
      : current?.status === 'pending_payment' ? 'starter_checkout_not_abandonable' : 'starter_checkout_not_payable');
  }
  actions['checkout.read'] = async (payload, context) => {
    if (!only(payload, ['orderRef', 'token'])) return refused('starter_input_invalid');
    if (context.actor.customerRef && payload.token === undefined) {
      const order = await authorizedOrder(payload, context);
      return order ? success(present(order)) : refused('starter_order_not_found');
    }
    if (!token(payload.token)) return refused('starter_recovery_unavailable');
    const inspected = await recovery.tokens.inspect(payload.token);
    if (!inspected || (payload.orderRef !== undefined
      && (!uuid(payload.orderRef) || !sameUuid(payload.orderRef, inspected.orderId)))) return refused('starter_recovery_unavailable');
    if (!await isInitialCheckoutOrder(db, inspected.orderId)) return refused('starter_recovery_unavailable');
    if (context.actor.customerRef && !sameUuid(inspected.clientId, context.actor.customerRef)) return refused('starter_order_not_found');
    if (inspected.tokenState === 'revoked') return refused('starter_recovery_unavailable');
    if (inspected.tokenState === 'expired') return refused('starter_recovery_expired');
    if (inspected.status === 'cancelled') return success({ status: 'cancelled', orderRef: inspected.orderId });
    if (inspected.tokenState === 'order_not_recoverable' && inspected.status === 'paid') return success({ status: 'paid', orderRef: inspected.orderId });
    if (inspected.status === 'expired' && inspected.tokenState !== 'revoked') return success({ status: 'expired', orderRef: inspected.orderId });
    if (inspected.tokenState !== 'active' || inspected.status !== 'pending_payment') return refused('starter_recovery_unavailable');
    const order = await authorizedOrder(payload, context);
    if (!order) return refused('starter_recovery_unavailable');
    const recoveryGuidance = await readCheckoutGuidance(db, recovery.tokens, payload.token, order);
    return success({ ...present(order), mode: inspected.mode, cadenceDays: inspected.cadenceDays,
      ...(recoveryGuidance ? { recoveryGuidance } : {}) });
  };
  actions['payment.simulate'] = async (payload, context) => {
    if (!only(payload, ['orderRef', 'token', 'outcome']) || !['captured', 'refused', 'expired', 'indeterminate'].includes(String(payload.outcome))) return refused('starter_input_invalid');
    const order = await authorizedOrder(payload, context);
    if (!order) return refused('starter_order_not_found');
    // Replacement payments belong exclusively to the recovery transition and its durable attempt receipt.
    if (order.recreated_from_order_id) return refused('starter_recovery_unavailable');
    const intent = await checkoutHost.readSettlementIntent({ orderId: order.id, channelKey: 'sandbox' });
    if (!intent) return refused('starter_sandbox_intent_unavailable');
    try {
      const key = command(context, 'payment');
      const storedQuote = order.metadata.quoteSnapshot as CreateQuoteResponse;
      if (payload.outcome === 'captured') activation.assertCaptureAvailable(storedQuote);
      const simulator = createPostgresSandboxPaymentSimulator(db, context.config.purchase.sandbox);
      const attempt = await simulator.beginAttempt({ settlementIntentId: intent.id, idempotencyKey: key,
        requestFingerprint: hash([order.id, payload.outcome]), at: new Date().toISOString() });
      mintSandboxContinuation(context,quoteOptions.keyring,{orderId:attempt.orderId,clientId:order.client_id,
        paymentIntentId:attempt.settlementIntentId,paymentAttemptId:attempt.id,replayed:attempt.replayed});
      const observation = await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: `${key}:observation`,
        outcome: payload.outcome as 'captured' | 'refused' | 'expired' | 'indeterminate', occurredAt: attempt.dispatchedAt });
      const accepted = await simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
        settlementIntentId: intent.id, attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: attempt.dispatchedAt });
      if (accepted.status !== 200) return refused('starter_sandbox_observation_refused');
      let renewalAttachment: string | undefined;
      if (payload.outcome === 'captured') {
        if (!await isInitialCheckoutOrder(db, order.id)) return refused('starter_order_not_found');
        renewalAttachment = await activation.activate({ editWindowHours: context.config.subscriptionCreation.editWindowHours, orderId: order.id, acceptedQuote: storedQuote,
          currency: order.currency_code, capturedReference: intent.external_ref ?? intent.id, methodFacts: attempt.methodFacts,
          stockSourceKey: source(context), templateId: `starter:${context.config.id}` });
      }
      const updated = await readOrder(order.id);
      return { ...success({ ...present(updated!), ...(renewalAttachment ? { renewalAttachment } : {}) }), replayed: attempt.replayed };
    } catch (error) { return failure(error); }
  };
  actions['subscription.address'] = async (payload, context) => {
    if (!context.actor.customerRef || !context.actor.principalRef) return refused('customer_session_required');
    if (!only(payload, ['subscriptionRef', 'recipientName', 'line1', 'line2', 'postalCode', 'city', 'phone', 'countryCode'])
      || !uuid(payload.subscriptionRef) || !['recipientName', 'line1', 'postalCode', 'city', 'phone'].every(key => text(payload[key], key === 'postalCode' ? context.config.purchase.inputLimits.postalCode
        : key === 'phone' ? context.config.purchase.inputLimits.phone : context.config.purchase.inputLimits.text))
      || (payload.line2 !== undefined && (typeof payload.line2 !== 'string' || payload.line2.length > context.config.purchase.inputLimits.text))
      || payload.countryCode !== context.config.market.country) return refused('starter_input_invalid');
    const templateVersion = await subscriptionHost.readTemplateVersion({ subscriptionId: payload.subscriptionRef, clientId: context.actor.customerRef });
    if (templateVersion === null) return refused('starter_subscription_not_found');
    const key = command(context, 'address');
    const priorVersion = await subscriptionHost.readCommandReceiptExpectedVersion({ actorId: context.actor.principalRef, idempotencyKey: key });
    try {
      const result = await destinations.changeShippingAddress({ actorId: context.actor.principalRef, clientId: context.actor.customerRef,
        subscriptionId: payload.subscriptionRef, idempotencyKey: key, expectedVersion: priorVersion ?? templateVersion,
        newAddress: { recipientName: String(payload.recipientName), line1: String(payload.line1), city: String(payload.city),
          postalCode: String(payload.postalCode), country: context.config.market.country, contactPhone: String(payload.phone),
          ...(payload.line2 ? { line2: String(payload.line2) } : {}) }, now: new Date().toISOString() });
      return 'refusalCode' in result ? refused(result.refusalCode) : success(result);
    } catch (error) { return failure(error); }
  };
  return actions;
}

function failure(error: unknown) {
  const admission = catalogAdmissionRefusal(error);
  if (admission) return refused(admission);
  if (error instanceof Error && error.message === 'starter_quote_refresh_required') return refused(error.message);
  if (isRecord(error)) {
    if (error.message === 'acquisition_terms_changed') return refused('starter_quote_refresh_required');
    if (error.name === 'AcquisitionTermsError' && typeof error.reason === 'string' && error.reason.startsWith('acquisition_terms_')) return refused(error.reason);
    if (error.code === '23505' || error.code === '40001' || (isRecord(error.details) && ['23505', '40001'].includes(String(error.details.code)))) return refused('starter_command_conflict');
    if (error.code === '22023' && typeof error.message === 'string' && /^(payment_simulator|commerce_destination|subscription_activation)_/.test(error.message)) return refused(error.message);
    if (error.name === 'CommerceOrderDraftPriceChangedError') return refused('starter_quote_price_changed');
    if (error.name === 'CommerceOrderDraftUnsupportedMoneyError') return refused(`starter_${String(error.reason)}`);
  }
  return refused('starter_purchase_unavailable');
}
