import { describe, expect, it } from "vitest";

import { renderRoute } from "./entry-server";

describe("public reference SSR entry", () => {
  it("renders distinct server markup for every declared document", () => {
    expect(renderRoute("/")).toContain("Reference collection");
    expect(renderRoute("/items/field-notes")).toContain("Field notes");
  });
});
