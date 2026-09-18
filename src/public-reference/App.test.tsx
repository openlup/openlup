import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PUBLIC_REFERENCE_ENTRIES, PublicReferenceApp } from "./App";

describe("public reference catalog", () => {
  it("renders the bounded static list and declared detail entry", () => {
    expect(PUBLIC_REFERENCE_ENTRIES.map((entry) => entry.path)).toEqual(["/items/field-notes"]);
    expect(renderToStaticMarkup(<PublicReferenceApp pathname="/" />)).toContain("Reference collection");
    expect(renderToStaticMarkup(<PublicReferenceApp pathname="/items/field-notes" />)).toContain("Field notes");
  });

  it("has no client-side fallback into an undeclared route", () => {
    expect(renderToStaticMarkup(<PublicReferenceApp pathname="/checkout" />)).toContain("not found");
  });
});
