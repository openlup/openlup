import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import type { KioskTheme } from "./KioskLayout";

interface KioskScreenProps {
  screenKey: string;
  theme: KioskTheme;
  title?: string;
  body?: string;
  children: ReactNode;
  /** "slide" used for consumer (warmer feel); "fade" used for producer. */
  variant?: "fade" | "slide";
}

export function KioskScreen({
  screenKey,
  theme,
  title,
  body,
  children,
  variant = "fade",
}: KioskScreenProps) {
  const titleColor = theme === "light" ? "#042B2C" : "#FDF8F0";
  const bodyColor =
    theme === "light" ? "rgba(4,43,44,0.7)" : "rgba(253,248,240,0.7)";

  const initial = variant === "slide" ? { opacity: 0, y: 16 } : { opacity: 0 };
  const animate = variant === "slide" ? { opacity: 1, y: 0 } : { opacity: 1 };
  const exit = variant === "slide" ? { opacity: 0, y: -16 } : { opacity: 0 };

  return (
    <AnimatePresence mode="wait">
      <motion.section
        key={screenKey}
        initial={initial}
        animate={animate}
        exit={exit}
        transition={{ duration: 0.25, ease: "easeOut" }}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding:
            "clamp(8px, 2vw, 16px) clamp(20px, 6vw, 56px) clamp(24px, 4vw, 32px)",
          maxWidth: 920,
          width: "100%",
          margin: "0 auto",
          minHeight: 0,
        }}
      >
        {title && (
          <h1
            style={{
              fontFamily:
                "'Clash Display', 'Plus Jakarta Sans', system-ui, sans-serif",
              fontWeight: 600,
              fontSize: "clamp(28px, 4.2vw, 44px)",
              lineHeight: 1.15,
              letterSpacing: "-0.01em",
              color: titleColor,
              margin: "0 0 12px 0",
            }}
          >
            {title}
          </h1>
        )}
        {body && (
          <p
            style={{
              fontSize: "clamp(15px, 1.8vw, 18px)",
              lineHeight: 1.5,
              color: bodyColor,
              margin: "0 0 28px 0",
              maxWidth: 720,
            }}
          >
            {body}
          </p>
        )}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          {children}
        </div>
      </motion.section>
    </AnimatePresence>
  );
}
