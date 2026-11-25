import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PREFLIGHT_INTEGRATION_OWNERS,
  createPreflightIntegrationFixture,
  verifyStaleApiReportRepair,
} from "./fixtures/preflight-integration-fixture.ts";

describe("real fast preflight (cold API and publication path)", () => {
  const fixture = createPreflightIntegrationFixture();

  beforeAll(() => fixture.setup(), 180000);
  afterAll(() => fixture.teardown());

  it("refuses a stale API report with a cold cache, then accepts the owner's repair", () => {
    verifyStaleApiReportRepair(fixture, "cold", false);
  }, 300000);

  it("names the unregistered public path and accepts its reviewed classification", () => {
    fixture.reset();
    const extra = "packages/platform/api/fixture-freshness.md";
    fixture.put(extra, "# Fixture freshness\n");
    fixture.commit("Add a public path before classification");
    fixture.fast("unregistered path", ["publication"], `extra ${extra}`, "Add the reviewed classification in config/openlup-publication-catalog.json.");
    const catalogue = "config/openlup-publication-catalog.json";
    const registration: { publicPaths: { path: string; class: string }[] } = JSON.parse(fixture.get(catalogue));
    registration.publicPaths.push({ path: extra, class: "public-output" });
    registration.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    fixture.put(catalogue, JSON.stringify(registration, null, 2) + "\n");
    fixture.commit("Register the fixture path");
    fixture.fast("path registered", []);
    for (const owner of PREFLIGHT_INTEGRATION_OWNERS) {
      expect(existsSync(fixture.path(`packages/${owner}/dist`))).toBe(false);
    }
  }, 180000);
});
