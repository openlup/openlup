import { startTransition, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { alternatePathForLangPreservingState } from "@/lib/i18nRoutes";
import { useRenderRuntime } from "@/app/renderMode";

export function LanguageSwitcher() {
  const { i18n } = useTranslation("common");
  const currentLang = i18n.language;
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { mode } = useRenderRuntime();

  const switchLang = (lang: "pl" | "en") => {
    const target = alternatePathForLangPreservingState(
      location.pathname,
      lang,
      location.search,
      location.hash,
    );
    // The URL is authoritative. Preference persistence is best-effort so a
    // privacy mode that blocks storage can never block language navigation.
    try {
      localStorage.setItem("openlup-lang", lang);
    } catch {
      // Continue with the route change.
    }
    // Below-the-fold SSG content may still be hydrating. A locale change
    // updates every translated component, so use the already-generated target
    // document instead of interrupting that pending hydration boundary.
    if (mode === "ssg") {
      window.location.assign(target);
      return;
    }
    // A locale switch updates every translated lazy boundary. During selective
    // hydration React requires that broad update to be a transition; otherwise
    // an interaction can force still-hydrating boundaries to client-render.
    startTransition(() => {
      void i18n.changeLanguage(lang);
      navigate(target);
      setOpen(false);
    });
  };

  const current = currentLang === "pl" ? "PL" : "EN";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm font-body font-medium px-2.5 py-1.5 rounded-lg hover:text-primary transition-all duration-200 text-void"
      >
        <span>{current}</span>
        <ChevronDown size={12} className={`transition-transform duration-200 text-charcoal/40 ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full right-0 mt-1.5 bg-white border border-border rounded-xl py-1.5 min-w-[140px] shadow-lg z-50"
          >
            <button onClick={() => switchLang("pl")} className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left font-body text-xs-plus hover:bg-light-teal/50 transition-colors ${currentLang === "pl" ? "text-primary font-semibold" : "text-charcoal/70"}`}>
              PL – Polski
            </button>
            <button onClick={() => switchLang("en")} className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left font-body text-xs-plus hover:bg-light-teal/50 transition-colors ${currentLang === "en" ? "text-primary font-semibold" : "text-charcoal/70"}`}>
              EN – English
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
