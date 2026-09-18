import { describe, expect, it } from "vitest";
import { cn, compactParts, valueOrDash } from "@/lib/utils";

describe("cn", () => {
  it("merges class names and resolves Tailwind conflicts", () => {
    const isHidden = false;
    expect(cn("px-2", "px-4", isHidden && "hidden", "font-semibold")).toBe(
      "px-4 font-semibold",
    );
  });
});

describe("compactParts", () => {
  it("drops null, undefined, empty and whitespace-only parts", () => {
    expect(compactParts(["DHL", null, "", "   ", undefined, "24h"])).toEqual(["DHL", "24h"]);
  });

  it("keeps a whitespace-padded part verbatim rather than trimming it", () => {
    expect(compactParts([" DHL "])).toEqual([" DHL "]);
  });
});

describe("valueOrDash", () => {
  it("renders a dash for missing, empty and whitespace-only values", () => {
    expect(valueOrDash(null)).toBe("-");
    expect(valueOrDash(undefined)).toBe("-");
    expect(valueOrDash("")).toBe("-");
    expect(valueOrDash("  ")).toBe("-");
  });

  it("returns a present value unchanged", () => {
    expect(valueOrDash("OMS-1001")).toBe("OMS-1001");
  });
});
