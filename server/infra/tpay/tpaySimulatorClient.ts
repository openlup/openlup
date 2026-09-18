import { createHash } from "node:crypto";

import type {
  TpayHttpClient,
  TpayPaymentChannel,
  TpayTransactionCreateInput,
  TpayTransactionCreated,
} from "./tpayHttpClient.js";

export const TPAY_SIMULATOR_CHANNELS: TpayPaymentChannel[] = [
  {
    id: "sim-pbl-1",
    name: "simulator-bank",
    fullName: "Tpay Simulator Bank",
    available: true,
    onlinePayment: true,
    instantRedirection: true,
    groups: [{ id: 1, name: "Pay-by-link" }],
  },
  {
    id: "150",
    name: "blik",
    fullName: "BLIK simulator",
    available: true,
    onlinePayment: false,
    instantRedirection: false,
    groups: [{ id: 150, name: "BLIK" }],
  },
];

/**
 * BLIK code that makes the simulator refuse a recurring mandate.
 *
 * Real Tpay reports this refusal only in `payments.errors[]`, with `result` and
 * every `status` field still reading like a success — and it emits no webhook for
 * failures at all. Without a way to reproduce that here, the entire decline path
 * (reason propagation, the card fallback, reservation release) would be
 * exercisable only against production Tpay with real money.
 *
 * Mirrors what production returned for an mBank code on 2026-07-20.
 */
export const TPAY_SIMULATOR_MANDATE_REFUSED_TOKEN = "000000";

export function createTpaySimulatorClient(): TpayHttpClient {
  return {
    async createTransaction(input) {
      return simulateCreatedTransaction(input);
    },
    async getTransaction(transactionId) {
      // Same field set as `createTransaction`: a caller that polls must not see a
      // different shape from the one it saw on create.
      return {
        transactionId,
        title: transactionId,
        status: "pending",
        transactionPaymentUrl: null,
        amount: null,
        currency: null,
        requestId: "tpay-simulator",
        payments: { status: "pending", errors: [] },
      };
    },
    async listPaymentChannels() {
      return TPAY_SIMULATOR_CHANNELS;
    },
  };
}

function simulateCreatedTransaction(input: TpayTransactionCreateInput): TpayTransactionCreated {
  const providerAttemptId = simulatorProviderAttemptId(input);
  const isPbl = Boolean(input.channelId);
  const mandateRequested = input.alias?.type === "PAYID";
  const refusesMandate = mandateRequested && input.blikToken === TPAY_SIMULATOR_MANDATE_REFUSED_TOKEN;

  return {
    transactionId: providerAttemptId,
    title: providerAttemptId,
    status: "pending",
    transactionPaymentUrl: isPbl ? simulatorPanelUrl(input, providerAttemptId) : null,
    requestId: "tpay-simulator",
    // Absent on a refusal, exactly as production behaves — the field is how a
    // capable bank is distinguished, not how a decline is announced.
    payIdEligible: refusesMandate ? null : (mandateRequested ? true : null),
    errors: refusesMandate
      ? [{
          errorCode: "payment_failed",
          errorMessage: "Bank nie umożliwia rejestracji aliasu dla płatności powtarzalnych",
          fieldName: null,
        }]
      : [],
  };
}

function simulatorProviderAttemptId(input: TpayTransactionCreateInput): string {
  const attemptKey = input.simulatorContext?.providerAttemptKey;
  if (!attemptKey) return `tpay_sim_${input.hiddenDescription}`;
  const suffix = createHash("sha256").update(attemptKey).digest("hex").slice(0, 16);
  return `tpay_sim_${input.hiddenDescription}_${suffix}`;
}

function simulatorPanelUrl(input: TpayTransactionCreateInput, providerAttemptId: string): string {
  const url = new URL("/skomponuj-pakiet/tpay-simulator", input.successUrl);
  url.searchParams.set("providerPaymentId", providerAttemptId);
  url.searchParams.set("order", input.description);
  if (input.simulatorContext?.orderId) url.searchParams.set("orderId", input.simulatorContext.orderId);
  url.searchParams.set("paymentIntentId", input.simulatorContext?.paymentIntentId ?? input.hiddenDescription);
  if (input.simulatorContext?.clientId) url.searchParams.set("clientId", input.simulatorContext.clientId);
  // Account `returnContext`: tell the (public) simulator page to return the buyer
  // to the in-account terminal after settling. Absent for the public flow → the
  // simulator page keeps its own localized `/skomponuj-pakiet/platnosc` return.
  if (input.simulatorContext?.returnPath) url.searchParams.set("return", input.simulatorContext.returnPath);
  return url.toString();
}
