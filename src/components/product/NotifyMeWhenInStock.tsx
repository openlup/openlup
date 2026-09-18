import { useState, type FormEvent } from "react";
import { notifyWhenInStock } from "@/domains/commerce/commerceClient";
import { validateEmailField } from "@/lib/schemas/fields/identity";

/**
 * "Powiadom mnie, gdy wróci" (notify-me) form for an out-of-stock sku.
 *
 * Self-contained: drop it next to any out-of-stock product/flavor surface and
 * pass the sku. Collects an email + explicit marketing-consent checkbox, posts
 * to the back-in-stock BFF (`notifyWhenInStock`), and shows an inline
 * confirmation. Styling reuses the configurator field/label/button utility
 * classes (see PromoCodeCard) so it matches the existing dark theme.
 *
 * Copy is bilingual via the `locale` prop (default "pl") to avoid threading new
 * i18n keys before the mount point is finalized; swap to react-i18next keys when
 * wired into the configurator (see PR notes for the recommended mount point).
 */

const inputCls =
  "w-full bg-offwhite/5 border-[1.5px] border-offwhite/12 rounded-xl px-5 py-4 font-body text-base text-offwhite placeholder:text-offwhite/25 transition-colors duration-200 focus:border-teal focus:outline-hidden focus:ring-[3px] focus:ring-teal/12";
const labelCls = "font-body text-sm text-offwhite/50 mb-2 block";
const buttonCls =
  "bg-teal border-teal text-void rounded-xl px-4 py-2 font-display font-semibold transition-opacity duration-200 disabled:opacity-40";
const errorCls = "font-body text-xs-plus text-destructive mt-1.5";
const okCls = "font-body text-xs-plus text-teal mt-1.5";

type Locale = "pl" | "en";

const COPY: Record<Locale, {
  heading: string;
  emailLabel: string;
  emailPlaceholder: string;
  consent: string;
  submit: string;
  submitting: string;
  success: string;
  error: string;
}> = {
  pl: {
    heading: "Powiadom mnie, gdy wróci",
    emailLabel: "Twój e-mail",
    emailPlaceholder: "ty@przyklad.pl",
    consent: "Zgadzam się na otrzymanie e-maila, gdy produkt wróci do sklepu.",
    submit: "Powiadom mnie",
    submitting: "Zapisujemy…",
    success: "Gotowe! Damy znać, gdy produkt wróci.",
    error: "Nie udało się zapisać. Spróbuj ponownie.",
  },
  en: {
    heading: "Notify me when it's back",
    emailLabel: "Your email",
    emailPlaceholder: "you@example.com",
    consent: "I agree to receive an email when this product is back in stock.",
    submit: "Notify me",
    submitting: "Saving…",
    success: "Done! We'll let you know when it's back.",
    error: "Couldn't save that. Please try again.",
  },
};

export interface NotifyMeWhenInStockProps {
  sku: string;
  locale?: Locale;
}

// Email validity reuses the canonical field schema (src/lib/schemas/fields/
// identity.ts) instead of an ad-hoc regex, per the architecture guardrail.
function isValidEmail(value: string): boolean {
  return validateEmailField(value, { required: true }).issues.length === 0;
}

export function NotifyMeWhenInStock({ sku, locale = "pl" }: NotifyMeWhenInStockProps) {
  const copy = COPY[locale];
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  const canSubmit = isValidEmail(email.trim()) && consent && status !== "submitting";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus("submitting");
    try {
      await notifyWhenInStock({
        sku,
        email: email.trim(),
        marketingConsent: true,
        locale,
      });
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  if (status === "done") {
    return (
      <div className="rounded-2xl border border-teal/30 bg-teal/10 p-5">
        <p className={okCls} role="status">{copy.success}</p>
      </div>
    );
  }

  return (
    <form className="rounded-2xl border border-offwhite/12 bg-offwhite/3 p-5" onSubmit={onSubmit}>
      <p className="font-display font-semibold text-[15px] text-offwhite mb-3">{copy.heading}</p>
      <label className={labelCls} htmlFor="notify-stock-email">
        {copy.emailLabel}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id="notify-stock-email"
          type="email"
          autoComplete="email"
          className={inputCls}
          placeholder={copy.emailPlaceholder}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" className={buttonCls} disabled={!canSubmit}>
          {status === "submitting" ? copy.submitting : copy.submit}
        </button>
      </div>
      <label className="mt-3 flex items-start gap-2 font-body text-xs-plus text-offwhite/55">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>{copy.consent}</span>
      </label>
      {status === "error" && (
        <p className={errorCls} role="alert">{copy.error}</p>
      )}
    </form>
  );
}
