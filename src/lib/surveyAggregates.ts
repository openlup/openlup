import type { SurveyRow } from "./exportSurveyCsv";

type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

function getField(row: SurveyRow, field: string): Json | undefined {
  const data = row.response_data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return (data as Record<string, Json>)[field];
}

export interface CountEntry {
  value: string;
  count: number;
}

export interface RankedEntry {
  value: string;
  weight: number;
  rank1: number;
  rank2: number;
  rank3: number;
}

export function aggregateSingleChoice(
  rows: SurveyRow[],
  field: string,
  options?: { order?: readonly string[]; sortDesc?: boolean },
): CountEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = getField(row, field);
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw !== "string") continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  if (options?.order) {
    return options.order
      .map((value) => ({ value, count: counts.get(value) ?? 0 }))
      .filter((entry) => entry.count > 0);
  }
  const entries: CountEntry[] = Array.from(counts, ([value, count]) => ({
    value,
    count,
  }));
  if (options?.sortDesc) entries.sort((a, b) => b.count - a.count);
  return entries;
}

export function aggregateMultiChoice(
  rows: SurveyRow[],
  field: string,
  options?: { order?: readonly string[]; sortDesc?: boolean },
): CountEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = getField(row, field);
    if (!Array.isArray(raw)) continue;
    for (const value of raw) {
      if (typeof value !== "string" || value === "") continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  if (options?.order) {
    return options.order
      .map((value) => ({ value, count: counts.get(value) ?? 0 }))
      .filter((entry) => entry.count > 0);
  }
  const entries: CountEntry[] = Array.from(counts, ([value, count]) => ({
    value,
    count,
  }));
  if (options?.sortDesc) entries.sort((a, b) => b.count - a.count);
  return entries;
}

// Weighted ranking: rank1 = 3pts, rank2 = 2pts, rank3 = 1pt.
export function aggregateRanked(
  rows: SurveyRow[],
  field: string,
): RankedEntry[] {
  const map = new Map<
    string,
    { weight: number; rank1: number; rank2: number; rank3: number }
  >();
  const bump = (value: string, rank: 1 | 2 | 3) => {
    const entry = map.get(value) ?? {
      weight: 0,
      rank1: 0,
      rank2: 0,
      rank3: 0,
    };
    if (rank === 1) {
      entry.rank1 += 1;
      entry.weight += 3;
    } else if (rank === 2) {
      entry.rank2 += 1;
      entry.weight += 2;
    } else {
      entry.rank3 += 1;
      entry.weight += 1;
    }
    map.set(value, entry);
  };
  for (const row of rows) {
    const raw = getField(row, field);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, Json>;
    if (typeof r.rank1 === "string" && r.rank1) bump(r.rank1, 1);
    if (typeof r.rank2 === "string" && r.rank2) bump(r.rank2, 2);
    if (typeof r.rank3 === "string" && r.rank3) bump(r.rank3, 3);
  }
  const entries: RankedEntry[] = Array.from(map, ([value, agg]) => ({
    value,
    weight: agg.weight,
    rank1: agg.rank1,
    rank2: agg.rank2,
    rank3: agg.rank3,
  }));
  entries.sort((a, b) => b.weight - a.weight);
  return entries;
}

export function completedCount(
  rows: SurveyRow[],
  type: "producer" | "consumer",
): number {
  return rows.filter((row) => {
    if (type === "producer") {
      const v = getField(row, "screen13_opt_in");
      return v === true || v === false;
    }
    // Consumer: row exists = submitted (submit fires only on finish)
    return true;
  }).length;
}

export function lastResponseAt(rows: SurveyRow[]): Date | null {
  if (rows.length === 0) return null;
  let latest = 0;
  for (const row of rows) {
    const ts = Date.parse(row.created_at);
    if (!Number.isNaN(ts) && ts > latest) latest = ts;
  }
  return latest === 0 ? null : new Date(latest);
}
