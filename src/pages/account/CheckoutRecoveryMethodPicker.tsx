import { hasCheckoutRecoveryCopy } from "@/checkout/machine/checkoutRecoveryGuidance";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  paymentBankPickerEnabled,
  PAYMENT_BANK_UNSUPPORTED,
  type PaymentChannel,
  type PaymentCheckoutDraft,
  type PaymentCheckoutMode,
  type PaymentMethod,
  type PaymentMethodOption,
} from "@/checkout/adapters/paymentMethodOptions";
import { BLIK_RECURRING_BANKS } from "@/domains/commerce/blikRecurringBanks";

/**
 * Payment-method picker for the recovery pay-page. Renders exactly the methods the
 * configurator offers for this order's mode (driven by the shared
 * `visiblePaymentMethods`), so staging behaves like the real checkout: BLIK and —
 * for one-time orders — pay-by-link (przelew). Field labels reuse the configurator
 * i18n; validation errors reuse the shared configurator validation keys.
 */
export interface CheckoutRecoveryMethodPickerProps {
  methods: PaymentMethodOption[];
  paymentMethod: PaymentMethod | null;
  onSelect: (method: PaymentMethod) => void;
  onContactSupport: () => void;
  draft: PaymentCheckoutDraft;
  onDraftChange: (patch: Partial<PaymentCheckoutDraft>) => void;
  channels: PaymentChannel[];
  fieldErrors: Record<string, string>;
  /** Subscription recovery only: recurring BLIK needs a mandate-capable bank. */
  checkoutMode: PaymentCheckoutMode;
}

export function CheckoutRecoveryMethodPicker({
  methods,
  paymentMethod,
  onSelect, onContactSupport,
  draft,
  onDraftChange,
  channels,
  fieldErrors,
  checkoutMode,
}: CheckoutRecoveryMethodPickerProps) {
  const { t, i18n } = useTranslation("account");
  const bankPickerEnabled = paymentBankPickerEnabled();
  const [selectionAnnouncement, setSelectionAnnouncement] = useState("");
  const preflightKey = "checkout:recoveryGuidance.messages.c16";
  const helpAvailable = hasCheckoutRecoveryCopy(i18n, "checkout:recoveryGuidance.messages.c12");
  const cardAvailable = methods.some((method) => method.value === "card");
  // Same rule as the configurator: collecting a code before the bank is known
  // invites a decline the buyer could have been spared — and this surface is
  // reached FROM a decline, so repeating it would loop them.
  const hideBlikCode = bankPickerEnabled
    && checkoutMode === "subscription"
    && (draft.blikBankId === "" || draft.blikBankId === PAYMENT_BANK_UNSUPPORTED);

  return (
    <div data-testid="recovery-method-picker" className="mb-6 space-y-3">
      <p className="sr-only" role="status" aria-live="polite">
        {selectionAnnouncement}
      </p>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-foreground/55">
          {t("account:completePayment.chooseMethod")}
        </legend>
        {methods.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-sm transition ${
              paymentMethod === option.value
                ? "border-teal bg-soft-sage text-teal-dark"
                : "border-teal-dark/12 text-foreground/70 hover:border-teal"
            }`}
          >
            <input
              id={`recovery-payment-method-${option.value}`}
              type="radio"
              name="recovery-payment-method"
              value={option.value}
              checked={paymentMethod === option.value}
              onChange={() => onSelect(option.value)}
              className="accent-teal"
            />
            {t(`account:completePayment.method.${option.value}`)}
          </label>
        ))}
      </fieldset>

      {paymentMethod === "blik" && bankPickerEnabled && checkoutMode === "subscription" && (
        <div>
          <label htmlFor="recovery-blik-bank" className="mb-1 block text-sm text-foreground/55">
            {t("account:completePayment.blikBankLabel")}
          </label>
          <select
            id="recovery-blik-bank"
            data-testid="recovery-blik-bank"
            value={draft.blikBankId}
            onChange={(event) => onDraftChange({ blikBankId: event.target.value })}
            aria-invalid={fieldErrors.blikBankId ? true : undefined}
            className="h-11 w-full rounded-md border border-teal-dark/15 bg-card px-3 text-foreground"
          >
            <option value="">{t("account:completePayment.blikBankPlaceholder")}</option>
            {BLIK_RECURRING_BANKS.map((bank) => (
              <option key={bank.id} value={bank.id}>{bank.displayName}</option>
            ))}
            <option value={PAYMENT_BANK_UNSUPPORTED}>{t("account:completePayment.blikBankOther")}</option>
          </select>
          {draft.blikBankId === PAYMENT_BANK_UNSUPPORTED && (
            <div className="mt-2 rounded-md border border-teal-dark/15 bg-card p-3" role="alert">
              {!hasCheckoutRecoveryCopy(i18n, preflightKey) && <p className="text-sm font-semibold text-foreground">
                {t("account:completePayment.blikBankUnsupportedExitTitle")}
              </p>}
              <p className="mt-1 text-sm text-foreground/70">
                {t(!cardAvailable && helpAvailable ? "checkout:recoveryGuidance.messages.c12" : cardAvailable && hasCheckoutRecoveryCopy(i18n, preflightKey) ? preflightKey : cardAvailable
                  ? "account:completePayment.blikBankUnsupportedExitBody"
                  : "account:completePayment.blikBankUnsupportedUnavailableBody")}
              </p>
              {!cardAvailable && helpAvailable && <button type="button" onClick={onContactSupport} className="focus-ring mt-3 min-h-11 rounded-md border px-4">
                {t("checkout:recoveryGuidance.actions.support")}
              </button>}
              {cardAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    onSelect("card");
                    setSelectionAnnouncement(t("account:completePayment.cardSelected"));
                    window.requestAnimationFrame(() => {
                      document.getElementById("recovery-payment-method-card")?.focus();
                    });
                  }}
                  className="focus-ring mt-3 inline-flex h-11 items-center rounded-md bg-teal px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  {t(hasCheckoutRecoveryCopy(i18n, "checkout:recoveryGuidance.actions.chooseCard")
                    ? "checkout:recoveryGuidance.actions.chooseCard" : "account:completePayment.blikBankUnsupportedExitCta")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {paymentMethod === "blik" && !hideBlikCode && (
        <div>
          <label htmlFor="recovery-blik" className="mb-1 block text-sm text-foreground/55">
            {t("account:completePayment.blikLabel")}
          </label>
          <input
            id="recovery-blik"
            data-testid="recovery-blik-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={draft.blikToken}
            onChange={(event) =>
              onDraftChange({ blikToken: event.target.value.replace(/\D/g, "").slice(0, 6) })
            }
            aria-invalid={fieldErrors.blikToken ? true : undefined}
            aria-describedby={fieldErrors.blikToken ? "recovery-blik-error" : undefined}
            className="h-11 w-full rounded-md border border-teal-dark/15 bg-card px-3 tracking-[0.4em] text-foreground"
            placeholder="••••••"
          />
          {fieldErrors.blikToken && (
            <p id="recovery-blik-error" className="mt-1 text-xs text-warm-coral" role="alert">
              {t(fieldErrors.blikToken)}
            </p>
          )}
        </div>
      )}

      {paymentMethod === "transfer" && (
        <div>
          <label htmlFor="recovery-pbl" className="mb-1 block text-sm text-foreground/55">
            {t("account:completePayment.bankLabel")}
          </label>
          <select
            id="recovery-pbl"
            data-testid="recovery-pbl-select"
            value={draft.pblChannelId}
            onChange={(event) => onDraftChange({ pblChannelId: event.target.value })}
            aria-invalid={fieldErrors.pblChannelId ? true : undefined}
            aria-describedby={fieldErrors.pblChannelId ? "recovery-pbl-error" : undefined}
            className="h-11 w-full rounded-md border border-teal-dark/15 bg-card px-3 text-foreground"
          >
            <option value="">{t("account:completePayment.bankPlaceholder")}</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.fullName}
              </option>
            ))}
          </select>
          {fieldErrors.pblChannelId && (
            <p id="recovery-pbl-error" className="mt-1 text-xs text-warm-coral" role="alert">
              {t(fieldErrors.pblChannelId)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
