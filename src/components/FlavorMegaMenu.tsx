import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { useLocalizedPath, RouteKey } from "@/lib/i18nRoutes";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";
import {
  packshotFrontLamb as lambFront,
  packshotFrontVenison as venisonFront,
  packshotFrontBeef as beefFront,
  packshotFrontTurkey as turkeyFront,
  packshotFrontSalmon as salmonFront,
  packshotFrontPork as porkFront,
  packshotFrontLambSecondaryLocale as lambFrontEn,
  packshotFrontVenisonSecondaryLocale as venisonFrontEn,
  packshotFrontBeefSecondaryLocale as beefFrontEn,
  packshotFrontTurkeySecondaryLocale as turkeyFrontEn,
  packshotFrontSalmonSecondaryLocale as salmonFrontEn,
  packshotFrontPorkSecondaryLocale as porkFrontEn,
} from "#deployment-media";

interface Flavor {
  id: string;
  routeKey: RouteKey;
  shortNameKey: string;
  accent: string;
  tintVar: string;
  packshot: string;
  packshotEn: string;
}

const FLAVORS: Flavor[] = [
  { id: "lamb",    routeKey: "productLamb",    shortNameKey: "common:nav.lambShort",    accent: "#00BFB3", tintVar: "--sage-tint",       packshot: lambFront,    packshotEn: lambFrontEn },
  { id: "venison", routeKey: "productVenison", shortNameKey: "common:nav.venisonShort", accent: "#8B1A4A", tintVar: "--lavender-tint",   packshot: venisonFront, packshotEn: venisonFrontEn },
  { id: "beef",    routeKey: "productBeef",    shortNameKey: "common:nav.beefShort",    accent: "#e06040", tintVar: "--terracotta-tint", packshot: beefFront,    packshotEn: beefFrontEn },
  { id: "turkey",  routeKey: "productTurkey",  shortNameKey: "common:nav.turkeyShort",  accent: "#50b0dc", tintVar: "--sky-tint",        packshot: turkeyFront,  packshotEn: turkeyFrontEn },
  { id: "salmon",  routeKey: "productSalmon",  shortNameKey: "common:nav.salmonShort",  accent: "#e6a050", tintVar: "--peach-tint",      packshot: salmonFront,  packshotEn: salmonFrontEn },
  { id: "pork",    routeKey: "productPork",    shortNameKey: "common:nav.porkShort",    accent: "#d88e9c", tintVar: "--rose-tint",       packshot: porkFront,    packshotEn: porkFrontEn },
];

interface Props {
  onItemClick?: () => void;
}

const FlavorMegaMenu = ({ onItemClick }: Props) => {
  const { t, i18n } = useTranslation("common");
  const lp = useLocalizedPath();
  const isEn = i18n.language === "en";
  const samplesPath = usePublicAcquisitionPath();

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      role="menu"
      aria-label={t("common:nav.flavorsTitle")}
      className="absolute top-full left-1/2 -translate-x-1/2 w-[min(860px,92vw)] pt-3 z-50"
    >
      <div className="relative bg-white border border-border rounded-2xl shadow-2xl p-7">
        <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute top-0 right-0 w-1/3 h-full bg-linear-to-bl from-[hsl(var(--sage-tint))]/40 to-transparent" />
        </div>

        <div className="relative flex gap-7">
        <div className="shrink-0 w-[240px] pr-7 border-r border-border/60 flex flex-col">
          <p className="label-text text-teal mb-3" style={{ letterSpacing: "0.14em" }}>openlup</p>
          <h3 className="font-display font-semibold text-[22px] text-charcoal leading-[1.15] mb-3">
            {t("common:nav.flavorsTitle")}
          </h3>
          <p className="font-body text-xs-plus text-charcoal/65 leading-relaxed mb-6">
            {t("common:nav.flavorsDescription")}
          </p>
          <Link
            to={samplesPath}
            onClick={onItemClick}
            className="mt-auto inline-flex items-center justify-center gap-1.5 pill-btn bg-cta text-cta-foreground font-semibold text-xs-plus px-4 py-[10px] hover:brightness-110 transition-all duration-200 shadow-xs whitespace-nowrap"
          >
            {t("common:nav.flavorsCta")}
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>

        <div className="flex-1 grid grid-cols-3 gap-3">
          {FLAVORS.map((flavor) => {
            const href = lp(flavor.routeKey);
            const img = isEn ? flavor.packshotEn : flavor.packshot;
            const name = t(flavor.shortNameKey);
            return (
              <Link
                key={flavor.id}
                to={href}
                onClick={onItemClick}
                role="menuitem"
                aria-label={`${name}, ${t("common:nav.flavors")}`}
                className="group relative flex flex-col items-center p-3 rounded-xl transition-colors duration-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
                style={{ ["--tile-bg" as string]: `hsl(var(${flavor.tintVar}))` }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = `hsl(var(${flavor.tintVar}))`; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = ""; }}
              >
                <div className="w-[120px] h-[140px] flex items-center justify-center transition-transform duration-300 ease-out group-hover:scale-[1.06] group-hover:rotate-[-1.5deg]">
                  <img
                    src={img}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={120}
                    height={140}
                    className="max-w-full max-h-full object-contain drop-shadow-md"
                  />
                </div>
                <span className="mt-2 font-body font-semibold text-sm text-charcoal group-hover:text-primary transition-colors">
                  {name}
                </span>
                <span
                  className="mt-1 h-[2px] w-8 rounded-full transition-all duration-200 group-hover:w-12"
                  style={{ backgroundColor: flavor.accent }}
                  aria-hidden="true"
                />
              </Link>
            );
          })}
        </div>
        </div>
      </div>
    </motion.div>
  );
};

export { FLAVORS };
export default FlavorMegaMenu;
