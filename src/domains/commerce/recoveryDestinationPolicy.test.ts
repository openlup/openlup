import { expect, it } from "vitest";
import { resolveRecoveryDestination as packageResolve } from "@openlup/platform/commerce";
import { resolveRecoveryDestination } from "./recoveryDestinationPolicy.js";
import { resolveRecoveryDestination as portResolve } from "./recoveryDestinationPorts.js";

it("binds both reference entrypoints to the single package recovery policy", () => {
  expect(resolveRecoveryDestination).toBe(packageResolve);
  expect(portResolve).toBe(packageResolve);
});
