import { describe, expectTypeOf, it } from "vitest";
import type { CommerceOmsClient as Client } from "./types.js";

describe("commerce OMS adapter type contract", () => {
  it("keeps query and RPC boundaries explicit", () => {
    expectTypeOf<Client["from"]>().toBeFunction();
    expectTypeOf<Client["rpc"]>().toBeFunction();
  });
});
