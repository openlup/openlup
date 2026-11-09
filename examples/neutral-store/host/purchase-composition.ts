import { isInitialCheckoutOrder, sameUuid } from './recurring-fence.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { setTimeout } from 'node:timers/promises';
import type { PostgresContactClientRegistrar } from '@openlup/platform/identity';
import { createInterimCheckoutLimiter, createCheckoutAttemptBindings, admitCheckoutAttempt, type CheckoutRateLimit } from './checkout-attempts.ts';
import { installedAcquisitionPredecessors, createAcquisitionRenewalBinding, type AcquisitionPredecessors, type AcquisitionRenewalBinding } from './acquisition-predecessors.ts';
import { createNativeQuoteService, quoteFailure } from './quote-composition.ts';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createPostgresPurchaseReservationPort, createPostgresAbandonedCheckoutCompensationPort } from '@openlup/platform/inventory';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { activateNativePurchaseWithRenewal } from '@openlup/platform/subscriptions';
import { ACQUISITION_TERMS_CAPABILITY, type CreateQuoteResponse } from '@openlup/platform/pricing';
import type { NativeRenewalPurchaseFacts } from '@openlup/platform/subscriptions';
import type { ApplicationBindings, ActionContext } from './bindings.ts';
import { validateCart, isRecord } from '../shared/offer.ts';
import { generateCheckoutRecoveryToken } from '@openlup/platform/commerce/server';
import type { PurchaseRecovery } from './checkout-recovery.ts';

const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const only = (payload: Record<string, unknown>, fields: string[]) => Object.keys(payload).every(key => key === 'locale' || fields.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;
const command = (context: ActionContext, operation: string) => `${operation}:${hash([context.actor.principalRef, context.commandKey])}`;
const source = (context: ActionContext) => `starter-demo:${context.config.id}`;
const present = (order: Record<string, unknown>) => ({ orderRef: order.id, status: order.status,
  total: { amountMinor: Number(order.total_amount_minor), currency: order.currency_code } });

/** Existing request admission precedes each action; ownership is derived here. */
export function composePurchaseCapabilities(db: Pool, contacts: PostgresContactClientRegistrar, checkRateLimit: CheckoutRateLimit | undefined, recovery: PurchaseRecovery, quoteOptions: { predecessors?: AcquisitionPredecessors; keyring?: PromotionAcceptanceKeyring; renewal?: AcquisitionRenewalBinding } = {}): ApplicationBindings['actions'] {
  let interimLimiter: ReturnType<typeof createInterimCheckoutLimiter> | undefined;
  let attemptBindings: ReturnType<typeof createCheckoutAttemptBindings> | undefined;
  const predecessors = quoteOptions.predecessors ?? installedAcquisitionPredecessors();
  const renewal = quoteOptions.renewal ?? createAcquisitionRenewalBinding(db);
  const quotes = createNativeQuoteService(db, predecessors, quoteOptions.keyring);
  const destinations = createPostgresDestinationPort(db);
  const reservations = createPostgresPurchaseReservationPort(db);
  const compensation = createPostgresAbandonedCheckoutCompensationPort(db);
  const readOrder = async (id: unknown) => {
    if (!uuid(id)) return null;
    return (await db.query(`SELECT id,client_id,status,total_amount_minor,currency_code,metadata,created_at
      FROM public.commerce_orders WHERE id=$1`, [id])).rows[0] ?? null;
  };
  const token = (value: unknown): value is string => typeof value === 'string' && /^rcv_[A-Za-z0-9_-]{43}$/.test(value);
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
    try {
    if (!only(payload, ['email', 'cart', 'configuration', 'country', 'termsRevision', 'termsAccepted', 'firstName', 'lastName', 'phone', 'line1', 'line2', 'city', 'postalCode', 'acquisitionCapability', 'quoteAcceptance', 'expectedTotal', 'promoCodes'])
      || !['firstName', 'lastName', 'phone', 'line1', 'city', 'postalCode'].every(key => text(payload[key], key === 'postalCode' ? context.config.purchase.inputLimits.postalCode
        : key === 'phone' ? context.config.purchase.inputLimits.phone
          : ['firstName', 'lastName'].includes(key) ? context.config.purchase.inputLimits.name : context.config.purchase.inputLimits.text))
      || (payload.line2 !== undefined && (typeof payload.line2 !== 'string' || payload.line2.length > context.config.purchase.inputLimits.text))
      || payload.configuration !== context.config.id || payload.country !== context.config.market.country) return refused('starter_input_invalid');
    const offer = validateCart(context.config, payload.cart);
    if (!offer.ok) return refused(offer.issues[0]!.code);
    if (offer.cart.mode === 'subscription' && payload.acquisitionCapability !== ACQUISITION_TERMS_CAPABILITY) return refused('acquisition_terms_capability_required');
    if (payload.termsAccepted !== true || payload.termsRevision !== context.config.legal.revision) return refused('starter_terms_required');
    if (payload.locale !== 'en' && payload.locale !== 'pl') return refused('starter_input_invalid');
    const email = context.actor.customerRef
      ? (await db.query('SELECT email FROM public.clients WHERE id=$1 AND principal_id=$2', [context.actor.customerRef, context.actor.principalRef])).rows[0]?.email
      : typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!text(email, context.config.purchase.inputLimits.email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return refused('starter_email_invalid');
    const key = command(context, 'checkout');
    const prior = (await db.query(`SELECT o.metadata->'quoteSnapshot' AS snapshot FROM public.commerce_order_draft_receipts r
      JOIN public.commerce_orders o ON o.id=r.order_id JOIN public.clients c ON c.id=o.client_id
      WHERE r.idempotency_key=$1 AND ($2::uuid IS NOT NULL AND c.id=$2 OR $2::uuid IS NULL AND lower(btrim(c.email))=$3)`,
    [key,context.actor.customerRef,email])).rows[0]?.snapshot as CreateQuoteResponse | undefined;
    let observed;
    try {
      observed = await quotes.quote(payload, context, prior);
      if (!prior) quotes.verify(observed, payload);
      if (observed.terms) renewal.assertAvailable(observed.snapshot);
    } catch (error) { return refused(quoteFailure(error)); }
    interimLimiter ??= createInterimCheckoutLimiter(context.config.purchase.attemptLimits);
    if (!await admitCheckoutAttempt(checkRateLimit ?? interimLimiter.checkRateLimit,
      { headers: {}, ...(context.actor.requesterKey ? { requesterKey: context.actor.requesterKey } : {}) },
      { idempotencyKey: context.commandKey, contact: { email } }, 0)) return refused('starter_attempt_limited');
    attemptBindings ??= createCheckoutAttemptBindings(context.config.purchase.attemptLimits);
    const attempt = attemptBindings.bind(context.commandKey, email, context.actor.requesterKey);
    if (!attempt) return refused('starter_attempt_limited');
    const contact = await (context.actor.customerRef
      ? Promise.resolve({ ok: true as const, clientId: context.actor.customerRef })
      : contacts.ensureContactClient({ email, ...context.config.purchase.contact,
        profileDefaults: { firstName: String(payload.firstName), lastName: String(payload.lastName),
          phone: String(payload.phone), country: context.config.market.country },
        journey: { idempotencyKey: context.commandKey, locale: payload.locale, mode: offer.cart.mode } }));
    if (!contact.ok) return refused('starter_purchase_unavailable');
    const quoteSnapshot = observed.snapshot;
    const quote = observed.projection;
    const shipping = address(payload, context.config.market.country);
    const drafts = predecessors.checkout(db, { regionCode: context.config.market.country,
      financialPolicy: createAcquisitionFinancialPolicy(), isAcquisitionDiscount: discount => discount.promotionId === `demo-acquisition:${context.config.id}` });
    let created: { id: string; fresh: boolean } | null = null;
    try {
      const result = await drafts.createOrderDraft({ idempotencyKey: key, quoteSnapshot }, { clientId: contact.clientId });
      const orderId = result.orderDraft.orderId.slice(6);
      created = { id: orderId, fresh: !result.orderDraft.replayed };
      const current = await readOrder(orderId);
      if (!current || !await isInitialCheckoutOrder(db, current.id) || !['pending_payment', 'paid'].includes(current.status)) return refused('starter_checkout_not_payable');
      // Replayed registration compares the original immutable address before returning it.
      await destinations.registerOrder({ idempotencyKey: `${key}:destination`, orderId, address: shipping, now: new Date().toISOString() });
      const stock = createPostgresFulfillmentStockSyncPort(db, { sourceKey: source(context), readLocalInventoryStock: async () => [] });
      for (const line of quote.lines) await stock.recordProviderStockCurrent({ requestKey: `starter-stock:${line.sku}`, snapshot: {
        providerRef: context.config.purchase.stock.providerRef, collectedAt: context.config.purchase.stock.collectedAt, sourceRevision: null,
        revisionSource: 'collection', quantityKind: 'snapshot', skuRef: line.sku,
        totalQuantity: context.config.purchase.stock.quantities[line.sku]!, forSaleQuantity: context.config.purchase.stock.quantities[line.sku]!, reservedOrUnavailableQuantity: 0, syncRunId: context.config.purchase.stock.syncRunId,
      }, inventoryClass: 'sellable', lastSyncedAt: context.config.purchase.stock.collectedAt, staleAfter: context.config.purchase.stock.staleAfter });
      const items = (await db.query('SELECT id,sku_id,quantity FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal', [orderId])).rows;
      await reservations.reserveOrderItems({ idempotencyKey: `${key}:hold`, orderId, stockSourceKey: source(context),
        items: items.map(item => ({ orderItemId: item.id, skuId: item.sku_id, quantity: item.quantity })),
        paymentStatus: 'created', expiresAt: new Date(new Date(current.created_at).getTime() + context.config.purchase.reservationMinutes * 60 * 1000).toISOString(), now: new Date().toISOString() });
      if (quote.mode === 'subscription') await db.query('SELECT public.subscription_declare_provisional_activation($1,$2::uuid,$3::integer,$4::timestamptz)',
        [`${key}:declare`, orderId, quote.cadenceDays, new Date().toISOString()]);
      await db.query('SELECT public.commerce_open_settlement_intent($1,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7::timestamptz)',
        [`${key}:intent`, orderId, 'sandbox', quote.totalMinor, quote.currency, '{}', new Date().toISOString()]);
      let recoveryToken: string | undefined;
      if (created.fresh && current.status === 'pending_payment') {
        recoveryToken = generateCheckoutRecoveryToken();
        const tokenId = await recovery.tokens.issue({ orderId, rawToken: recoveryToken, expiresAt: '' });
        const expiry = (await db.query('SELECT expires_at FROM public.commerce_checkout_recovery_tokens WHERE id=$1', [tokenId])).rows[0];
        await recovery.deliver({ email, rawToken: recoveryToken, orderRef: orderId,
          expiresAt: new Date(expiry.expires_at).toISOString(), context, locale: payload.locale });
      }
      return { ...success({ ...present(current), ...(recoveryToken ? { token: recoveryToken } : {}) }),
        replayed: result.orderDraft.replayed };
    } catch (error) {
      // Creation has no payment dispatch. Never cancel the canonical order on a
      // changed-input replay, or any error carrying uncertain/in-flight dispatch.
      const reason = isRecord(error) ? error.reason ?? (isRecord(error.details) ? error.details.reason : undefined) : undefined;
      if (created?.fresh && reason !== 'provider_attempt_in_flight' && reason !== 'provider_dispatch_uncertain') {
        await compensation.cancelAbandonedOrder({ idempotencyKey: `${key}:compensate`, orderId: created.id,
          reason: ['journey_consumed', 'checkout_journey_consumed'].includes(String(reason)) ? 'checkout_journey_consumed' : 'checkout_failed_before_dispatch' });
      }
      return failure(error);
    }
    } catch (error) { return refused(quoteFailure(error)); }
    finally { await setTimeout(Math.max(0, context.config.purchase.responseFloorMs - (performance.now() - started))); }
  };
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
    if (inspected.status === 'cancelled') return refused('starter_recovery_cancelled');
    if (inspected.tokenState === 'order_not_recoverable' && inspected.status === 'paid') return success({ status: 'paid' });
    if (inspected.tokenState !== 'active' || inspected.status !== 'pending_payment') return refused('starter_recovery_unavailable');
    const order = await authorizedOrder(payload, context);
    return order ? success({ ...present(order), mode: inspected.mode, cadenceDays: inspected.cadenceDays }) : refused('starter_recovery_unavailable');
  };
  actions['payment.simulate'] = async (payload, context) => {
    if (!only(payload, ['orderRef', 'token', 'outcome']) || !['captured', 'refused', 'expired', 'indeterminate'].includes(String(payload.outcome))) return refused('starter_input_invalid');
    const order = await authorizedOrder(payload, context);
    if (!order) return refused('starter_order_not_found');
    const intent = (await db.query('SELECT id,status,external_ref FROM public.commerce_settlement_intents WHERE order_id=$1 AND channel_key=$2', [order.id, 'sandbox'])).rows[0];
    if (!intent) return refused('starter_sandbox_intent_unavailable');
    try {
      const key = command(context, 'payment');
      const storedQuote = order.metadata.quoteSnapshot as CreateQuoteResponse;
      if (payload.outcome === 'captured' && (storedQuote.quote.context as { acquisitionTerms?: unknown })?.acquisitionTerms) renewal.assertAvailable(storedQuote);
      const simulator = createPostgresSandboxPaymentSimulator(db, context.config.purchase.sandbox);
      const attempt = await simulator.beginAttempt({ settlementIntentId: intent.id, idempotencyKey: key,
        requestFingerprint: hash([order.id, payload.outcome]), at: new Date().toISOString() });
      const observation = await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: `${key}:observation`,
        outcome: payload.outcome as 'captured' | 'refused' | 'expired' | 'indeterminate', occurredAt: attempt.dispatchedAt });
      const accepted = await simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
        settlementIntentId: intent.id, attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: attempt.dispatchedAt });
      if (accepted.status !== 200) return refused('starter_sandbox_observation_refused');
      let renewalAttachment: string | undefined;
      if (payload.outcome === 'captured') {
        if (!await isInitialCheckoutOrder(db, order.id)) return refused('starter_order_not_found');
        const declaration = (await db.query('SELECT cadence_days FROM public.subscription_activations WHERE order_id=$1', [order.id])).rows[0];
        if (declaration) {
          const acceptedQuote = order.metadata.quoteSnapshot as CreateQuoteResponse;
          const acquisitionTerms = (acceptedQuote.quote.context as { acquisitionTerms?: unknown }).acquisitionTerms;
          if (acquisitionTerms) {
            renewalAttachment = await renewal.activate({ orderId: order.id, acceptedQuote,
              capturedReference: intent.external_ref ?? intent.id, methodFacts: attempt.methodFacts,
              stockSourceKey: source(context), templateId: `starter:${context.config.id}` });
          } else {
          const lines = acceptedQuote.quote.lines;
          const shippingTerms = (acceptedQuote.quote.context as { shippingTerms?: import('@openlup/platform/shipping').ShippingTerms } | undefined)?.shippingTerms;
          const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: 'sandbox', ...attempt.methodFacts,
            stockSourceKey: source(context), templateId: `starter:${context.config.id}`, cadenceDays: declaration.cadence_days,
            currency: order.currency_code, shippingAmountMinor: (acceptedQuote.quote.shippingGross?.amountMinor ?? 0) - (acceptedQuote.quote.shippingDiscountGross?.amountMinor ?? 0), acquisitionRef: null,
            renewalTerms: { version: 'native.renewal-terms.v1', ...(shippingTerms === undefined ? {} : { shippingTerms }) },
            lines: lines.map((line, index) => ({ lineOrdinal: index + 1, sku: line.sku, quantity: line.quantity, unitAmountMinor: line.unitPriceGross.amountMinor })) };
          renewalAttachment = (await activateNativePurchaseWithRenewal(db, { orderId: order.id,
            idempotencyKey: `activate:${order.id}`, capturedReference: intent.external_ref ?? intent.id, facts })).renewalAttachment;
          }
        }
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
    const subscription = (await db.query('SELECT template_version FROM public.subscriptions WHERE id=$1 AND client_id=$2', [payload.subscriptionRef, context.actor.customerRef])).rows[0];
    if (!subscription) return refused('starter_subscription_not_found');
    const key = command(context, 'address');
    const prior = (await db.query(`SELECT command->>'expectedVersion' AS version FROM public.subscription_command_receipts
      WHERE actor_id=$1 AND idempotency_key=$2`, [context.actor.principalRef, key])).rows[0];
    try {
      const result = await destinations.changeShippingAddress({ actorId: context.actor.principalRef, clientId: context.actor.customerRef,
        subscriptionId: payload.subscriptionRef, idempotencyKey: key, expectedVersion: prior ? Number(prior.version) : subscription.template_version,
        newAddress: { recipientName: String(payload.recipientName), line1: String(payload.line1), city: String(payload.city),
          postalCode: String(payload.postalCode), country: context.config.market.country, contactPhone: String(payload.phone),
          ...(payload.line2 ? { line2: String(payload.line2) } : {}) }, now: new Date().toISOString() });
      return 'refusalCode' in result ? refused(result.refusalCode) : success(result);
    } catch (error) { return failure(error); }
  };
  return actions;
}

function failure(error: unknown) {
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
