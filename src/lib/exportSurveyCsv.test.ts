import { describe, expect, it } from "vitest";
import { rowsToCsv } from "@/lib/exportSurveyCsv";

describe("rowsToCsv", () => {
  it("returns only stable base headers for an empty export", () => {
    expect(rowsToCsv([])).toBe("id,created_at\n");
  });

  it("flattens survey payloads and escapes CSV-sensitive values", () => {
    const csv = rowsToCsv([
      {
        id: "row-1",
        created_at: "2026-05-14T07:00:00.000Z",
        response_data: {
          screen5_usage_combined: ["Food", "Treats"],
          quoted: "needs, commas and \"quotes\"",
          nested: { rank1: "Taste", rank2: "Price" },
          opted_in: true,
        },
      },
      {
        id: "row-2",
        created_at: "2026-05-14T08:00:00.000Z",
        response_data: {
          screen5_usage_combined: [],
          quoted: "plain",
          nested: null,
          opted_in: false,
        },
      },
    ]);

    expect(csv.split("\n")[0]).toBe("id,created_at,Usage,quoted,nested,opted_in");
    expect(csv).toContain('row-1,2026-05-14T07:00:00.000Z,Food | Treats,"needs, commas and ""quotes""",rank1=Taste; rank2=Price,yes');
    expect(csv).toContain("row-2,2026-05-14T08:00:00.000Z,,plain,,no");
  });
});
