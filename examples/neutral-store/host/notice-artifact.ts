import type { Locale } from '../shared/config.ts';
import type { PrivateCapture } from './private-capture.ts';
import { isUuid } from './recurring-fence.ts';

// These are the notice kinds admitted by the selected native message owners.
export const noticeKinds = [
  'payment_failed', 'payment_expired', 'payment_recovery', 'payment_recovered',
  'winback_eligible', 'stock_wait_started', 'stock_wait_resumed',
  'subscription.created', 'subscription.activation_action_required',
  'subscription.cancelled', 'subscription.paused', 'subscription.resumed',
  'subscription.pause_reminder_due', 'subscription.delivery_rescheduled',
  'subscription.cycle_skipped', 'subscription.address_changed',
  'subscription.package_changed', 'subscription.renewal_upcoming', 'subscription.renewal_at_risk',
  'subscription_stock_wait.started', 'subscription_stock_wait.resumed',
] as const;

/** The developer mailbox preserves the original rendered content on every replay. */
export interface NoticeArtifactV1 {
  schemaVersion: 1;
  kind: typeof noticeKinds[number];
  messageKey: string;
  noticeId: string;
  subscriptionId: string;
  clientId: string;
  caseId: string | null;
  orderId: string | null;
  operationId: string | null;
  obligationId: string | null;
  token: string | null;
  recoveryUrl: string | null;
  expiresAt: string | null;
  recipient: string;
  recipientReference: string;
  templateReference: string;
  subject: string;
  body: string;
  locale: Locale;
}

const fail = (): never => { throw new Error('starter_notice_identity_unavailable'); };
export function isNoticeKind(value: unknown): value is NoticeArtifactV1['kind'] {
  return typeof value === 'string' && noticeKinds.some(kind => kind === value);
}

function validate(value: unknown, key: string): NoticeArtifactV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'kind', 'messageKey', 'noticeId', 'subscriptionId', 'clientId',
    'caseId', 'orderId', 'operationId', 'obligationId', 'token', 'recoveryUrl', 'expiresAt',
    'recipient', 'recipientReference', 'templateReference', 'subject', 'body', 'locale'];
  if (Object.keys(row).sort().join() !== fields.sort().join()
    || row.schemaVersion !== 1 || !isNoticeKind(row.kind) || row.messageKey !== key
    || !isUuid(row.noticeId) || !isUuid(row.subscriptionId) || !isUuid(row.clientId)
    || ['caseId', 'orderId', 'operationId', 'obligationId'].some(field => row[field] !== null && !isUuid(row[field]))
    || ['recipient', 'recipientReference', 'templateReference', 'subject', 'body'].some(field => typeof row[field] !== 'string')
    || !['en', 'pl'].includes(String(row.locale))) return fail();
  const needsToken = ['payment_failed', 'payment_expired', 'payment_recovery'].includes(row.kind);
  if (needsToken) {
    if (typeof row.token !== 'string' || !/^(?:rcv_)?[A-Za-z0-9_-]{43}$/.test(row.token)
      || typeof row.recoveryUrl !== 'string' || typeof row.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(row.expiresAt))
      || [row.caseId, row.orderId, row.operationId, row.obligationId].some(id => id === null)) return fail();
    try {
      const url = new URL(row.recoveryUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.searchParams.getAll('token').length !== 1 || url.searchParams.get('token') !== row.token) return fail();
    } catch { return fail(); }
  } else if (row.token !== null || row.recoveryUrl !== null || row.expiresAt !== null) return fail();
  return value as NoticeArtifactV1;
}

/** One schema and one writer/reader, backed by the existing private capture protocol. */
export function createNoticeArtifacts(capture: PrivateCapture) {
  return {
    async read(key: string): Promise<NoticeArtifactV1 | null> {
      const value = await capture.read(key);
      return value === null ? null : validate(value, key);
    },
    async writeOnce(key: string, record: NoticeArtifactV1): Promise<void> {
      await capture.writeOnce(key, { ...validate(record, key) });
    },
  };
}
