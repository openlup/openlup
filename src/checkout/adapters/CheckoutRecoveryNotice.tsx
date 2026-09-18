import { useEffect, useRef } from "react";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";
import { useTranslation } from "react-i18next";
import { hasCheckoutRecoveryCopy, presentCheckoutRecoveryGuidance, type CheckoutRecoveryAction, type CheckoutRecoveryPresentation, type CheckoutRecoveryPresentationInput } from "../machine/checkoutRecoveryGuidance";

export interface CheckoutRecoveryNoticeProps {
  presentation: CheckoutRecoveryPresentation | null;
  /** Hosts select/focus an existing method or perform the named non-charge action. */
  onAction: (action: CheckoutRecoveryAction) => void;
  disabled?: boolean;
}

/** Loaded only for an actual refusal; focus follows the mounted attempt. */
export function CheckoutRecoveryGuidanceNotice({ onAction, focusRequest, ...input }: CheckoutRecoveryPresentationInput & Pick<CheckoutRecoveryNoticeProps, "onAction"> & {
  focusRequest: { attemptId: string; activeElement: Element | null; interacted: boolean } | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const presentation = presentCheckoutRecoveryGuidance(input);
  useEffect(() => {
    if (focusRequest?.attemptId === input.guidance?.paymentAttemptId && !focusRequest?.interacted
      && focusRequest?.activeElement === document.activeElement) {
      container.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [input.guidance?.paymentAttemptId, focusRequest]);
  return <div ref={container}><CheckoutRecoveryNotice presentation={presentation} onAction={onAction} /></div>;
}

export function CheckoutRecoveryNotice({ presentation, onAction, disabled = false }: CheckoutRecoveryNoticeProps) {
  const { t, i18n } = useTranslation("checkout");
  const keys = presentation ? [presentation.messageKey, ...presentation.actions.map(({ labelKey }) => labelKey)] : [];
  const visible = Boolean(presentation) && keys.every((key) => hasCheckoutRecoveryCopy(i18n, key));
  const recommended = visible && presentation?.emphasis === "recommended";
  useEffect(() => {
    if (recommended) reportCheckoutClientEvent("payment_form", "recommendation_shown");
  }, [recommended]);
  // Unapproved/missing locale entries keep the host's existing fallback. Never
  // print a translation key or silently introduce another language's new copy.
  if (!visible || !presentation) return null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="checkout-recovery-notice"
      data-emphasis={presentation.emphasis} className="space-y-3 rounded-xl border p-4 text-sm">
      <p>{t(presentation.messageKey)}</p>
      <div className="flex flex-wrap gap-2">
        {presentation.actions.map((action) => (
          <button key={`${action.kind}:${action.method ?? ""}`} type="button" disabled={disabled}
            onClick={() => {
              if (recommended) reportCheckoutClientEvent("payment_form", "recommendation_selected");
              onAction(action);
            }}
            className="min-h-11 rounded-full border px-4 py-2 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {t(action.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
