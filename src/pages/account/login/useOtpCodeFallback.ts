import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from '@/lib/flags';

/**
 * State + submit handler for the magic-link code fallback shown after a link
 * is sent (for cases where the link itself doesn't work, e.g. an inbox
 * provider's link-safety prefetch burning the single-use token).
 */
export function useOtpCodeFallback(
  signInWithOtpCode: (email: string, code: string) => Promise<{ error: string | null }>,
  onVerified: () => void,
  codeFormat: "numeric" | "opaque" = "numeric",
) {
  const { t } = useTranslation("account");
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function reset() {
    setCode('');
    setError('');
  }

  async function submit(email: string) {
    if (loading) return;
    const valid = codeFormat === "numeric" ? /^\d{6,8}$/.test(code.trim()) : /^\S{16,256}$/.test(code.trim());
    if (!valid) {
      reportOtpValidationBlocked();
      setError(t('account:login.codeInvalidFormat'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { error: err } = await signInWithOtpCode(email.trim(), code.trim());
      if (err) {
        setError(t('account:login.codeError'));
        return;
      }
      onVerified();
    } catch {
      setError(t("account:login.codeError"));
    } finally {
      setLoading(false);
    }
  }

  return {
    code,
    setCode(value: string) {
      setCode(value);
      if (error) setError('');
    },
    error,
    loading,
    reset,
    submit,
  };
}

function reportOtpValidationBlocked(): void {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return;
    void reporter.then((loadedReporter) => {
      try {
        loadedReporter?.reportCustomerJourneyDiagnostic({
          action: "auth_otp",
          phase: "attempted",
          code: "observed",
          clientActionKey,
        });
        loadedReporter?.reportCustomerJourneyDiagnostic({
          action: "auth_otp",
          phase: "settled",
          code: "validation_blocked",
          clientActionKey,
        });
      } catch {
        // Diagnostics are never allowed to change local validation.
      }
    }).catch(() => undefined);
  } catch {
    // The feature gate and lazy module are intentionally best effort.
  }
}
