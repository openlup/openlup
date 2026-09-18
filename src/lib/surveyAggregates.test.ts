import { describe, expect, it } from "vitest";
import {
  aggregateMultiChoice,
  aggregateRanked,
  aggregateSingleChoice,
  completedCount,
  lastResponseAt,
} from "@/lib/surveyAggregates";
import type { SurveyRow } from "@/lib/exportSurveyCsv";

const rows: SurveyRow[] = [
  {
    id: "1",
    created_at: "2026-05-14T07:00:00.000Z",
    response_data: {
      region: "EU",
      channels: ["Retail", "Online"],
      ranking: { rank1: "Taste", rank2: "Price", rank3: "Sustainability" },
      screen13_opt_in: true,
    },
  },
  {
    id: "2",
    created_at: "2026-05-14T08:00:00.000Z",
    response_data: {
      region: "EU",
      channels: ["Retail", ""],
      ranking: { rank1: "Price", rank2: "Taste" },
      screen13_opt_in: false,
    },
  },
  {
    id: "3",
    created_at: "not-a-date",
    response_data: {
      region: "US",
      channels: "Retail",
      ranking: null,
    },
  },
];

describe("surveyAggregates", () => {
  it("counts single-choice values with optional ordering", () => {
    expect(aggregateSingleChoice(rows, "region", { order: ["US", "EU"] })).toEqual([
      { value: "US", count: 1 },
      { value: "EU", count: 2 },
    ]);
  });

  it("counts multi-choice arrays and ignores malformed values", () => {
    expect(aggregateMultiChoice(rows, "channels", { sortDesc: true })).toEqual([
      { value: "Retail", count: 2 },
      { value: "Online", count: 1 },
    ]);
  });

  it("weights ranked answers by rank position", () => {
    expect(aggregateRanked(rows, "ranking")).toEqual([
      { value: "Taste", weight: 5, rank1: 1, rank2: 1, rank3: 0 },
      { value: "Price", weight: 5, rank1: 1, rank2: 1, rank3: 0 },
      { value: "Sustainability", weight: 1, rank1: 0, rank2: 0, rank3: 1 },
    ]);
  });

  it("reports completion and latest response timestamps", () => {
    expect(completedCount(rows, "producer")).toBe(2);
    expect(completedCount(rows, "consumer")).toBe(3);
    expect(lastResponseAt(rows)?.toISOString()).toBe("2026-05-14T08:00:00.000Z");
    expect(lastResponseAt([])).toBeNull();
  });
});
