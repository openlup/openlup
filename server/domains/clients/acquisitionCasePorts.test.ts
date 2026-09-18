import { describe, expect, it } from "vitest";

import type {
  AcquisitionCasePort,
  AcquisitionCaseResult,
} from "./acquisitionCasePorts.js";

describe("acquisition case port", () => {
  it("exposes capability-local operations and tagged failures", () => {
    const failure = { ok: false, error: { kind: "rate_limited" } } satisfies AcquisitionCaseResult<number>;
    const port = {
      submit: async () => failure,
      list: async () => failure,
      get: async () => failure,
      transition: async () => failure,
      activeCount: async () => ({ ok: true as const, value: 0 }),
      close: async () => undefined,
    } satisfies AcquisitionCasePort;
    expect(Object.keys(port).sort()).toEqual(["activeCount", "close", "get", "list", "submit", "transition"]);
    expect(failure.error.kind).toBe("rate_limited");
  });
});
