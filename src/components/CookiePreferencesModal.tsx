import { useTranslation } from "react-i18next";

export interface CookieConsent {
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}

export type OptionalCookieCategory = "functional" | "analytics" | "marketing";

const Toggle = ({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange?.(!checked)}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal ${
      checked ? "bg-teal" : "bg-offwhite/20"
    } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
  >
    <span
      className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform ${
        checked ? "translate-x-6" : "translate-x-1"
      }`}
    />
  </button>
);

/**
 * The four-category preferences dialog, shared by the mobile strip and the
 * desktop banner. Keys stay literal so the unused-i18n-keys guard can see them.
 */
const CookiePreferencesModal = ({
  prefs,
  onToggle,
  onSave,
  onClose,
}: {
  prefs: CookieConsent;
  onToggle: (category: OptionalCookieCategory, value: boolean) => void;
  onSave: () => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation("common");

  return (
    <div className="fixed inset-0 z-9999 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-xs"
        onClick={onClose}
      />
      {/* Modal */}
      <div className="relative w-full max-w-lg bg-void border border-offwhite/10 rounded-2xl shadow-2xl p-6 sm:p-8 max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-xl text-offwhite mb-6">
          {t("common:cookieBanner.preferencesTitle")}
        </h2>

        <div className="space-y-5">
          {/* Necessary */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-body text-sm text-offwhite font-medium">
                {t("common:cookieBanner.necessary")}
              </p>
              <p className="font-body text-xs text-offwhite/50 mt-0.5">
                {t("common:cookieBanner.necessaryDesc")}
              </p>
            </div>
            <Toggle checked disabled />
          </div>

          {/* Functional */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-body text-sm text-offwhite font-medium">
                {t("common:cookieBanner.functional")}
              </p>
              <p className="font-body text-xs text-offwhite/50 mt-0.5">
                {t("common:cookieBanner.functionalDesc")}
              </p>
            </div>
            <Toggle
              checked={prefs.functional}
              onChange={(v) => onToggle("functional", v)}
            />
          </div>

          {/* Analytics */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-body text-sm text-offwhite font-medium">
                {t("common:cookieBanner.analytics")}
              </p>
              <p className="font-body text-xs text-offwhite/50 mt-0.5">
                {t("common:cookieBanner.analyticsDesc")}
              </p>
            </div>
            <Toggle
              checked={prefs.analytics}
              onChange={(v) => onToggle("analytics", v)}
            />
          </div>

          {/* Marketing */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-body text-sm text-offwhite font-medium">
                {t("common:cookieBanner.marketing")}
              </p>
              <p className="font-body text-xs text-offwhite/50 mt-0.5">
                {t("common:cookieBanner.marketingDesc")}
              </p>
            </div>
            <Toggle
              checked={prefs.marketing}
              onChange={(v) => onToggle("marketing", v)}
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mt-8">
          <button
            onClick={onSave}
            className="flex-1 rounded-xl bg-teal px-5 py-2.5 font-body text-sm font-medium text-void hover:bg-teal/90 transition-colors"
          >
            {t("common:cookieBanner.save")}
          </button>
          <button
            onClick={onClose}
            className="flex-1 rounded-xl border border-offwhite/20 px-5 py-2.5 font-body text-sm text-offwhite hover:bg-offwhite/5 transition-colors"
          >
            {t("common:cookieBanner.close", "Zamknij")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CookiePreferencesModal;
