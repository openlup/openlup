import pg from 'pg';
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
import type { OriginPolicy } from './origin-policy.ts';
import { createSessions } from './sessions.ts';
import { createPostgresCheckoutRecoveryTokenPort } from '@openlup/platform/commerce/server';
import { createCheckoutRecoveryDelivery } from './checkout-recovery.ts';
import { composePurchaseCapabilities } from './purchase-composition.ts';
import { composeExistingCapabilities } from './e-composition.ts';

const nobody = (): VerifiedActor => ({ customerRef: null, operatorRef: null });
const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Local demonstration only. All database connections use the restricted runtime URL. */
export async function composeNativeBindings(connectionString: string, origin: OriginPolicy): Promise<ApplicationBindings> {
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    const identity = (await pool.query(`SELECT session_user AS login, current_user AS role,
      rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (identity?.login !== 'starter_runtime' || identity.role !== 'starter_runtime'
      || identity.rolsuper !== false || identity.rolbypassrls !== false) throw new Error('starter_runtime_connection_required');
  } catch (error) { await pool.end(); throw error; }
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
  if (!resolved.binding) { await pool.end(); throw new Error('starter_customer_session_binding_required'); }
  const customer = resolved.binding;
  const operator = createOperatorSessionService({ store: operators, delivery: captured, issuer: sessions.issuer('operator') });
  const operatorAuth = createOperatorAdminAuth({ authority: operators, verifier: {
    async verifyAccessToken(token) {
      const found = sessions.read({ headers: { cookie: 'starter_session=' + token } });
      return found?.session.kind === 'operator'
        ? { principalId: found.session.principalId, email: null, emailVerified: false } : null;
    },
  } });
  const capabilities = composeExistingCapabilities({ executor: pool, connectionString });
  const contacts = createPostgresContactClientRegistrar({ connectionString });
  const recoveryLane = createPostgresRoleFreeTransactionLane({ connectionString });
  const recovery = {
    tokens: createPostgresCheckoutRecoveryTokenPort(recoveryLane),
    deliver: async (input: Parameters<ReturnType<typeof createCheckoutRecoveryDelivery>>[0]) => {
      const admittedOrigin = input.context.actor.requestOrigin;
      if (!admittedOrigin) throw new Error('starter_recovery_origin_required');
      await createCheckoutRecoveryDelivery(admittedOrigin)(input);
    },
  };
  const actions: ApplicationBindings['actions'] = { ...capabilities.actions, ...composePurchaseCapabilities(pool, contacts, undefined, recovery) };
  const asCustomer = <T>(principalId: string, work: (db: PgGatewayClient) => Promise<T>) =>
    gateway.asActor({ role: 'authenticated', sub: principalId }, db => work(db as PgGatewayClient));
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
  actions['account.read'] = async (_payload, context) => {
    const principal = context.actor.principalRef;
    if (!principal) return refused('customer_session_required');
    return asCustomer(principal, async db => success({
      profile: await createPostgresCustomerMePort(db).getCustomerMe(principal),
      subscriptionControl: await createPostgresCustomerSubscriptionSnapshotPort(db).getSnapshot(),
      fullProjection: { ok: false, code: 'starter_account_projection_binding_required' },
    }));
  };
  actions['account.orders'] = async (payload, context) => {
    if (!context.actor.principalRef || !context.actor.customerRef) return refused('customer_session_required');
    const store = createPostgresCustomerOrderHistoryReadStore(pool, {
      principalId: context.actor.principalRef, clientId: context.actor.customerRef,
      readInvoiceSummaries: async () => { throw new Error('starter_invoice_history_binding_required'); },
    });
    // Native owned headers, explicitly selected fields. No metadata or invented rich projection.
    const present = (row: Record<string, unknown>) => ({ orderId: row.id, status: row.status,
      total: { amountMinor: row.total_cents, currency: row.currency }, createdAt: row.created_at });
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
        const authorized = await operatorAuth.authorize(token);
        // Reduced reads require native human admin authority, not a Commerce
        // mutation actor. The control-plane resolver cannot provision that actor.
        return authorized.ok ? { ...requester, customerRef: null, operatorRef: authorized.principalId,
          principalRef: authorized.principalId, sessionToken: token } : { ...nobody(), ...requester };
      }
      const profile = await asCustomer(session.principalId, db => createPostgresCustomerMePort(db).getCustomerMe(session.principalId));
      return profile ? { ...requester, customerRef: profile.clientId, operatorRef: null, principalRef: session.principalId, sessionToken: token } : { ...nobody(), ...requester };
    },
    async close() { sessions.close(); await Promise.all([capabilities.close(), recoveryLane.close(), contacts.close(), operators.close(), pool.end()]); },
  };
}
