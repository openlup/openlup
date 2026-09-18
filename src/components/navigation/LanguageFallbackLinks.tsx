import { useLocation } from "react-router-dom";

import { alternatePathForLangPreservingState } from "@/lib/i18nRoutes";

/**
 * Plain PL/EN anchors for the non-enhanced render (no JS yet or hydration
 * pending). Full page navigation, no state, so the switch always works.
 */
export function LanguageFallbackLinks({ className = "" }: { className?: string }) {
  const location = useLocation();
  const href = (lang: "pl" | "en") =>
    alternatePathForLangPreservingState(location.pathname, lang, location.search, location.hash);
  return (
    <div className={`flex gap-2 font-body text-sm font-semibold ${className}`}>
      <a href={href("pl")}>PL</a>
      <a href={href("en")}>EN</a>
    </div>
  );
}
