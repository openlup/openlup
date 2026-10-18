import { expect, it } from "vitest";
import { createIdentityContribution } from "../../src/identity/contribution.js";
it("identifies the capability separately from the containing rail and retains its schema", () => {
  const requiredSchema = { version: "fixture-v1", migration: "fixture.sql", objects: [{ kind: "table" as const, name: "public.clients" }] };
  const contribution = createIdentityContribution({ version: "0.15.0", requiredSchema });
  expect(contribution.manifest.module).toEqual({
    id: "identity", kind: "capability", provides: ["./identity", "./identity/contracts"],
    dependsOn: [
      { module: "bff", entries: ["./bff"] }, { module: "data", entries: ["./data"] },
      { module: "kernel", entries: ["./kernel"] }, { module: "http", entries: ["./http"] },
    ],
  });
  expect(contribution.manifest.requiredSchema).toBe(requiredSchema);
  expect(contribution.manifest.kind).toBe("rail");
});
