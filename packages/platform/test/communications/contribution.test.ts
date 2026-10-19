import { expect, it } from "vitest";
import { createCommunicationsContribution } from "../../src/communications/contribution.js";

it("declares the selected schema and capability without mounting a route, handler or schedule", () => {
  const requiredSchema = { version: "synthetic-v1", migration: "synthetic.sql", objects: [{ kind: "table" as const, name: "public.synthetic_receipts" }] };
  const contribution = createCommunicationsContribution({ version: "0.16.0", requiredSchema, requiredPorts: ["delivery", "delivery"] });
  expect(contribution.manifest).toMatchObject({ kind: "rail", module: {
    id: "communications", kind: "capability", provides: ["./communications", "./communications/contracts"],
    dependsOn: [{ module: "data", entries: ["./data"] }, { module: "identity", entries: ["./identity"] }, { module: "http", entries: ["./http"] }],
  }, requiredPorts: ["delivery"] });
  expect(contribution.manifest.requiredSchema).toBe(requiredSchema);
  expect(contribution.handlers).toEqual([]);
  expect(contribution.schedules).toEqual([]);
  expect(contribution.routes).toEqual([]);
});
