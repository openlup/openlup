import { describe, expect, it } from "vitest";
import { selectCount, selectRows } from "./observabilityEvidenceQueries.js";

describe("observability evidence queries", () => {
  it("selectRows returns data and defaults null to []", async () => {
    expect(await selectRows(Promise.resolve({ data: [{ a: 1 }], error: null }), "t")).toEqual([{ a: 1 }]);
    expect(await selectRows(Promise.resolve({ data: null, error: null }), "t")).toEqual([]);
  });

  it("selectRows throws a labelled error", async () => {
    await expect(selectRows(Promise.resolve({ data: null, error: { message: "boom" } }), "rows")).rejects.toThrow("rows: boom");
    await expect(selectRows(Promise.resolve({ data: null, error: {} }), "rows")).rejects.toThrow("rows: query failed");
  });

  it("selectCount returns count and defaults null to 0", async () => {
    expect(await selectCount(Promise.resolve({ data: null, error: null, count: 7 }), "c")).toBe(7);
    expect(await selectCount(Promise.resolve({ data: null, error: null, count: null }), "c")).toBe(0);
  });

  it("selectCount throws a labelled error", async () => {
    await expect(selectCount(Promise.resolve({ data: null, error: { message: "nope" } }), "cnt")).rejects.toThrow("cnt: nope");
  });
});
