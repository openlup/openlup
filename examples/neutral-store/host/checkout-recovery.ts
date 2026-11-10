import { createPrivateCapture } from './private-capture.ts';
import type { PostgresCheckoutRecoveryTokenPort } from '@openlup/platform/commerce/server';
import type { ActionContext } from './bindings.ts';
import { routes } from '../shared/routes.ts';

export interface CheckoutRecoveryMessage {
  kind: 'checkout-recovery';
  email: string;
  subject: string;
  body: string;
  completionUrl: string;
  expiresAt: string;
  orderRef: string;
}
export interface PurchaseRecovery {
  tokens: PostgresCheckoutRecoveryTokenPort;
  deliver(input: { email: string; rawToken: string; orderRef: string; expiresAt: string; context: ActionContext; locale: 'en' | 'pl' }): Promise<void>;
}

/** Private delivery artifact, separate from authentication challenges and logs. */
export function createCheckoutRecoveryDelivery(origin: string,
  capture: (message: CheckoutRecoveryMessage) => Promise<void> = captureRecoveryMessage): PurchaseRecovery['deliver'] {
  return async ({ email, rawToken, orderRef, expiresAt, context, locale: language }) => {
    const copy = context.config.purchase.recoveryMessage;
    const completionUrl = new URL(routes.completion[language], origin);
    completionUrl.searchParams.set('token', rawToken);
    await capture({ kind: 'checkout-recovery', email, subject: copy.subject[language],
      body: [copy.body[language], completionUrl.href, `${copy.expiryLabel[language]} ${expiresAt}`,
        `${copy.orderLabel[language]} ${orderRef}`].join('\n'),
      completionUrl: completionUrl.href, expiresAt, orderRef });
  };
}
async function captureRecoveryMessage(message: CheckoutRecoveryMessage): Promise<void> {
  const capture = createPrivateCapture();
  const key = `checkout-recovery:${message.orderRef.toLowerCase()}`;
  await capture.writeOnce(key, { ...message });
  const committed = await capture.read(key);
  if (!committed) throw new Error('starter_private_capture_unavailable');
}

/** The original immutable capture is this application's frozen re-quote email source.
 * Missing, erased, malformed or foreign captures are never repaired from a profile. */
export async function readFrozenCheckoutEmail(orderRef: string, capture = createPrivateCapture()): Promise<string | null> {
  try {
    const value = await capture.read(`checkout-recovery:${orderRef.toLowerCase()}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'checkout-recovery' || value.orderRef !== orderRef.toLowerCase()
      || typeof value.email !== 'string' || value.email !== value.email.trim().toLowerCase()
      || value.email.length > 160 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email)) return null;
    return value.email;
  } catch { return null; }
}
