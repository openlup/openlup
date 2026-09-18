import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useNavigate } from "react-router-dom";
import { paymentStatusUrlFor } from "./checkoutNavigation";
import { useTranslation } from "react-i18next";
import { paymentStatusContinuationRequestSchema, type PaymentStatusContinuationRequest } from "@/domains/commerce/paymentContinuationContracts";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { PaymentCheckoutDraft, PaymentMethod } from "@/checkout/adapters/paymentMethodOptions";
import type { ConfiguratorPaymentWaitController } from "./useConfiguratorPaymentWait";
import { useCheckoutRecoveryGuidance } from "./useCheckoutRecoveryGuidance";
import { clearCheckoutDeclineNotice, takeCheckoutRecoveryRequest } from "./checkoutDeclineNotice";
import type { CheckoutPaymentRecoveryGuidance } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import type { CheckoutInlineRecoveryPayResponse } from "@/domains/commerce/checkoutInlineRecoveryContracts";

const INLINE_RECOVERY_DEADLINE_MS = 25_000;

/** Carries only read identity across the existing refusal/remount boundaries. */
export function useConfiguratorRecoveryPresentation(input: {
  onComplete: (data: ConfiguratorFormData, draft: PaymentCheckoutDraft) => void | Promise<void>;
  paymentWait: ConfiguratorPaymentWaitController | null;
  statusPath: string;
  setSubmitError: Dispatch<SetStateAction<string | null>>;
  checkoutMode: "one_time" | "subscription";
  paymentMethod: PaymentMethod | null;
  onInlineRecoveryResult: (
    result: CheckoutInlineRecoveryPayResponse,
    data: ConfiguratorFormData,
    journeyId: string,
  ) => void | Promise<void>;
  clearOneTimeCode?: () => void;
}) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation("checkout");
  const [request, setRequest] = useState<PaymentStatusContinuationRequest | null>(takeCheckoutRecoveryRequest);
  const retryRef = useRef<{ expectedPaymentAttemptId: string; retryRequestId: string } | null>(null);
  const recoveryGenerationRef = useRef(0);
  const routedAway = useRef(false);
  useEffect(() => () => {
    recoveryGenerationRef.current += 1;
  }, []);
  const approved = typeof i18n.getResource?.(i18n.resolvedLanguage ?? i18n.language, "checkout", "recoveryGuidance.messages.c12") === "string";
  const read = useCheckoutRecoveryGuidance({ statusRequest: request, enabled: approved });
  const guidance = read.guidance;
  const executable = guidanceAllowsMethod(guidance, input.paymentMethod);
  const blocked = Boolean(request && (read.loading || read.response && read.response.status !== "failed" || !executable));
  const waitingRequest = input.paymentWait?.recoveryRequest;
  const consumeWaitingRecovery = input.paymentWait?.consumeRecovery;
  // `resolving` spans handoff → read start → first settle for one request, so the
  // host never sees a gap between the wait and its verdict. Keyed by ids, not
  // object identity: a retry refused at once re-enters with the SAME ids, which the
  // read memoises on, so that verdict is re-read explicitly and re-arms this flag.
  // Other re-reads of the same request (authority change) do not reopen it.
  const requestKey = request ? continuationKey(request) : null;
  const readStartedFor = useRef<string | null>(null);
  const [readSettledFor, setReadSettledFor] = useState<string | null>(null);
  const [rereadFor, setRereadFor] = useState<string | null>(null);
  useEffect(() => {
    if (read.loading) readStartedFor.current = requestKey;
    else if (requestKey && readStartedFor.current === requestKey) setReadSettledFor(requestKey);
  }, [read.loading, requestKey]);
  const refreshRead = read.refresh;
  useEffect(() => {
    if (!rereadFor || rereadFor !== requestKey) return;
    setRereadFor(null);
    void refreshRead();
  }, [rereadFor, requestKey, refreshRead]);
  const resolving = Boolean(approved && (waitingRequest || (requestKey && readSettledFor !== requestKey)));
  useEffect(() => {
    if (!waitingRequest) return;
    recoveryGenerationRef.current += 1;
    setRequest(waitingRequest);
    consumeWaitingRecovery?.();
  }, [waitingRequest, consumeWaitingRecovery, input.paymentMethod]);
  const clear = useCallback(() => {
    recoveryGenerationRef.current += 1;
    routedAway.current = false;
    retryRef.current = null;
    setRequest(null);
    setRereadFor(null);
    consumeWaitingRecovery?.();
    clearCheckoutDeclineNotice();
  }, [consumeWaitingRecovery]);
  const onComplete = useCallback(async (data: ConfiguratorFormData, draft: PaymentCheckoutDraft) => {
    // Keep the authoritative read alive until it permits retry or routes away.
    if (blocked || routedAway.current) return;
    try {
      if (request) {
        // Once exact refusal identity exists, losing its guidance is an
        // unavailable recovery state. It must never fall through to generic
        // checkout, which would create a fresh order/subscription.
        if (!guidance || !guidanceAllowsMethod(guidance, data.paymentMethod)) {
          throw new Error("checkout:recoveryGuidance.messages.c12");
        }
        // This branch is reached only after a refusal, so its provider-specific
        // request builder and schemas stay outside the initial configurator bundle.
        // Loading is bounded before any provider dispatch; once loaded, the
        // request keeps its existing full-response 25-second deadline.
        const recoveryGeneration = recoveryGenerationRef.current;
        const startedAt = Date.now();
        const executor = await loadInlineRecoveryExecutor(INLINE_RECOVERY_DEADLINE_MS);
        // Navigation/back/start-over can clear the exact aggregate while the
        // optional chunk is loading. That accepted exit must win before POST.
        if (recoveryGenerationRef.current !== recoveryGeneration || routedAway.current) return;
        const retry = retryRef.current?.expectedPaymentAttemptId === guidance.paymentAttemptId
          ? retryRef.current
          : { expectedPaymentAttemptId: guidance.paymentAttemptId,
              retryRequestId: executor.createCheckoutInlineRetryRequestId() };
        retryRef.current = retry;
        const execution = await executor.executeCheckoutInlineRecovery({
          identity: request,
          guidance,
          data,
          executionDraft: draft,
          retryRequestId: retry.retryRequestId,
          timeoutMs: Math.max(1, INLINE_RECOVERY_DEADLINE_MS - (Date.now() - startedAt)),
          onAuthorityChanged: async () => {
            // Another tab may have rotated the shared HttpOnly cookie. Re-read
            // authoritative state before allowing any later buyer action.
            retryRef.current = null;
            await read.refresh();
          },
        });
        if (execution.request.paymentMethod === "blik") input.clearOneTimeCode?.();
        retryRef.current = null;
        setRequest(null);
        await input.onInlineRecoveryResult(execution.result, data, execution.request.journeyId);
        return;
      }
      setRequest(null);
      await input.onComplete(data, draft);
    }
    catch (error) {
      const candidate = error && typeof error === "object" && "checkoutRecoveryRequest" in error
        ? error.checkoutRecoveryRequest : null;
      const parsed = paymentStatusContinuationRequestSchema.safeParse(candidate);
      if (parsed.success && approved) {
        recoveryGenerationRef.current += 1;
        if (request && continuationKey(parsed.data) === continuationKey(request)) {
          // The retry itself was refused: same order ids, a new attempt. Ask again,
          // or guidance (and the next expected attempt) stays the spent one.
          readStartedFor.current = null;
          setReadSettledFor(null);
          setRereadFor(continuationKey(parsed.data));
        }
        setRequest(parsed.data);
        // The new reader alone may assert a cause. The initial fallback does not.
        throw new Error("checkout:recoveryGuidance.messages.c12");
      }
      throw error;
    }
  }, [input.onComplete, input.onInlineRecoveryResult, input.clearOneTimeCode, approved, blocked, guidance, request, read.refresh]);
  useEffect(() => {
    if (!request || !approved) return;
    if (read.response && read.response.status !== "failed") {
      // The host's existing wait page owns polling, expiry and activation after
      // payment; a late status must leave the refusal form without a new charge.
      retryRef.current = null;
      recoveryGenerationRef.current += 1;
      routedAway.current = true;
      setRequest(null);
      navigate(paymentStatusUrlFor(input.statusPath, request), { replace: true });
      return;
    }
    const fallback = t("checkout:recoveryGuidance.messages.c12");
    const refusalMessages = [fallback, t("checkout:errors.paymentDeclinedCard"),
      t("checkout:errors.paymentDeclinedBlik"), t("checkout:errors.paymentDeclinedRecoverable")];
    input.setSubmitError((current) => current && !refusalMessages.includes(current)
      ? current : guidance ? null : fallback);
    if (guidance) {
      document.querySelector<HTMLElement>('[data-testid="checkout-recovery-notice"] button')?.focus();
    }
  }, [request, approved, guidance, read.response, input.setSubmitError, input.statusPath, navigate, t]);
  return { onComplete, ownsRefusal: Boolean(approved && (request || waitingRequest)), guidance, clear,
    blocked, resolving };
}

function continuationKey(request: PaymentStatusContinuationRequest): string {
  return [request.orderId, request.paymentIntentId, request.clientId, request.journeyId ?? ""].join("|");
}

async function loadInlineRecoveryExecutor(timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      import("@/checkout/adapters/checkoutInlineRecoveryPay"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("checkout:errors.timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function guidanceAllowsMethod(
  guidance: CheckoutPaymentRecoveryGuidance | null,
  selectedMethod: PaymentMethod | null,
): boolean {
  if (!guidance || !selectedMethod || !guidance.methodKey || !["card", "blik"].includes(guidance.methodKey)
    || !["card", "blik"].includes(selectedMethod)) return false;
  if (guidance.methodKey !== selectedMethod) return guidance.actions.includes("change_method");
  return guidance.restriction !== "method"
    && (guidance.actions.includes("change_instrument") || guidance.actions.includes("correct_data"));
}
