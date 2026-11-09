import { expect, it, vi } from 'vitest';
import { createCheckoutRecoveryWaveJob, createCheckoutRecoveryWaveHttpEntry } from '../../src/composition/checkoutRecoveryWaves.js';
import { withCheckoutRecoverySendEvidence } from '../../src/communications/checkoutRecoverySendEvidence.js';
import type { TransactionalEmailPort } from '../../src/commerce/outboxOrderDraftEmailPorts.js';
import type { HttpRequest } from '../../src/http/index.js';

it.each(['method', 'missing-secret', 'wrong-bearer', 'disabled'])('guards %s before constructing persistence', async state => {
  const bind = vi.fn();
  const job = createCheckoutRecoveryWaveJob({ jobName: 'recovery', leaseSeconds: 120, batchSize: 200, enabled: () => state !== 'disabled', bind });
  const entry = createCheckoutRecoveryWaveHttpEntry(job, { secret: () => state === 'missing-secret' ? undefined : 'synthetic', invocationSource: 'fixture', now: () => '2040-01-02T12:00:00Z' });
  const result = await entry({ method: state === 'method' ? 'DELETE' : 'GET', headers: { authorization: state === 'wrong-bearer' ? 'Bearer other' : 'Bearer synthetic' } } as HttpRequest);
  expect(result.status).toBe(state === 'method' ? 405 : state === 'missing-secret' ? 503 : state === 'wrong-bearer' ? 401 : 200);
  expect(bind).not.toHaveBeenCalled();
});
it('retains every other mail method, confirmed transport result, and dedupe identity', async () => {
  const sendOrderConfirmation = vi.fn(), findExistingSend = vi.fn(), recordConfirmedSend = vi.fn();
  const outcome = { ok: true, messageId: 'capture:1', httpStatus: 200, providerError: null, aborted: false };
  const base = { sendOrderConfirmation, findExistingSend, sendCheckoutRecovery: async () => outcome } as unknown as TransactionalEmailPort;
  const wrapped = withCheckoutRecoverySendEvidence(base, { recordConfirmedSend });
  expect(wrapped.sendOrderConfirmation).toBe(sendOrderConfirmation); expect(wrapped.findExistingSend).toBe(findExistingSend);
  const input = { outboxEventId: 'event:1' } as Parameters<typeof wrapped.sendCheckoutRecovery>[0];
  expect(await wrapped.sendCheckoutRecovery(input)).toBe(outcome);
  expect(recordConfirmedSend).toHaveBeenCalledExactlyOnceWith('event:1', 'capture:1');
});
it('keeps ambiguous acceptance-write failure visible to the caller', async () => {
  const base = { sendCheckoutRecovery: async () => ({ ok: true, messageId: 'capture:1', httpStatus: 200, providerError: null, aborted: false }) } as unknown as TransactionalEmailPort;
  const wrapped = withCheckoutRecoverySendEvidence(base, { recordConfirmedSend: async () => { throw Error('receipt unavailable'); } });
  await expect(wrapped.sendCheckoutRecovery({ outboxEventId: 'event:1' } as Parameters<typeof wrapped.sendCheckoutRecovery>[0])).rejects.toThrow('receipt unavailable');
});
