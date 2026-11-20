import type { PaymentRepairMethodPort } from "@openlup/platform/payments/contracts";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
} from "../../_lib/bff/response.js";
import { customerCauseForFailureClass } from "@openlup/core/payment";

import type { DunningCaseDisplayFacts } from "../subscription/subscriptionDunningDispatchPorts.js";

import {
  PAYMENT_RECOVERY_CONTRACT_VERSION,
  paymentRecoverySetupMethodRequestSchema,
  paymentRecoverySetupMethodResponseSchema,
} from "../../../src/domains/payment/contracts.js";
import type {
  CustomerRecoveryAuthenticationResult,
  SubscriptionPaymentRecoverySetupPort,
  SubscriptionRecoveryCaseResolution,
} from "../subscription/paymentRecoveryPorts.js";
import { admitPaymentRecoveryRequest } from "../subscription/paymentRecoveryHandler.js";

/**
 * Wave D-4a — mints a Stripe SetupIntent for the recovery flow.
 *
 * The handler validates the recovery token and the customer's auth session
 * (same triple-flag gate + token rules as `redeem.ts`), then resolves the
 * subscription's existing Stripe customer reference and asks the injected
 * `createSetupIntent` callback to create the intent with metadata tagged
 * `{ clientId, subscriptionId, recoveryCaseId }`. The webhook normalizer
 * (Wave C + Wave D-4a) reads those tags on `setup_intent.succeeded` and
 * upserts the new `commerce_payment_method_refs` row bound to the
 * subscription.
 *
 * Both token purposes mint here, and the purpose decides what the webhook's
 * follow-up call can do. `repair_payment` runs on an open case, where the
 * webhook also makes that exact failed cycle retryable — the cron sees the
 * cycle only after both facts are durable. `resume_subscription` runs on an
 * expired case, where the same call is a no-op, so the webhook only lands the
 * method row and the redeem RPC alone decides whether the resume happens.
 */
export type PaymentRecoverySubscriptionResolution = SubscriptionRecoveryCaseResolution;

export interface StripeSetupIntentCallbackInput {
  customer: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface StripeSetupIntentCallbackResult {
  setupIntentId: string;
  clientSecret: string;
  replayed: boolean;
}

export type StripeSetupIntentCallback = (
  input: StripeSetupIntentCallbackInput,
) => Promise<StripeSetupIntentCallbackResult>;

export interface PaymentRecoverySetupHandlerDeps {
  enabled: () => boolean;
  authenticateCustomer: (req: VercelRequest) => Promise<CustomerRecoveryAuthenticationResult | { ok: false }>;
  recoveryPort: SubscriptionPaymentRecoverySetupPort;
  /** Neutral payment-method repair port; preferred over legacy `createSetupIntent`. */
  methodPort?: PaymentRepairMethodPort;
  /** @deprecated Prefer `methodPort` (`PaymentRepairMethodPort`). Retained for 1.x callers. */
  createSetupIntent?: StripeSetupIntentCallback;
  /** Optional provider kind passed when resolving an existing provider customer ref. */
  providerKind?: string;
  ensureCustomer: (input: {
    clientId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }) => Promise<string>;
  /**
   * Display facts for the case being repaired. OPTIONAL by design: a deployment
   * that cannot answer them still mints the SetupIntent and still repairs the
   * method — the payer simply gets the page as it was before this wave.
   */
  caseDisplayFacts?: { read(caseId: string): Promise<DunningCaseDisplayFacts> };
  now?: () => Date;
}

export function createPaymentRecoverySetupHandler({
  enabled,
  authenticateCustomer,
  recoveryPort,
  methodPort,
  createSetupIntent,
  providerKind,
  ensureCustomer,
  caseDisplayFacts,
  now = () => new Date(),
}: PaymentRecoverySetupHandlerDeps) {
  if (!methodPort && !createSetupIntent) {
    throw new Error("payment_recovery_setup_method_port_required");
  }
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const admitted = await admitPaymentRecoveryRequest({
      req,
      res,
      enabled,
      authenticateCustomer,
      recoveryPort,
      schema: paymentRecoverySetupMethodRequestSchema,
      badRequestMessage: "Invalid payment recovery setup request",
      rejectUsedToken: true,
      now,
    });
    if (!admitted) return;
    const { data, evidence } = admitted;
    // Minting is purpose-independent: collecting a card cannot itself charge or
    // resume anything. The confirm webhook's retry-scheduling call no-ops on any
    // case that is not open, so an expired-dunning case cannot be provoked into
    // a charge here, and the redeem RPC stays the only authority on whether a
    // resume is admissible (PR 2485).
    const resolution = await recoveryPort.resolveRecoveryCaseSubscription({
      tokenEvidence: evidence,
      ...(providerKind ? { providerKind } : {}),
    });
    if (!resolution) {
      sendBffError(res, "CONFLICT", "Payment recovery case is not actionable", {
        details: { reason: "case_or_customer_missing" },
      });
      return;
    }

    const setupMetadata = {
      clientId: evidence.clientId,
      subscriptionId: resolution.subscriptionId,
      recoveryCaseId: resolution.caseId,
      source: "payment-recovery.setup",
    };
    const customer = resolution.providerCustomerRef ?? await ensureCustomer({
      clientId: evidence.clientId,
      // Customer creation is client-scoped, unlike the case-scoped SetupIntent.
      // Keep both the request and key stable so reloads cannot fragment one
      // buyer into multiple provider customers before the method webhook lands.
      metadata: {
        clientId: evidence.clientId,
        source: "payment-recovery.customer",
      },
      idempotencyKey: `recovery-customer:${evidence.clientId}`,
    });
    const setupInput = {
      customer,
      metadata: setupMetadata,
      idempotencyKey: `recovery-setup:${resolution.caseId}:${data.idempotencyKey}`,
    };
    let setup: StripeSetupIntentCallbackResult;
    if (methodPort) {
      const result = await methodPort.setupMethod(setupInput);
      if (result.kind === "unsupported" || result.handoff.kind !== "client-confirmed") {
        throw new Error("payment_repair_method_setup_unsupported");
      }
      setup = {
        setupIntentId: result.setupRef,
        clientSecret: result.handoff.payload,
        replayed: result.replayed,
      };
    } else if (createSetupIntent) {
      setup = await createSetupIntent(setupInput);
    } else {
      throw new Error("payment_recovery_setup_method_port_required");
    }

    // Display-only, and deliberately read AFTER method setup exists: a failure
    // here must cost the payer a sentence, never the form.
    let display: DunningCaseDisplayFacts = { failureClass: null, amountMinor: null, currency: null };
    if (caseDisplayFacts) {
      try {
        display = await caseDisplayFacts.read(resolution.caseId);
      } catch {
        display = { failureClass: null, amountMinor: null, currency: null };
      }
    }

    const response = paymentRecoverySetupMethodResponseSchema.parse({
      contractVersion: PAYMENT_RECOVERY_CONTRACT_VERSION,
      setup: {
        clientSecret: setup.clientSecret,
        setupIntentId: setup.setupIntentId,
        caseId: resolution.caseId,
        subscriptionId: resolution.subscriptionId,
        purpose: evidence.purpose,
        replayed: setup.replayed,
        amountMinor: display.amountMinor,
        currency: display.currency,
        // The class the case recorded becomes the payer-facing cause here, at the
        // edge, so the browser never sees a taxonomy value it could branch on.
        // An unrecorded class degrades to `unknown`, which the page renders as
        // silence.
        failureCause: customerCauseForFailureClass(display.failureClass),
      },
    });
    sendBffSuccess(res, response, { contractVersion: PAYMENT_RECOVERY_CONTRACT_VERSION });
  };
}

export { hashRecoveryToken } from "../subscription/paymentRecoveryPorts.js";
export type { SubscriptionPaymentRecoverySetupPort as PaymentRecoverySetupPort } from "../subscription/paymentRecoveryPorts.js";
