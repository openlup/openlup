import type { Locale } from '../shared/config.ts';
import type { PrivateCapture } from './private-capture.ts';
import { isUuid } from './recurring-fence.ts';

/** Private developer mailbox, preserving the original paid receipt on replay. */
export interface PaidMailArtifactV1 {
  schemaVersion: 1;
  kind: 'order_paid';
  messageKey: string;
  outboxEventId: string;
  orderId: string;
  recipient: string;
  recipientReference: string;
  templateReference: string;
  locale: Locale;
  subject: string;
  body: string;
}

const fail = (): never => { throw new Error('starter_paid_mail_identity_unavailable'); };
export const paidMailKey = (eventId: string) => `commerce-order-paid:${eventId}`;
function validate(value: unknown, key: string): PaidMailArtifactV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'kind', 'messageKey', 'outboxEventId', 'orderId', 'recipient',
    'recipientReference', 'templateReference', 'locale', 'subject', 'body'];
  if (Object.keys(row).sort().join() !== fields.sort().join()
    || row.schemaVersion !== 1 || row.kind !== 'order_paid' || row.messageKey !== key
    || !isUuid(row.outboxEventId) || key !== paidMailKey(String(row.outboxEventId))
    || typeof row.orderId !== 'string' || !isUuid(row.orderId.replace(/^order_/, ''))
    || !['en', 'pl'].includes(String(row.locale))
    || ['recipient', 'recipientReference', 'templateReference', 'subject', 'body'].some(field => typeof row[field] !== 'string' || !row[field].trim())
    || !String(row.recipientReference).startsWith('client:')
    || !isUuid(String(row.recipientReference).slice(7))
    || row.templateReference !== `template:commerce-order-paid:${row.locale}`) return fail();
  return value as PaidMailArtifactV1;
}

/** Shares the atomic, permission-checked private capture protocol with notices. */
export function createPaidMailArtifacts(capture: PrivateCapture) {
  return {
    async read(key: string): Promise<PaidMailArtifactV1 | null> {
      const value = await capture.read(key);
      return value === null ? null : validate(value, key);
    },
    async writeOnce(key: string, record: PaidMailArtifactV1): Promise<void> {
      await capture.writeOnce(key, { ...validate(record, key) });
    },
  };
}
