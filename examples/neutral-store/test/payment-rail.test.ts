import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaymentAdapter } from '@openlup/platform/payments/contracts';
import { createOwnedPaymentRail } from '../owned/payment-rail.ts';

function buildStubAdapter(): PaymentAdapter {
  return {
    capabilities: {
      providerKind: 'stub_provider',
      captureFlows: [{ kind: 'redirect_payment', handoff: 'redirect', methodFamilies: ['card'] }],
      requiresStoredMandateEvidence: false,
      unattendedChargeFlow: 'off_session_payment',
      payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
      methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
      terminalOutcomeReporting: { kind: 'status_field', silenceBecomesSuspectAfterMinutes: 360 },
      mandateUpsertIsSubscriptionScoped: false,
      supportedCurrencies: ['USD'],
      unattended: 'unsupported',
      readback: 'unsupported',
      close: 'unsupported',
      exactAbsence: 'unsupported',
      refundObservation: 'unsupported',
      refundCreate: 'unsupported',
      authorizationCaptureSplit: 'unsupported',
      assessMandate: () => ({ chargeable: false, status: 'not_applicable', reasons: [] }),
    },
    attemptPort: {
      validateInput() {
        return null;
      },
      async execute() {
        return {
          outcome: { kind: 'attempt', status: 'processing' },
          dispatch: { kind: 'unknown' },
          diagnostics: {},
        };
      },
    },
    verifyPort: {
      async verifyAndNormalize() {
        return { kind: 'refusal', reason: 'signature' };
      },
    },
    readbackPort: {
      async readPayment(input) {
        return { ...input, kind: 'unsupported' };
      },
    },
  };
}

test('createOwnedPaymentRail stays in sandbox mode when no adapters are supplied', () => {
  const result = createOwnedPaymentRail();
  assert.equal(result.mode, 'sandbox');
  assert.equal(result.registry, null);
  assert.equal(result.rails.size, 0);
});

test('createOwnedPaymentRail refuses provider mode when required host ports are omitted', () => {
  assert.throws(
    () => createOwnedPaymentRail({ adapters: [buildStubAdapter()] }),
    /owned_payment_rail_host_ports_required/,
  );
});

test('createOwnedPaymentRail mounts an external adapter into the provider registry and postgres rail', () => {
  const stub = buildStubAdapter();
  const composed = createOwnedPaymentRail({
    adapters: [stub],
    executor: {
      async query() {
        return { rows: [] };
      },
    },
    railMode: 'test',
    truth: {
      dunningTemplateSlug: 'payment-failed',
      recoveryUrlPath: '/account/recovery',
      recoveryTemplateSlug: 'checkout-recovery',
    },
    resolveMethodOwner: async () => null,
    resolveSavedMethodOwner: async () => null,
  });
  assert.equal(composed.mode, 'provider');
  assert.ok(composed.registry);
  assert.equal(composed.registry.get('stub_provider'), stub);
  assert.equal(composed.rails.get('stub_provider')?.provider, 'stub_provider');
});
