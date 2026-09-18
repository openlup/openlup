import type { CSSProperties } from "react";

export const AUTO_ADVANCE_DELAY_MS = 700;

export interface SurveyOption {
  value: string;
  label: string;
}

export interface RankedTriple {
  rank1: string;
  rank2: string;
  rank3: string;
}

export function asOptions(arr: readonly string[]): readonly SurveyOption[] {
  return arr.map((s) => ({ value: s, label: s }));
}

export const tileGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 14,
  width: "100%",
  flex: 1,
  alignContent: "start",
  overflowY: "auto",
  paddingRight: 4,
};

export const ctaRowStyle: CSSProperties = {
  marginTop: 20,
  display: "flex",
  justifyContent: "flex-end",
  flexShrink: 0,
};
