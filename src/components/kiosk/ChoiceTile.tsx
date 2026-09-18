import type { KioskTheme } from "./KioskLayout";

interface ChoiceTileProps {
  label: string;
  selected: boolean;
  disabled?: boolean;
  theme: KioskTheme;
  onClick: () => void;
}

const ACCENT = "#45BABC";

export function ChoiceTile({
  label,
  selected,
  disabled,
  theme,
  onClick,
}: ChoiceTileProps) {
  const isLight = theme === "light";

  const baseBg = isLight ? "#FFFFFF" : "rgba(253,248,240,0.04)";
  const baseBorder = isLight ? "1px solid #E5DDD0" : "1px solid rgba(253,248,240,0.18)";
  const fg = isLight ? "#042B2C" : "#FDF8F0";

  const selectedBg = isLight
    ? "rgba(69,186,188,0.08)"
    : "rgba(69,186,188,0.15)";
  const selectedBorder = isLight
    ? `1px solid ${ACCENT}`
    : `2px solid ${ACCENT}`;
  const leftAccent = isLight ? `4px solid ${ACCENT}` : "none";

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        appearance: "none",
        WebkitAppearance: "none",
        textAlign: "left",
        width: "100%",
        minHeight: 80,
        padding: "18px 24px",
        background: selected ? selectedBg : baseBg,
        border: selected ? selectedBorder : baseBorder,
        borderLeft: selected ? leftAccent : baseBorder,
        borderRadius: 14,
        color: fg,
        fontFamily: "inherit",
        fontSize: "clamp(15px, 1.7vw, 18px)",
        fontWeight: 500,
        lineHeight: 1.35,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "background 150ms, border 150ms, transform 100ms",
        touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );
}
