/**
 * Map a checkout-recovery BFF error to localized customer copy — never surface the raw
 * English BFF message on the Polish recovery terminal (CJ54-1). CONFLICT reasons are
 * handled upstream as a fallback; the remaining reachable failure is a provider-execution
 * error — most often the off-session renewal intent still being in flight — which we
 * explain honestly instead of dead-ending with an untranslated "could not be started".
 */
export function localizeRecoveryError(reason: unknown, t: (key: string) => string): string {
  const code = recoveryErrorReason(reason);
  const base = "account:completePayment.errorReason";
  if (
    code === "provider_attempt_in_flight" ||
    code === "payment_intent_in_flight" ||
    code === "payment_control_conflict"
  ) {
    return t(`${base}.inProgress`);
  }
  if (code === "provider_execution_failed") return t(`${base}.providerFailed`);
  return t("account:completePayment.genericError");
}

/**
 * Dunning-recovery outcomes the redeem RPC reports through the BFF's CONFLICT
 * reason. A not-yet-chargeable method is the resume rail's webhook race and
 * leaves the saved card intact. A changed case reaches BOTH cohorts — the
 * legacy delegate raises it for a `repair_payment` token whose case is no
 * longer open, exactly as the resume branch does for one no longer expired — so
 * its copy names neither journey. `resume_subscription_not_available` is kept
 * for deploy skew: a BFF still refusing the purpose emits it until redeployed.
 */
export function localizeDunningRecoveryError(
  reason: unknown,
  t: (key: string) => string,
): string | null {
  const code = recoveryErrorReason(reason);
  if (code === "resume_method_not_chargeable") return t("account:recovery.resumeMethodNotReady");
  if (code === "resume_case_state_changed") return t("account:recovery.linkStale");
  if (code === "resume_subscription_not_available") return t("account:recovery.resumeNeedsSupport");
  return null;
}

/**
 * Customer-facing text for a dunning-recovery failure: the mapped reason when
 * there is one, otherwise the raw failure, truncated, and the generic copy for
 * a shapeless one. Never a dead end with no explanation.
 */
export function formatDunningRecoveryError(reason: unknown, t: (key: string) => string): string {
  const localized = localizeDunningRecoveryError(reason, t);
  if (localized) return localized;
  if (reason instanceof Error) return reason.message.slice(0, 240);
  if (typeof reason === "string") return reason.slice(0, 240);
  return t("account:recovery.genericError");
}

/**
 * Every word the embedded card step renders, in this host's namespace.
 *
 * `src/domains/payment` is a candidate neutral kernel (`src/lib/coreDomains.ts`)
 * and must not reach into the app's i18n namespaces, so the host hands it the
 * finished sentences through `PaymentFormCopy`. The `load*` entries are the
 * failure vocabulary: a provider script that failed or never finished loading
 * used to leave a permanently disabled pay button and nothing else on screen.
 * Recovery and the configurator fill the SAME shape, which is what makes the two
 * paths fail identically by construction rather than by duplication.
 */
export function recoveryCardPaymentCopy(t: (key: string) => string, subscription: boolean) {
  const base = "account:completePayment";
  return {
    payButton: t(`${base}.payCta.${subscription ? "subscription" : "oneTime"}`),
    payingButton: t(`${base}.processing`),
    errorPrefix: t(`${base}.cardDeclined`),
    unavailable: t(`${base}.cardUnavailable`),
    loadFailed: t(`${base}.cardLoadFailed`),
    loadRetry: t(`${base}.cardLoadRetry`),
    loadAlternative: t(`${base}.cardLoadAlternative`),
  };
}

/** Prefer the BFF error's `details.reason`, then its top-level `code`, else null. */
export function recoveryErrorReason(reason: unknown): string | null {
  if (typeof reason !== "object" || reason === null) return null;
  const details = (reason as { details?: unknown }).details;
  if (details && typeof details === "object" && "reason" in details) {
    const value = (details as { reason?: unknown }).reason;
    if (typeof value === "string") return value;
  }
  const code = (reason as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
