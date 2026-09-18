import { describe, expect, it } from "vitest";

import * as publicSurface from "./contracts.js";
import {
  METHOD_LAST_DIGITS_SNAPSHOT_KEY,
  METHOD_SCHEME_SNAPSHOT_KEY,
} from "./paymentMethodLifecycle.js";

// The contracts module is a pure re-export seam. This pin holds the public
// names identical to their internal sources, so a rename inside the domain
// cannot silently strand a cross-domain consumer on a stale value.
describe("payment domain public contracts", () => {
  it("re-exports the method-facts snapshot keys unchanged", () => {
    expect(publicSurface.METHOD_SCHEME_SNAPSHOT_KEY).toBe(METHOD_SCHEME_SNAPSHOT_KEY);
    expect(publicSurface.METHOD_LAST_DIGITS_SNAPSHOT_KEY).toBe(METHOD_LAST_DIGITS_SNAPSHOT_KEY);
  });
});
