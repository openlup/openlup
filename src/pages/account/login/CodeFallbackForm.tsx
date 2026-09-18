import { InlineError } from './loginAtoms';

/**
 * Magic-link-code fallback: a numeric code input shown under the sent panel
 * for cases where the e-mail's link itself doesn't work (e.g. an inbox
 * provider's link-safety prefetch burning the single-use token before the
 * customer clicks it). Mirrors the admin login page's code UI.
 */
export function CodeFallbackForm({
  sectionLabel,
  label,
  placeholder,
  value,
  error,
  loading,
  submitLabel,
  loadingLabel,
  onChange,
  onSubmit,
}: {
  sectionLabel: string;
  label: string;
  placeholder: string;
  value: string;
  error: string;
  loading: boolean;
  submitLabel: string;
  loadingLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2.5 border-t border-teal-dark/10 pt-4 text-left">
      <span className="text-center font-body text-[13px] font-semibold text-teal-dark">
        {sectionLabel}
      </span>
      <label htmlFor="customer-otp-code" className="flex flex-col gap-[7px]">
        <span className="font-body text-[13px] font-semibold text-teal-dark">{label}</span>
        <input
          id="customer-otp-code"
          name="otp-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder={placeholder}
          value={value}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'customer-otp-code-error' : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="focus-ring min-h-[50px] w-full rounded-control border-[1.5px] border-teal-dark/15 bg-white px-[15px] font-body text-[15px] text-teal-dark transition-all duration-150 placeholder:text-foreground/40"
        />
      </label>
      {error ? <InlineError id="customer-otp-code-error">{error}</InlineError> : null}
      <button
        type="button"
        disabled={loading}
        onClick={onSubmit}
        className="focus-ring min-h-[50px] w-full rounded-control bg-teal font-body text-[15px] font-semibold text-void transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {loading ? loadingLabel : submitLabel}
      </button>
    </div>
  );
}
