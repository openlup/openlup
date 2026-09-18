import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from '@/lib/flags';

// The email OTP code is the digits-only fallback printed under the magic-link
// button ("Nie działa link? Wpisz ten kod..."). Accept 6–8 digits (Supabase
// email OTP length) — mirrors the admin login page's validator.
const isLikelyOtpCode = (value: string): boolean => /^\d{6,8}$/.test(value.trim());

/**
 * State + submit handler for the magic-link code fallback shown after a link
 * is sent (for cases where the link itself doesn't work, e.g. an inbox
 * provider's link-safety prefetch burning the single-use token).
 */
export function useOtpCodeFallback(
  signInWithOtpCode: (email: string, code: string) => Promise<{ error: string | null }>,
  onVerified: () => void,
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
    if (!isLikelyOtpCode(code)) {
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
