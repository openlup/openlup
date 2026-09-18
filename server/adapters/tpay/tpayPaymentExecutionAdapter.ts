import { failureEvidencePayload } from "../paymentFailureEvidence.js";
import { tpayFailureEvidence } from "./tpayFailureEvidence.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  PaymentExecutionInput,
  PaymentExecutionResult,
  TpayTransientProviderInput,
} from "../../../src/domains/payment/types.js";
import {
  aliasValue,
  buildCreateTransactionInput,
  resolveRecurringModel,
} from "./tpayCreateTransactionInput.js";
import { declineCodeReading } from "./declineFailureHints.js";
import {
  assertableHints,
  isMandateRefusal,
  mandateCapabilityReadable,
  readAttemptDeclineObservation,
  declineEvidenceSource,
  states,
} from "./tpayDeclineEvidence.js";
import type {
  TpayHttpClient,
  TpayPayerInput,
  TpayTransactionCreateInput,
} from "../../infra/tpay/tpayHttpClient.js";
import {
  tpayTrustedPreDispatchFailure,
  tpayTrustedRefusalFailure,
} from "../../infra/tpay/tpayDispatchFailure.js";
import { ProviderAttemptPreDispatchError } from "../../shared/preparedProviderAttempt.js";

/** The one place this adapter spells its own provider identity. */
export const PROVIDER_KIND = "tpay" as const;

export interface TpayPaymentExecutionAdapterOptions {
  client: TpayHttpClient;
  notificationUrl: string;
  successUrl: string;
  errorUrl: string;
  oneClickEnabled?: boolean;
  aliasRegistrationOnCodeEnabled?: boolean;
  /** One public switch for admitting new subscription BLIK Model O mandates. */
  modelOActivationEnabled?: boolean;
  resolvePayer?: (input: PaymentExecutionInput) => TpayPayerInput | null;
}

export function createTpayPaymentExecutionAdapter({
  client,
  notificationUrl,
  successUrl,
  errorUrl,
  oneClickEnabled = false,
  aliasRegistrationOnCodeEnabled = false,
  modelOActivationEnabled = false,
  resolvePayer = defaultPayer,
}: TpayPaymentExecutionAdapterOptions): PaymentExecutionPort {
  const validateInput = (input: PaymentExecutionInput) => {
    const transient = requireTpayTransientInput(input, {
      oneClickEnabled,
      modelOActivationEnabled,
    });
    if (input.currency !== "PLN") throw new TpayExecutionInputError("tpay_currency_not_supported");
    const payer = resolvePayer(input);
    if (!payer) throw new TpayExecutionInputError("tpay_payer_missing");
    return { transient, payer };
  };

  return {
    validateInput(input): void {
      validateInput(input);
    },
    async execute(input): Promise<PaymentExecutionResult> {
      const { transient, payer } = validateInput(input);

      const request = buildCreateTransactionInput({
        input,
        transient,
        payer,
        notificationUrl,
        successUrl,
        errorUrl,
        aliasRegistrationOnCodeEnabled,
        modelOActivationEnabled,
      });
      let response;
      try {
        response = await client.createTransaction(request);
      } catch (error) {
        // Two independent proofs Tpay holds no transaction: never asked, or it refused the request
        // document. Both release the attempt; everything else stays ambiguous and rethrows.
        const noCharge = tpayTrustedPreDispatchFailure(error) ?? tpayTrustedRefusalFailure(error);
        if (noCharge) throw new ProviderAttemptPreDispatchError(noCharge);
        throw error;
      }
      const providerAttemptId = response.title || response.transactionId;
      // This provider reports a synchronous decline ONLY here. `result`, `status`
      // and `payments.status` all still read "success"/"pending" on a rejected
      // transaction, so they cannot be used to detect one.
      const rejections = response.errors ?? [];
      const rejection = rejections[0] ?? null;
      // The provider has carried a hard refusal code since the first minute, but
      // only in the transaction's attempt log — never in the create response,
      // whose codes are generic. So ask for it the moment the provider says no,
      // instead of learning it hours later from the reconciliation poll.
      // Fail-open: `null` means "read nothing", and every branch below then
      // behaves exactly as it did before this read existed.
      const observation = rejection
        ? await readAttemptDeclineObservation(client, response.transactionId)
        : null;
      const attemptCode = observation?.code ?? null;
      // A code the table cannot read decides nothing. Promoting a known-unknown
      // such as `"100"` to a verdict would silence the message fallback for the
      // one code we openly admit we cannot read — a regression, not a fix.
      const attemptReading = attemptCode === null ? null : declineCodeReading(attemptCode);
      const decidingAttemptReading = attemptReading !== null && states(attemptReading)
        ? attemptReading
        : null;
      const mandateUnsupported = decidingAttemptReading
        ? mandateCapabilityReadable(transient.flow)
          && response.payIdEligible !== true
          && (decidingAttemptReading.hints?.includes("mandateUnsupported") ?? false)
        : rejection !== null && rejections.some((error) =>
          isMandateRefusal(transient.flow, response.payIdEligible, error.errorMessage)
        );
      // Read here, where the code vocabulary is owned, so the control plane
      // classifies the refusal without ever seeing a provider-native code. The
      // attempt log wins when it says something, because it is the carrier the
      // provider itself writes the refusal into; the create response's own code
      // is the fallback reading.
      // The advice half is suppressed when this adapter is already asserting a
      // mandate refusal: advice outranks hints by design in the taxonomy, and
      // the identity code is only the FIRST error, so a generic terminal code
      // arriving ahead of the mandate explanation would otherwise mask the one
      // reading that says the stored reference — not the instrument — is dead.
      const reading = decidingAttemptReading ?? declineCodeReading(rejection?.errorCode);
      const declineEvidence = rejection ? declineEvidenceSource({
        attemptCode, decidingAttemptReading, mandateUnsupported, reading, errorCode: rejection.errorCode,
      }) : null;
      // A capability code is read as mandate evidence only while registering a
      // mandate. The same opaque code on one-time or stored-mandate charges must
      // not claim that a mandate is dead. The rule itself lives beside the
      // refusal evidence it qualifies, because the reconciliation rail funnels
      // its hints through the same one — a refusal must not classify by which
      // rail saw it.
      const neutralReasonHints = assertableHints(reading.hints, transient.flow);
      const providerDecline = rejection
        ? {
            code: rejection.errorCode,
            // Preserve the first provider code as the stable decline identity, but
            // inspect every error for the capability signal. The provider may put a
            // generic payment failure first and the mandate explanation later.
            mandateUnsupported,
            ...(reading.adviceCode && !mandateUnsupported ? { adviceCode: reading.adviceCode } : {}),
            ...(neutralReasonHints?.length ? { neutralReasonHints } : {}),
          }
        : null;

      return {
        provider: PROVIDER_KIND,
        providerAttemptId,
        providerSessionId: response.transactionId,
        // Stays non-terminal even on a decline: the control plane owns terminal
        // transitions and reads `providerDecline` below to make one.
        attemptStatus: "processing",
        providerDecline,
        nextActionKind: !providerDecline && transient.flow === "pbl_one_time" && response.transactionPaymentUrl
          ? "redirect"
          : null,
        redirectUrl: providerDecline ? null : response.transactionPaymentUrl,
        // A rejected activation must not publish a payment method reference.
        paymentMethodRef: transient.flow === "blik_recurring_activation" && !providerDecline
          ? aliasValue(input.paymentIntentId)
          : null,
        // A declined transaction produces no webhook at all: Tpay's `tr_status`
        // only ever carries `true` or `chargeback`. Claiming otherwise would
        // strand the attempt waiting for a callback that never arrives.
        webhookExpected: !providerDecline,
        recoveryRequired: false,
        requestPayload: {
          providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.providerRequestFingerprint,
          providerFlow: transient.flow,
          amountMinor: input.amountMinor,
          currency: input.currency,
          orderRef: input.orderRef,
          channelId: transient.flow === "pbl_one_time" ? transient.channelId : undefined,
          // The model actually sent, not the one the client asked for — the single
          // activation switch can make those diverge, and this field is where a
          // diagnosis looks for the truth.
          recurringModel: transient.flow === "blik_recurring_activation"
            ? resolveRecurringModel(transient.recurringModel, modelOActivationEnabled)
            : undefined,
          methodRefPresent: transient.flow === "recurring_charge" || transient.flow === "blik_one_click"
            ? Boolean(input.paymentMethodRef)
            : undefined,
          methodRefAliasType: transient.flow === "recurring_charge" || transient.flow === "blik_one_click"
            ? input.paymentMethodAliasType ?? "PAYID"
            : undefined,
          aliasRegistrationRequested: transient.flow === "blik_one_time"
            ? aliasRegistrationOnCodeEnabled
            : undefined,
        },
        responsePayload: {
          providerStatus: response.status,
          providerAttemptId,
          providerSessionId: response.transactionId,
          requestId: response.requestId,
          redirectUrlPresent: Boolean(response.transactionPaymentUrl),
          payIdEligible: response.payIdEligible,
          // Codes only. `errorMessage` is free-form prose that can carry
          // payer-identifying text, so it never reaches our stored payload.
          providerErrorCodes: (response.errors ?? []).map((error) => error.errorCode),
          ...(declineEvidence ? { declineEvidence } : {}),
          ...failureEvidencePayload(observation ? tpayFailureEvidence({
            source: "execution", providerPaymentId: response.transactionId, refusalVerified: true,
            flow: transient.flow, observation, errorCode: rejection?.errorCode, reading,
          }) : null),
        },
      };
    },
  };
}

function requireTpayTransientInput(
  input: PaymentExecutionInput,
  options: { oneClickEnabled: boolean; modelOActivationEnabled: boolean },
): TpayTransientProviderInput {
  if (input.providerFlow === "blik_one_click") {
    if (!options.oneClickEnabled) throw new TpayExecutionInputError("tpay_blik_one_click_not_enabled");
    if (input.mode !== "one_time") throw new TpayExecutionInputError("tpay_blik_one_click_requires_one_time");
    if (!input.paymentMethodRef) throw new TpayExecutionInputError("tpay_blik_one_click_payid_missing");
    if (input.transientProviderInput && input.transientProviderInput.flow !== "blik_one_click") {
      throw new TpayExecutionInputError("tpay_provider_flow_mismatch");
    }
    return { provider: PROVIDER_KIND, flow: "blik_one_click" };
  }

  if (input.providerFlow === "recurring_charge") {
    if (input.mode !== "subscription_cycle") throw new TpayExecutionInputError("tpay_recurring_charge_requires_cycle");
    if (!input.paymentMethodRef) throw new TpayExecutionInputError("tpay_recurring_charge_payid_missing");
    if (input.paymentMethodAliasType && input.paymentMethodAliasType !== "PAYID") {
      throw new TpayExecutionInputError("tpay_recurring_charge_requires_payid");
    }
    if (input.paymentMethodRecurringModel !== "O") {
      throw new TpayExecutionInputError("tpay_recurring_charge_requires_model_o");
    }
    if (input.transientProviderInput && input.transientProviderInput.flow !== "recurring_charge") {
      throw new TpayExecutionInputError("tpay_provider_flow_mismatch");
    }
    return { provider: PROVIDER_KIND, flow: "recurring_charge" };
  }

  const transient = input.transientProviderInput;
  if (!transient || transient.provider !== PROVIDER_KIND) throw new TpayExecutionInputError("tpay_transient_input_missing");
  if (input.providerFlow && input.providerFlow !== transient.flow) {
    throw new TpayExecutionInputError("tpay_provider_flow_mismatch");
  }
  if (transient.flow === "blik_one_time" || transient.flow === "blik_recurring_activation") {
    if (!transient.blikToken) throw new TpayExecutionInputError("tpay_blik_token_missing");
  }
  if (transient.flow === "pbl_one_time" && !transient.channelId) {
    throw new TpayExecutionInputError("tpay_channel_id_missing");
  }
  if (transient.flow === "pbl_one_time" && input.mode !== "one_time") {
    throw new TpayExecutionInputError("tpay_pbl_recurring_not_supported");
  }
  if (transient.flow === "blik_recurring_activation") {
    if (!options.modelOActivationEnabled) {
      throw new TpayExecutionInputError("tpay_blik_recurring_activation_not_enabled");
    }
    if (transient.recurringModel !== "O") {
      throw new TpayExecutionInputError("tpay_blik_model_o_required");
    }
    if (input.mode !== "subscription_cycle") {
      throw new TpayExecutionInputError("tpay_blik_recurring_activation_requires_subscription_cycle");
    }
    if (input.saveForFutureUse !== true) {
      throw new TpayExecutionInputError("tpay_blik_recurring_activation_requires_save_for_future_use");
    }
  }
  return transient;
}

function defaultPayer(input: PaymentExecutionInput): TpayPayerInput | null {
  if (input.payer) return input.payer;
  if (!input.customerRef) return null;
  return { email: input.customerRef, name: "openlup customer" };
}

export class TpayExecutionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TpayExecutionInputError";
  }
}
