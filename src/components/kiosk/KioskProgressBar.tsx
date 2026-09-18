import type { KioskTheme } from "./KioskLayout";

interface KioskProgressBarProps {
  current: number;
  total: number;
  theme: KioskTheme;
}

const COLORS: Record<KioskTheme, { track: string; fill: string }> = {
  light: { track: "#E5DDD0", fill: "#042B2C" },
  dark: { track: "rgba(253,248,240,0.12)", fill: "#45BABC" },
};

export function KioskProgressBar({ current, total, theme }: KioskProgressBarProps) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const c = COLORS[theme];
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        backgroundColor: c.track,
        zIndex: 10,
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${ratio * 100}%`,
          backgroundColor: c.fill,
          transition: "width 250ms ease",
        }}
      />
    </div>
  );
}
