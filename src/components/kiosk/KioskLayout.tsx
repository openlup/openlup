import { useEffect, type ReactNode } from "react";
import { Helmet } from "react-helmet-async";
import { absoluteUrl } from "@/lib/i18nRoutes";

export type KioskTheme = "light" | "dark";

const THEME_STYLES: Record<KioskTheme, { bg: string; fg: string; muted: string }> = {
  light: { bg: "#FDF8F0", fg: "#042B2C", muted: "#666666" },
  dark: { bg: "#042B2C", fg: "#FDF8F0", muted: "rgba(253,248,240,0.55)" },
};

interface KioskLayoutProps {
  theme: KioskTheme;
  headerLabel: string;
  canonicalPath: string;
  footerLabel?: string;
  onBack?: () => void;
  /**
   * Allow the outer container to scroll. Use for screens with text inputs so
   * mobile keyboards don't trap "Submit"/"Finish" buttons behind the IME.
   */
  allowScroll?: boolean;
  children: ReactNode;
}

export function KioskLayout({
  theme,
  headerLabel,
  canonicalPath,
  footerLabel,
  onBack,
  allowScroll = false,
  children,
}: KioskLayoutProps) {
  const styles = THEME_STYLES[theme];

  const backButtonStyle = {
    appearance: "none" as const,
    WebkitAppearance: "none" as const,
    minHeight: 52,
    padding: "0 22px",
    background: "transparent",
    color: styles.fg,
    border:
      theme === "light"
        ? "1px solid rgba(4,43,44,0.22)"
        : "1px solid rgba(253,248,240,0.28)",
    borderRadius: 10,
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: "0.06em" as const,
    textTransform: "uppercase" as const,
    cursor: "pointer",
    touchAction: "manipulation" as const,
  };

  // Disable browser back button — push state on mount, re-push on popstate
  useEffect(() => {
    const handler = () => {
      window.history.pushState(null, "", window.location.href);
    };
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Disable browser context menu (long-press / right-click)
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  // Hosted entries already contain the static homepage canonical. Update that
  // singleton instead of asking Helmet to append a second, conflicting link.
  useEffect(() => {
    const selector = 'link[rel="canonical"]:not([hreflang])';
    let canonical = document.head.querySelector<HTMLLinkElement>(selector);
    const created = !canonical;
    const previousHref = canonical?.getAttribute("href") ?? null;
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", absoluteUrl(canonicalPath));
    return () => {
      if (created) {
        canonical.remove();
      } else if (previousHref === null) {
        canonical.removeAttribute("href");
      } else {
        canonical.setAttribute("href", previousHref);
      }
    };
  }, [canonicalPath]);

  return (
    <>
      <Helmet>
        <html lang="en" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
        />
        <meta name="robots" content="noindex, nofollow" />
        <title>{headerLabel}</title>
      </Helmet>

      <div
        className="kiosk-root"
        style={{
          position: allowScroll ? "absolute" : "fixed",
          inset: 0,
          backgroundColor: styles.bg,
          color: styles.fg,
          fontFamily:
            "'Plus Jakarta Sans', system-ui, -apple-system, Segoe UI, sans-serif",
          WebkitUserSelect: "none",
          userSelect: "none",
          WebkitTouchCallout: "none",
          touchAction: "manipulation",
          overflowY: allowScroll ? "auto" : "hidden",
          overflowX: "hidden",
          WebkitOverflowScrolling: allowScroll ? "touch" : undefined,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            position: "absolute",
            top: 16,
            left: 28,
            right: 28,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 13,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: styles.fg,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <span style={{ fontWeight: 600 }}>{headerLabel}</span>
        </header>

        <main
          style={{
            flex: allowScroll ? "0 0 auto" : 1,
            display: "flex",
            flexDirection: "column",
            minHeight: allowScroll ? "100%" : 0,
            paddingTop: 56,
            paddingBottom: footerLabel ? 48 : 24,
          }}
        >
          {children}
          {allowScroll && onBack && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-start",
                padding: "16px 24px 24px",
              }}
            >
              <button type="button" onClick={onBack} style={backButtonStyle}>
                ← Back
              </button>
            </div>
          )}
        </main>

        {footerLabel && (
          <footer
            style={{
              position: "absolute",
              bottom: 16,
              left: 28,
              right: 28,
              fontSize: 11,
              color: styles.muted,
              textAlign: "center",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            {footerLabel}
          </footer>
        )}

        {onBack && !allowScroll && (
          <button
            type="button"
            onClick={onBack}
            style={{
              ...backButtonStyle,
              position: "absolute",
              bottom: footerLabel ? 44 : 24,
              left: 24,
              zIndex: 6,
            }}
          >
            ← Back
          </button>
        )}
      </div>
    </>
  );
}
