import { expect, it, vi } from 'vitest';
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderSchedule } from '../../src/commerce/server/checkoutRecoveryReminderSchedule.js';
import { createCheckoutRecoveryContentFactory } from '../../src/communications/contracts/checkoutRecovery.js';
import { createAbandonedCartContentFactory } from '../../src/communications/contracts/abandonedCart.js';
import { createOutboxCheckoutRecoveryEmailHandler } from '../../src/commerce/server/outboxCheckoutRecoveryEmailHandler.js';
import type { TransactionalEmailPort } from '../../src/commerce/outboxOrderDraftEmailPorts.js';
import type { OutboxEventRow } from '@openlup/core/outbox';

const defaults = { revision: 'default',
  abandonedCart: [{ stage: 'first', afterHours: 1 }, { stage: 'gentle', afterHours: 24 }, { stage: 'last', afterHours: 72 }],
  checkoutRecovery: [{ stage: 'first', afterHours: 1 }, { stage: 'last', afterHours: 20 }] } as const;
const malformedSchedules: unknown[] = [null, [], {}, { ...defaults, revision: '' }, { ...defaults, revision: ' \t' },
  { ...defaults, extra: true }, { ...defaults, abandonedCart: [] }, { ...defaults, checkoutRecovery: null },
  ...[0, -1, 1.5, '20', null, 2147483648, Infinity].map(afterHours => ({ ...defaults, checkoutRecovery: [{ stage: 'last', afterHours }] })),
  ...['gentle', 'unknown', null].map(stage => ({ ...defaults, checkoutRecovery: [{ stage, afterHours: 20 }] })),
  { ...defaults, abandonedCart: [{ stage: 'first', afterHours: 1 }] },
  { ...defaults, abandonedCart: [{ stage: 'last', afterHours: 1 }, { stage: 'last', afterHours: 2 }] },
  { ...defaults, abandonedCart: [{ stage: 'first', afterHours: 2 }, { stage: 'last', afterHours: 2 }] },
  { ...defaults, abandonedCart: [{ stage: 'first', afterHours: 3 }, { stage: 'last', afterHours: 2 }] },
  { ...defaults, checkoutRecovery: [{ stage: 'last', afterHours: 20, extra: true }] },
  { ...defaults, checkoutRecovery: [null] }, { ...defaults, checkoutRecovery: [1] },
  { ...defaults, checkoutRecovery: [{ afterHours: 20 }] },
];
it('defaults only for absence, returns independent values, and explicitly installs the custom schedule', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const first = await readCheckoutRecoveryReminderSchedule({ query });
  expect(first).toEqual(defaults);
  (first.abandonedCart as { afterHours: number }[])[0]!.afterHours = 99;
  expect(await readCheckoutRecoveryReminderSchedule({ query })).toEqual(defaults);
  const custom = { ...defaults, revision: 'owned-1', checkoutRecovery: [{ stage: 'last', afterHours: 48 }] } as const;
  await installCheckoutRecoveryReminderSchedule({ query }, custom);
  expect(query).toHaveBeenLastCalledWith('SELECT public.commerce_install_checkout_recovery_reminder_schedule($1::text, $2::jsonb)', ['checkout_recovery_reminders', JSON.stringify(custom)]);
  query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(custom) }] });
  expect(await readCheckoutRecoveryReminderSchedule({ query })).toEqual(custom);
});
it.each(malformedSchedules)('refuses invalid schedule before writes and on installed reads: %j', async value => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: JSON.stringify(value) }] });
  await expect(installCheckoutRecoveryReminderSchedule({ query }, value as never)).rejects.toThrow('checkout_recovery_reminder_schedule_invalid');
  expect(query).not.toHaveBeenCalled();
  await expect(readCheckoutRecoveryReminderSchedule({ query })).rejects.toThrow('checkout_recovery_reminder_schedule_invalid');
});
it.each([null, '{bad', 'undefined'])('names malformed persisted JSON: %j', async value_text => {
  await expect(readCheckoutRecoveryReminderSchedule({ query: async () => ({ rows: [{ value_text }] }) }))
    .rejects.toThrow('checkout_recovery_reminder_schedule_invalid');
});
const recoveryCopy = { greeting: () => 'hello', cta: 'pay', subjectFirst: 'first', subjectFinal: 'final', preheader: 'preview',
  headingFirst: 'first', headingFinal: 'final', introSubscription: 'subscription', introOneTime: 'purchase',
  contextCheer: () => 'context', subscriptionCheer: () => 'subscription-context', finalNote: 'deadline' };
const tone = (name: string) => ({ subject: name, preheader: name, heading: name, intro: name, body: name, cta: name });
const abandonedCopy = { greeting: () => 'hello', first: tone('first'), gentle: tone('gentle'), last: tone('last') };
it.each(['en', 'pl'] as const)('preserves old content bytes and lets explicit stage override hours in %s', locale => {
  const recovery = createCheckoutRecoveryContentFactory({ commerceEmailContent: { checkoutRecovery: { en: recoveryCopy, pl: recoveryCopy } } }).checkoutRecoveryEmailContent;
  const abandoned = createAbandonedCartContentFactory({ commerceEmailContent: { abandonedCart: { en: abandonedCopy, pl: abandonedCopy } }, marketingUnsubscribeFooter: () => [] }).abandonedCartEmailContent;
  const common = { firstName: null, brandName: 'Example', recoveryUrl: 'https://example.invalid/recover', mode: 'one_time' as const,
    ctaUrl: 'https://example.invalid/cart', unsubscribeUrl: 'https://example.invalid/unsubscribe' };
  for (const [hours, stage] of [[1, 'first'], [20, 'last']] as const) {
    const old = recovery(locale, { ...common, reminderHours: hours }, 'signature');
    expect(recovery(locale, { ...common, reminderHours: hours, stage }, 'signature')).toEqual(old);
    expect(recovery(locale, { ...common, reminderHours: 48, stage }, 'signature')).toEqual(old);
  }
  for (const [hours, stage] of [[1, 'first'], [24, 'gentle'], [72, 'last']] as const) {
    const old = abandoned(locale, { ...common, reminderHours: hours }, 'signature');
    expect(abandoned(locale, { ...common, reminderHours: hours, stage }, 'signature')).toEqual(old);
    expect(abandoned(locale, { ...common, reminderHours: 48, stage }, 'signature')).toEqual(old);
  }
});
it.each([undefined, 'first', 'last', 'unknown', null])('decodes legacy/new recovery stage or refuses unknown values: %j', async stage => {
  const send = vi.fn<TransactionalEmailPort['sendCheckoutRecovery']>(async () => ({ ok: true, messageId: 'fixture', httpStatus: 200, providerError: null, aborted: false }));
  const read = vi.fn(async () => ({ orderStatus: 'pending_payment', paymentStatus: null, hasPayment: false }));
  const handler = createOutboxCheckoutRecoveryEmailHandler({
    emailPort: { sendCheckoutRecovery: send, findExistingSend: async () => false } as unknown as TransactionalEmailPort,
    lifecyclePort: { read }, recipientPort: { resolve: async () => ({ email: 'fixture@example.invalid', firstName: null }) },
    runtime: { resolveLocale: () => 'en', parseOutboxPayload: (schema, payload) => { const p = schema.safeParse(payload);
      return p.success ? { ok: true, data: p.data } : { ok: false, outcome: { kind: 'discard', reason: 'contract_parse_failed' } }; },
      mapSendOutcome: () => ({ kind: 'processed' }) },
  });
  const orderId = '11111111-2222-4333-8444-555555555555';
  const payload = { orderId, recoveryToken: 'rcv_fixture', reminderHours: stage === undefined ? 20 : 48,
    ...(stage === undefined ? {} : { stage }) };
  const outcome = await handler.handle({ id: orderId, payload } as OutboxEventRow, new AbortController().signal);
  if (stage === 'unknown' || stage === null) { expect(outcome.kind).toBe('discard'); expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); }
  else { expect(outcome.kind).toBe('processed'); expect(send.mock.lastCall?.[0]).toMatchObject(payload);
    if (stage === undefined) expect(send.mock.lastCall?.[0]).not.toHaveProperty('stage'); }
});
