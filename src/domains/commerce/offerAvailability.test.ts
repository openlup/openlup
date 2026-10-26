import { expect, it } from "vitest";
import * as facade from "./offerAvailability.js";
import * as core from "@openlup/platform/commerce";

it("delegates every availability helper with function identity preserved", () => {
  for (const name of Object.keys(facade) as Array<keyof typeof facade>) expect(facade[name]).toBe(core[name]);
});
