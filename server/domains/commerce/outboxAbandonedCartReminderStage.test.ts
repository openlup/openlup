import { expect, it, vi } from 'vitest';
import { createOutboxAbandonedCartEmailHandler } from './outboxAbandonedCartEmailHandler.js';
import type { MarketingEmailPort } from './marketingEmailPorts.js';
import type { OutboxEventRow } from './outboxDispatchContracts.js';

const orderUuid = '11111111-2222-4333-8444-555555555555';
function fixture(hours: 1 | 24 | 72) {
  const send = vi.fn<MarketingEmailPort['send']>(async () => ({ ok: true, resendId: 'fixture', httpStatus: 200, providerError: null, aborted: false }));
  const resolve = vi.fn(async () => ({ email: 'fixture@example.invalid', firstName: null, country: 'ZZ' }));
  const handler = createOutboxAbandonedCartEmailHandler({ recipientPort: { resolve },
    conversionPort: { isConverted: async () => false }, consentEvaluator: { evaluate: async () => ({ allowed: true, reason: 'allowed', decisionId: 'fixture' }) },
    marketingEmailPort: { send, findExistingSend: async () => false }, baseUrl: 'https://example.invalid',
    buildUnsubscribeUrl: async () => 'https://example.invalid/unsubscribe', eventType: `commerce.order_draft.abandoned.${hours}h`, reminderHours: hours });
  const signal = new AbortController().signal;
  const run = (payload: unknown) => handler.handle({ id: orderUuid, payload } as OutboxEventRow, signal);
  return { run, send, resolve };
}
it.each([[1, 'first'], [24, 'gentle'], [72, 'last']] as const)('old %ih payload and explicit %s render identical mail, including custom hours', async (hours, stage) => {
  const { run, send } = fixture(hours);
  await run({ orderUuid, reminderHours: hours }); const old = send.mock.lastCall?.[0];
  await run({ orderUuid, reminderHours: hours, stage }); expect(send.mock.lastCall?.[0]).toEqual(old);
  await run({ orderUuid, reminderHours: 48, stage }); expect(send.mock.lastCall?.[0]).toEqual(old);
  await run({ orderUuid }); expect(send.mock.lastCall?.[0]).toEqual(old);
});
it.each(['unknown', null, 1])('refuses malformed abandoned-cart stage before reading or sending: %j', async stage => {
  const f = fixture(72); const result = await f.run({ orderUuid, reminderHours: 48, stage });
  expect(result).toMatchObject({ kind: 'discard', reason: expect.stringContaining('contract_parse_failed') });
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});
