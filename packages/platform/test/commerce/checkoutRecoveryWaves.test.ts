import { afterEach, expect, it, vi } from 'vitest';
import { createCheckoutRecoveryWaveJob, createCheckoutRecoveryWaveHttpEntry } from '../../src/composition/checkoutRecoveryWaves.js';
import { withCheckoutRecoverySendEvidence } from '../../src/communications/checkoutRecoverySendEvidence.js';
import type { TransactionalEmailPort } from '../../src/commerce/outboxOrderDraftEmailPorts.js';
import { createCheckoutRecoveryContentFactory } from '../../src/communications/contracts/checkoutRecovery.js';
import { createOutboxCheckoutRecoveryEmailHandler } from '../../src/commerce/server/outboxCheckoutRecoveryEmailHandler.js';
import type { OutboxEventRow } from '@openlup/core/outbox';
import type { HttpRequest } from '../../src/http/index.js';

it.each(['method', 'missing-secret', 'wrong-bearer', 'disabled'])('guards %s before constructing persistence', async state => {
  const bind = vi.fn();
  const job = createCheckoutRecoveryWaveJob({ jobName: 'recovery', leaseSeconds: 120, batchSize: 200, enabled: () => state !== 'disabled', bind });
  const entry = createCheckoutRecoveryWaveHttpEntry(job, { secret: () => state === 'missing-secret' ? undefined : 'synthetic', invocationSource: 'fixture', now: () => '2040-01-02T12:00:00Z' });
  const result = await entry({ method: state === 'method' ? 'DELETE' : 'GET', headers: { authorization: state === 'wrong-bearer' ? 'Bearer other' : 'Bearer synthetic' } } as HttpRequest);
  expect(result.status).toBe(state === 'method' ? 405 : state === 'missing-secret' ? 503 : state === 'wrong-bearer' ? 401 : 200);
  expect(bind).not.toHaveBeenCalled();
});
const ordinaryMailMethods = [
  'sendReturnApprovedNotice', 'sendReturnRejectedNotice', 'sendOrderConfirmation', 'sendOrderPaidConfirmation',
  'sendPaymentFailedNotice', 'sendCheckoutExpiredNotice', 'sendOrderCanceledNotice', 'sendOrderRefundedNotice',
  'sendShipmentDispatchedNotice', 'sendShipmentDeliveredNotice', 'sendShipmentExceptionNotice',
] as const satisfies readonly Exclude<keyof TransactionalEmailPort, 'findExistingSend' | 'sendCheckoutRecovery'>[];

it.each(['plain', 'frozen'] as const)('delegates every email method without mutating a %s object port', async kind => {
  const outcome = { ok: true, messageId: 'capture:1', httpStatus: 200, providerError: null, aborted: false };
  const base = {
    findExistingSend: vi.fn<TransactionalEmailPort['findExistingSend']>(async (_template, event) => event === 'ordinary:1'),
    sendReturnApprovedNotice: vi.fn<TransactionalEmailPort['sendReturnApprovedNotice']>(async () => outcome),
    sendReturnRejectedNotice: vi.fn<TransactionalEmailPort['sendReturnRejectedNotice']>(async () => outcome),
    sendOrderConfirmation: vi.fn<TransactionalEmailPort['sendOrderConfirmation']>(async () => outcome),
    sendCheckoutRecovery: vi.fn<TransactionalEmailPort['sendCheckoutRecovery']>(async () => outcome),
    sendOrderPaidConfirmation: vi.fn<TransactionalEmailPort['sendOrderPaidConfirmation']>(async () => outcome),
    sendPaymentFailedNotice: vi.fn<TransactionalEmailPort['sendPaymentFailedNotice']>(async () => outcome),
    sendCheckoutExpiredNotice: vi.fn<TransactionalEmailPort['sendCheckoutExpiredNotice']>(async () => outcome),
    sendOrderCanceledNotice: vi.fn<TransactionalEmailPort['sendOrderCanceledNotice']>(async () => outcome),
    sendOrderRefundedNotice: vi.fn<TransactionalEmailPort['sendOrderRefundedNotice']>(async () => outcome),
    sendShipmentDispatchedNotice: vi.fn<TransactionalEmailPort['sendShipmentDispatchedNotice']>(async () => outcome),
    sendShipmentDeliveredNotice: vi.fn<TransactionalEmailPort['sendShipmentDeliveredNotice']>(async () => outcome),
    sendShipmentExceptionNotice: vi.fn<TransactionalEmailPort['sendShipmentExceptionNotice']>(async () => outcome),
  } satisfies TransactionalEmailPort;
  const original = kind === 'frozen' ? Object.freeze(base) : base;
  const descriptors = Object.getOwnPropertyDescriptors(original), prototype = Object.getPrototypeOf(original);
  const recordConfirmedSend = vi.fn();
  const wrapped: TransactionalEmailPort = withCheckoutRecoverySendEvidence(original, { recordConfirmedSend });
  expect(wrapped).not.toBe(original);
  expect(Object.keys(wrapped).sort()).toEqual([...ordinaryMailMethods, 'findExistingSend', 'sendCheckoutRecovery'].sort());
  expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors);
  const input = { to: 'recipient@example.invalid', firstName: null, orderId: 'order:1', outboxEventId: 'ordinary:1',
    items: [], totals: null, signal: new AbortController().signal };
  // The facade forwards each opaque domain input unchanged, without interpreting it.
  for (const method of ordinaryMailMethods) {
    expect(await wrapped[method](input as never)).toBe(outcome);
    expect(base[method]).toHaveBeenCalledExactlyOnceWith(input);
    expect(base[method].mock.contexts[0]).toBe(original);
  }
  expect(await wrapped.findExistingSend('ordinary-template', input.outboxEventId)).toBe(true);
  expect(base.findExistingSend).toHaveBeenCalledExactlyOnceWith('ordinary-template', 'ordinary:1');
  expect(base.findExistingSend.mock.contexts[0]).toBe(original);
  expect(recordConfirmedSend).not.toHaveBeenCalled();
  const recovery = { ...input, recoveryToken: 'rcv_synthetic', mode: 'one_time', reminderHours: 1, outboxEventId: 'recovery:1' };
  expect(await wrapped.sendCheckoutRecovery(recovery)).toBe(outcome);
  expect(base.sendCheckoutRecovery).toHaveBeenCalledExactlyOnceWith(recovery);
  expect(base.sendCheckoutRecovery.mock.contexts[0]).toBe(original);
  expect(recordConfirmedSend).toHaveBeenCalledExactlyOnceWith('recovery:1', 'capture:1');
  expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors);
  expect(Object.getPrototypeOf(original)).toBe(prototype);
  expect(Object.isFrozen(original)).toBe(kind === 'frozen');
});
it('delegates prototype methods and private state on a class-backed transactional email port', async () => {
  const outcome = { ok: true, messageId: 'capture:class', httpStatus: 200, providerError: null, aborted: false };
  const unselected = async (): Promise<never> => { throw Error('unselected_mail'); };
  class EmailPort implements TransactionalEmailPort {
    #sent = new Set<string>();
    async findExistingSend(template: string, event: string) { return this.#sent.has(`${template}:${event}`); }
    async sendOrderConfirmation(input: Parameters<TransactionalEmailPort['sendOrderConfirmation']>[0]) {
      this.#sent.add(`order:${input.outboxEventId}`); return outcome;
    }
    async sendCheckoutRecovery(input: Parameters<TransactionalEmailPort['sendCheckoutRecovery']>[0]) {
      this.#sent.add(`recovery:${input.outboxEventId}`); return outcome;
    }
    sendReturnApprovedNotice = unselected;
    sendReturnRejectedNotice = unselected;
    sendOrderPaidConfirmation = unselected;
    sendPaymentFailedNotice = unselected;
    sendCheckoutExpiredNotice = unselected;
    sendOrderCanceledNotice = unselected;
    sendOrderRefundedNotice = unselected;
    sendShipmentDispatchedNotice = unselected;
    sendShipmentDeliveredNotice = unselected;
    sendShipmentExceptionNotice = unselected;
  }
  const original = new EmailPort(), recordConfirmedSend = vi.fn();
  const descriptors = Object.getOwnPropertyDescriptors(original), prototype = Object.getPrototypeOf(original);
  const wrapped: TransactionalEmailPort = withCheckoutRecoverySendEvidence(original, { recordConfirmedSend });
  expect(wrapped).not.toBe(original);
  expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors);
  const ordinary = { to: 'recipient@example.invalid', firstName: null, orderId: 'order:1', outboxEventId: 'ordinary:1',
    items: [], totals: null, signal: new AbortController().signal };
  expect(await wrapped.findExistingSend('order', ordinary.outboxEventId)).toBe(false);
  expect(await wrapped.sendOrderConfirmation(ordinary)).toBe(outcome);
  expect(await wrapped.findExistingSend('order', ordinary.outboxEventId)).toBe(true);
  expect(await original.findExistingSend('order', ordinary.outboxEventId)).toBe(true);
  expect(recordConfirmedSend).not.toHaveBeenCalled();
  const recovery = { ...ordinary, recoveryToken: 'rcv_synthetic', mode: 'one_time', reminderHours: 1, outboxEventId: 'recovery:1' };
  expect(await wrapped.sendCheckoutRecovery(recovery)).toBe(outcome);
  expect(await wrapped.findExistingSend('recovery', recovery.outboxEventId)).toBe(true);
  expect(recordConfirmedSend).toHaveBeenCalledExactlyOnceWith('recovery:1', 'capture:class');
  expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors);
  expect(Object.getPrototypeOf(original)).toBe(prototype);
});
it('keeps ambiguous acceptance-write failure visible to the caller', async () => {
  const base = { sendCheckoutRecovery: async () => ({ ok: true, messageId: 'capture:1', httpStatus: 200, providerError: null, aborted: false }) } as unknown as TransactionalEmailPort;
  const wrapped = withCheckoutRecoverySendEvidence(base, { recordConfirmedSend: async () => { throw Error('receipt unavailable'); } });
  await expect(wrapped.sendCheckoutRecovery({ outboxEventId: 'event:1' } as Parameters<typeof wrapped.sendCheckoutRecovery>[0])).rejects.toThrow('receipt unavailable');
});

afterEach(() => { vi.useRealTimers(); });

it.each(['en', 'pl'] as const)('retains configured first/final recovery content for %s', locale => {
  const copy = (language: string) => ({ greeting: () => `${language}:hello`, cta: `${language}:pay`,
    subjectFirst: `${language}:first`, subjectFinal: `${language}:final`, preheader: `${language}:preview`,
    headingFirst: `${language}:heading-first`, headingFinal: `${language}:heading-final`,
    introSubscription: `${language}:subscription`, introOneTime: `${language}:purchase`,
    contextCheer: () => `${language}:context`, subscriptionCheer: () => `${language}:subscription-context`, finalNote: `${language}:deadline` });
  const content = createCheckoutRecoveryContentFactory({ commerceEmailContent: { checkoutRecovery: { en: copy('en'), pl: copy('pl') } } });
  for (const wave of [1, 20] as const) {
    const email = content.checkoutRecoveryEmailContent(locale, { firstName: null, brandName: 'Example', mode: 'one_time',
      reminderHours: wave, recoveryUrl: 'https://example.test/complete?token=rcv_synthetic' }, 'signature');
    expect(email.subject).toBe(`${locale}:${wave === 1 ? 'first' : 'final'}`);
    expect(email.blocks).toContainEqual({ kind: 'button', label: `${locale}:pay`, href: 'https://example.test/complete?token=rcv_synthetic' });
    const text = email.blocks.flatMap(block => 'text' in block ? [block.text] : []).join(' ');
    expect(text.includes(`${locale}:deadline`)).toBe(wave === 20);
    expect(text.includes(`${locale}:context`)).toBe(wave === 1);
  }
});

it.each(['paid', 'succeeded', 'fresh', 'exhausted', 'recipient', 'dedupe'])('retains recovery-handler %s refusal/dedupe behavior', async state => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-02T12:00:00Z'));
  const orderId = '11111111-2222-4333-8444-555555555555';
  const send = vi.fn(async () => ({ ok: true, messageId: 'capture:1', httpStatus: 200, providerError: null, aborted: false }));
  const handler = createOutboxCheckoutRecoveryEmailHandler({
    emailPort: { sendCheckoutRecovery: send, findExistingSend: async () => state === 'dedupe' } as unknown as TransactionalEmailPort,
    recipientPort: { resolve: async () => state === 'recipient' ? null : { email: 'reader@example.invalid', firstName: null } },
    lifecyclePort: { read: async () => ({ orderStatus: state === 'paid' ? 'paid' : 'pending_payment',
      paymentStatus: state === 'succeeded' ? 'succeeded' : ['fresh', 'exhausted'].includes(state) ? 'processing' : null,
      paymentUpdatedAt: '2040-01-02T11:59:00Z', hasPayment: state === 'succeeded' }) },
    runtime: { resolveLocale: () => 'en', parseOutboxPayload: (schema, payload) => { const parsed = schema.safeParse(payload);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, outcome: { kind: 'discard', reason: 'invalid_payload' } }; },
      mapSendOutcome: outcome => outcome.ok ? { kind: 'processed' } : { kind: 'retry', reason: 'send_failed' } },
  });
  const row: OutboxEventRow = { id: orderId, aggregate_id: orderId, aggregate_type: 'commerce_order',
    event_type: 'commerce.checkout_recovery', idempotency_key: `checkout_recovery:1h:${orderId}`,
    created_at: '2040-01-02T12:00:00Z', available_at: '2040-01-02T12:00:00Z', processed_at: null,
    status: 'processing', attempts: state === 'exhausted' ? 5 : 1, payload: { orderId, recoveryToken: 'rcv_synthetic' }, error: null, metadata: {} };
  const outcome = await handler.handle(row, new AbortController().signal);
  if (state === 'fresh') expect(outcome).toEqual({ kind: 'retry', reason: 'payment_session_active' });
  else if (state === 'dedupe') expect(outcome).toEqual({ kind: 'processed', detail: { dedupe: 'email_already_sent' } });
  else expect(outcome).toEqual({ kind: 'processed', detail: { skipped: {
    paid: 'order_not_pending_payment', succeeded: 'order_already_paid', exhausted: 'payment_session_exhausted', recipient: 'recipient_unresolved',
  }[state] } });
  expect(send).not.toHaveBeenCalled();
});
