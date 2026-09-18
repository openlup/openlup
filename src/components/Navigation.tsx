import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { PanelLeft, X, ChevronDown } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { brandMark as veliLogo } from "#deployment-media";
import { useLocalizedPath } from "@/lib/i18nRoutes";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";
import { useRenderRuntime } from "@/app/renderMode";
import { isCustomerAccountSurfaceAllowed } from "@/lib/hiddenSurfaceAccess";
import FlavorMegaMenu, { FLAVORS } from "@/components/FlavorMegaMenu";
import { LanguageFallbackLinks } from "@/components/navigation/LanguageFallbackLinks";
import { LanguageSwitcher } from "@/components/navigation/LanguageSwitcher";
import { SocialLinks } from "@/components/SocialLinks";
import { useMobileMenuA11y } from "@/components/navigation/useMobileMenuA11y";
import { NavAuthLink } from "@/components/navigation/NavAuthLink";
import { navLinks, type NavChild, type NavLink } from "@/components/navigation/navLinks";
const Navigation = () => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const dropdownTimeout = useRef<ReturnType<typeof setTimeout>>();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { mode } = useRenderRuntime();
  // Keep the first lazy SSG render server-identical, then enhance after mount.
  const [enhanced, setEnhanced] = useState(mode === "csr");
  const { t, i18n } = useTranslation("common");
  const lp = useLocalizedPath();
  const homePath = lp("home");
  const samplesPath = usePublicAcquisitionPath();
  const loginPath = lp("customerLogin");
  const accountSurface = isCustomerAccountSurfaceAllowed();
  const accountPath = lp("customerDashboard");
  const reduceMotion = useReducedMotion() ?? false;

  const hrefFor = (link: NavLink) => link.routeKey ? lp(link.routeKey) : (link.href || "#");
  const hrefForChild = (child: NavChild) => lp(child.routeKey);
  const closeMobileMenu = useCallback(() => setMobileOpen(false), []);
  useMobileMenuA11y({ open: mobileOpen, openerRef: menuButtonRef, panelRef: mobilePanelRef,
    initialFocusRef: mobileCloseButtonRef, onClose: closeMobileMenu });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenDropdown(null);
        closeMobileMenu();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeMobileMenu]);
  useEffect(() => () => clearTimeout(dropdownTimeout.current), []);
  useEffect(() => setEnhanced(true), []);
  useEffect(() => {
    let frame = 0;
    const updateScrolled = () => {
      frame = 0;
      setScrolled(window.scrollY > 40);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateScrolled);
    };
    updateScrolled();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const handleNavClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    closeMobileMenu();
    setOpenDropdown(null);
    if (href.startsWith("/")) {
      navigate(href);
      return;
    }
    if (location.pathname !== homePath) {
      navigate(homePath + href);
      return;
    }
    const target = document.querySelector(href);
    if (target) target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [navigate, location.pathname, homePath, reduceMotion, closeMobileMenu]);
  const handleDropdownEnter = (label: string) => {
    clearTimeout(dropdownTimeout.current); setOpenDropdown(label);
  };
  const handleDropdownLeave = () => {
    dropdownTimeout.current = setTimeout(() => setOpenDropdown(null), 150);
  };
  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-100 focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:rounded-lg focus:font-body focus:font-semibold focus:text-sm">
        Skip to content
      </a>
      <nav className={`fixed top-[var(--announcement-height)] left-0 right-0 z-50 h-[var(--header-height)] flex items-center px-5 md:px-6 lg:px-12 transition-all duration-300 ${scrolled ? "bg-white/95 backdrop-blur-[20px] border-b border-border shadow-xs" : "bg-white/80 backdrop-blur-md"}`}>
        <a href={homePath} onClick={(e) => { e.preventDefault(); if (location.pathname === homePath) { window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }); } else { navigate(homePath); } }} className="block">
          <img src={veliLogo} alt="openlup™" className="h-[28px] w-auto" />
        </a>

        <div className="hidden lg:flex items-center gap-8 mx-auto">
          {navLinks.map((link) => {
            const label = t(link.labelKey);
            const href = hrefFor(link);
            const isMega = link.labelKey === "common:nav.forDogs";
            return link.children ? (
              <div
                key={link.labelKey}
                className="relative"
                onMouseEnter={() => handleDropdownEnter(link.labelKey)}
                onMouseLeave={handleDropdownLeave}
              >
                <button
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={openDropdown === link.labelKey}
                  onClick={() => setOpenDropdown(openDropdown === link.labelKey ? null : link.labelKey)}
                  className="font-body font-medium text-sm text-void hover:text-primary transition-colors duration-200 flex items-center gap-1"
                >
                  {label}
                  <ChevronDown size={14} className={`transition-transform duration-200 ${openDropdown === link.labelKey ? "rotate-180" : ""}`} />
                </button>
                <AnimatePresence>
                  {openDropdown === link.labelKey && (
                    isMega ? (
                      <FlavorMegaMenu key="mega" onItemClick={() => setOpenDropdown(null)} />
                    ) : (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        transition={{ duration: 0.15 }}
                        className="absolute top-full left-1/2 -translate-x-1/2 mt-2 bg-white border border-border rounded-xl py-2 min-w-[220px] shadow-lg"
                      >
                        {link.children.map((child) => {
                          const childHref = hrefForChild(child);
                          return (
                            <a
                              key={child.labelKey}
                              href={childHref}
                              onClick={(e) => handleNavClick(e, childHref)}
                              className="flex items-center gap-2.5 px-4 py-2.5 font-body text-xs-plus text-charcoal hover:text-primary hover:bg-light-teal/50 transition-colors duration-150"
                            >
                              {child.dotColor && (
                                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: child.dotColor }} aria-hidden="true" />
                              )}
                              {t(child.labelKey)}
                            </a>
                          );
                        })}
                      </motion.div>
                    )
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <a key={link.labelKey} href={href} onClick={(e) => handleNavClick(e, href)} className={`font-body font-medium text-sm transition-colors duration-200 ${location.pathname === href ? "text-primary border-b-2 border-primary pb-0.5" : "text-void hover:text-primary"}`}>
                {label}
              </a>
            );
          })}
        </div>

        <div className="hidden lg:flex items-center gap-3">
          {accountSurface && <NavAuthLink variant="bar" loginPath={loginPath} accountPath={accountPath} onNavigate={handleNavClick} />}
          <a href={samplesPath} onClick={(e) => handleNavClick(e, samplesPath)} className="pill-btn bg-cta text-cta-foreground text-sm font-semibold px-[22px] py-[10px] hover:brightness-110 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-void focus-visible:ring-offset-2 focus-visible:ring-offset-white">
            {t("common:nav.apply")}
          </a>
          <SocialLinks variant="nav" className="ml-1" />
          {!enhanced ? <LanguageFallbackLinks /> : <LanguageSwitcher />}
        </div>

        {!enhanced ? (
          <details className="group relative ml-auto lg:hidden">
            <summary className="flex min-h-[44px] min-w-[44px] cursor-pointer list-none items-center justify-center p-2 text-void focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden" aria-label="Open menu">
              <PanelLeft size={24} />
            </summary>
            <div className="absolute right-0 top-full mt-2 max-h-[75vh] w-[min(90vw,22rem)] overflow-y-auto rounded-2xl border border-border bg-white p-5 shadow-xl">
              <div className="flex flex-col gap-4">
                {navLinks.flatMap((link) => link.children?.length
                  ? link.children.map((child) => (
                      <a key={child.routeKey} href={hrefForChild(child)} className="font-body text-base font-semibold text-void">
                        {t(child.labelKey)}
                      </a>
                    ))
                  : [(
                      <a key={link.labelKey} href={hrefFor(link)} className="font-body text-base font-semibold text-void">
                        {t(link.labelKey)}
                      </a>
                    )])}
              </div>
              <div className="mt-5 flex items-center border-t border-border pt-4">
                <LanguageFallbackLinks className="gap-4" />
                <SocialLinks variant="nav" className="ml-auto" />
              </div>
            </div>
          </details>
        ) : (
          <button ref={menuButtonRef} type="button" onClick={() => setMobileOpen(true)} className="lg:hidden ml-auto text-void p-2 min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white" aria-label="Open menu" aria-expanded={mobileOpen}>
            <PanelLeft size={24} />
          </button>
        )}
      </nav>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={reduceMotion ? { opacity: 1 } : { x: "100%" }}
            animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-60"
          >
            <div
              ref={mobilePanelRef}
              role="dialog"
              aria-modal="true"
              aria-label={t("common:nav.menu", { defaultValue: "Menu" })}
              tabIndex={-1}
              className="h-full bg-white flex flex-col p-6 focus:outline-none"
            >
              <div className="flex justify-between items-center">
                <img src={veliLogo} alt="openlup™" className="h-[28px] w-auto" />
                <div className="flex items-center gap-1">
                  <SocialLinks variant="nav" />
                  <LanguageSwitcher />
                  <button ref={mobileCloseButtonRef} type="button" onClick={closeMobileMenu} className="text-void p-2 min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white" aria-label="Close menu"><X size={24} /></button>
                </div>
              </div>
              <div className="flex flex-col gap-6 mt-16">
                {navLinks.map((link) => {
                  const href = hrefFor(link);
                  const isMega = link.labelKey === "common:nav.forDogs";
                  return link.children ? (
                    <div key={link.labelKey}>
                      <a href={href} onClick={(e) => handleNavClick(e, href)} className="font-body font-semibold text-[22px] text-void hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-white rounded-sm">
                        {t(link.labelKey)}
                      </a>
                      <div className={isMega ? "mt-4" : "flex flex-col gap-2 mt-3 ml-4 border-l border-border pl-4"}>
                        {isMega ? (
                          // Mobile (runda 11): smaki w gridzie 3-kol z dużymi puszkami.
                          <div className="grid grid-cols-3 gap-2.5">
                            {FLAVORS.map((flavor) => (
                              <a
                                key={flavor.id}
                                href={lp(flavor.routeKey)}
                                onClick={(e) => handleNavClick(e, lp(flavor.routeKey))}
                                className="flex flex-col items-center gap-1.5 rounded-xl bg-warm-cream border border-border p-2.5 hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                              >
                                <span className="h-16 flex items-center justify-center">
                                  <img src={i18n.language === "en" ? flavor.packshotEn : flavor.packshot} alt="" loading="lazy" className="max-h-full w-auto object-contain" />
                                </span>
                                <span className="font-body text-xs text-center text-charcoal/75 leading-tight">{t(flavor.shortNameKey)}</span>
                              </a>
                            ))}
                          </div>
                        ) : (
                          link.children.map((child) => {
                            const childHref = hrefForChild(child);
                            return (
                              <a key={child.labelKey} href={childHref} onClick={(e) => handleNavClick(e, childHref)} className="flex items-center gap-2.5 font-body text-base text-muted-foreground hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-white rounded-sm">
                                {child.dotColor && (
                                  <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: child.dotColor }} aria-hidden="true" />
                                )}
                                {t(child.labelKey)}
                              </a>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ) : (
                    <a key={link.labelKey} href={href} onClick={(e) => handleNavClick(e, href)} className="font-body font-semibold text-[22px] text-void hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-white rounded-sm">
                      {t(link.labelKey)}
                    </a>
                  );
                })}
              </div>
              <div className="mt-auto flex flex-col gap-3">
                {accountSurface && <NavAuthLink variant="drawer" loginPath={loginPath} accountPath={accountPath} onNavigate={handleNavClick} />}
                <a href={samplesPath} onClick={(e) => handleNavClick(e, samplesPath)} className="pill-btn bg-cta text-cta-foreground text-center font-semibold py-[14px] px-8 text-sm-plus hover:brightness-110 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-void focus-visible:ring-offset-2 focus-visible:ring-offset-white">
                  {t("common:nav.applyProgram")}
                </a>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navigation;
