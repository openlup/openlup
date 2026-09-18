import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";

/**
 * Sticky bottom mobile CTA — pojawia się po przescrollowaniu poza hero
 * (1 viewport). Tylko mobile (md:hidden). Wzór: standard DTC subscription
 * brands. Konwersyjna mikro-mechanika: zawsze widoczny przycisk do
 * akwizycji; w hidden preview prowadzi do konfiguratora, w produkcji do
 * publicznego fallbacku.
 */

export function MobileStickyConfiguratorCTA() {
  const { t } = useTranslation("home");
  const acquisitionPath = usePublicAcquisitionPath();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const updateVisible = () => {
      frame = 0;
      setVisible(window.scrollY > window.innerHeight * 0.85);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateVisible);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    updateVisible();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      className={`md:hidden fixed bottom-0 inset-x-0 z-50 px-4 pb-4 pt-3 bg-linear-to-t from-void via-void/95 to-void/0 transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"
      }`}
      // The consent strip owns the very bottom of the viewport while it is
      // shown; this CTA sits on top of it rather than under it. `0px` once the
      // visitor has answered.
      style={{ bottom: "var(--consent-prompt-height, 0px)" }}
    >
      <Link
        to={acquisitionPath}
        className="flex items-center justify-center gap-2 w-full h-[52px] rounded-full bg-cta text-cta-foreground font-display font-semibold text-[15px] shadow-2xl hover:brightness-110 transition-all"
      >
        {t("home:stickyCta.label")}
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}
