import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGING_MIN_SEVERITY,
  parsePagingMinSeverity,
  shouldPage,
} from "./alertPagingPolicy";

describe("alert paging policy", () => {
  it("pages p0 only at the default threshold; p1 is panel-urgent, not a page", () => {
    expect(shouldPage("p0")).toBe(true);
    expect(shouldPage("p1")).toBe(false);
    expect(shouldPage("p2")).toBe(false);
    expect(shouldPage("p3")).toBe(false);
  });

  it("fails safe: unknown or malformed severity always pages", () => {
    expect(shouldPage("weird")).toBe(true);
    expect(shouldPage("")).toBe(true);
    expect(shouldPage("P0")).toBe(true); // case-sensitive rank lookup misses -> page
  });

  it("respects a custom threshold", () => {
    expect(shouldPage("p2", "p2")).toBe(true);
    expect(shouldPage("p3", "p2")).toBe(false);
    expect(shouldPage("p1", "p0")).toBe(false);
    expect(shouldPage("p0", "p0")).toBe(true);
    // An operator can widen the floor back to the pre-cutover behaviour.
    expect(shouldPage("p1", "p1")).toBe(true);
  });

  it("defaults to p0 and parses config leniently", () => {
    expect(DEFAULT_PAGING_MIN_SEVERITY).toBe("p0");
    expect(parsePagingMinSeverity("p0")).toBe("p0");
    expect(parsePagingMinSeverity("  P2 ")).toBe("p2");
    expect(parsePagingMinSeverity("bogus")).toBe("p0");
    expect(parsePagingMinSeverity(undefined)).toBe("p0");
    expect(parsePagingMinSeverity(null)).toBe("p0");
  });
});
