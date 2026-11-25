import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { StoreConfig } from '../shared/config.ts';
import type { ActionInput, ActionResult, Operation } from '../shared/api.ts';
import { operationLimits } from '../shared/limits.ts';
import { evaluateOffer, parseCart, validateCart } from '../shared/offer.ts';
import type { PersonalDataContributorRegistry } from '@openlup/platform/identity';
import type { PgQueryExecutor } from '@openlup/platform/data';
import type { installationFinding } from '../shared/refusals.ts';
import type { StarterCatalogueItem } from '../shared/catalogue-products.ts';
import type { composeCatalogueStorefront } from './catalogue-storefront.ts';

export interface VerifiedActor {
  customerRef: string | null;
  operatorRef: string | null;
  /** Server-derived values, never populated from action payloads. */
  principalRef?: string;
  sessionToken?: string;
  /** Host-derived peer fingerprint for public intake quotas; never a payload value. */
  requesterKey?: string;
  /** Canonical origin derived from the admitted Host, never a payload or forwarding header. */
  requestOrigin?: string;
}

export interface ActionContext {
  commandKey: string;
  /** `performance.now()` when the HTTP host received the request, before body and authentication. */
  receivedAt?: number;
  /** Actual transport cookie; never supplied by an action body. */
  requestCookie?: string;
  actor: VerifiedActor;
  config: StoreConfig;
  quoteProducts?: readonly StarterCatalogueItem[];
  setCookie?: (cookie: string) => void;
  accept?: () => Promise<void>;
  registerCatalogueBuildCheck?: (check: () => ReturnType<typeof installationFinding>) => void;
}

export type ActionBinding = (input: ActionInput, context: ActionContext) => Promise<ActionResult>;

export interface ApplicationBindings {
  /** Programmatic owner composition only; never serialized as an HTTP action. */
  personalData?: PersonalDataContributorRegistry<PgQueryExecutor>;
  actions: Partial<Record<Operation, ActionBinding>>;
  resolveCatalogue?: ReturnType<typeof composeCatalogueStorefront>['resolveCatalogue'];
  authenticate(request: IncomingMessage): Promise<VerifiedActor>;
  close(): Promise<void>;
}

/** The default per-requester quota key: a digest of the socket peer address.
 * This local host trusts its socket peer only, never forwarding headers or a
 * contact supplied by the caller, so requests behind one proxy share its quota.
 * A host behind a trusted proxy replaces this function in one place. */
export function requesterKeyFor(request: IncomingMessage): string | undefined {
  const peer = request.socket.remoteAddress;
  return peer ? createHash('sha256').update(peer.toLowerCase()).digest('hex') : undefined;
}

/** Pending native dependencies remain visibly unbound. Never use browser fixtures as a store. */
export function pendingBindings(): ApplicationBindings {
  return {
    actions: {},
    authenticate: async () => ({ customerRef: null, operatorRef: null }),
    close: async () => {},
  };
}

export const customerOperations = new Set<Operation>([
  'account.billing', 'account.defaults', 'account.addresses', 'account.paymentPreference', 'account.deliveryPreference', 'subscription.savedAddress',
  'account.profile', 'account.invoiceCorrection', 'checkout.recoveryStart',
  'account.read', 'account.orders', 'account.invoice', 'account.consent',
  'subscription.cancelDirect', 'subscription.cancelFeedback', 'subscription.acceptSaveOffer',
  'subscription.command', 'subscription.preview', 'subscription.catalog', 'subscription.address', 'return.request',
]);

export async function dispatchAction(
  bindings: ApplicationBindings,
  operation: Operation,
  input: ActionInput,
  context: ActionContext,
): Promise<ActionResult> {
  if (operation.startsWith('operator.') || operation === 'ingest.submit') {
    if (context.actor.operatorRef === null) return { ok: false, code: 'operator_required' };
  }
  if (customerOperations.has(operation) && context.actor.customerRef === null) {
    return { ok: false, code: 'customer_session_required' };
  }
  const limit = operationLimits[operation];
  if (limit) return { ok: false, code: limit.code };
  if (operation === 'offer.validate' || operation === 'checkout.create') {
    if (operation === 'offer.validate' && bindings.actions[operation] && bindings.resolveCatalogue) {
      const parsed = parseCart(context.config.id, input.cart);
      if (parsed.ok && parsed.cart.lines.some(({ sku }) => !context.config.offer.products.some(item => item.sku === sku)
        && !context.config.subscriptionEditing.catalogue.some(item => item.sku === sku))) {
        const result = await bindings.resolveCatalogue(context.config);
        if (!result.ok) return result;
        context = { ...context, quoteProducts: result.value.products };
        input = { ...input, cart: parsed.cart };
      }
    }
    const selected = operation === 'checkout.create' && bindings.actions[operation]
      ? parseCart(context.config.id,input.cart) : validateCart(context.config,input.cart,'checkout',context.quoteProducts);
    if (!selected.ok) return { ok: false,code: selected.issues[0]!.code };
    if (selected.cart.mode === 'subscription' && (operation === 'offer.validate' || !bindings.actions[operation])
      && input.acquisitionCapability !== 'subscription-acquisition.v1') return { ok: false,code: 'acquisition_terms_capability_required' };
    if (selected.cart.mode === 'subscription' && operation === 'offer.validate' && !bindings.actions[operation]) return { ok: false,code: 'host_binding_required' };
  }
  if (operation === 'offer.validate' && bindings.actions[operation]) return bindings.actions[operation]!(input, context);
  if (operation === 'offer.validate') {
    const result = evaluateOffer(context.config, input.cart);
    return result.ok ? { ok: true, value: result.quote } : { ok: false, code: result.issues[0]!.code };
  }
  if (operation === 'checkout.create' && !bindings.actions[operation]) {
    const offer = evaluateOffer(context.config, input.cart);
    if (!offer.ok) return { ok: false, code: offer.issues[0]!.code };
    if (input.termsAccepted !== true || input.termsRevision !== context.config.legal.revision) {
      return { ok: false, code: 'starter_terms_required' };
    }
  }
  const action = bindings.actions[operation];
  if (!action) return { ok: false, code: 'host_binding_required' };
  if (operation !== 'operator.catalogDrafts' || !['create', 'revise', 'prepare'].some(value => value === input.action))
    return action(input, context);
  let check: (() => ReturnType<typeof installationFinding>) | undefined;
  const result = await action(input, { ...context, registerCatalogueBuildCheck: registered => { check = registered; } });
  const trigger = input.action === 'prepare' ? 'candidate_dependency_unavailable' : 'catalog_draft_dependency_unavailable';
  const finding = !result.ok && result.code === trigger ? check?.() : undefined;
  return finding ? { ok: false, ...finding, message: finding.observed } : result;
}
