import type { KioskTheme } from "./KioskLayout";

interface RankedChoiceTileProps {
  label: string;
  rank: number | null;
  disabled?: boolean;
  theme: KioskTheme;
  onClick: () => void;
}

const ACCENT = "#45BABC";

export function RankedChoiceTile({
  label,
  rank,
  disabled,
  theme,
  onClick,
}: RankedChoiceTileProps) {
  const isLight = theme === "light";
  const selected = rank !== null;

  const baseBg = isLight ? "#FFFFFF" : "rgba(253,248,240,0.04)";
  const baseBorder = isLight ? "1px solid #E5DDD0" : "1px solid rgba(253,248,240,0.18)";
  const fg = isLight ? "#042B2C" : "#FDF8F0";

  const selectedBg = isLight
    ? "rgba(69,186,188,0.08)"
    : "rgba(69,186,188,0.15)";
  const selectedBorder = isLight ? `1px solid ${ACCENT}` : `2px solid ${ACCENT}`;
  const leftAccent = isLight ? `4px solid ${ACCENT}` : "none";

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled && !selected}
      aria-pressed={selected}
      style={{
        appearance: "none",
        WebkitAppearance: "none",
        textAlign: "left",
        width: "100%",
        minHeight: 80,
        padding: "18px 24px 18px 24px",
        background: selected ? selectedBg : baseBg,
        border: selected ? selectedBorder : baseBorder,
        borderLeft: selected ? leftAccent : baseBorder,
        borderRadius: 14,
        color: fg,
        fontFamily: "inherit",
        fontSize: "clamp(15px, 1.7vw, 18px)",
        fontWeight: 500,
        lineHeight: 1.35,
        cursor: disabled && !selected ? "not-allowed" : "pointer",
        opacity: disabled && !selected ? 0.35 : 1,
        transition: "background 150ms, border 150ms",
        touchAction: "manipulation",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 36,
          height: 36,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 16,
          fontWeight: 700,
          background: selected ? ACCENT : "transparent",
          color: selected ? "#042B2C" : isLight ? "rgba(4,43,44,0.35)" : "rgba(253,248,240,0.35)",
          border: selected ? "none" : `1.5px dashed ${isLight ? "rgba(4,43,44,0.25)" : "rgba(253,248,240,0.25)"}`,
        }}
      >
        {selected ? rank : ""}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
