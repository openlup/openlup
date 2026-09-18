import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useLocalizedPath } from "@/lib/i18nRoutes";

export default function HomepageAppTransparencySection() {
  const { t } = useTranslation(["content", "home"]);
  const localizedPath = useLocalizedPath();

  return (
    <section
      aria-labelledby="app-transparency-title"
      className="bg-void px-6 py-14 text-offwhite lg:px-[72px]"
    >
      <div className="mx-auto grid max-w-[1180px] gap-8 border-t border-offwhite/10 pt-10 md:grid-cols-[0.9fr_1.4fr]">
        <div>
          <p className="label-text mb-3 text-teal">{t("content:appTransparency.eyebrow")}</p>
          <h2
            id="app-transparency-title"
            className="font-display text-3xl font-semibold leading-tight md:text-4xl"
          >
            {t("content:appTransparency.title")}
          </h2>
        </div>
        <div className="space-y-4 font-body text-sm-plus leading-relaxed text-offwhite/72">
          <p>{t("home:appTransparency.description")}</p>
          <p>{t("content:appTransparency.dataUse")}</p>
          <p>{t("content:appTransparency.googleUse")}</p>
          <p>
            {t("content:appTransparency.privacyPrefix")}{" "}
            <Link
              to={localizedPath("privacyPolicy")}
              className="font-semibold text-teal underline underline-offset-4 hover:text-offwhite"
            >
              {t("content:appTransparency.privacyLink")}
            </Link>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
