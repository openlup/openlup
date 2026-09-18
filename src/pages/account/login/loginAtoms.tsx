import type { ReactNode } from 'react';
import { AlertCircle, MailCheck, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

// Login page (kierunek C · Editorial) atoms. Cream scope (`.account-light`).
// Brand rules: Clash Display headings, Plus Jakarta body, coral = primary CTA
// only (the CTA itself reuses CoralButton in LoginPage), radius control 12,
// icons from lucide-react. Values match the design handoff prototype 1:1.

/** Google's 4-colour "G" mark (inline SVG — not a Lucide glyph). */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className="block shrink-0"
      aria-hidden="true"
    >
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

/**
 * White Google sign-in button with hairline border. Shows an optional "last
 * used" pill (returning customer whose last method was Google).
 */
export function GoogleSignInButton({
  label,
  lastUsedLabel,
  disabled,
  onClick,
}: {
  label: string;
  lastUsedLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'focus-ring relative flex min-h-[52px] w-full items-center justify-center gap-[11px] rounded-control bg-white px-4.5',
        'border-[1.5px] border-teal-dark/15 font-body text-[15px] font-semibold text-teal-dark',
        'transition-all duration-150 hover:border-teal-dark/25 hover:shadow-card',
        'disabled:pointer-events-none disabled:opacity-60',
      )}
    >
      <GoogleMark />
      {label}
      {lastUsedLabel ? (
        <span className="absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center gap-[5px] rounded-full bg-teal/12 px-[9px] py-1 text-[11px] font-bold tracking-[0.04em] text-teal-dark">
          <span className="h-[5px] w-[5px] rounded-full bg-teal" />
          {lastUsedLabel}
        </span>
      ) : null}
    </button>
  );
}

/** Hairline divider with a centred uppercase label ("LUB" / "OR"). */
export function LoginDivider({ label }: { label: string }) {
  return (
    <div className="my-1 flex items-center gap-3.5">
      <span className="h-px flex-1 bg-teal-dark/10" />
      <span className="font-body text-[12px] font-semibold uppercase tracking-[0.1em] text-foreground/40">
        {label}
      </span>
      <span className="h-px flex-1 bg-teal-dark/10" />
    </div>
  );
}

/** E-mail label + input. Teal focus ring; coral border in the invalid state. */
export function EmailField({
  id,
  label,
  placeholder,
  value,
  invalid,
  errorId,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  invalid: boolean;
  errorId?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-[7px]">
      <span className="font-body text-[13px] font-semibold text-teal-dark">
        {label}
      </span>
      <input
        id={id}
        type="email"
        autoComplete="email"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={invalid && errorId ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={cn(
          'focus-ring min-h-[50px] w-full rounded-control border-[1.5px] bg-white px-[15px] font-body text-[15px] text-teal-dark transition-all duration-150',
          'placeholder:text-foreground/40',
          invalid ? 'border-warm-coral' : 'border-teal-dark/15',
        )}
      />
    </label>
  );
}

/** Inline form error under the e-mail field (coral wash + alert icon). */
export function InlineError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      role="alert"
      className="flex items-start gap-2 rounded-[10px] bg-warm-coral/12 px-3 py-2.5"
    >
      <AlertCircle
        size={15}
        className="mt-px shrink-0 text-[hsl(17_60%_48%)]"
        aria-hidden="true"
      />
      <span className="font-body text-[13px] leading-[1.5] text-[hsl(17_55%_38%)]">
        {children}
      </span>
    </div>
  );
}

/** Confirmation panel shown after a sign-in link is sent. */
export function SentPanel({
  title,
  bodyPrefix,
  email,
  bodySuffix,
  sentAtLabel,
  expiresAtLabel,
  expired,
  expiredTitle,
  expiredBody,
  resendLabel,
  useOtherLabel,
  onResend,
  onUseOther,
}: {
  title: string;
  bodyPrefix: string;
  email: string;
  bodySuffix: string;
  sentAtLabel: string;
  expiresAtLabel: string;
  expired: boolean;
  expiredTitle: string;
  expiredBody: string;
  resendLabel: string;
  useOtherLabel: string;
  onResend: () => void;
  onUseOther: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3.5 text-center">
      <span className={cn(
        'grid size-14 place-items-center rounded-full',
        expired ? 'bg-warm-coral/12' : 'bg-teal/15',
      )}>
        {expired ? (
          <AlertCircle size={26} className="text-[hsl(17_60%_48%)]" aria-hidden="true" />
        ) : (
          <MailCheck size={26} className="text-teal" aria-hidden="true" />
        )}
      </span>
      <div>
        <h1 className="m-0 font-display text-[21px] font-semibold text-teal-dark">
          {expired ? expiredTitle : title}
        </h1>
        <p className="mx-auto mt-2 max-w-[320px] font-body text-[15px] leading-[1.55] text-foreground/60">
          {expired ? (
            expiredBody
          ) : (
            <>
              {bodyPrefix}{' '}
              <strong className="font-bold text-teal-dark">{email}</strong>
              {bodySuffix}
            </>
          )}
        </p>
        {!expired ? (
          <div className="mx-auto mt-3 flex max-w-[320px] flex-col gap-1 rounded-control bg-white/70 px-3 py-2 font-body text-[12px] leading-[1.45] text-foreground/55">
            <span>{sentAtLabel}</span>
            <span>{expiresAtLabel}</span>
          </div>
        ) : null}
      </div>
      <div className="mt-1 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onResend}
          className="focus-ring rounded-sm font-body text-[13px] font-bold text-teal"
        >
          {resendLabel}
        </button>
        <button
          type="button"
          onClick={onUseOther}
          className="focus-ring rounded-sm font-body text-[13px] text-foreground/50 underline underline-offset-2"
        >
          {useOtherLabel}
        </button>
      </div>
    </div>
  );
}

/** Eyebrow + Clash Display headline + subtitle. */
export function LoginHeading({
  eyebrow,
  eyebrowTone,
  title,
  subtitle,
}: {
  eyebrow: string;
  eyebrowTone: 'teal' | 'coral';
  title: string;
  subtitle: ReactNode;
}) {
  return (
    <div className="mb-7.5 flex flex-col items-center gap-3 text-center">
      <span
        className={cn(
          'font-body text-[12px] font-bold uppercase tracking-[0.16em]',
          eyebrowTone === 'coral' ? 'text-warm-coral' : 'text-teal',
        )}
      >
        {eyebrow}
      </span>
      <h1 className="m-0 whitespace-pre-line font-display text-[50px] font-bold leading-[0.98] tracking-[-0.02em] text-teal-dark">
        {title}
      </h1>
      <p className="m-0 max-w-[360px] font-body text-[16px] leading-[1.55] text-foreground/60">
        {subtitle}
      </p>
    </div>
  );
}

/** Footer trust row (shield + "secure passwordless sign-in"). */
export function TrustRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-[7px] font-body text-[12px] text-foreground/40">
      <ShieldCheck size={14} className="text-foreground/40" aria-hidden="true" />
      {label}
    </div>
  );
}
