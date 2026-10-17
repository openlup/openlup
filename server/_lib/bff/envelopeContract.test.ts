import { describe, expect, it } from "vitest";

import { BFF_ERROR_CODES, BFF_REQUEST_REFERENCE_HEADER } from "@openlup/platform/bff";
import {
  BFF_REQUEST_REFERENCE_HEADER as CONTRACT_REQUEST_REFERENCE_HEADER,
  bffErrorCodeSchema,
} from "../../../src/lib/bff/contracts.js";

describe("reference BFF envelope binding", () => {
  it("keeps the browser contract's error codes and request reference header equal to the package envelope", () => {
    expect([...BFF_ERROR_CODES]).toEqual([...bffErrorCodeSchema.options]);
    expect(BFF_REQUEST_REFERENCE_HEADER).toBe(CONTRACT_REQUEST_REFERENCE_HEADER);
  });
});
