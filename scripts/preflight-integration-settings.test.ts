import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPreflightIntegrationFixture } from "./fixtures/preflight-integration-fixture.ts";

describe("real fast preflight (settings catalogue)", () => {
  const fixture = createPreflightIntegrationFixture();

  beforeAll(() => fixture.setup(), 180000);
  afterAll(() => fixture.teardown());

  it("refuses stale settings with warm-seeded and cold caches, then accepts the owner's repair", () => {
    fixture.reset(true);
    const dataPath = "packages/platform/src/inventory/settings-data.json";
    const entries: { kind: string }[] = JSON.parse(fixture.get(dataPath));
    fixture.put(
      dataPath,
      JSON.stringify([
        ...entries,
        { ...entries.find(entry => entry.kind === "invariant"), key: "inventory.fixtureFreshness", goal: "Describe the freshness fixture." },
      ], null, 2) + "\n",
    );
    fixture.put("packages/platform/changes/fixture-freshness.md", "- Exercise the settings catalogue owner.\n");
    fixture.commit("Add the fixture setting with its original catalogue");
    const settingsCheck = (cache: string) => fixture.fast(
      `settings stale (${cache})`,
      ["settings-catalogue"],
      "settings-catalogue: FAIL packages/platform/settings-catalog.json is stale",
      "node scripts/settings-catalogue.ts --write",
    );
    const warmSettings = settingsCheck("warm");
    fixture.cold();
    expect(settingsCheck("cold")).toEqual(warmSettings);
    fixture.run(process.execPath, "scripts/settings-catalogue.ts", "--write");
    fixture.commit("Regenerate the settings carriers");
    fixture.fast("settings repaired", []);
  }, 300000);
});
