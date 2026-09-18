import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useLocalizedPath } from "@/lib/i18nRoutes";

export function InvalidCheckoutSession({ showAccountCta = false }: { showAccountCta?: boolean }) {
  const { t } = useTranslation("checkout");
  const localizedPath = useLocalizedPath();

  return (
    <div data-testid="invalid-checkout-session" className="w-full max-w-[520px] text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-warm-coral/15">
        <AlertTriangle className="h-8 w-8 text-accent-coral" aria-hidden="true" />
      </div>
      <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-accent-coral">
        {t("checkout:invalidSession.eyebrow")}
      </p>
      <h1 className="mb-4 font-display text-[clamp(26px,4.5vw,38px)] font-semibold leading-[1.1] text-offwhite">
        {t("checkout:invalidSession.title")}
      </h1>
      <p className="font-body text-[15px] leading-relaxed text-offwhite/60">
        {t("checkout:invalidSession.body")}
      </p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          to={localizedPath("configurator")}
          className="pill-btn inline-flex h-12 items-center justify-center bg-warm-coral px-6 text-sm font-semibold text-cfg-on-accent transition hover:brightness-110"
        >
          {t("checkout:invalidSession.ctaConfigurator")}
        </Link>
        {showAccountCta && (
          <Link
            to={localizedPath("customerDashboard")}
            className="pill-btn inline-flex h-12 items-center justify-center border border-offwhite/20 px-6 text-sm font-semibold text-offwhite transition hover:bg-offwhite/5"
          >
            {t("checkout:invalidSession.ctaAccount")}
          </Link>
        )}
      </div>
    </div>
  );
}
