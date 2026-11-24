import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmailTransport } from '@openlup/platform/communications';
import { createOwnedEmailTransport } from './email-transport.ts';

test('createOwnedEmailTransport defaults to zero-credential in-memory sandbox capture', async () => {
  const composed = createOwnedEmailTransport();
  assert.equal(composed.mode, 'sandbox');
  assert.ok(composed.captured);
  const result = await composed.transport.send({
    from: 'store@example.test',
    to: 'buyer@example.test',
    subject: 'Order confirmed',
    html: '<p>Confirmed</p>',
  });
  assert.equal(result.outcome.ok, true);
  assert.equal(composed.captured.sent.length, 1);
});

test('createOwnedEmailTransport wraps an external provider transport with fail-closed policy guards', async () => {
  let called = 0;
  const custom: EmailTransport = {
    providerKind: 'stub_email',
    async send() {
      called += 1;
      return {
        outcome: { ok: true, resendId: 'msg_test_001', providerError: null, httpStatus: 200, aborted: false },
        providerResponse: { id: 'msg_test_001' },
      };
    },
  };
  const composed = createOwnedEmailTransport({ transport: custom });
  assert.equal(composed.mode, 'provider');
  assert.equal(composed.captured, null);
  assert.equal(composed.transport.providerKind, 'stub_email');
  const refused = await composed.transport.send({
    from: 'store@example.test',
    to: 'buyer@example.test',
    subject: 'Blocked unadmitted transport',
    html: '<p>Test</p>',
  });
  assert.equal(refused.outcome.ok, false);
  assert.equal(called, 0);
});
