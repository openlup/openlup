import { expect, it } from "vitest";
import { bindCommunicationTriggers } from "./triggerBindings.js";
import { EMAIL_CANON_REGISTRY } from "../../../src/domains/communications/emailCanon.js";
it("binds only implemented canon rows to explicit callables, with no maintained cadence", () => {
  const row = EMAIL_CANON_REGISTRY.find(row => row.deliveryStatus === "implemented")!;
  const run = async () => "invoked";
  const result = bindCommunicationTriggers([{ slug: row.slug, run }]);
  expect(result[0]).toMatchObject({ slug: row.slug, owner: row.owner, run });
  expect(() => bindCommunicationTriggers([{ slug: row.slug, run }, { slug: row.slug, run }])).toThrow();
  expect(() => bindCommunicationTriggers([{ slug: "unknown", run }])).toThrow();
  const inert = EMAIL_CANON_REGISTRY.find(row => row.deliveryStatus !== "implemented")!;
  expect(() => bindCommunicationTriggers([{ slug: inert.slug, run }])).toThrow();
  expect(() => bindCommunicationTriggers([{ slug: row.slug, run: null as never }])).toThrow();
});
