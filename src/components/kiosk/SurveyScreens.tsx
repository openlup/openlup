import { useEffect, useMemo, useState } from "react";
import { KioskScreen } from "./KioskScreen";
import { KioskButton } from "./KioskButton";
import { ChoiceTile } from "./ChoiceTile";
import { RankedChoiceTile } from "./RankedChoiceTile";
import type { KioskTheme } from "./KioskLayout";
import {
  AUTO_ADVANCE_DELAY_MS,
  ctaRowStyle,
  tileGridStyle,
  type RankedTriple,
  type SurveyOption,
} from "./surveyScreenUtils";

function fg(theme: KioskTheme): string {
  return theme === "light" ? "#042B2C" : "#FDF8F0";
}
function fgMuted(theme: KioskTheme): string {
  return theme === "light" ? "rgba(4,43,44,0.75)" : "rgba(253,248,240,0.7)";
}
function fgSoft(theme: KioskTheme): string {
  return theme === "light" ? "rgba(4,43,44,0.5)" : "rgba(253,248,240,0.45)";
}
function inputBg(theme: KioskTheme): string {
  return theme === "light" ? "#FFFFFF" : "rgba(253,248,240,0.06)";
}
function inputBorder(theme: KioskTheme): string {
  return theme === "light" ? "1px solid #E5DDD0" : "1px solid rgba(253,248,240,0.2)";
}

// ─── Single-choice screen (hybrid auto-advance) ──────────────────────────────
//
// First visit (autoAdvance=true): tap → selected state instantly → 700ms delay → advance.
// After Back (autoAdvance=false): tap → selected state only; explicit Next CTA advances.

export function ScreenSingle({
  screenKey,
  theme,
  title,
  body,
  options,
  value,
  onSelect,
  onAdvance,
  autoAdvance = true,
}: {
  screenKey: string;
  theme: KioskTheme;
  title: string;
  body?: string;
  options: readonly SurveyOption[];
  value: string;
  onSelect: (v: string) => void;
  onAdvance: () => void;
  autoAdvance?: boolean;
}) {
  return (
    <KioskScreen
      screenKey={screenKey}
      theme={theme}
      title={title}
      body={body}
      variant={theme === "dark" ? "slide" : "fade"}
    >
      <div style={tileGridStyle}>
        {options.map((opt) => (
          <ChoiceTile
            key={opt.value}
            label={opt.label}
            selected={value === opt.value}
            theme={theme}
            onClick={() => {
              onSelect(opt.value);
              if (autoAdvance) {
                window.setTimeout(onAdvance, AUTO_ADVANCE_DELAY_MS);
              }
            }}
          />
        ))}
      </div>
      {!autoAdvance && (
        <div style={ctaRowStyle}>
          <KioskButton label="Next →" onClick={onAdvance} theme={theme} />
        </div>
      )}
    </KioskScreen>
  );
}

// ─── Multi-choice screen (explicit NEXT) ─────────────────────────────────────

export function ScreenMulti({
  screenKey,
  theme,
  title,
  body,
  options,
  values,
  onToggle,
  onNext,
  nextDisabled,
}: {
  screenKey: string;
  theme: KioskTheme;
  title: string;
  body?: string;
  options: readonly SurveyOption[];
  values: string[];
  onToggle: (v: string) => void;
  onNext: () => void;
  nextDisabled: boolean;
}) {
  return (
    <KioskScreen
      screenKey={screenKey}
      theme={theme}
      title={title}
      body={body}
      variant={theme === "dark" ? "slide" : "fade"}
    >
      <div style={tileGridStyle}>
        {options.map((opt) => (
          <ChoiceTile
            key={opt.value}
            label={opt.label}
            selected={values.includes(opt.value)}
            theme={theme}
            onClick={() => onToggle(opt.value)}
          />
        ))}
      </div>
      <div style={ctaRowStyle}>
        <KioskButton
          label="Next →"
          onClick={onNext}
          disabled={nextDisabled}
          theme={theme}
        />
      </div>
    </KioskScreen>
  );
}

// ─── Ranked top-3 screen ─────────────────────────────────────────────────────

export function ScreenRanked({
  screenKey,
  theme,
  title,
  body,
  options,
  ranks,
  onChange,
  onNext,
}: {
  screenKey: string;
  theme: KioskTheme;
  title: string;
  body?: string;
  options: readonly SurveyOption[];
  ranks: RankedTriple;
  onChange: (r: RankedTriple) => void;
  onNext: () => void;
}) {
  const rankByOption = useMemo(() => {
    const map: Record<string, number> = {};
    if (ranks.rank1) map[ranks.rank1] = 1;
    if (ranks.rank2) map[ranks.rank2] = 2;
    if (ranks.rank3) map[ranks.rank3] = 3;
    return map;
  }, [ranks]);

  const used = (ranks.rank1 ? 1 : 0) + (ranks.rank2 ? 1 : 0) + (ranks.rank3 ? 1 : 0);

  const handleTap = (opt: string) => {
    const r = rankByOption[opt];
    if (r) {
      const next = { ...ranks };
      if (r === 1) {
        next.rank1 = next.rank2;
        next.rank2 = next.rank3;
        next.rank3 = "";
      } else if (r === 2) {
        next.rank2 = next.rank3;
        next.rank3 = "";
      } else {
        next.rank3 = "";
      }
      onChange(next);
    } else {
      if (used >= 3) return;
      const next = { ...ranks };
      if (!next.rank1) next.rank1 = opt;
      else if (!next.rank2) next.rank2 = opt;
      else next.rank3 = opt;
      onChange(next);
    }
  };

  return (
    <KioskScreen
      screenKey={screenKey}
      theme={theme}
      title={title}
      body={body}
      variant={theme === "dark" ? "slide" : "fade"}
    >
      <div style={tileGridStyle}>
        {options.map((opt) => {
          const r = rankByOption[opt.value] ?? null;
          return (
            <RankedChoiceTile
              key={opt.value}
              label={opt.label}
              rank={r}
              theme={theme}
              disabled={r === null && used >= 3}
              onClick={() => handleTap(opt.value)}
            />
          );
        })}
      </div>
      <div style={ctaRowStyle}>
        <KioskButton
          label="Next →"
          onClick={onNext}
          disabled={used < 3}
          theme={theme}
        />
      </div>
    </KioskScreen>
  );
}

// ─── Optional surprise-quote screen ──────────────────────────────────────────

export function ScreenSurprise({
  theme,
  title,
  body,
  onFinish,
}: {
  theme: KioskTheme;
  title: string;
  body?: string;
  onFinish: (quote: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <KioskScreen
      screenKey="surprise"
      theme={theme}
      title={title}
      body={body}
      variant={theme === "dark" ? "slide" : "fade"}
    >
      <input
        type="text"
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        inputMode="text"
        enterKeyHint="done"
        autoComplete="off"
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          width: "100%",
          maxWidth: 720,
          height: 72,
          padding: "0 22px",
          fontSize: 18,
          fontFamily: "inherit",
          background: inputBg(theme),
          border: inputBorder(theme),
          borderRadius: 14,
          color: fg(theme),
          outline: "none",
        }}
      />
      <div style={{ ...ctaRowStyle, gap: 16 }}>
        <KioskButton
          label="Finish →"
          onClick={() => onFinish(text)}
          theme={theme}
        />
        <KioskButton
          label="Skip →"
          onClick={() => onFinish("")}
          theme={theme}
          variant="ghost"
        />
      </div>
    </KioskScreen>
  );
}

// ─── Thank-you screen with countdown ─────────────────────────────────────────

export function ScreenThankYou({
  theme,
  headline,
  body,
  small,
  onReset,
  resetSeconds = 15,
}: {
  theme: KioskTheme;
  headline: string;
  body: string;
  small?: string;
  onReset: () => void;
  resetSeconds?: number;
}) {
  const [secondsLeft, setSecondsLeft] = useState(resetSeconds);

  useEffect(() => {
    if (secondsLeft <= 0) {
      onReset();
      return;
    }
    const t = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [secondsLeft, onReset]);

  return (
    <KioskScreen
      screenKey="thank_you"
      theme={theme}
      variant={theme === "dark" ? "slide" : "fade"}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: 20,
        }}
      >
        <h1
          style={{
            fontFamily: "'Clash Display', 'Plus Jakarta Sans', sans-serif",
            fontWeight: 600,
            fontSize: "clamp(36px, 5vw, 56px)",
            lineHeight: 1.1,
            color: fg(theme),
            margin: 0,
          }}
        >
          {headline}
        </h1>
        <p
          style={{
            fontSize: "clamp(16px, 1.9vw, 20px)",
            lineHeight: 1.55,
            color: fgMuted(theme),
            maxWidth: 680,
            margin: 0,
          }}
        >
          {body}
        </p>
        {small && (
          <p style={{ fontSize: 13, color: fgSoft(theme), margin: 0 }}>{small}</p>
        )}
        <p
          style={{
            position: "absolute",
            bottom: 64,
            right: 28,
            fontSize: 12,
            color: fgSoft(theme),
            margin: 0,
          }}
        >
          Restarting in {secondsLeft}…
        </p>
      </div>
    </KioskScreen>
  );
}

// ─── Exit screen (early disqualification) ────────────────────────────────────

export function ScreenExit({
  theme,
  headline,
  body,
  onReset,
  resetSeconds = 10,
}: {
  theme: KioskTheme;
  headline: string;
  body: string;
  onReset: () => void;
  resetSeconds?: number;
}) {
  const [secondsLeft, setSecondsLeft] = useState(resetSeconds);
  useEffect(() => {
    if (secondsLeft <= 0) {
      onReset();
      return;
    }
    const t = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [secondsLeft, onReset]);

  return (
    <KioskScreen
      screenKey="exit"
      theme={theme}
      variant={theme === "dark" ? "slide" : "fade"}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: 20,
        }}
      >
        <h1
          style={{
            fontFamily: "'Clash Display', 'Plus Jakarta Sans', sans-serif",
            fontWeight: 600,
            fontSize: "clamp(36px, 5vw, 56px)",
            color: fg(theme),
            margin: 0,
          }}
        >
          {headline}
        </h1>
        <p
          style={{
            fontSize: "clamp(16px, 1.9vw, 20px)",
            color: fgMuted(theme),
            maxWidth: 680,
            margin: 0,
          }}
        >
          {body}
        </p>
        <p style={{ fontSize: 12, color: fgSoft(theme), margin: 0 }}>
          Restarting in {secondsLeft}…
        </p>
      </div>
    </KioskScreen>
  );
}

// ─── Light-theme text input used in producer contact form ────────────────────

export function KioskInput({
  theme,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  inputMode,
  enterKeyHint,
}: {
  theme: KioskTheme;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel" | "url" | "search" | "numeric" | "decimal";
  enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
}) {
  const resolvedInputMode = inputMode ?? (type === "email" ? "email" : undefined);
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 13,
        color: fgMuted(theme),
      }}
    >
      <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoCapitalize={type === "email" ? "none" : undefined}
        inputMode={resolvedInputMode}
        enterKeyHint={enterKeyHint}
        spellCheck={false}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          height: 64,
          padding: "0 18px",
          fontSize: 17,
          fontFamily: "inherit",
          background: inputBg(theme),
          border: inputBorder(theme),
          borderRadius: 12,
          color: fg(theme),
          outline: "none",
        }}
      />
    </label>
  );
}
