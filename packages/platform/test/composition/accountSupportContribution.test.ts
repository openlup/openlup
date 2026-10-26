import { checkReadiness, type ReadinessInput } from "@openlup/core/readiness";
import { expect, it, vi } from "vitest";
import { createAccountSupportContribution } from "../../src/composition/index.js";

const schema = { version: "complete-catalogue", migration: "host-migration-chain", objects: [] };
const run = vi.fn(async () => "owner");
const options = { version: "0.26.0", requiredSchema: schema, accountSupport: { account: run, invoice: null },
  dependsOn: [{ module: "identity", entries: ["./identity"] }], routes: [{ id: "account", handle: run }] };

it("C1 describes selected callables, null obligations and routes without registering workers", () => {
  const result = createAccountSupportContribution(options), contribution = result.contributions[0]!;
  expect(contribution.manifest).toEqual({ name: "@openlup/platform", version: "0.26.0", kind: "rail",
    module: { id: "account-support", kind: "capability", provides: ["./account-support", "./account-support/contracts"], dependsOn: options.dependsOn },
    emits: [], handles: [], schedules: [], env: [], requiredPorts: ["account", "invoice"], routes: ["account"], requiredSchema: schema });
  expect(result.ports).toEqual({ "@openlup/platform/account-support:account": run });
  expect(result.routes["@openlup/platform/account-support:account"]).toBe(run);
  expect(contribution.routes[0]!.handle).toBe(run);
  expect(contribution.handlers).toEqual([]); expect(contribution.schedules).toEqual([]); expect(result.triggers).toEqual({});
  expect(run).not.toHaveBeenCalled();
});

it.each(["port", "owner"] as const)("C1 Core refuses a missing selected %s", async missing => {
  const selected = createAccountSupportContribution({ ...options, accountSupport: { account: run } });
  const identity = { ...selected.contributions[0]!, manifest: { ...selected.contributions[0]!.manifest,
    module: { id: "identity", kind: "capability" as const, provides: ["./identity"], dependsOn: [] }, requiredPorts: [], routes: [] }, routes: [] };
  const input: ReadinessInput = {
    candidate: { artifact: "artifact", configuration: "config", environment: "local", database: "db", schema: "complete-catalogue" }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", kind: "kernel", version: "0.26.0" },
      { name: "@openlup/platform", kind: "rail", version: "0.26.0", modules: missing === "owner" ? ["account-support"] : ["account-support", "identity"] }],
    contributions: missing === "owner" ? selected.contributions : [...selected.contributions, identity], vocabulary: [], exemptions: [],
    bindings: { ports: missing === "port" ? {} : selected.ports, routes: selected.routes, triggers: {}, env: {} },
    schemaProbe: { observe: async () => ({ database: "db", version: schema.version, objects: [] }) },
  };
  const report = await checkReadiness(input);
  expect(report.state).toBe("unsatisfied");
  expect(report.issues).toEqual([expect.objectContaining(missing === "port"
    ? { code: "OPENLUP_E_PORT_MISSING", subject: "account" } : { code: "OPENLUP_E_SET_MISMATCH", subject: "dependency:identity" })]);
});

it("C1 refuses duplicate route registration", () => {
  expect(() => createAccountSupportContribution({ ...options, routes: [options.routes[0]!, options.routes[0]!] })).toThrow("account_support_duplicate_route");
});
