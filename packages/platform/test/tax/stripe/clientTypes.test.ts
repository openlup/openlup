import type Stripe from "stripe";
import type { StripeTaxAdapterOptions } from "@openlup/platform/tax/stripe";
import { expectTypeOf, it } from "vitest";

it("accepts the installed SDK tax resources with an account and mode binding", () => {
  type BoundResources = Pick<Stripe["tax"], "calculations" | "registrations" | "transactions"> & {
    readonly scope: { readonly accountRef: string; readonly mode: "test" | "live" };
  };
  expectTypeOf<BoundResources>().toExtend<StripeTaxAdapterOptions["client"]>();
});
