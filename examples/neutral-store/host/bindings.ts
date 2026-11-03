import type { IncomingMessage } from 'node:http';
import type { StoreConfig } from '../shared/config.ts';
import type { ActionInput, ActionResult, Operation } from '../shared/api.ts';
import { evaluateOffer } from '../shared/offer.ts';

export interface VerifiedActor {
  customerRef: string | null;
  operatorRef: string | null;
  /** Server-derived values, never populated from action payloads. */
  principalRef?: string;
  sessionToken?: string;
  /** Host-derived peer fingerprint for public intake quotas; never a payload value. */
  requesterKey?: string;
}

export interface ActionContext {
  commandKey: string;
  actor: VerifiedActor;
  config: StoreConfig;
  setCookie?: (cookie: string) => void;
  accept?: () => Promise<void>;
}

export type ActionBinding = (input: ActionInput, context: ActionContext) => Promise<ActionResult>;

export interface ApplicationBindings {
  actions: Partial<Record<Operation, ActionBinding>>;
  authenticate(request: IncomingMessage): Promise<VerifiedActor>;
  close(): Promise<void>;
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
  'account.read', 'account.orders', 'account.invoice', 'account.consent',
  'subscription.command', 'subscription.address', 'return.request',
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
  if (operation === 'offer.validate') {
    const result = evaluateOffer(context.config, input.cart);
    return result.ok ? { ok: true, value: result.quote } : { ok: false, code: result.issues[0]!.code };
  }
  if (operation === 'checkout.create') {
    const offer = evaluateOffer(context.config, input.cart);
    if (!offer.ok) return { ok: false, code: offer.issues[0]!.code };
    if (input.termsAccepted !== true || input.termsRevision !== context.config.legal.revision) {
      return { ok: false, code: 'starter_terms_required' };
    }
  }
  const action = bindings.actions[operation];
  if (!action) return { ok: false, code: 'host_binding_required' };
  return action(input, context);
}
