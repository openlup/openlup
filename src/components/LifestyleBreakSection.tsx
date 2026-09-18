import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { lifestyleOwnerPortrait as womanWithAkita } from "#deployment-media";
import { useLocalizedPath } from "@/lib/i18nRoutes";

const LifestyleBreakSection = () => {
  const { t } = useTranslation("content");
  const lp = useLocalizedPath();
  return (
    <section className="relative h-[400px] overflow-hidden">
      <img src={womanWithAkita} alt="Woman walking with her Akita in nature" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
      <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.3), rgba(0,0,0,0.45))" }} />
      <div className="relative z-10 flex flex-col items-center justify-center h-full px-6 gap-6">
        <p className="font-display font-semibold text-[24px] lg:text-[40px] text-white text-center leading-[1.2] max-w-[600px] drop-shadow-lg whitespace-pre-line">{t("content:lifestyle.text")}</p>
        <Link to={lp("ourStory")} className="pill-btn bg-white/90 text-void font-semibold text-sm-plus px-8 py-[12px] hover:bg-white transition-all duration-200 shadow-lg">
          {t("content:lifestyle.cta")}
        </Link>
      </div>
    </section>
  );
};

export default LifestyleBreakSection;
