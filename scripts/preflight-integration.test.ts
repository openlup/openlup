import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPreflightIntegrationFixture, verifyStaleApiReportRepair } from "./fixtures/preflight-integration-fixture.ts";

describe("real fast preflight (warm API and toolchain)", () => {
  const fixture = createPreflightIntegrationFixture();

  beforeAll(() => fixture.setup(), 180000);
  afterAll(() => fixture.teardown());

  it("refuses a stale API report with a warm-seeded cache, then accepts the owner's repair", () => {
    verifyStaleApiReportRepair(fixture, "warm-seeded", true);
  }, 300000);

  it.each(["patch drift", "Node major mismatch", "npm major mismatch"])("checks the installed toolchain with %s", variant => {
    fixture.reset();
    const node = process.versions.node;
    const npm = fixture.run(process.execPath, fixture.npmCli, "--version");
    const differentPin = (version: string, majorMismatch: boolean) => {
      const [major, minor, patch] = version.split(".").map(Number);
      return `${majorMismatch ? major + 1 : major}.${minor}.${patch + 1}`;
    };
    const pinnedNode = differentPin(node, variant === "Node major mismatch");
    const pinnedNpm = `npm@${differentPin(npm, variant === "npm major mismatch")}`;
    fixture.put(".nvmrc", `${pinnedNode}\n`);
    fixture.put("package.json", JSON.stringify({ ...JSON.parse(fixture.get("package.json")), packageManager: pinnedNpm }));
    const check = () => fixture.run(process.execPath, "--input-type=module", "-e",
      "import { assertCarrierToolchain } from './scripts/agent-review-landing.mjs'; console.log(assertCarrierToolchain(process.cwd()));");
    if (variant === "Node major mismatch") {
      expect(check).toThrow(`requires the Node major pinned by .nvmrc (${pinnedNode}); found Node ${node}. Run nvm install && nvm use.`);
    } else if (variant === "npm major mismatch") {
      expect(check).toThrow(`requires the npm major pinned by packageManager (${pinnedNpm}); found npm@${npm}. Run npm install --global ${pinnedNpm}.`);
    } else {
      expect(check()).toBe(`carrier toolchain: Node ${node}, npm ${npm}, ICU ${process.versions.icu}`);
    }
  }, 30_000);
});
