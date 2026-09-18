import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useLocalizedPath } from "@/lib/i18nRoutes";
import { ANALYTICS_CONSENT_EVENT } from "@/lib/analytics/dataLayer";
import { readStorageItem, writeStorageItem } from "@/lib/browserStorage";
import {
  reportCheckoutClientEvent,
  type CheckoutClientEventCode,
  type CheckoutClientEventStage,
} from "@/lib/telemetry/checkoutClientEvent";
import CookiePreferencesModal, { type CookieConsent } from "@/components/CookiePreferencesModal";

const STORAGE_KEY = "cookie-consent";

/**
 * The prompt's rendered height, published on `document.documentElement` so every
 * fixed bottom bar sits ABOVE it instead of under it: the prompt outranks the
 * page (`z-9998` against the bars' `z-50`), so without this it simply covers
 * whatever the step asks the visitor to press. `0px` off screen keeps the
 * consumers' `var(--consent-prompt-height, 0px)` safe forever. 56 px (36 px of
 * controls plus 16 px of padding) is a floor, not only a fallback: while the
 * prompt is on screen a missing `ResizeObserver` or a zero rect means missing
 * layout rather than a hidden element, and a bar offset by 0 is the defect.
 */
const CONSENT_HEIGHT_VAR = "--consent-prompt-height";
const FALLBACK_STRIP_HEIGHT_PX = 56;

/**
 * Tailwind `md`, in its own unit so a non-default root font size cannot make the
 * counted stage disagree with the form CSS shows. CSS swaps the mobile strip for
 * the desktop banner at this width, which is also where the configurator's fixed
 * bars become static. Read once, when the prompt appears, so a resize can never
 * split one shown/answered pair across two stages.
 */
const DESKTOP_QUERY = "(min-width: 48rem)";

type ConsentAnswerCode = Extract<
  CheckoutClientEventCode,
  "accepted_all" | "rejected_non_essential" | "preferences_saved"
>;

function promptStage(): CheckoutClientEventStage {
  return typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches
    ? "consent_desktop"
    : "consent_mobile";
}

function getStoredConsent(): CookieConsent | null {
  const raw = readStorageItem("localStorage", STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CookieConsent;
  } catch {
    return null;
  }
}

// A denied store means the choice cannot be remembered for the next visit. The
// banner still closes and the consent still applies to THIS document: the write
// must never be the reason the accept button throws.
function saveConsent(consent: CookieConsent) {
  writeStorageItem("localStorage", STORAGE_KEY, JSON.stringify(consent));
}

const FOCUS_RING = "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal";

const CookieBanner = () => {
  const { t } = useTranslation("common");
  const lp = useLocalizedPath();
  const [visible, setVisible] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<CookieConsent>({
    necessary: true,
    functional: true,
    analytics: true,
    marketing: true,
  });
  const promptRef = useRef<HTMLDivElement | null>(null);
  const promptStageRef = useRef<CheckoutClientEventStage | null>(null);

  useEffect(() => {
    const stored = getStoredConsent();
    if (!stored) {
      setVisible(true);
    } else {
      setPrefs(stored);
    }
  }, []);

  useEffect(() => {
    if (!visible || promptStageRef.current) return;
    promptStageRef.current = promptStage();
    reportCheckoutClientEvent(promptStageRef.current, "prompt_shown");
  }, [visible]);

  // Listen for external event to open preferences (from footer link)
  const handleOpenPrefs = useCallback(() => {
    setShowPrefs(true);
  }, []);

  useEffect(() => {
    window.addEventListener("open-cookie-preferences", handleOpenPrefs);
    return () =>
      window.removeEventListener("open-cookie-preferences", handleOpenPrefs);
  }, [handleOpenPrefs]);

  // Before paint: a bar offset by 0 for one frame, then jumping, is the same
  // defect seen quickly. Observed rather than computed once, because a locale
  // that wraps to a second row changes the height with no state change here.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const clear = () => root.style.setProperty(CONSENT_HEIGHT_VAR, "0px");
    const element = promptRef.current;
    if (!visible || !element) {
      clear();
      return;
    }

    const publish = () => {
      const measured = Math.ceil(element.getBoundingClientRect().height);
      root.style.setProperty(CONSENT_HEIGHT_VAR, `${measured || FALLBACK_STRIP_HEIGHT_PX}px`);
    };

    publish();
    if (typeof ResizeObserver === "undefined") return clear;

    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [visible]);

  const accept = (consent: CookieConsent, answer: ConsentAnswerCode) => {
    saveConsent(consent);
    setPrefs(consent);
    setVisible(false);
    setShowPrefs(false);
    window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
    // Only an answer that closes the prompt is a prompt answer; a visitor who
    // reopens preferences from the footer later is not counted again.
    if (visible && promptStageRef.current) {
      reportCheckoutClientEvent(promptStageRef.current, answer);
    }
  };

  const acceptAll = () =>
    accept({ necessary: true, functional: true, analytics: true, marketing: true }, "accepted_all");

  const rejectNonEssential = () =>
    accept(
      { necessary: true, functional: false, analytics: false, marketing: false },
      "rejected_non_essential",
    );

  const savePreferences = () => accept({ ...prefs, necessary: true }, "preferences_saved");

  if (!visible && !showPrefs) return null;

  return (
    <>
      {visible && (
        <div
          ref={promptRef}
          role="region"
          aria-label={t("common:cookieBanner.regionLabel")}
          className="fixed inset-x-0 bottom-0 z-9998 border-t border-offwhite/10 bg-void/95 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md md:px-0 md:pt-0 md:pb-[env(safe-area-inset-bottom)]"
          style={{ zIndex: 9998 }}
        >
          {/* Mobile strip: one row that never covers the configurator's fixed CTA. */}
          <div data-consent-form="strip" className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-1.5 gap-y-1 md:hidden">
            <div className="flex min-w-0 items-center gap-x-1.5">
              <Link
                to={lp("cookiePolicy")}
                className={`font-body whitespace-nowrap text-[11px] text-offwhite/70 underline-offset-2 hover:underline ${FOCUS_RING}`}
              >
                {t("common:cookieBanner.label")}
              </Link>
              <button
                type="button"
                data-cookie-manage
                onClick={() => setShowPrefs(true)}
                className={`font-body whitespace-nowrap text-[11px] text-offwhite/50 underline ${FOCUS_RING}`}
              >
                {t("common:cookieBanner.settings")}
              </button>
            </div>
            <span className="flex-1" />
            <button
              type="button"
              onClick={rejectNonEssential}
              className={`h-9 whitespace-nowrap rounded-lg border border-offwhite/20 px-2.5 font-body text-xs text-offwhite transition-colors hover:bg-offwhite/5 ${FOCUS_RING}`}
            >
              {t("common:cookieBanner.essentialOnly")}
            </button>
            <button
              type="button"
              onClick={acceptAll}
              className={`h-9 whitespace-nowrap rounded-lg bg-teal px-2.5 font-body text-xs font-medium text-void transition-colors hover:bg-teal/90 ${FOCUS_RING}`}
            >
              {t("common:cookieBanner.accept")}
            </button>
          </div>

          {/* Desktop banner: the pre-#3415 layout and copy, from `md` up. The
              actions share the sentence's row only from `lg`; at tablet widths
              that row squeezed the sentence to eight lines and 22 % of 1024 px. */}
          <div data-consent-form="banner" className="mx-auto hidden max-w-[1280px] flex-col items-start gap-4 px-6 py-5 md:flex lg:flex-row lg:items-center">
            <p className="font-body text-sm text-offwhite/70 lg:flex-1">
              {t("common:cookieBanner.message")}{" "}
              <Link
                to={lp("cookiePolicy")}
                className={`text-teal underline hover:text-teal/80 transition-colors ${FOCUS_RING}`}
              >
                {t("common:cookieBanner.learnMore")}
              </Link>
            </p>
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={acceptAll}
                className={`rounded-xl bg-teal px-5 py-2.5 font-body text-sm font-medium text-void hover:bg-teal/90 transition-colors ${FOCUS_RING}`}
              >
                {t("common:cookieBanner.acceptAll")}
              </button>
              <button
                type="button"
                onClick={rejectNonEssential}
                className={`rounded-xl border border-offwhite/20 px-5 py-2.5 font-body text-sm text-offwhite hover:bg-offwhite/5 transition-colors ${FOCUS_RING}`}
              >
                {t("common:cookieBanner.rejectNonEssential")}
              </button>
              <button
                type="button"
                data-cookie-manage
                onClick={() => setShowPrefs(true)}
                className={`font-body text-sm text-offwhite/50 underline hover:text-offwhite/80 transition-colors px-1 py-2 ${FOCUS_RING}`}
              >
                {t("common:cookieBanner.managePreferences")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPrefs && (
        <CookiePreferencesModal
          prefs={prefs}
          onToggle={(category, value) => setPrefs((p) => ({ ...p, [category]: value }))}
          onSave={savePreferences}
          onClose={() => setShowPrefs(false)}
        />
      )}
    </>
  );
};

export default CookieBanner;
