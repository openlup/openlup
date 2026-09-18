import type { KioskTheme } from "./KioskLayout";

interface KioskButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  theme: KioskTheme;
  variant?: "primary" | "ghost";
}

const ACCENT = "#45BABC";

export function KioskButton({
  label,
  onClick,
  disabled,
  theme,
  variant = "primary",
}: KioskButtonProps) {
  const isLight = theme === "light";

  let bg: string;
  let fg: string;
  let border: string;

  if (variant === "primary") {
    bg = isLight ? "#042B2C" : ACCENT;
    fg = isLight ? "#FDF8F0" : "#042B2C";
    border = "1px solid transparent";
  } else {
    bg = "transparent";
    fg = isLight ? "#042B2C" : "#FDF8F0";
    border = isLight ? "1px solid rgba(4,43,44,0.25)" : "1px solid rgba(253,248,240,0.25)";
  }

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        appearance: "none",
        WebkitAppearance: "none",
        minHeight: 64,
        padding: "0 32px",
        background: bg,
        color: fg,
        border,
        borderRadius: 12,
        fontFamily: "inherit",
        fontSize: "clamp(14px, 1.6vw, 17px)",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        transition: "opacity 150ms, transform 100ms",
        touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );
}
