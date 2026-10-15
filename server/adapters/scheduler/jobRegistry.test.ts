import { describe, expect, it } from "vitest";

import { loadJobRegistry } from "./jobRegistry.js";

describe("reference job registry binding", () => {
  it("loads no active jobs from the selected public configuration", () => {
    expect(loadJobRegistry()).toEqual([]);
  });
});
