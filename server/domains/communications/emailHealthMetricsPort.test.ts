import { describe, expect, it } from "vitest";

import * as emailHealthMetricsPort from "./emailHealthMetricsPort.js";

describe("emailHealthMetricsPort", () => {
  it("keeps the provider-neutral contract type-only at runtime", () => {
    expect(Object.keys(emailHealthMetricsPort)).toEqual([]);
  });
});
