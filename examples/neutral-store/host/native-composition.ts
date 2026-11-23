import { composeSandboxRecoveryPayments, composeExpiredRecovery } from './checkout-recovery.ts';
import { readPostgresCustomerAccountClient, createPostgresCustomerAccountMutationPort, createCustomerAccountMutationSchemas, createAccountEventPrivacyContributor } from '@openlup/platform/account-support';
import { createPersonalDataContributorRegistry, createCustomerBillingPrivacyContributor, createCustomerSavedAddressPrivacyContributor,
  createCustomerPreferencePrivacyContributor, createFulfillmentParcelContactPrivacyContributor, type PersonalDataContributor } from '@openlup/platform/identity';
import type { PgQueryExecutor } from '@openlup/platform/data';
import { customerAccountPolicy } from '../owned/acquisition-policy.ts';
import type { SubscriptionCommand } from '@openlup/platform/subscriptions/contracts';
import { createPostgresSubscriptionCommands, createPostgresSubscriptionSaveOfferAcceptor } from '@openlup/platform/subscriptions';
import type { ActionInput, ActionResult } from '../shared/api.ts';
import { isUuid } from './recurring-fence.ts';
import { admitCareCommand, assertSubscriptionCare, type SubscriptionCareConfig } from '../shared/renewal-config.ts';
import { isRecord } from '../shared/offer.ts';
import { readAccountRenewal } from './account-renewal.ts';
import { composeOperatorRecovery } from './operator-recovery.ts';
import { composeAuthenticatedRecovery } from './authenticated-recovery.ts';
import pg from 'pg';
import type { StoreConfig } from '../shared/config.ts';
import { readCheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/server';
import { readRenewalStockProtectionPolicy } from '@openlup/platform/inventory';
import { createHash } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { resolveCustomerSessionBinding, createCapturedCustomerChallengeDelivery,
  createOperatorSessionService, createPostgresOperatorIdentityStore,
  createPostgresCustomerMePort, createOperatorAdminAuth, createPostgresContactClientRegistrar } from '@openlup/platform/identity';
import { createPostgresDataGateway, createPostgresRoleFreeTransactionLane, type PgGatewayClient } from '@openlup/platform/data';
import { createPostgresCustomerOrderHistoryReadStore, createPostgresCustomerSubscriptionSnapshotPort,
  createPostgresCustomerNewsletterPreferencesPort } from '@openlup/platform/account-support';
import { createPostgresCommerceOmsControlPlane } from '@openlup/platform/commerce/server/postgres';
import type { ActionBinding, ApplicationBindings, VerifiedActor } from './bindings.ts';
import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import type { OriginPolicy } from './origin-policy.ts';
import { createSessions } from './sessions.ts';
import { createCheckoutRecoveryStartHandler, createPostgresCustomerCheckoutRecoveryStartPort, createPostgresCheckoutRecoveryTokenPort } from '@openlup/platform/commerce/server';
import { createCheckoutRecoveryDelivery } from './checkout-recovery.ts';
import { composePurchaseCapabilities } from './purchase-composition.ts';
import { portalResponder, composePortalCapabilities, composeE4Capabilities } from './e4-composition.ts';
import { composeExistingCapabilities } from './e-composition.ts';
import { composeSubscriptionEditors, readEditorSubscriptions } from './subscription-editors.ts';

const nobody = (): VerifiedActor => ({ customerRef: null, operatorRef: null });
const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Native data owners are registered even without a browser privacy workflow.
 * Missing identity/subscription owners and unresolved event retention remain explicit. */
export function createStarterPersonalDataRegistry(additional: readonly PersonalDataContributor<PgQueryExecutor>[] = []) {
  return createPersonalDataContributorRegistry<PgQueryExecutor>([...additional, createCustomerBillingPrivacyContributor(),
    createCustomerSavedAddressPrivacyContributor(), createCustomerPreferencePrivacyContributor(), createFulfillmentParcelContactPrivacyContributor(),
    createAccountEventPrivacyContributor({ read: null, assess: null })], { requiredContributorIds: [
      'identity','subscriptions','account-support','fulfillment-parcel-contacts','customer-billing','customer-saved-addresses','customer-preferences',
    ] });
}

/** Local demonstration only. Publication uses a private credential on the same database. */
export async function composeNativeBindings(connectionString: string, origin: OriginPolicy, config: StoreConfig, quoteAcceptanceKeyring?: PromotionAcceptanceKeyring, publicationPassword?: string): Promise<ApplicationBindings> {
  const pool = new pg.Pool({ connectionString, max: 4 });
  const publication = publicationPassword === undefined ? undefined : (() => {
    const url = new URL(connectionString);
    url.username = 'openlup_catalog_publication';
    url.password = publicationPassword;
    url.searchParams.delete('user');
    url.searchParams.delete('password');
    return createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: url.href });
  })();
  try {
    if (publication) {
      if (!/^[a-f0-9]{64}$/u.test(publicationPassword!)) throw new Error('starter_catalogue_publication_password_invalid');
      await publication.run(async db => {
        const { rows } = await db.query(`SELECT session_user = 'openlup_catalog_publication'
          AND current_user = session_user AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
          AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid OR roleid = r.oid) AS allowed
          FROM pg_catalog.pg_roles r WHERE rolname = current_user`);
        if (rows[0]?.allowed !== true) throw new Error('starter_catalogue_publication_login_invalid');
      }).catch(() => { throw new Error('starter_catalogue_publication_login_invalid'); });
    }
    const identity = (await pool.query(`SELECT session_user AS login, current_user AS role,
      rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (identity?.login !== 'starter_runtime' || identity.role !== 'starter_runtime'
      || identity.rolsuper !== false || identity.rolbypassrls !== false) throw new Error('starter_runtime_connection_required');
    const ledger = await pool.query(`SELECT routine IS NOT NULL AS present,
      pg_catalog.has_function_privilege(current_user, routine, 'EXECUTE') AS executable
      FROM (SELECT pg_catalog.to_regprocedure(
        'public.commerce_record_checkout_attempt(text,text,text,bigint,bigint,bigint,bigint,bigint)'
      )::oid AS routine) AS checkout_ledger`).catch(() => {
      throw new Error('starter_checkout_attempt_ledger_check_failed');
    });
    if (!Array.isArray(ledger.rows) || ledger.rows.length !== 1) throw new Error('starter_checkout_attempt_ledger_check_failed');
    const readiness = ledger.rows[0];
    if (readiness?.present === false) throw new Error('starter_checkout_attempt_ledger_missing');
    if (readiness?.present !== true || typeof readiness.executable !== 'boolean')
      throw new Error('starter_checkout_attempt_ledger_check_failed');
    if (!readiness.executable) throw new Error('starter_checkout_attempt_ledger_execute_required');
    const installed = await readRenewalStockProtectionPolicy(pool);
    const expected = config.inventory.renewalProtection;
    if (installed.revision !== expected.revision || installed.renewalProtectionDays !== expected.renewalProtectionDays) {
      throw new Error('starter_installed_policy_drift');
    }
    const reminders = await readCheckoutRecoveryReminderSchedule(pool);
    const expectedReminders = config.checkoutRecoveryReminders;
    if (reminders.revision !== expectedReminders.revision
      || ['abandonedCart', 'checkoutRecovery'].some(key => {
        const field = key as 'abandonedCart' | 'checkoutRecovery';
        return reminders[field].length !== expectedReminders[field].length
          || reminders[field].some((wave, i) => wave.stage !== expectedReminders[field][i]?.stage
            || wave.afterHours !== expectedReminders[field][i]?.afterHours);
      })) throw new Error('starter_installed_policy_drift');
    if (!(await pool.query("SELECT to_regprocedure('public.invoicing_capture_duty_with_buyer(text,text,uuid,uuid,jsonb,timestamp with time zone)') IS NOT NULL AS ready")).rows[0]?.ready)
      throw new Error('starter_billing_installation_required');
  } catch (error) { await Promise.all([pool.end(), publication?.close()]); throw error; }
  const sessions = createSessions(origin.secureCookies);
  const gateway = createPostgresDataGateway({ connectionString }, { poolFactory: () => pool });
  const operators = createPostgresOperatorIdentityStore({ connectionString });
  const oms = createPostgresCommerceOmsControlPlane(pool);
  // Private captured mailbox; never an HTTP route, response payload or log.
  const captured = createCapturedCustomerChallengeDelivery(async message => {
    const directory = resolve('.context/captured-messages');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(resolve(directory, 'identity.jsonl'), JSON.stringify(message) + '\n', { mode: 0o600 });
  });
  const resolved = resolveCustomerSessionBinding({ PLATFORM_BUNDLE: 'node-postgres', DATABASE_URL: connectionString },
    { issuer: sessions.issuer('customer'), delivery: captured });
  if (!resolved.binding) { await Promise.all([pool.end(), publication?.close()]); throw new Error('starter_customer_session_binding_required'); }
  const customer = resolved.binding;
  const operator = createOperatorSessionService({ store: operators, delivery: captured, issuer: sessions.issuer('operator') });
  const operatorAuth = createOperatorAdminAuth({ authority: operators, verifier: {
    async verifyAccessToken(token) {
      const found = sessions.read({ headers: { cookie: 'starter_session=' + token } });
      return found?.session.kind === 'operator'
        ? { principalId: found.session.principalId, email: null, emailVerified: false } : null;
    },
  } });
  const capabilities = composeExistingCapabilities({ executor: pool, connectionString, publication });
  const contacts = createPostgresContactClientRegistrar({ connectionString });
  const checkoutRecoveryTokenLane = createPostgresRoleFreeTransactionLane({ connectionString });
  const recovery = {
    tokens: createPostgresCheckoutRecoveryTokenPort(checkoutRecoveryTokenLane),
    deliver: async (input: Parameters<ReturnType<typeof createCheckoutRecoveryDelivery>>[0]) => {
      const admittedOrigin = input.context.actor.requestOrigin;
      if (!admittedOrigin) throw new Error('starter_recovery_origin_required');
      await createCheckoutRecoveryDelivery(admittedOrigin)(input);
    },
  };
  const actions: ApplicationBindings['actions'] = { ...capabilities.actions,
    ...composeE4Capabilities(pool, async context => {
      const authorization = await operatorAuth.authorize(context.actor.sessionToken ?? '', { allowedRoles: ['admin'] });
      return authorization.ok && authorization.principalId.toLowerCase() === context.actor.operatorRef?.toLowerCase();
    }), ...composePurchaseCapabilities(pool, contacts, undefined, recovery, {
      ...(quoteAcceptanceKeyring ? { keyring: quoteAcceptanceKeyring } : {}),
      bindContact(session) {
        // The contact registrar owns a nested unit of the native draft transaction.
        const borrowed = { async connect() {
          return { async query(statement: string, values?: unknown[]) {
            if (statement === 'BEGIN') return session.query('SAVEPOINT checkout_contact');
            if (statement === 'COMMIT') return session.query('RELEASE SAVEPOINT checkout_contact');
            if (statement === 'ROLLBACK') return session.query('ROLLBACK TO SAVEPOINT checkout_contact');
            if (statement === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return { rows: [] };
            return session.query(statement, values);
          }, release() {} };
        } } as unknown as pg.Pool;
        return createPostgresContactClientRegistrar({ connectionString }, { pool: borrowed });
      },
    }),
    ...composeAuthenticatedRecovery(pool), ...composeOperatorRecovery(pool), ...composeSubscriptionEditors(pool) };
  Object.assign(actions, composePortalCapabilities(pool, async context => {
    const auth = await operatorAuth.authorize(context.actor.sessionToken ?? '', { allowedRoles: ['admin'] });
    return auth.ok && auth.principalId.toLowerCase() === context.actor.operatorRef?.toLowerCase();
  }, quoteAcceptanceKeyring));
  const asCustomer = <T>(principalId: string, work: (db: PgGatewayClient) => Promise<T>) =>
    gateway.asActor({ role: 'authenticated', sub: principalId }, db => work(db as PgGatewayClient));
  Object.assign(actions, composeExpiredRecovery(pool, checkoutRecoveryTokenLane, recovery.tokens, quoteAcceptanceKeyring));
  Object.assign(actions, composeSandboxRecoveryPayments(pool, checkoutRecoveryTokenLane, recovery.tokens, quoteAcceptanceKeyring));
  actions['checkout.recoveryStart'] = async (payload, context) => {
    if (!context.actor.principalRef) return refused('customer_session_required');
    if (Object.keys(payload).some(key => !['orderRef', 'subscriptionRef', 'locale'].includes(key))) return refused('starter_input_invalid');
    return asCustomer(context.actor.principalRef, async db => {
      const response = { result: refused('starter_recovery_unavailable') as Awaited<ReturnType<ActionBinding>> };
      const handler = createCheckoutRecoveryStartHandler<typeof response>({ recoveryEnabled: () => true,
        authenticateUser: async () => ({ ok: true, userId: context.actor.principalRef! }),
        createPort: () => createPostgresCustomerCheckoutRecoveryStartPort(db), respond: portalResponder, lifetimeMs: 86400000 });
      await handler({ method: 'POST', body: { ...(payload.orderRef !== undefined ? { orderId: payload.orderRef } : {}),
        ...(payload.subscriptionRef !== undefined ? { subscriptionId: payload.subscriptionRef } : {}) } }, response);
      return response.result;
    });
  };
  const email = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length <= limit
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  const pad = (started: number) => setTimeout(Math.max(0, 400 - (Date.now() - started)));
  const verify = (kind: 'customer' | 'operator'): ActionBinding => async (payload, context) => {
    if (typeof payload.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.token) || !context.setCookie) return refused('starter_input_invalid');
    const session = await (kind === 'customer' ? customer.verifyChallenge(payload.token) : operator.verifyChallenge(payload.token));
    if (!session) return refused('starter_auth_invalid');
    sessions.revoke(context.actor.sessionToken);
    context.setCookie(sessions.cookie(session.accessToken));
    return success({ expiresAt: session.expiresAt });
  };
  actions['subscription.command'] = composeSubscriptionCommands(pool);
  Object.assign(actions, composeCareActions(pool));
  actions['auth.request'] = async (payload, context) => {
    if (!email(payload.email, context.config.purchase.inputLimits.email)) return refused('starter_input_invalid');
    const started = Date.now();
    await customer.requestChallenge(payload.email.trim());
    await pad(started);
    return success({ accepted: true });
  };
  actions['auth.verify'] = verify('customer');
  actions['auth.callback'] = verify('customer');
  actions['auth.operator'] = async (payload, context) => {
    if (payload.token !== undefined) return verify('operator')(payload, context);
    if (!email(payload.email, context.config.purchase.inputLimits.email)) return refused('starter_input_invalid');
    const started = Date.now();
    await operator.requestChallenge(payload.email.trim(), async () => { await pad(started); await context.accept?.(); });
    return success({ accepted: true });
  };
  actions['auth.signOut'] = async (_payload, context) => {
    sessions.revoke(context.actor.sessionToken);
    context.setCookie?.(sessions.clearCookie());
    return success({ signedOut: true });
  };
  actions['account.read'] = async (payload, context) => {
    const principal = context.actor.principalRef;
    if (!principal) return refused('customer_session_required');
    const { saveOfferFor } = payload;
    if (Object.keys(payload).length && !closed(payload, ['saveOfferFor'])) return invalidCareInput();
    const actor = careActor(context.actor);
    let offerId: string | undefined;
    if (Object.hasOwn(payload, 'saveOfferFor')) {
      if (!isUuid(saveOfferFor)) return invalidCareInput();
      if (!actor) return refused('customer_session_required');
      offerId = await ownedSubscription(pool, actor, saveOfferFor);
      if (!offerId) return refused('starter_subscription_not_found');
    }
    const account = await asCustomer(principal, async db => ({
      profile: await createPostgresCustomerMePort(db).getCustomerMe(principal),
      subscriptionControl: await createPostgresCustomerSubscriptionSnapshotPort(db).getSnapshot(),
    }));
    // Release the actor transaction before the projection borrows this pool.
    const renewal = actor && await readAccountRenewal(pool, { principalId: actor.actorId, clientId: actor.clientId });
    const ids = renewal ? renewal.subscriptions.map(row => String(row.subscriptionId)) : [];
    const offers = actor && await offerAcceptor(pool, context.config.renewal.subscriptionCare).readPresentations({
      actor, subscriptionIds: offerId ? [...new Set([...ids, offerId])] : ids, now: new Date().toISOString(),
    });
    return success({
      ...account,
      profile: account.profile && context.actor.customerRef ? { ...account.profile,
        phone: (await readPostgresCustomerAccountClient(pool, { principalId: principal, clientId: context.actor.customerRef }))?.phone ?? null } : account.profile,
      renewal: renewal && { subscriptions: renewal.subscriptions.map(row => ({
        ...row, saveOfferGeneration: offers?.get(String(row.subscriptionId))?.generation ?? null,
      })) },
      ...(offerId ? { saveOffer: offers?.get(offerId) ?? null } : {}),
      subscriptionEditors: await readEditorSubscriptions(pool, context.actor),
      accountEvents: context.actor.customerRef ? await createPostgresCustomerAccountMutationPort(pool,
        { principalId: principal, clientId: context.actor.customerRef }, createCustomerAccountMutationSchemas(customerAccountPolicy),
        () => new Date().toISOString()).readEvents(principal) : [],
      fullProjection: { ok: false, code: 'starter_account_projection_binding_required' },
    });
  };
  actions['account.orders'] = async (payload, context) => {
    if (!context.actor.principalRef || !context.actor.customerRef) return refused('customer_session_required');
    const store = createPostgresCustomerOrderHistoryReadStore(pool, {
      principalId: context.actor.principalRef, clientId: context.actor.customerRef,
      readInvoiceSummaries: async () => { throw new Error('starter_invoice_history_binding_required'); },
    });
    // Native owned headers, explicitly selected fields. No metadata or invented rich projection.
    const present = (row: Record<string, unknown>) => ({ orderId: row.id, status: row.status,
      total: { amountMinor: row.total_cents, currency: row.currency }, createdAt: row.created_at,
      recoverableCheckout: row.status === 'pending_payment' && row.subscription_cycle_id == null });
    const orderId = payload.orderRef ?? payload.orderId;
    if (orderId !== undefined) {
      if (!uuid(orderId)) return refused('starter_input_invalid');
      try {
        const order = await store.readCustomerOrder(context.actor.customerRef, orderId);
        return order ? success({ order: present(order) }) : refused('starter_order_not_found');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('native_account_order_money_')) return refused(error.message);
        throw error;
      }
    }
    return success({ orders: (await store.readCustomerOrders(context.actor.customerRef, ['cancelled', 'expired'], 30)).map(present) });
  };
  actions['account.consent'] = async (payload, context) => {
    if (!context.actor.principalRef) return refused('customer_session_required');
    if ((payload.purpose !== undefined && payload.purpose !== 'marketing_newsletter')
      || payload.granted === true || (payload.granted !== undefined && payload.granted !== false)) return refused('host_binding_required');
    return asCustomer(context.actor.principalRef, async db => {
      const port = createPostgresCustomerNewsletterPreferencesPort(db);
      try { return success(payload.granted === false ? await port.withdrawNewsletter() : await port.getPreferences()); }
      catch (error) { if (error instanceof Error && error.message === 'host_binding_required') return refused('host_binding_required'); throw error; }
    });
  };
  actions['operator.orders'] = async () => success(await oms.listOrders({ view: 'control_plane_v1', page: 1, pageSize: 30 }));
  actions['operator.order'] = async payload => {
    const orderId = payload.orderRef ?? payload.orderId;
    if (!uuid(orderId)) return refused('starter_input_invalid');
    const value = await oms.getOrderDetail({ view: 'control_plane_v1', orderId });
    return value ? success(value) : refused('starter_order_not_found');
  };
  return {
    personalData: createStarterPersonalDataRegistry(),
    actions,
    async authenticate(request) {
      // This local host trusts its socket peer only, never forwarding headers or
      // a contact supplied by the caller. Proxies share their peer's quota.
      const peer = request.socket.remoteAddress;
      const admittedOrigin = origin.originFor(request.headers.host ?? '');
      const requester = { ...(peer ? { requesterKey: createHash('sha256').update(peer.toLowerCase()).digest('hex') } : {}),
        ...(admittedOrigin ? { requestOrigin: admittedOrigin } : {}) };
      const found = sessions.read(request);
      if (!found) return { ...nobody(), ...requester };
      const { session, token } = found;
      if (session.kind === 'operator') {
        const authorized = await operatorAuth.authorize(token, { allowedRoles: ['admin'] });
        // Reduced reads require native human admin authority, not a Commerce
        // mutation actor. The control-plane resolver cannot provision that actor.
        return authorized.ok ? { ...requester, customerRef: null, operatorRef: authorized.principalId,
          principalRef: authorized.principalId, sessionToken: token } : { ...nobody(), ...requester };
      }
      const profile = await asCustomer(session.principalId, db => createPostgresCustomerMePort(db).getCustomerMe(session.principalId));
      return profile ? { ...requester, customerRef: profile.clientId, operatorRef: null, principalRef: session.principalId, sessionToken: token } : { ...nobody(), ...requester };
    },
    async close() { sessions.close(); await Promise.all([capabilities.close(), checkoutRecoveryTokenLane.close(), contacts.close(), operators.close(), publication?.close(), pool.end()]); },
  };
}

/** Keep the editor request envelope and lifecycle commands on their existing owners. */
export function composeSubscriptionCommands(pool: pg.Pool): ActionBinding {
  const edit = composeSubscriptionEditors(pool)['subscription.command']!;
  const care = composeSubscriptionCare(pool);
  return (input, context) => Object.hasOwn(input, 'request') ? edit(input, context) : care(input, context);
}

function careActor(actor: VerifiedActor) {
  if (actor.principalRef && actor.customerRef) return { kind: 'customer' as const, actorId: actor.principalRef, clientId: actor.customerRef };
}
type CareActor = NonNullable<ReturnType<typeof careActor>>;
async function ownedSubscription(pool: pg.Pool, actor: CareActor, subscriptionRef: string) {
  const { rows: [owner] } = await pool.query<{ id: string }>(`SELECT s.id FROM public.subscriptions s JOIN public.clients c ON c.id=s.client_id
    WHERE s.id=$1::uuid AND c.id=$2::uuid AND c.principal_id=$3::uuid`, [subscriptionRef, actor.clientId, actor.actorId]);
  return owner?.id;
}
const closed = (input: ActionInput, keys: string[]) => Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
const invalidCareInput = () => ({ ...refused('starter_input_invalid'), status: 400 as const });
const careTransaction = (pool: pg.Pool, begin = 'BEGIN ISOLATION LEVEL READ COMMITTED') => async <T>(work: (db: PgQueryExecutor) => Promise<T>) => {
  const db = await pool.connect();
  try { await db.query(begin); const value = await work(db); await db.query('COMMIT'); return value; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
};
function offerAcceptor(pool: pg.Pool, care: SubscriptionCareConfig) {
  return createPostgresSubscriptionSaveOfferAcceptor({
    withTransaction: careTransaction(pool), lifecycleTerms: care.terms,
    admitSubscriptionCommand: facts => admitCareCommand(care, facts),
    offerPolicy: { offerPresentation: care.retention.offerPresentation ?? 'ask_permission_first',
      defaultOffer: care.retention.defaultOffer, allowedPausePresets: care.pausePresets.allowed,
      preselectedPausePreset: care.retention.pausePreset ?? care.pausePresets.default, rescheduleOfferDays: care.rescheduleOfferDays },
  });
}
const offerRefusals = {
  subscription_save_offer_unavailable: 'starter_save_offer_unavailable',
  subscription_save_offer_stale: 'starter_save_offer_stale',
  subscription_save_offer_consumed: 'starter_save_offer_consumed',
} as const;
const feedbackRefusals = {
  invalid_reason: 'starter_cancel_feedback_invalid_reason',
  cancel_not_found: 'starter_cancel_feedback_cancel_not_found',
  reason_not_offered: 'starter_cancel_feedback_reason_not_offered',
  reason_conflict: 'starter_cancel_feedback_conflict',
} as const;
function admissionRefusal(error: unknown) {
  if (error instanceof Error && ['starter_subscription_action_not_admitted', 'starter_pause_preset_not_admitted'].includes(error.message)) return refused(error.message);
  throw error;
}
type OfferInput = Parameters<ReturnType<typeof offerAcceptor>['accept']>[0];
function exactUtcTerm(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4,5}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)) return false;
  const iso = value[4] === '-' ? value : '+0' + value;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso.slice(0, -4) + 'Z';
}
function offerChoice(input: ActionInput): (Pick<OfferInput, 'generation'> & (
  Pick<Extract<OfferInput, { kind: 'pause' }>, 'kind' | 'pausePreset' | 'duration'> |
  Pick<Extract<OfferInput, { kind: 'reschedule' }>, 'kind' | 'newNextCycleAt'> | { kind: 'skip' })) | undefined {
  const { generation, kind, duration, pausePreset, newNextCycleAt } = input;
  if (typeof generation !== 'string' || !/^[a-f0-9]{64}$/u.test(generation)) return;
  const common = ['subscriptionRef', 'generation', 'kind'];
  if (kind === 'skip' && closed(input, common)) return { generation, kind };
  if (kind === 'reschedule' && closed(input, [...common, 'newNextCycleAt'])
    && exactUtcTerm(newNextCycleAt)) return { generation, kind, newNextCycleAt };
  if (kind !== 'pause' || !closed(input, [...common, 'pausePreset', 'duration']) || !isRecord(duration)
    || (pausePreset !== '2_weeks' && pausePreset !== '1_month' && pausePreset !== 'indefinite')) return;
  if (duration.unit === 'indefinite' && closed(duration, ['unit'])) return { generation, kind, pausePreset, duration: { unit: duration.unit } };
  if ((duration.unit === 'days' || duration.unit === 'months') && closed(duration, ['unit', 'value'])
    && typeof duration.value === 'number' && Number.isSafeInteger(duration.value) && duration.value > 0) {
    return { generation, kind, pausePreset, duration: { unit: duration.unit, value: duration.value } };
  }
}
export function composeCareActions(pool: pg.Pool, now = () => new Date().toISOString()) {
  const direct = composeSubscriptionCare(pool, now, true);
  const scoped = (work: (input: ActionInput, scope: { actor: CareActor; subscriptionId: string },
    care: SubscriptionCareConfig, key: string) => Promise<ActionResult>): ActionBinding => async (input, context) => {
    const actor = careActor(context.actor);
    if (!actor) return refused('customer_session_required');
    if (!isUuid(input.subscriptionRef)) return invalidCareInput();
    const subscriptionId = await ownedSubscription(pool, actor, input.subscriptionRef);
    if (!subscriptionId) return refused('starter_subscription_not_found');
    return work(input, { actor, subscriptionId }, context.config.renewal.subscriptionCare, context.commandKey);
  };
  return {
    'subscription.cancelDirect': ((input, context) => closed(input, ['subscriptionRef'])
      ? direct({ action: 'cancel', subscriptionRef: input.subscriptionRef }, context)
      : Promise.resolve(invalidCareInput())) satisfies ActionBinding,
    'subscription.acceptSaveOffer': scoped(async (input, scope, care, idempotencyKey) => {
      const choice = offerChoice(input);
      if (!choice) return invalidCareInput();
      try {
        const result = await offerAcceptor(pool, care).accept({ ...scope, ...choice, idempotencyKey, now: now() });
        if (result.outcome !== 'refused') return { ...success(result), replayed: result.outcome === 'replayed' };
        return refused(offerRefusals[result.reason as keyof typeof offerRefusals] ?? result.reason);
      } catch (error) { return admissionRefusal(error); }
    }),
    'subscription.cancelFeedback': scoped(async (input, { actor, subscriptionId }, care) => {
      if (!closed(input, ['subscriptionRef', 'cancelCommandKey', 'reasonCode'])
        || typeof input.cancelCommandKey !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/u.test(input.cancelCommandKey)) return invalidCareInput();
      const { reasonCode, cancelCommandKey } = input;
      if (typeof reasonCode !== 'string' || !/^[a-z][a-z0-9_]{0,119}$/u.test(reasonCode)) {
        return { ...refused(feedbackRefusals.invalid_reason), status: 400 };
      }
      return careTransaction(pool)(async db => {
        const { rows: [setup] } = await db.query(`SELECT to_regclass('public.subscription_cancel_feedback') IS NOT NULL
          AND pg_catalog.has_function_privilege(current_user,
            to_regprocedure('public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean)')::oid, 'EXECUTE') AS ready`);
        if (!setup?.ready) return refused('starter_cancel_feedback_setup_required');
        const { rows: [receipt] } = await db.query(`SELECT r.result->>'eventId' AS event_id
          FROM public.subscription_command_receipts r JOIN public.clients c ON c.id=r.client_id
          WHERE r.actor_id=$1::uuid AND c.principal_id=$1::uuid AND c.id=$2::uuid AND r.subscription_id=$3::uuid
            AND r.idempotency_key=$4 AND r.command->>'action'='cancel' AND r.status='applied'`,
        [actor.actorId, actor.clientId, subscriptionId, cancelCommandKey]);
        if (!receipt?.event_id) return refused(feedbackRefusals.cancel_not_found);
        const { rows: [result] } = await db.query(`SELECT public.subscription_cancel_feedback_submit($1::uuid,$2::uuid,$3::text,$4::boolean) AS status`,
          [receipt.event_id, actor.clientId, reasonCode, care.retentionReasons.includes(reasonCode)]);
        const status = result?.status;
        if (status === 'recorded' || status === 'replayed') return success({ status });
        if (typeof status === 'string' && Object.hasOwn(feedbackRefusals, status)) {
          return { ...refused(feedbackRefusals[status as keyof typeof feedbackRefusals]), status: status === 'invalid_reason' ? 400 : 409 };
        }
        throw Error('starter_cancel_feedback_response_invalid');
      });
    }),
  };
}

/** The session supplies authority; the package owns lifecycle, timing, receipts and all writes. */
export function composeSubscriptionCare(pool: pg.Pool, now = () => new Date().toISOString(), direct = false): ActionBinding {
  return async (input, context) => {
    const refuse = (code: string) => ({ ok: false as const, code });
    const actor = careActor(context.actor);
    if (!actor) return refuse('customer_session_required');
    if (direct && !isUuid(input.subscriptionRef)) return invalidCareInput();
    const allowed = ['action', 'subscriptionRef', 'reason', 'pausePreset', 'survey', 'saveOffer', 'newNextCycleAt', 'confirmedChargeTiming', 'locale'];
    if (Object.keys(input).some(key => !allowed.includes(key)) || !isUuid(input.subscriptionRef)
      || typeof input.action !== 'string' || !['skip', 'slide', 'pause', 'resume', 'cancel', 'order_now', 'reactivate'].includes(input.action)
      || (input.reason != null && (typeof input.reason !== 'string' || input.reason.length > 2000))) return refuse('starter_input_invalid');
    const subscriptionId = await ownedSubscription(pool, actor, input.subscriptionRef);
    if (!subscriptionId) return refuse('starter_subscription_not_found');
    assertSubscriptionCare(context.config.renewal.subscriptionCare);
    const port = createPostgresSubscriptionCommands({
      lifecycleTerms: context.config.renewal.subscriptionCare.terms,
      retentionReasonCodes: context.config.renewal.subscriptionCare.retentionReasons,
      admitSubscriptionCommand: facts => { if (!direct) admitCareCommand(context.config.renewal.subscriptionCare, facts); },
      withTransaction: careTransaction(pool, direct ? undefined : 'BEGIN'),
      async futureTerms() { return { outcome: 'refused', reason: 'subscription_command_unsupported_action' }; },
    });
    const base = { actor, subscriptionId, idempotencyKey: context.commandKey, now: now() };
    const reason = typeof input.reason === 'string' ? input.reason : null;
    let command: SubscriptionCommand;
    switch (input.action) {
      case 'order_now': case 'reactivate':
        if (input.confirmedChargeTiming !== true) return refuse('subscription_command_charge_timing_not_confirmed');
        command = { ...base, action: input.action, confirmedChargeTiming: true }; break;
      case 'pause':
        command = { ...base, action: 'pause', pausePreset: String(input.pausePreset), reason,
          survey: input.survey as Extract<SubscriptionCommand, { action: 'pause' }>['survey'] ?? null,
          saveOffer: input.saveOffer as Extract<SubscriptionCommand, { action: 'pause' }>['saveOffer'] ?? null }; break;
      case 'slide':
        if (typeof input.newNextCycleAt !== 'string' || !Number.isFinite(Date.parse(input.newNextCycleAt))) return refuse('starter_input_invalid');
        command = { ...base, action: 'slide', newNextCycleAt: input.newNextCycleAt, reason, confirmedChargeTiming: input.confirmedChargeTiming === true }; break;
      case 'cancel':
        command = { ...base, action: 'cancel', reason, confirmedChargeTiming: input.confirmedChargeTiming === true,
          survey: input.survey as Extract<SubscriptionCommand, { action: 'cancel' }>['survey'] ?? null,
          saveOffer: input.saveOffer as Extract<SubscriptionCommand, { action: 'cancel' }>['saveOffer'] ?? null }; break;
      default:
        command = { ...base, action: input.action as 'skip' | 'resume', reason, confirmedChargeTiming: input.confirmedChargeTiming === true };
    }
    try {
      const result = await port.apply(command);
      if ('supported' in result) return refuse(result.refusalCode);
      if (result.outcome === 'refused') return refuse(result.reason);
      return { ok: true, value: result, replayed: result.outcome === 'replayed' };
    } catch (error) {
      return admissionRefusal(error);
    }
  };
}
