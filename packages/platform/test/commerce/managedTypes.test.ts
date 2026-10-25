import { describe, expectTypeOf, it } from "vitest";
import type { CommerceOmsStore as Client } from "../../src/commerce/adapters/managed/oms/types.js";

describe("commerce OMS adapter type contract", () => {
  it("keeps query and RPC boundaries explicit", () => {
    expectTypeOf<Client["query"]>().toBeFunction();
    expectTypeOf<Client["rpc"]>().toBeFunction();
  });
});
