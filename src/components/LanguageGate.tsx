import { ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { writeStorageItem } from "@/lib/browserStorage";
import { Lang } from "@/lib/i18nRoutes";

interface Props {
  lang?: Lang;
  forceLocale?: Lang;
  children: ReactNode;
}

// Language only. This component used to ALSO write canonical + hreflang straight
// into document.head, which made it a second head writer racing <Seo /> (Helmet):
// both emitted the same tag types, Helmet only replaces its own (`data-rh`), so
// every page carried two <link rel=canonical> — contradicting on /legacy, where this
// file said `/legacy` while Seo said `/`. It could not see page-level context like
// Index.tsx's isLegacy branch, so it could never get that right. `Seo` now owns the
// whole head and derives hreflang from the canonical. See docs/SEO_CONTENT_PLAN.md.
const LanguageGate = ({ lang, forceLocale, children }: Props) => {
  const effectiveLang: Lang = forceLocale ?? lang ?? "pl";
  const { i18n } = useTranslation("common");

  useEffect(() => {
    if (i18n.language !== effectiveLang) {
      i18n.changeLanguage(effectiveLang);
      // Best effort. The URL owns the locale, so a denied store costs nothing —
      // but a throw here is a commit-phase error that blanks the routed tree.
      writeStorageItem("localStorage", "openlup-lang", effectiveLang);
    }
    document.documentElement.setAttribute("lang", effectiveLang);
  }, [effectiveLang, i18n]);

  return <>{children}</>;
};

export default LanguageGate;
